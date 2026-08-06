# Server Deployment

Target directory: `/opt/walletscaner`.

The server stack is paper/research only. PostgreSQL is canonical; `reports/` and `logs/` are operational views and cannot restore the ledger by themselves.

## Services

`docker-compose.server.yml` starts:

- private PostgreSQL 16 volume;
- Redis 7 with AOF;
- one-shot checksum-verified migration job;
- Solana discovery plus Helius active-pool ingestion;
- evidence sampler;
- wallet-alpha scorer/report refresh every 15 minutes;
- paper/alert outbox worker;
- PostgreSQL-only API;
- production Next.js dashboard.

The legacy `market-watch` service is disabled unless the `legacy-research` profile is explicitly requested. Historical backfill is a commented, separately budgeted maintenance job.

## Environment

Create `/opt/walletscaner/.env.server` outside source control. At minimum set:

```text
POSTGRES_PASSWORD=<strong-secret>
POSTGRES_DB=memecoin_alpha
DATABASE_URL=postgres://postgres:<strong-secret>@postgres:5432/memecoin_alpha
REPOSITORY_MODE=postgres
SOLANA_RPC_URL=<dedicated-mainnet-rpc>
SOLANA_WS_URL=<dedicated-mainnet-ws>
HELIUS_API_KEY=<secret>
HELIUS_INGEST_MODE=webhook
HELIUS_WEBHOOK_ID=<existing-helius-webhook-id>
HELIUS_WEBHOOK_URL=https://api.example.com/api/webhooks/helius
HELIUS_WEBHOOK_AUTH_HEADER=<random-shared-secret>
HELIUS_WEBHOOK_SYNC_INTERVAL_MINUTES=15
HELIUS_TRANSACTION_STREAM_ENABLED=false
ENABLE_LIVE_EXECUTION=false
```

Copy the reviewed program/decoder, Pyth, threshold and optional alert settings from `.env.example`. Do not put real provider or bot credentials in an image layer.

`PUBLIC_API_BASE_URL` must be the browser-reachable API URL used at web image build time. Put API/web behind an HTTPS reverse proxy before exposing them publicly. The webhook endpoint must never be public over plain HTTP.

On the Helius free plan, create one Enhanced Webhook with `transactionTypes=["SWAP"]`, the reviewed program IDs, the public URL above and the same auth header. Copy the returned webhook ID into `.env.server`; `solana-ingestion` verifies that stable program-address set and skips unchanged management updates. `transactionSubscribe` is a paid-plan option and must remain disabled here.

## Deploy

```sh
cd /opt/walletscaner
sha256sum -c /path/to/reviewed-worker-image.tar.sha256
docker load -i /path/to/reviewed-worker-image.tar
docker image inspect walletscaner-worker:local --format '{{.Id}}'
docker compose -p walletscaner -f docker-compose.server.yml --env-file .env.server config --quiet
docker compose -p walletscaner -f docker-compose.server.yml --env-file .env.server up -d --no-build postgres redis
docker compose -p walletscaner -f docker-compose.server.yml --env-file .env.server run --rm --no-deps migrate
docker compose -p walletscaner -f docker-compose.server.yml --env-file .env.server up -d --no-build --no-deps solana-ingestion
docker compose -p walletscaner -f docker-compose.server.yml --env-file .env.server ps
```

Do not build on the shared server. Record the loaded image ID and preserve the previous image/source
artifact as the rollback point. The migration service must complete successfully before ingestion/API.
The API calls `assertReady()` before listening and has no production memory fallback. Profile-free
startup is core-only; activate optional profiles only after their own acceptance gate.

Inspect logs:

```sh
docker compose -p walletscaner -f docker-compose.server.yml --env-file .env.server logs --tail=200 migrate solana-ingestion
```

Canonical health:

```sh
curl -fsS http://127.0.0.1:4010/health
curl -fsS http://127.0.0.1:4010/api/pipeline/health
```

`deploy/server-status.sh` provides a bounded read-only host/database/co-tenant snapshot. It is useful
evidence, but acceptance still requires `/api/pipeline/health`, structured `solana-ingestion-health`
logs and the indexed SQL checks in `docs/operations.md`.

## Safe rollout

1. Take a PostgreSQL backup and capture pre-deploy table/slot/backlog metrics.
2. Deploy with Telegram/Discord credentials absent.
3. Run seven days of shadow ingest and compare old/v2 decoder coverage and wallet identity.
4. Require the documented lag, gap-repair, backlog, memory, parse-coverage and replay invariants.
5. Run at least 14 days of paper-only operation.
6. Add alert credentials only after legitimate live `watch`/`candidate` gates pass.
7. Keep `ENABLE_LIVE_EXECUTION=false`.

No deployment should be called production-ready only because containers are healthy. The acceptance evidence is described in `docs/operations.md` and `reports/walletscaner-v2-implementation-review.html`.

## Backup and rollback

- Back up the PostgreSQL volume/database before every schema rollout.
- Never edit a migration already recorded in `schema_migrations`; create a new numbered migration.
- Preserve the previous image revision and `.env.server` separately from the DB backup.
- A code rollback does not automatically reverse a schema migration. Verify backward compatibility before switching images.
- Do not run two canonical writers against the same strategy version during cutover unless the replay/idempotency comparison explicitly expects it.
