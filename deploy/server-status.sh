#!/usr/bin/env sh
set -eu

PROJECT_DIR="${WALLETSCANER_PROJECT_DIR:-/opt/walletscaner}"
cd "$PROJECT_DIR"

set -a
# shellcheck disable=SC1091
. ./.env.server
set +a

compose() {
  docker compose -p walletscaner --env-file .env.server -f docker-compose.server.yml "$@"
}

printf 'Snapshot UTC: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '\nWalletscaner containers:\n'
compose ps

printf '\nProtected co-tenant state (read-only):\n'
docker ps --filter 'label=com.docker.compose.project=robinhoodscaner-intel' \
  --format '{{.Names}}|{{.Status}}'
for name in \
  robinhoodscaner-intel-api-1 \
  robinhoodscaner-intel-postgres-1 \
  robinhoodscaner-intel-redis-1
do
  docker inspect "$name" \
    --format '{{.Name}}|restart={{.RestartCount}}|health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}'
done

printf '\nHost headroom:\n'
uptime
free -m
df -h / /var/lib/docker 2>/dev/null | awk 'NR == 1 || !seen[$1]++'

running_containers="$(
  {
    docker ps --filter 'label=com.docker.compose.project=walletscaner' --format '{{.Names}}'
    docker ps --filter 'label=com.docker.compose.project=robinhoodscaner-intel' --format '{{.Names}}'
  } | sort -u
)"
if [ -n "$running_containers" ]; then
  printf '\nBounded container resource snapshot:\n'
  # Container names come from read-only exact Compose-label filters above.
  # shellcheck disable=SC2086
  docker stats --no-stream --format '{{.Name}}|cpu={{.CPUPerc}}|mem={{.MemUsage}}' $running_containers
fi

if compose ps --status running --services | grep -qx postgres; then
  printf '\nDatabase working set (no full heap counts):\n'
  compose exec -T postgres psql \
    -v ON_ERROR_STOP=1 \
    -U postgres \
    -d "${POSTGRES_DB:?POSTGRES_DB is required}" \
    -P pager=off \
    -c "
      SELECT current_database() AS database,
             pg_size_pretty(pg_database_size(current_database())) AS database_size;

      SELECT c.relname,
             GREATEST(c.reltuples, 0)::bigint AS planner_estimated_rows,
             pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
      FROM pg_class c
      WHERE c.oid IN (
        'chain_event_inbox'::regclass,
        'price_observations'::regclass,
        'wallet_trade_events'::regclass,
        'wallet_entry_signals'::regclass,
        'wallet_signal_outcomes'::regclass
      )
      ORDER BY pg_total_relation_size(c.oid) DESC;

      SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'processing')) AS unresolved_events,
             COUNT(*) FILTER (WHERE status = 'dead_letter') AS dead_letters
      FROM chain_event_inbox
      WHERE status IN ('pending', 'processing', 'dead_letter');

      SELECT
        (SELECT updated_at FROM pipeline_watermarks ORDER BY updated_at DESC LIMIT 1)
          AS latest_pipeline_watermark_at;
    "

  incremental_schema_ready="$(
    compose exec -T postgres psql -U postgres -d "$POSTGRES_DB" -Atqc \
      "SELECT to_regclass('public.wallet_alpha_work_queue') IS NOT NULL
              AND to_regclass('public.idx_price_observations_retention') IS NOT NULL"
  )"
  if [ "$incremental_schema_ready" = "t" ]; then
    compose exec -T postgres psql \
      -v ON_ERROR_STOP=1 \
      -U postgres \
      -d "$POSTGRES_DB" \
      -P pager=off \
      -c "
        SELECT COUNT(*) FILTER (WHERE revision > completed_revision) AS alpha_pending,
               COUNT(*) FILTER (
                 WHERE locked_by IS NOT NULL AND lock_expires_at > NOW()
               ) AS alpha_leased
        FROM wallet_alpha_work_queue;

        SELECT observed_at AS latest_price_at
        FROM price_observations
        ORDER BY observed_at DESC
        LIMIT 1;
      "
  else
    printf 'Incremental alpha/price freshness: migration not applied yet.\n'
  fi
else
  printf '\nDatabase working set: skipped; Walletscaner PostgreSQL is stopped.\n'
fi

printf '\nRecent Walletscaner canary logs:\n'
compose logs --tail=30 solana-ingestion evidence-sampler wallet-alpha 2>&1 || true
