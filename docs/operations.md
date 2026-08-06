# Operations

Walletscaner v2 must be operated as a PostgreSQL-backed evidence system. A process being alive is not proof that chain coverage, parser quality or paper delivery is healthy.

## Required configuration

Create `.env` for local work or `.env.server` for the server from `.env.example`.

Required for the canonical production path:

- `DATABASE_URL` and `REPOSITORY_MODE=postgres`;
- dedicated `SOLANA_RPC_URL` and `SOLANA_WS_URL`;
- `HELIUS_API_KEY` for the bounded standard trade WebSocket, DAS risk lookup and optional history;
- token-risk RPC uses `SOLANA_TOKEN_RISK_RPC_URL` (or the normal Solana RPC) first and
  `SOLANA_TOKEN_RISK_FALLBACK_RPC_URL`/Helius only after a primary transport failure;
- Helius DAS creator enrichment runs only for tokens that already passed the cheap market gate
  and public-RPC token-risk gate; disable it with `HELIUS_CREATOR_ENRICHMENT_ENABLED=false`;
- pool sampling deduplicates DexScreener requests by token, batches up to 30 addresses per the
  provider contract and uses bounded concurrency (`DEXSCREENER_SAMPLE_CONCURRENCY`, default `2`)
  so a slow provider call cannot serialize the entire active-pool set;
- ingestion performs no append-only price-history write. Live pool decisions may still run every
  30 seconds and write a compact current `pools` row, while market-proxy evidence is embedded in the
  affected wallet trade/entry. `evidence-sampler` is the only `price_observations` writer and uses
  deterministic 120-second compact buckets;
- paper evidence uses deterministic 120-second buckets, compact provider audit fields and a
  500-active-token circuit breaker. Deferred-token counts are emitted as structured saturation
  metrics instead of silently expanding storage;
- ingestion market sampling is capped at 120 fairly prioritized due pools per provider cycle and
  1,000 active pools in memory. Subscription-first, least-recently-sampled ordering preserves live
  candidates while deferred and eviction counts make saturation explicit;
- `HELIUS_INGEST_MODE=rpc` with `HELIUS_STANDARD_TRADE_WS_ENABLED=true` for the recommended
  free-plan hybrid: broad program discovery and HTTP gap repair remain on the configured Solana
  RPC, while only market-eligible pools use Helius standard `logsSubscribe`;
- `RPC_TRADE_MAX_ACTIVE_POOLS=3` keeps the metered WebSocket stream bounded and leaves free-plan
  headroom for token-risk fallback/DAS calls; `SOLANA_TRADE_WS_URL` can explicitly override the
  trade WebSocket without changing discovery;
- public HTTP transaction visibility can lag the Helius log notification. Keep
  `RPC_TRADE_TRANSACTION_FETCH_MAX_ATTEMPTS=6`, retry from 1 second, and cap retry delay at
  8 seconds. Live resolution is additionally capped at 128 workers plus 2,000 queued signatures.
  Health logs expose request, retry, recovery, final-unresolved, active, queued and dropped counts;
- canonical inbox claims use an index skip-scan over one unresolved head per partition instead of
  ranking the full backlog. Processing is bounded to four independent partitions, claims eight rows
  with a 90-second lease, and preserves sequential ordering inside each partition. Tune
  `CANONICAL_EVENT_PROCESS_CONCURRENCY`, `CANONICAL_EVENT_CLAIM_LIMIT` and
  `CANONICAL_EVENT_LEASE_SECONDS` only from measured throughput and lease-expiry evidence;
- canonical swap replay resolves a missing in-memory pool from the PostgreSQL `pools` primary key
  and retains that compact context in a bounded address cache. Pool sampling still expires after
  120 minutes; replay hydration does not resubscribe or resume market sampling for old pools;
- historical SOL/USD conversion first reuses a persisted Pyth observation within 60 seconds.
  Missing observations are single-flighted and cached in bounded 60-second event-time buckets
  (`HISTORICAL_SOL_USD_CACHE_MAX_ENTRIES`, default 4,096), reducing repeated backlog HTTP lookups
  without replacing exact persisted price provenance. Actual historical provider requests are
  serialized at a minimum 1.2-second interval; HTTP 429 responses trip an exponential bounded
  backoff plus per-bucket negative cache instead of creating a retry storm. Historical requests use
  the Benchmarks single-timestamp endpoint; the interval endpoint returns an array of per-second
  updates and is not a drop-in single-price response;
- `SOLANA_POOL_PROGRAMS_JSON` with reviewed program IDs/discriminators;
- `PYTH_SOL_USD_FEED_ID` and Pyth endpoint settings;
- a non-empty `HELIUS_WEBHOOK_AUTH_HEADER` matching the Helius webhook configuration.

Optional delivery credentials are `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` and `DISCORD_WEBHOOK_URL`. Keep them in a secret manager or untracked environment file.

For server activation, pipe a JSON object containing `telegramBotToken` and `telegramChatId` to
`scripts/deploy/update-telegram-env.py --env-file .env.server`. The updater validates both values,
deduplicates the managed keys and atomically replaces the env file without printing either secret.

The dedicated `telegram-notifier` requires both Telegram values and refuses startup when either is
missing. It polls every 30 seconds, sends a status summary at startup and every six hours, and claims
at most one message per cycle. Each pool discovery scan is capped at 100 previously unseen rows so
a provider burst cannot create unbounded database or Telegram work. Qualified-pool alerts require `MIN_LIQUIDITY_USD`,
`MIN_VOLUME_5M_USD` and known/passed token-risk evidence. The default recent-pool window is 30
minutes with a five-minute first-start lookback. Never print the bot token or copy it into source,
Compose, reports, logs or a tracked env file.

Migration `016_telegram_pool_candidate_index.sql` is deliberately non-transactional and builds the
partial candidate index concurrently. The migration runner recognizes the
`-- migrate:no-transaction` header; do not move this index back into a normal transaction on a live
database because doing so would block pool writers during the build.

`ALERT_COOLDOWN_MINUTES` suppresses later cross-strategy alerts for the same token using the durable signal history; the earliest deterministic contender remains deliverable. Paper processing remains independent.

Do not set `ENABLE_LIVE_EXECUTION=true`; there is no approved live execution phase.

## Local verification

```bash
cp .env.example .env
npm install
docker compose up -d postgres redis
npm run db:migrate
npm test
npm run typecheck
npm run lint
npm run build --workspaces --if-present
```

The GitHub Actions workflow supplies an isolated PostgreSQL 16 service and sets `TEST_DATABASE_URL`, so the inbox/outbox/FIFO SQL integration suite is a mandatory CI gate rather than a skipped optional test.

Run the data path in separate terminals:

```bash
npm run worker:solana
npm run worker:evidence-sampler
npm run worker:wallet-alpha
npm run research:wallet-alpha # on-demand full report only
npm run research:wallet-alpha-managed-shadow
npm run worker:paper-alert
npm run worker:telegram-notifier
npm run dev
```

The production worker is an incremental scorer; the report command is an on-demand summary and is
not scheduled. Changed wallets enter a revisioned PostgreSQL work queue. The worker claims one
wallet lease at a time, reads only that wallet with explicit trade/entry/outcome row ceilings,
persists wallet-scoped FIFO state, and leaves events arriving during a lease pending at the next
revision. A pathological wallet is delayed without blocking later wallets. Each cycle also has a
hard wall-clock limit, while the Compose loop uses exponential backoff after process failures.

`research:wallet-alpha-managed-shadow` is different: it is a bounded, read-only model-selection
report. Its default is 25 wallets with a hard ceiling of 100; it does not claim/complete queue work,
write managed scores, save signals or enqueue Telegram messages. Do not add it to the production
Compose loop until the query plan, runtime/RSS and protected co-tenant impact are measured and the
user explicitly authorizes a shadow rollout.

## Server stack

`docker-compose.server.yml` defines:

- the default core: `postgres`, Redis with AOF, one-shot `migrate` and `solana-ingestion`;
- `research`: `evidence-sampler` and periodic `wallet-alpha`;
- `paper`: one explicitly selected, version-frozen qualified-pool paper simulator;
- `notifications`: Telegram-only signal, qualified-pool, paper-event and status delivery;
- `ui`: PostgreSQL-backed `api` and production-built `web`;
- `operations`: dry-run-first data maintenance, the operations monitor and scheduled backup;
- `legacy-research`: the non-canonical `market-watch` path.

Every service has an explicit memory, CPU-weight/quota and PID ceiling. Walletscaner CPU shares are
deliberately below the host default so a co-tenant gets priority during contention. The alpha Node
heap is capped at 112 MB and the PostgreSQL cache/work-memory settings are sized for a 2 GB shared
host. Do not remove these ceilings to hide an OOM; reduce batch size first.

The Telegram notifier keeps a 40 MB Node heap, an 80 MB container ceiling and a 2% CPU quota. The
container ceiling leaves room for the Node runtime and TLS/native allocations; it is not a target or
reservation, so alert on measured RSS growth rather than treating the limit as normal usage.
Its Compose command invokes Node with the `tsx` loader directly; do not add an `npm run` wrapper to
this small service because the extra npm and tsx launcher processes materially increase RSS.

Load reviewed prebuilt images, then start and inspect only the default core with:

```bash
docker compose -p walletscaner -f docker-compose.server.yml --env-file .env.server config --quiet
docker compose -p walletscaner -f docker-compose.server.yml --env-file .env.server up -d --no-build postgres redis
docker compose -p walletscaner -f docker-compose.server.yml --env-file .env.server run --rm --no-deps migrate
docker compose -p walletscaner -f docker-compose.server.yml --env-file .env.server up -d --no-build --no-deps solana-ingestion
docker compose -p walletscaner -f docker-compose.server.yml --env-file .env.server ps
docker compose -p walletscaner -f docker-compose.server.yml --env-file .env.server logs --tail=200 solana-ingestion
```

Never build on the shared server and never start all profiles together. `market-watch` starts only with
`--profile legacy-research` and is not a canonical production writer. Historical backfill and old
report-refresh examples are commented out; run them only as explicit, budgeted maintenance jobs.

`deploy/server-status.sh` is a read-only, bounded snapshot: it avoids full heap counts, reports
planner-estimated large-table cardinalities, queries only indexed working sets and includes protected
co-tenant health/restart/resource evidence. Use it together with the canonical checks below.

## Health checks

API liveness:

```bash
curl -fsS http://localhost:4010/health
```

Canonical DB/pipeline summary:

```bash
curl -fsS http://localhost:4010/api/pipeline/health
```

The pipeline response includes DB reachability (by virtue of a successful query), exact unresolved
working-set/dead-letter counts, an explicitly marked planner estimate for processed history, rolling
24-hour parser/price coverage, latest received/processed slot, processing lag, oldest pending age,
last pool/swap/wallet-trade times and watermarks. This avoids scanning the multi-gigabyte payload
heap for every health request.

The five-minute operations monitor uses partial working-set indexes and `LIMIT 1` freshness probes.
Retention keeps compact price observations for two days, successfully processed or rolled-back
inbox metadata for three days, buy-only entry-candidate swaps for three days, non-latest wallet
scores for seven days, admitted wallet evidence for 95 days and rejected/excluded wallet evidence
for three days. Canonical insertion atomically stores the immutable payload SHA-256 and queue
metadata in `chain_event_inbox` plus the complete JSON in a daily
`chain_event_payloads` partition. Processed payloads keep 48 hours. Before an old daily partition is
dropped, any unresolved payload is copied to `chain_event_payload_holds`; pending, retrying and
dead-letter work is therefore preserved while the high-volume partition files return to the
filesystem. `price_observations` uses the same daily-drop model with a compact bounded idempotency
key table. Maintenance is advisory-lock protected, bounded by row batches and a 30-second runtime,
and must retain capacity above measured ingress.

`MAINTENANCE_DRY_RUN=true` is the safe shadow/deployment default. Keep it enabled while verifying the
eligible row counts, deletion query plans, database backup and shared-host headroom. Set it to
`false` only after an explicit retention approval; then run one bounded maintenance cycle, verify
the remaining row ages and Robinhoodscaner health, and only afterward enable the recurring service.
The canary must never delete historical production rows merely to improve its storage metrics.

The maintenance and health loops invoke Node/tsx directly with a 32 MB heap instead of using an npm
wrapper. This avoids a second long-lived Node process and keeps their 64 MB container ceilings useful
on the shared host. Raise neither heap nor container limits to mask an unbounded query or batch.

### Fixed-disk shared-host profile

DigitalOcean disk expansion is unavailable for the current host. On 2026-07-15 the user explicitly
approved the existing retention horizons and the observe-only stack was activated after a fresh
custom-format PostgreSQL dump was verified both on-host and off-host by SHA-256 and
`pg_restore --list`. The active profile keeps only `postgres`, `redis`, `solana-ingestion`,
`evidence-sampler`, `wallet-alpha`, `data-maintenance`, `operations-monitor`, `postgres-backup`,
`telegram-notifier` and the explicitly authorized low-resource `paper-alert` running. API, web and
legacy research stay stopped.

Before the durable-writer fix, repeated price payloads arrived at roughly 16,000 rows per hour.
After deployment, `evidence-sampler` was the sole writer and the live monitor reported 168 rows per
hour (216/hour in a later five-minute window). A 32 MB-heap recurring cycle deleted 60,000 old
observations plus 10,000 processed inbox rows in 30 seconds. A separate one-batch canary deleted
5,000 price rows, 5,000 processed inbox rows and 5,000 transient swaps, leaving each bounded stage
above measured ingress. Within the shared 30-second row budget, expired three-day `swaps` run before
processed inbox metadata. Both can remain continuously eligible, and placing inbox first caused
swap retention to be starved by more than three hours. Do not reverse this order without a measured
round-robin replacement. On 2026-07-16, removing only stopped stateless
Walletscaner API/web images plus an older offsite-verified server dump moved host disk from 89% used
with 7.5 GB free to 82.65% used with about 12 GB free. These are live containment measurements, not a
long-term acceptance result. The seven-day shadow must still record hourly relation/filesystem
growth, retention lag, WAL/backup headroom, autovacuum progress and co-tenant health.

The 30-second setting bounds mutation scheduling rather than the entire process wall clock. The
maintenance PostgreSQL connection allows at most 15 seconds for the initial read-only
eligibility inventory and then lowers itself to a five-second mutation timeout. A timed-out pruning
stage increments `queryTimeoutCount`, leaves earlier committed batches intact and lets the run emit
its normal health record. The JavaScript deadline remains the total-budget guard; the database
timeout prevents one statement that started before that deadline from running for minutes after it.

The durable price write path belongs only to `evidence-sampler` and uses 120-second compact pool
buckets. It runs through direct Node/tsx; the 2026-07-28 restart canary measured about 45.8 MiB
instead of 78.3 MiB with the previous npm wrapper. `solana-ingestion` retains the faster in-process
decision cadence without appending market
snapshots; it stores compact current pool state and embeds explicit market-proxy provenance only in
evidence that was actually affected. This separates real-time decisions from durable research
history and prevents launch volume from multiplying storage. Unchanged pool market state is written
at most every 300 seconds; the first sample, an eligibility transition and a rug bypass that
interval, so signal qualification and terminal-risk handling remain immediate.

On this one-CPU host, wallet-alpha runs Node/tsx directly and sets
`PGOPTIONS=-c max_parallel_workers_per_gather=0` only for its own database sessions. It leases one
wallet at a time and defaults to 10,000 trade, 2,000 entry and 4,000 outcome rows per wallet plus a
240-second cycle deadline. Crossing a row ceiling quarantines only that wallet for a long retry.
Before those full reads, the production worker probes at most six trade rows and three entry rows.
If both thresholds are unmet, it completes only the current queue revision without materializing a
ledger or score; canonical evidence remains and a later write requeues the wallet. Keep this probe
after the indexed one-wallet claim. A correlated evidence predicate inside the ordered claim query
caused a 56+ second production disk scan under backup I/O and is prohibited.
The generated gate processes 99 normal wallets behind one 10,001-trade pathological wallet in
under 0.5 seconds at about 123.5 MiB RSS under the 112 MiB heap/160 MiB container boundaries. This
does not replace a shared-host canary. The final shared-host bounded-probe cycle completed 26 queue
revisions in 245.3 seconds under concurrent backup I/O: 12 scored, 14 low-evidence skips, no failures
and 96.27 MiB RSS. Do not raise the heap or PostgreSQL CPU quota as a substitute.

Wallet outcome persistence is lifecycle-driven rather than poll-driven. The first provisional row
is durable, repeated provisional calculations are no-ops, and the row is written again only when it
advances to `unresolved` or `mature`. Mature rows stay immutable. This prevents the two-minute
sampler from churning outcome indexes and wallet-alpha queue revisions while preserving the final
chronological evidence.

`chain_event_inbox` remains the durable-before-side-effects boundary. Migration
`018_chain_event_payload_compaction.sql` adds metadata-only hash/time columns, and
`019_chain_event_payload_compaction_index.sql` builds the partial index concurrently in its own
non-transactional migration. The index uses `payload_compacted_at`, so construction does not detoast
the large payload heap. Migration `020_chain_event_prehashed_compaction_index.sql` selects only
insertion-time hashes, so steady-state maintenance does not recalculate a multi-kilobyte JSON hash.
After 48 hours, maintenance preserves that SHA-256 and compaction time in the metadata and a small
JSON audit envelope; after three days, processed/rolled-back rows leave the hot store. Transitional
legacy rows without a hash age out rather than causing a perpetual rehash backlog. The full payload
remains recoverable from the verified daily/offsite backup; unresolved work is never compacted.

Migration `021_swaps_retention_index.sql` makes global buy-bridge retention proportional to the
three-day working set. Migrations 022-023 concurrently remove two legacy B-tree indexes that had
zero production scans: the chain-first wallet-trade index duplicated the active
strategy/wallet/time path, and the swap trader/time index was superseded by the first-entry
wallet/token path. Migration 024 removes only the hot-table foreign key after an entry has copied
the source id and flow evidence, allowing old bridge rows to age out while retaining the archival
reference. Do not re-add these structures without a measured query plan and write-amplification
budget.

Migrations 025-032 replace the transitional same-table compaction design with the steady-state
fixed-disk layout. Migration 025 adds daily payload partitions plus a small unresolved hold table;
026 moves partition-head ordering off JSON; 027 rebuilds the two-day price store as daily
partitions and drops its legacy bloated indexes; 028 performs the one-time stopped-stack
truncate/reload of only unresolved and three-day inbox metadata, releasing the legacy TOAST files
without `VACUUM FULL`; 029-032 add oldest-first wallet-evidence retention indexes. Migrations 027 and
028 are intentionally destructive transitions and require a current verified off-host backup,
restore-list verification, stopped Walletscaner writers and rollback headroom.

The ingestion worker closes disk admission at 90% used or below 4 GiB free. It stops discovery,
trade and parser writes, but leaves PostgreSQL and bounded maintenance available. Admission resumes
only below 85% used and above the minimum-free-space floor. This hysteresis is an emergency safety
boundary, not a substitute for healthy partition retirement. Cursor-backed gap repair and backlog
closure must be verified after every resume.

For this host, `OPERATIONS_MAX_DATABASE_BYTES=12884901888` (12 GiB), disk warning is 85% and disk
critical is 92%. Do not raise these thresholds merely to clear an alarm. Normal `DELETE` and vacuum
make table space reusable by PostgreSQL but do not promise filesystem shrinkage; never use
`VACUUM FULL` on the shared host without a verified backup, space proof, rollback plan and explicit
approval. Keep only the newest verified server dump once older generations are verified off-host.

Docker image retention is project-scoped. After a verified deployment, run
`scripts/deploy/prune-walletscaner-images.sh` first in its default report-only mode and then with
`APPLY=true`, an explicit `KEEP_RELEASE_TAG` and one `KEEP_ROLLBACK_TAG`. It removes tags only from
the exact `walletscaner-worker` repository and protects every image referenced by any container.
Never substitute `docker system prune`, `docker image prune` or `docker builder prune`: image and
BuildKit accounting is host-wide and can include protected Robinhoodscaner layers.

The worker emits `solana-ingestion-health` JSON logs every minute. In the recommended hybrid,
healthy output has `tradeIngestMode: "rpc"`, `trade.status: "ok"`,
`tradeTransport.websocketProvider: "mainnet.helius-rpc.com"`, a bounded active subscription
count, and steadily increasing WebSocket message counters while eligible pools are active.
`tradeTransport.estimatedHeliusWsCreditsPerHour` is an operational estimate from received bytes,
not the provider invoice; reconcile it with the Helius dashboard. There must be no unresolved
gaps or sustained reconnect growth. These provider diagnostics are not yet merged into
`/api/pipeline/health`.

Useful DB inspection:

```sql
SELECT status, count(*)
FROM chain_event_inbox
GROUP BY status
ORDER BY status;

SELECT idempotency_key, slot, event_type, attempt_count, last_error, received_at
FROM chain_event_inbox
WHERE status = 'dead_letter'
ORDER BY received_at DESC
LIMIT 50;

SELECT destination, status, count(*)
FROM signal_outbox
GROUP BY destination, status
ORDER BY destination, status;

SELECT pipeline, partition_key, last_contiguous_slot, status, updated_at
FROM pipeline_watermarks
ORDER BY updated_at DESC;
```

## Webhook operation

`POST /api/webhooks/helius` performs auth verification, normalization, dedupe and inbox insertion, then returns `200` with accepted/duplicate/rejected counts. It does not run the parser in the HTTP request.

Operational requirements:

- expose it only over HTTPS;
- configure the exact shared auth header in Helius and `HELIUS_WEBHOOK_AUTH_HEADER`;
- create the webhook once, copy its ID into `HELIUS_WEBHOOK_ID`, then let the worker synchronize active pool addresses;
- keep `HELIUS_WEBHOOK_SYNC_INTERVAL_MINUTES=15` unless the credit budget justifies more frequent management updates;
- alert on non-2xx responses and sustained webhook duplicates;
- measure handler p95/p99; the code path is short, but the “under one second” SLA must be verified against the deployed DB.

Do not use `transaction-subscribe` mode on the free Helius plan. The provider rejects it with
JSON-RPC code `-32600`. Enhanced Webhooks remain supported, but charging per delivered event plus
management updates makes them a poor fit for a frequently changing pool set.

The recommended free-plan path is therefore `HELIUS_INGEST_MODE=rpc`: public RPC/WebSocket for
broad program discovery, DexScreener batched market sampling, Helius standard WebSocket only for
the newest market-eligible pools, public HTTP transaction fetch/gap repair, and Helius HTTP/DAS
only as a filtered token-risk fallback. If Helius standard WebSocket is disabled, the worker falls
back to `SOLANA_WS_URL`; this is cheaper but must be treated as degraded when live notifications
do not match HTTP backfill.

## Retry and recovery

- Inbox and outbox claims use leases. A crashed worker's expired `processing` row is claimable again.
- Canonical claims expose only one oldest unresolved row per partition. Different partition heads
  may run concurrently, but a retrying, leased or dead-letter head still blocks later events from
  that same partition.
- Parser failures become `retry` until the maximum attempt count, then `dead_letter`; the original payload remains intact.
- Paper and alert destinations retry independently. A delivered destination is not repeated when the other destination fails.
- Backfill stops at an unresolved older signature rather than saving a cursor beyond it.

Do not bulk-reset dead letters without first fixing or versioning the decoder. Replaying unchanged poison payloads only hides parser coverage defects. After a decoder change, replay a bounded set, compare resulting table/score hashes, then expand.

## Paper worker behavior

`qualified-pool-paper-v1` is an immutable negative-control cohort. The selectable
`qualified-pool-paper-v2` starts a separate future-only $100 portfolio; it never rewrites, resets or
inherits v1 cash/PnL. Set `PAPER_STRATEGY_VERSION` to exactly one reviewed version before recreating
`paper-alert`. Both versions consider only qualified-pool notifications delivered after their own
durable activation timestamps. V1:

- waits 120 seconds and rechecks the exact notified pool rather than selecting another,
  higher-liquidity pair for the token;
- rechecks the latest token-risk assessment at entry time and fails closed if it became unknown or
  warning-bearing after the notification;
- fails closed when entry liquidity is unknown, below $15,000, or has lost more than 20% versus the
  notification; it also requires at least $5,000 five-minute volume and bounded buy/sell activity;
- limits each entry to $12, 0.06% of pool liquidity, available cash and a $36 aggregate exposure
  ceiling; at most three positions may be open;
- models 30 bps fees and liquidity/deterioration-sensitive slippage;
- exits fully at -22%, liquidity deterioration, momentum decay or 120 minutes;
- sells 60% after +75% to recover approximately the original stake, sells half the remainder after
  +200%, and trails the runner 28% below its observed peak;
- distinguishes a provider error or absent liquidity field from explicit zero liquidity. An exact
  pool must be absent in three successful provider responses before the remaining position is
  terminalized as unsellable; no imaginary stop fill is credited after a rug.

V2 waits five minutes, requires a fresh zero-risk/warning-free assessment, at least $30,000 retained
liquidity, $10,000 five-minute volume, 40 transactions, 58% buy share and a volume/liquidity ratio no
higher than 1.5. It caps exposure at two $8 positions/$16 total, uses more adverse slippage, exits at
-15% or material liquidity deterioration, sells 80% at +30%, takes a second partial at +75%, trails
18% and closes by 45 minutes. These thresholds are predeclared; judge v2 only on its future cohort.

`paper_trade_events` is the append-only cash/PnL audit log. `paper_trades` holds the current
materialized position, and `paper_portfolios` freezes the activation timestamp, starting balance and
strategy config. The paper worker never consumes the `alert` destination and never contacts Telegram
directly; it enqueues `paper-trade` messages for `telegram-notifier`.

DEX Screener remains a paper approximation, not proof that an on-chain order at the modeled price
would have filled. The strategy is an initial hypothesis and must be judged only after the 14-day
chronological paper gate, including rug exposure, liquidity failures, drawdown and profit factor.

## Rollout sequence

1. Capture a production snapshot: current chain slot, table counts, inbox backlog, last evidence timestamps, process memory and provider rate-limit/credit state.
2. Run old and v2 decoders in shadow for seven days with paper execution absent. The separately
   authorized Telegram notifier may deliver persisted wallet-alpha signals plus gated qualified-pool
   and status research notices; it must not change scoring or execution behavior.
3. Verify supported mainnet fixture parse coverage is at least 99%, signer/vault classification and duplicate/out-of-order replay invariants.
4. Verify ingest lag p95 `< 3s`, p99 `< 10s`; all known reconnect gaps close within five minutes; backlog has no positive long-run slope; memory is bounded.
5. Promote the canonical writer only after the previous gates pass.
6. Run at least 14 days paper-only. Confirm candidate wallets have at least 90% high-quality execution coverage.
7. Enable wallet-alpha signal messages only for legitimate persisted `paper-watch`/`paper-candidate`
   rows. Separately authorized qualified-pool discovery messages must be labeled as research notices,
   pass liquidity/volume/risk gates and remain distinct from signals. Keep live execution disabled.

If webhook lag/gap/throughput thresholds fail on two consecutive days, a paid transaction stream or LaserStream becomes the next infrastructure evaluation; neither is a current dependency.

## Acceptance queries and evidence

Retain, per rollout:

- command/test output and exact Git revision;
- recorded mainnet fixture list and decoder version;
- daily lag/backlog/dead-letter/price-coverage summaries;
- reconnect chaos replay result;
- duplicate replay table and score hashes;
- seven-day memory series;
- paper fill/rejection/exit counts;
- alert idempotency and latency sample.

Passing unit tests is necessary but not sufficient. No “production ready” decision should be made without the live evidence above.

## Shared-host canary boundary

On the current shared host, `walletscaner` is the only Compose project in scope. Never run global
Docker cleanup/restart commands and never target the protected co-tenant project. A canary must:

1. record co-tenant container health, restart counts, CPU and memory before Walletscaner starts;
2. start only PostgreSQL and the one-shot migration first, then verify the migration and backup;
3. start ingestion with alpha/sampler disabled, observe resource/lag state, then add one bounded
   alpha batch and the sampler independently;
4. abort and stop only the `walletscaner` Compose project if the co-tenant restarts, becomes
   unhealthy, or shows sustained CPU/latency regression;
5. keep live execution false and leave alert credentials disabled throughout shadow testing.

The server Compose file uses profiles to keep accidental aggregate resource demand below the host
boundary. A profile-free `up` includes only PostgreSQL, Redis, migration and Solana ingestion. UI
services require `--profile ui`; alpha/evidence research requires `--profile research`; paper alerting
requires `--profile paper`; maintenance, monitoring and scheduled backups require
`--profile operations`. During the first canary, target each service by its exact name instead of
activating an entire profile. Enabling a profile is an operational decision, not a convenience flag.

## Backup and migration discipline

- Back up PostgreSQL before applying a new production migration.
- Keep PostgreSQL on the server or a same-region managed service; never point the live workers at
  a home workstation database and never copy the raw Docker volume between hosts.
- Pull custom-format dumps to an off-host directory with
  `scripts/backup/pull-verified-postgres-backup.ps1`. The script rate-limits SCP, requires the
  server SHA-256 sidecar and verifies the archive with PostgreSQL 16 `pg_restore --list`.
- `scripts/backup/run-offsite-backup.ps1` is the unattended wrapper. It always selects the newest
  server generation, uses resumable SFTP with bounded retries, atomically writes
  `~/WalletscanerBackups/_status/latest.json`, and acknowledges the remote copy only after local
  verification. A missing SSH connection or Docker daemon fails closed.
- Server backup retention is fail-safe by default: a dump is not eligible for deletion until a
  matching `.offsite-verified` marker exists and its acknowledged SHA-256 matches the server
  sidecar. Use `-AcknowledgeRemote` only after the local checksum/archive checks succeed. On the
  fixed-disk host, a completed generation awaiting that acknowledgement also blocks the next
  scheduled dump, so an unavailable off-host workstation degrades backup freshness instead of
  filling production storage. Once all generations are acknowledged, the newest server recovery
  point is retained and older verified server copies are removed before allocating the next dump.
  The job also requires free space at least equal to the newest dump plus
  `POSTGRES_BACKUP_MIN_FREE_BYTES` (2 GiB by default) before starting. New custom-format dumps must
  pass `pg_restore --list`; interrupted `.dump.tmp` files are cleaned only after six hours.
- Perform a full isolated PostgreSQL 16 restore at least weekly and before deleting the last server
  copy of any recovery generation. Record table counts, migration level and invalid-index count.
- Keep at least one recent server copy and two verified off-host generations. Off-host retention
  must never depend on the same disk or Docker daemon as production.
- Run `npm run db:migrate` as a one-shot job before workers/API.
- Never edit an applied migration: the runner checks SHA-256 and will reject drift.
- Reports and logs are operational views; restoring them without PostgreSQL does not restore the system.
