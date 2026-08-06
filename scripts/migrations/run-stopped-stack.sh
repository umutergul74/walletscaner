#!/bin/sh
set -eu

container="${POSTGRES_CONTAINER:-walletscaner-postgres-1}"
database="${POSTGRES_DATABASE:-memecoin_alpha}"
migration_dir="${MIGRATION_DIRECTORY:-/opt/walletscaner/scripts/migrations}"
status_file="${MIGRATION_STATUS_FILE:-/opt/walletscaner/reports/bounded-storage-migration.status}"

test "$container" = walletscaner-postgres-1
test "$database" = memecoin_alpha
test "$migration_dir" = /opt/walletscaner/scripts/migrations
test "$(docker inspect "$container" --format '{{.State.Health.Status}}')" = healthy

psql_exec() {
  docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U postgres -d "$database" "$@"
}

printf 'state=running\nstarted_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$status_file"

for file in "$migration_dir"/0*.sql; do
  filename="$(basename "$file")"
  case "$filename" in
    0??_*.sql) ;;
    *) continue ;;
  esac
  checksum="$(sha256sum "$file" | awk '{print $1}')"
  case "$checksum" in
    *[!a-f0-9]*|'') echo "Invalid checksum for $filename" >&2; exit 2 ;;
  esac

  existing="$(psql_exec -At \
    -c "SELECT checksum FROM schema_migrations WHERE filename = '$filename'")"
  if [ "$existing" ]; then
    if [ "$existing" != "$checksum" ]; then
      echo "Applied migration checksum mismatch: $filename" >&2
      exit 3
    fi
    continue
  fi

  echo "Applying $filename"
  if head -n 1 "$file" | grep -q '^-- migrate:no-transaction'; then
    psql_exec < "$file"
    psql_exec \
      -c "INSERT INTO schema_migrations (filename, checksum) VALUES ('$filename', '$checksum')"
  else
    {
      echo 'BEGIN;'
      cat "$file"
      printf "\nINSERT INTO schema_migrations (filename, checksum) VALUES ('%s', '%s');\n" \
        "$filename" "$checksum"
      echo 'COMMIT;'
    } | psql_exec
  fi
done

invalid_indexes="$(psql_exec -At -c \
  "SELECT COUNT(*) FROM pg_index WHERE NOT indisvalid AND indrelid IN (
     'chain_event_inbox'::regclass,
     'price_observations'::regclass,
     'wallet_trade_events'::regclass,
     'wallet_entry_signals'::regclass,
     'wallet_signal_outcomes'::regclass,
     'wallet_position_episodes'::regclass
   )")"
test "$invalid_indexes" = 0

printf 'state=complete\ncompleted_at=%s\nlatest=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$(psql_exec -At -c 'SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1')" \
  > "$status_file"
cat "$status_file"
