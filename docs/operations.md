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
- same-mint entries are grouped by exact pool after the shared token-batch fetch, and outcome state
  changes are written in `EVIDENCE_OUTCOME_WRITE_BATCH_SIZE` batches (default 200, hard maximum
  500). Heartbeats expose active/sample market counts, lifecycle candidates/saves, batch count,
  provider time, database read/write time and total cycle time;
- ingestion market sampling is capped at 120 fairly prioritized due pools per provider cycle and
  1,000 active pools in memory. Subscription-first, least-recently-sampled ordering preserves live
  candidates while deferred and eviction counts make saturation explicit;
- `HELIUS_INGEST_MODE=rpc` with `HELIUS_STANDARD_TRADE_WS_ENABLED=true` for the recommended
  free-plan hybrid: broad program discovery and HTTP gap repair remain on the configured Solana
  RPC, while only market-eligible pools use Helius standard `logsSubscribe`;
- `RPC_TRADE_MAX_ACTIVE_POOLS=3` is the general bounded ceiling and leaves free-plan headroom for
  token-risk fallback/DAS calls. The current one-vCPU shared-host production profile uses `1`:
  three slots measured 458 events/minute ingress versus 338/minute parser egress, while one slot
  passed a sustained R42 drain canary. Do not restore three without a new throughput canary.
  `SOLANA_TRADE_WS_URL` can explicitly override the trade WebSocket without changing discovery;
- `RPC_TRADE_MINIMUM_OBSERVATION_HOLD_SECONDS=300` prevents candidate churn. A market-qualified pool
  can fill an empty exact-pool lane before token-risk enrichment passes, but this never makes it
  alpha-eligible. At capacity, only the oldest non-alpha-protected observation that completed the
  hold may rotate; its coverage gap is committed before unsubscribe;
- public HTTP transaction visibility can lag the Helius log notification. Keep
  `RPC_TRADE_TRANSACTION_FETCH_MAX_ATTEMPTS=6`, retry from 1 second, and cap retry delay at
  8 seconds. Live resolution is additionally capped at 128 workers plus 2,000 queued signatures.
  Health logs expose request, retry, recovery, final-unresolved, active, queued and dropped counts;
- `RPC_TRADE_MAX_QUEUE_DELAY_MS=15000` is a trade-only latency circuit breaker. Because exact-pool
  cursor admission remains ordered per address, a hot pool can exceed the shared host's sustainable
  request/parser rate before reaching the depth high-water mark. The first admitted head older than
  this bound invokes the same durable coverage-release path as depth pressure, keeps that head
  admitted, purges only the released address's queued work and marks the partial interval
  incomplete. It does not increase concurrency, provider credits or turn incomplete evidence into
  alpha coverage;
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
`MIN_VOLUME_5M_USD` and known/passed token-risk evidence. `strict-flow-v2-20260817` additionally
requires five-minute maturity, at least 20 five-minute transactions, 50%-below-60% buy share,
volume/liquidity below 0.50, top-10 holder concentration below 20%, zero/warning-free risk and
complete trade coverage. Every feature is frozen in the outbox payload. The default recent-pool
window is 30 minutes with a five-minute first-start lookback. Never print the bot token or copy it into source,
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
hard wall-clock limit. The long-lived process listens for commit-bound PostgreSQL wake hints and
falls back to a 30-second poll while backlog exists or a 300-second poll while idle. Listener
failure degrades to polling with bounded reconnect backoff; the PostgreSQL queue remains durable.

`research:wallet-alpha-managed-shadow` is different: it is a bounded, read-only model-selection
report. Its default is 25 wallets with a hard ceiling of 100; it does not claim/complete queue work,
write managed scores, save signals or enqueue Telegram messages. Evidence is loaded in five-wallet
batches by default (hard ceiling ten) and followability excludes entries without a proven source-buy
to observation delay of at most 60 seconds. Use
`WALLET_ALPHA_MANAGED_SHADOW_BATCH_SIZE` and
`WALLET_ALPHA_MANAGED_SHADOW_MAX_ENTRY_DELAY_SECONDS` only for bounded one-shot research. Do not add
it to the production Compose loop until the query plan, runtime/RSS and protected co-tenant impact
are measured and the user explicitly authorizes a shadow rollout.

The 2026-08-16 production one-shot is the current resource baseline. The original all-at-once
25-wallet query reported 176.56 MiB process RSS and violated the intended 160 MiB boundary. The
five-wallet-batch replacement retained 5,204 of 5,771 entries under the 60-second timing gate,
completed at 139.01 MiB RSS, persisted nothing and produced no qualified wallet. Keep it one-shot:
the query is still I/O-heavy and is not a recurring service.

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
key table. Maintenance is advisory-lock protected, uses 250-row raw-payload compaction batches and
a 45-second runtime ceiling, and must retain capacity above measured ingress. The smaller
compaction batch was selected from the populated host after 500-row tail latency intermittently
crossed the 7.5-second statement boundary and zeroed an otherwise healthy cycle; CPU and memory
container ceilings remain unchanged.

Partition maintenance checks `pg_inherits` before issuing DDL, so an already-attached daily
partition is a catalog read rather than a repeated parent-table lock. If a payload partition is
genuinely missing, the transaction takes the `chain_event_inbox` lock before the payload-parent
lock, matching canonical admission order, and uses
`MAINTENANCE_PARTITION_LOCK_TIMEOUT_MS` (1.5 seconds by default). A missing current-day partition is
critical and fails the run; a future partition that cannot be created within the short lock budget
is deferred. An orphan relation with the expected child name is never attached implicitly.

Canonical claim is a single-statement idempotent lease operation. PostgreSQL deadlock,
serialization, lock-timeout and transient-shutdown SQLSTATEs are retried with bounded exponential
backoff and jitter; the statement either commits the lease or advances no row/cursor state. The
worker exposes retry count, last SQLSTATE and next-retry timing in health telemetry. Exhausting the
bounded claim retry keeps ingestion alive and fail-closed instead of converting a transient
database arbitration failure into a provider reconnect/restart loop.

`MAINTENANCE_DRY_RUN=true` is the safe shadow/deployment default. Keep it enabled while verifying the
eligible row counts, deletion query plans, database backup and shared-host headroom. Set it to
`false` only after an explicit retention approval; then run one bounded maintenance cycle, verify
the remaining row ages and Robinhoodscaner health, and only afterward enable the recurring service.
The canary must never delete historical production rows merely to improve its storage metrics.
For a one-shot Compose canary, pass the override after `run`; a shell prefix does not override a
same-named value loaded by the service's `env_file`:

```bash
docker compose -p walletscaner -f docker-compose.server.yml --env-file .env.server \
  --profile operations run --rm --no-deps \
  -e MAINTENANCE_DRY_RUN=true -e ARCHIVE_RETIREMENT_ENABLED=false \
  data-maintenance node --import tsx scripts/maintenance/prune-operational-data.ts
```

The 2026-08-14 rollout exposed this precedence rule: the first attempted dry run executed one
already-approved normal retention cycle, removing 86,570 expired three-day hot `swaps`, 5,000
expired rejected entries and 11 expired price partitions. It removed zero durable wallet trades
and zero raw payload partitions; migration 034 blocked all 11 eligible payload partitions. The
correct `run -e` form then produced a zero-mutation dry run. Preserve this evidence and do not use a
shell prefix as a canary override.

The maintenance and health loops invoke Node/tsx directly with a 32 MB heap instead of using an npm
wrapper. This avoids a second long-lived Node process and keeps their 64 MB container ceilings useful
on the shared host. Raise neither heap nor container limits to mask an unbounded query or batch.

Migrations 036 and 037 keep the two JSON-heavy rejection/score paths bounded without raising those
limits. Rejected entries use an exact partial retention index; each 500-entry batch is selected and
locked, its dependent outcomes are deleted, and the same entries are deleted in one transaction, so
a timeout rolls back the whole batch. Superseded score identity is recorded atomically in the narrow
`wallet_alpha_score_supersessions` table only when a changed score is actually inserted. Seven-day
maintenance reads that queue by `calculated_at` and deletes the full score primary key; the foreign
key cascades queue cleanup. The independent 95-day hard score horizon remains a separate indexed
stage. Do not restore the cross-row `EXISTS newer` scan over `wallet_alpha_scores`: most old rows are
the only/latest score for a wallet, so that shape is not bounded by the requested delete batch.

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
above measured ingress. Those July canaries used the original 30-second profile. Within the current
shared 45-second row budget, expired three-day `swaps` still run before processed inbox metadata.
Both can remain continuously eligible, and placing inbox first caused swap retention to be starved
by more than three hours. Do not reverse this order without a measured round-robin replacement. On
2026-07-16, removing only stopped stateless
Walletscaner API/web images plus an older offsite-verified server dump moved host disk from 89% used
with 7.5 GB free to 82.65% used with about 12 GB free. These are live containment measurements, not a
long-term acceptance result. The seven-day shadow must still record hourly relation/filesystem
growth, retention lag, WAL/backup headroom, autovacuum progress and co-tenant health.

The 45-second setting bounds mutation scheduling rather than the entire process wall clock. The
maintenance PostgreSQL connection allows at most 15 seconds for the initial read-only
eligibility inventory and then lowers itself to a five-second mutation timeout. A timed-out pruning
stage increments both `queryTimeoutCount` and its named `queryTimeoutsByStage` bucket, leaves earlier
committed batches intact and lets the run emit its normal health record. The JavaScript deadline
remains the total-budget guard; the database timeout prevents one statement that started before that
deadline from running for minutes after it. Payload compaction selects one independently verified
UTC archive day at a time and carries `received_at` through every batch. Payload and hold rows are
then matched by `(received_at, event_idempotency_key)`, allowing PostgreSQL to runtime-prune all
unrelated daily partitions instead of probing every partition for every inbox row. The same exact
archive segment must retain the configured Object Lock reserve before either compaction or inbox
retirement can proceed.

When the oldest verified, retention-eligible raw payload exceeds the configured boundary by more
than `MAINTENANCE_COMPACTION_PRIORITY_LAG_SECONDS` (one hour by default), maintenance reserves the
majority of its bounded run for payload compaction and skips the competing processed-inbox metadata
stage for that cycle. Metadata retirement resumes automatically after compaction returns inside the
one-hour envelope. Every cycle atomically replaces
`reports/operational-maintenance-latest.json`; the report records inventory, per-stage counts,
timeouts and duration without becoming canonical state. Acceptance is based on boundary lag and
rows/hour exceeding measured ingress, not on one successful batch.

Compaction walks every uncompacted, retention-expired row covered by a verified archive, including a
backlog row already older than the three-day inbox-metadata horizon. The three-day boundary controls
metadata retirement, not whether its recoverable raw payload may first be compacted. Otherwise the
monitor can correctly see an old raw row that the compactor has made permanently ineligible. The
payload stage has its own bounded `MAINTENANCE_COMPACTION_STATEMENT_TIMEOUT_MS` (7.5 seconds by
default) and may use up to 92% of the 45-second run only while work remains; other stages resume in
the same run when compaction finishes early. Do not increase its CPU/container ceilings to clear a
backlog.

The durable price write path belongs only to `evidence-sampler` and uses 120-second compact pool
buckets. It runs through direct Node/tsx; the 2026-07-28 restart canary measured about 45.8 MiB
instead of 78.3 MiB with the previous npm wrapper. `solana-ingestion` retains the faster in-process
decision cadence without appending market
snapshots; it stores compact current pool state and embeds explicit market-proxy provenance only in
evidence that was actually affected. This separates real-time decisions from durable research
history and prevents launch volume from multiplying storage. Unchanged pool market state is written
at most every 300 seconds; the first sample, an eligibility transition and a rug bypass that
interval, so signal qualification and terminal-risk handling remain immediate.

`solana-ingestion` also invokes Node/tsx directly. The 2026-08-20 production canary removed the
long-lived npm and standalone `tsx` wrapper processes: container memory was 78.26 MiB immediately
before recreation, 55.58 MiB on the first healthy RPC heartbeat and 62.91 MiB after caches had grown
for nine minutes, while the existing 160 MiB burst ceiling and 15% CPU quota stayed unchanged. This
initial-window reduction still requires the normal 24-hour peak comparison; it is a process-tree
optimization, not permission to raise subscription or fetch concurrency.

On this one-CPU host, wallet-alpha runs Node/tsx directly and sets
`PGOPTIONS=-c max_parallel_workers_per_gather=0` only for its own database sessions. It leases one
wallet at a time and defaults to 10,000 trade, 2,000 entry and 4,000 outcome rows per wallet plus a
240-second cycle deadline. Crossing a row ceiling quarantines only that wallet for a long retry.
Before materializing or sorting any one-wallet history, three separate five-second index-bounded
upper-limit probes check whether trades, entries or outcomes exceed their configured ceilings. A
normal relation cannot consume the other two relations' statement budget, and any timeout reports
its exact stage. An
`evidence_limit` failure is persisted as an explicit quarantine class. Migration 047 preserves the
future `not_before` quarantine when new score-changing or signal-lane evidence revises the same
coalesced row, so a hot pathological wallet cannot cancel its own delay or be retried twice in one
cycle. Successful completion clears the quarantine; unrelated transient failures remain visible as
ordinary failed work.
Before those full reads, the production worker peeks at no more than 100 unlocked queue revisions
without leasing them and runs one five-second-timeout admission prefetch. Each wallet's two lateral
index probes stop after at most six trade rows and three entry rows. The cached result is keyed by
the exact queue revision; if evidence advances the revision before the one-wallet claim, the worker
ignores the stale result and falls back to fresh one-wallet probes. If both thresholds are unmet, it
completes only the claimed revision without materializing a ledger or score; canonical evidence
remains and a later write requeues the wallet. The ordered claim SQL itself remains evidence-free.
A correlated evidence predicate inside that claim query caused a 56+ second production disk scan
under backup I/O and is prohibited.
Migrations 043 and 048 add three scheduling lanes without adding another process or duplicating
queue rows. Priority 2 is restricted to a controlled-flow, critical-risk-passed entry whose latest
persisted wallet status is `watch`, `candidate` or `validated-paper`. Risk-passed entries from
unqualified wallets, sells, outcomes and other score-changing entries are priority 1;
background/historical changes are priority 0. Claims order by priority and then retry/age. An
elevated commit wakes the worker; background bursts are intentionally coalesced until the fallback
poll. The service still has one wallet in flight, a 112 MiB Node heap, a 160 MiB container ceiling
and a 10% CPU ceiling. Operational acceptance requires `listener=listening`, bounded lane-specific
oldest age, no growing failed count, and measured signal-lane enqueue-to-refresh latency; total
pending alone is not an incident if the signal lane remains current and background drains.

Cgroup evidence on the populated host showed wallet alpha throttled in 8,202 of 11,967 periods and
PostgreSQL in 1,139,787 of 1,617,147 periods while the host remained about 71% idle. A restart-free
quota canary raised only PostgreSQL from 18% to 21% and wallet alpha from 7% to 10%. Across its first
two complete cycles, a comparable light cycle fell from 201.5 to 132.5 seconds and a heavy cycle
completed 54 rather than 46 wallets inside the same 245-second ceiling; pending work moved 8,531 to
8,495 despite concurrent ingress. These are hard ceilings rather than reservations, low CPU shares
are unchanged, and aggregate Walletscaner limits remain below one CPU. Revert both values if a later
one-hour queue slope is not negative.
Telegram status combines pipeline freshness with the bounded operations report. It includes
signal/score/background lane counts, oldest ready and signal-ready ages, non-quarantine failures,
quarantined wallets, disk free space and raw-payload compaction lag. A missing/stale operational
report, signal-lane age above five minutes, ready-work age above one hour, non-quarantine failure,
database warning or existing discovery/inbox fault keeps the aggregate state `DEGRADED`. This is a
truthful research/operations status; it never changes alpha admission or live-execution state.
The generated gate processes 99 normal wallets behind one 10,001-trade pathological wallet in
under 0.5 seconds at about 123.5 MiB RSS under the 112 MiB heap/160 MiB container boundaries. This
does not replace a shared-host canary. The final shared-host bounded-probe cycle completed 26 queue
revisions in 245.3 seconds under concurrent backup I/O: 12 scored, 14 low-evidence skips, no failures
and 96.27 MiB RSS. Do not raise the heap or either accepted CPU ceiling without a new measured
throttling and co-tenant-safe canary.

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

The monitor also retains at most one filesystem/database sample per hour for 30 days in
`reports/operational-storage-history.jsonl`. After 24 hours it reports a conservative linear runway
above `OPERATIONS_STORAGE_RESERVE_BYTES` (8 GiB on this host) and degrades below
`OPERATIONS_MIN_STORAGE_RUNWAY_DAYS` (14 days). An immature trend is reported as unknown, never as
infinite runway. The reserve is intervention/backup headroom; it does not replace the ingestion
circuit breaker or authorize deleting evidence. See [storage_lifecycle.md](storage_lifecycle.md)
for the measured 95-day capacity gap and compact hot/cold target.

Whole raw-payload partitions use `CHAIN_EVENT_RAW_PAYLOAD_RETENTION_HOURS` directly. Inbox metadata
continues to use `CHAIN_EVENT_RETENTION_DAYS`; coupling these two horizons previously retained one
extra UTC day of full payload data despite the configured 48-hour contract.

Migration 035 adds a concurrent partial `received_at` index for archive-gated inbox retirement.
Maintenance selects the oldest exact verified/Object-Locked archive day with eligible metadata,
then performs a parameterized index walk in 500-row batches. Do not collapse the verified days into
one `MIN(range_start)`/`MAX(range_end)` window: on the populated host that plan bitmap-scanned and
sorted the broad range, while the exact-day `LATERAL` plan located 500 rows in 906 ms under the
five-second statement ceiling. Pre-archive metadata is deliberately skipped.

Migration 050 adds the `wallet-evidence-daily-v1` archive source. The writer waits at least
`ARCHIVE_WALLET_EVIDENCE_SETTLE_HOURS` (72 hours by default), counts trade/entry/outcome rows
independently, streams one bounded zstd artifact, and stores exact per-type counts. The verifier
must read the object back and validate Object Lock, SHA-256, byte count, line envelopes and all
three type counts. Historical wallet catch-up never preempts a pending chain-payload segment.
`archive_segment_generations` is append-only manifest history; do not delete generations or B2
revisions. A verified wallet segment starts compact-shadow eligibility but does not enable source
retirement.

Migration 051 and `wallet-evidence-materializer-scheduler` implement that compact shadow. The
scheduler waits ten minutes after startup, then processes at most one verified day every thirty
minutes with one database connection, no gather parallelism, an 80 MiB memory cap and 5% CPU cap.
Every run is transaction- and advisory-lock-protected. It must finish source/fact count and dual
digest parity before recording a verified day; mismatch/retry receipts and their oldest age are
reported by operational health. Do not start a second manual materializer while the scheduler is
active, and do not treat compact verification alone as source-retirement authority.

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
`tradeObservation.status` is `degraded` when a coverage-capable market candidate exists but the
lane is empty, or when configured addresses have not all received subscription acknowledgements.
An empty lane is `ok` only when no coverage-capable market candidate is currently tracked.
`tradeTransport.estimatedHeliusWsCreditsPerHour` is an operational estimate from received bytes,
not the provider invoice; reconcile it with the Helius dashboard. There must be no unresolved
gaps or sustained reconnect growth. These provider diagnostics are not yet merged into
`/api/pipeline/health`.

`poolDiscoveryCoverage` begins at each ingestion process start and reports unique accepted discovery
events only; duplicate inbox deliveries are not counted. Track `decodedEventRatio` and
`unmatchedEventCount` per program, plus `innerInstructionPoolCount`. A release that adds or changes a
decoder must use these counters together with retained canonical/B2 payloads and reviewed mainnet
fixtures; a rising unmatched count is a parser-coverage incident, not evidence that no pool exists.

For filtered standard-RPC discovery, compare `prefilteredWebsocketMessageCount` and
`prefilteredWebsocketMessageBytes` with total WebSocket counts. These are avoided JSON
parse/allocation volumes, not avoided provider traffic. A zero prefilter count is expected for a
source containing any unfiltered address; it is unexpected for the configured launch-program-only
discovery source after traffic begins.

`getSignaturesForAddress` cannot apply the WebSocket log predicate. The source therefore reapplies
the exact configured instruction-log filter after every fetched transaction, including initial and
reconnect backfill. It parses Solana `Program ... invoke`, `success` and `failed` nesting and accepts
an exact instruction log only while the configured target program is the active top frame and only
after that target frame completes successfully. This keeps inner CPI discovery while rejecting
same-name instructions emitted by another program in the same transaction. A missing, failed or
malformed target completion fails closed; a later unrelated truncated suffix cannot invalidate an
already completed target proof. `postfetchFilteredTransactionCount`
is resolved but intentionally irrelevant traffic: it advances the source cursor but is not emitted,
persisted or included in `poolDiscoveryCoverage`. Only an emitted transaction whose configured
program instruction then fails all reviewed discriminators increments `unmatchedEventCount`.

Every Walletscaner service uses Compose-scoped `json-file` rotation capped at three 10 MiB files.
The option becomes active only after that exact Walletscaner container is recreated. It does not
change the Docker daemon or the protected co-tenant's logging policy.

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
- Wallet-alpha migration 049 preserves a future transient retry boundary when new evidence
  coalesces into the same revision-safe queue row. New evidence still increments `revision`, but it
  cannot reset a failing hot wallet to immediately claimable and starve its priority lane.
- Canonical claims expose only one oldest unresolved row per partition. Different partition heads
  may run concurrently, but a retrying, leased or dead-letter head still blocks later events from
  that same partition.
- Parser failures become `retry` until the maximum attempt count, then `dead_letter`; the original payload remains intact.
- Paper and alert destinations retry independently. A delivered destination is not repeated when the other destination fails.
- Backfill stops at an unresolved older signature rather than saving a cursor beyond it.

### Ordered RPC trade throughput

Standard-RPC trade admission is ordered independently per pool address. This prevents a later
signature from advancing a pool cursor across an unresolved predecessor, but it also means a fixed
delay is paid serially for every event on a hot pool. The reviewed shared-host profile therefore
uses:

- `SOLANA_TRANSACTION_FETCH_DELAY_MS=0`; confirmed WebSocket notifications are fetched immediately;
- the unchanged six-attempt exponential visibility retry as the owner of null/error recovery;
- `RPC_TRADE_INITIAL_BACKFILL_LIMIT=500`; a cursorless first page containing exactly 500 signatures
  is ambiguous and emits nothing until a later bounded attempt can prove a below-limit boundary;
- `RPC_TRADE_BACKFILL_PAGE_LIMIT=500` and `RPC_TRADE_MAX_BACKFILL_PAGES=4`, matching the existing
  2,000-signature queue ceiling for a bounded reconnect recovery window;
- at most three active pools in the general profile, but one in the accepted fixed shared-host
  profile; one ordered worker per active address, 0.20 ingestion CPU and the existing 160 MiB
  memory ceiling;
- a 15-second maximum live queue-delay guard in the fixed shared-host profile. Depth alone is not a
  sufficient saturation signal: the 29-August production incident reached roughly 114 seconds of
  queue delay before the 80%/2,000-item high-water guard released the pool. The delay guard exits an
  unsustainable observation earlier and leaves the lane available for a pool whose raw notification
  rate fits the fixed budget;
- a five-minute minimum observation hold. Rotation never treats the resulting partial interval as
  complete wallet-profitability evidence; the exact pool remains fail-closed after its durable gap.

Do not compensate for per-address delay by raising CPU, heap or configured fetch concurrency. Judge
the live path by queue depth and fresh queue delay, not the process-lifetime maximum. A safe profile
change waits for queue/workers/subscriptions to reach zero, applies only the hash-locked env keys,
recreates only ingestion, and restarts the canary clock. If a nonzero queue must be abandoned after
a crash, recovery is valid only for pools that `restoreRecentPools` actually resubscribes; a larger
page budget alone cannot recover an unsubscribed pool.

### Discovery coverage incidents

Discovery health is supervised independently for each configured launch program. The normal
two-minute activity-probe cooldown is set by
`SOLANA_DISCOVERY_ACTIVITY_PROBE_COOLDOWN_SECONDS=120`; do not shorten it to improve discovery
latency because it is a breach diagnostic, not the discovery feed. A valid quiet probe can explain
WebSocket silence. JSON-RPC error payloads, malformed results, a newer head slot or a different
latest signature in the same slot cannot.

If one public provider acknowledges all per-program subscriptions but delivers only a subset,
split the exact affected programs onto a second standard-RPC endpoint instead of suppressing the
incident or increasing the silence threshold. Configure both
`SOLANA_DISCOVERY_WS_SECONDARY_URL` and a non-empty
`SOLANA_DISCOVERY_WS_SECONDARY_PROGRAMS_JSON`. Verify the resulting hostname-only
`discoveryTransport.routes`, one ACK and fresh notifications per active program, zero timeout/drop
counters, and an independent activity probe that is not ahead. Changing this route requires an
ingestion-only recreate; durable gap-repair sessions resume and remain alpha-excluded until their
normal proof gate completes.

Initial/reconnect admission uses a reviewed 100-signature page and five-page ceiling (500 signatures total).
The health heartbeat exposes this as `discoveryBackfill`. Do not raise transaction concurrency,
queue capacity, CPU or heap to hide a truncation. A different profile requires a measured
per-program signature-rate window, must remain at or below the hard 2,000-signature ceiling and must
still prove cursor-boundary reachability before any event is admitted as recovered.

The incident repair path is separate: it stages at most 500 signatures per cycle, resumes its
`before_signature` from PostgreSQL after restart, and caps the public instruction-filtered session
at `SOLANA_DISCOVERY_GAP_REPAIR_MAX_SIGNATURES=500`. Public
`getSignaturesForAddress` cannot reapply the live log predicate, so a larger default accumulates
mostly irrelevant program traffic and cannot meet the five-minute shared-host recovery budget. It
replays at most
`SOLANA_DISCOVERY_GAP_REPAIR_REPLAY_LIMIT=50` oldest signatures per cycle with a 30-second default
cooldown. A persisted collecting or replaying repair already above the active cap fails immediately
on resume. This bounds RPC, CPU, RAM and database write pressure; an exact boundary inside the cap
may converge, while a larger interval is retained as alpha-excluded. An unresolved transaction
leaves the incident open for bounded retry.

A signature-cap breach is terminal for that bounded repair, not permission to raise the cap until
the database fills. After two independently fresh current-transport samples, the supervisor closes
only the transport state as `transport_recovered_gap_unreconciled`, preserves the failed repair and
keeps the entire incident interval alpha-excluded. Telegram emits one recovery transition for that
state change. Any future restart uses the newer durable live cursor; a genuinely new gap opens a new
incident rather than reusing or relabelling the failed history.

Treat these conditions as fail-closed coverage incidents:

- source startup failure;
- backfill page-budget truncation;
- activity ahead while the WebSocket is silent/stale or behind;
- subscription acknowledgement timeout, including one followed by a late acknowledgement;
- any increase in live discovery queue-pressure or dropped-signature counters; the durable row uses
  reason `combined` for schema compatibility and records `coverageTrigger=live_queue_pressure`
  plus the exact counters in metadata;
- a combined breach that cannot be proven quiet.

`solana-ingestion-health.discoveryCoverageSupervisor.sources` exposes per-program lifecycle,
probe, restart, ACK, heartbeat, truncation, repair progress, last-signature and fresh-WebSocket
evidence. Cumulative counters are monotonic across a supervised source restart. Transport recovery
alone must say the gap is still unreconciled. A `coverage-reconciled` transition is permitted only
after durable boundary reach, complete oldest-first replay, exact completion at the immutable staged
target, an independent history-aware RPC result showing that target at the exact slot is
`finalized`, and post-incident WebSocket evidence. A finalized failed transaction remains a valid
ordering boundary because complete replay has already classified it as producing no discovery
event; record its success flag in proof metadata instead of leaving the incident open forever. Do
not compare the repair target with the moving latest program head or live cursor; both may advance
normally during a long repair.

If `telegram-notifier` was stopped while incidents opened and recovered repeatedly, restart must
not replay the whole historical transition stream. The notifier selects only the latest durable
open-or-recovered state for each program before checking outbox idempotency. This bounds a restart to
at most one current coverage summary per configured program; subsequent live transitions still
produce their own durable message when they become that program's newest state. A restart producing
more than the configured-program count, or producing the same latest source key twice, fails the
notification canary and `paper-alert` must remain stopped.

Queue pressure and backfill truncation are evidence-loss boundaries, not transport-restart health
checks. They open an incident immediately without cycling the source. Standard-source durable repair
may later reconcile the interval; until its explicit proof commits, the interval remains
alpha-excluded. Repair-cap or unavailable-cursor failures are not normalized as degradation.

Useful incident inspection:

```sql
SELECT idempotency_key, provider, program_address, reason,
       gap_started_at, opened_at, closed_at, resolution,
       coverage_reconciled_at, coverage_repair_id,
       restart_attempt_count, last_restart_error
FROM ingestion_coverage_incidents
ORDER BY opened_at DESC
LIMIT 50;

SELECT repair_id, incident_id, program_address, status, boundary_reached,
       fetched_signature_count, completed_signature_count, last_error, updated_at
FROM ingestion_gap_repairs
ORDER BY created_at DESC
LIMIT 50;

SELECT status, count(*)
FROM telegram_notification_outbox
WHERE event_type = 'qualified-pool'
GROUP BY status
ORDER BY status;
```

An open incident, or a pool whose canonical creation time is inside a closed unreconciled interval,
must block strict Telegram and paper admission. `suppressed` is an expected terminal audit state,
not notifier backlog. Do not reset suppressed rows to pending. Do not edit or delete incident rows.

The advisory lock serializes a paper open with incidents already known or committing at that moment;
it cannot predict a later diagnostic whose conservative gap starts before that fill. Query and
exclude those retroactively coverage-tainted paper entries from performance analysis; do not rewrite
the append-only trade event or call it a fill-quality result.

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

V3 (`qualified-pool-paper-v3-strict-flow`) starts another independent $100 portfolio and accepts
only the versioned strict-flow payload after its own activation. It repeats exact-pool admission two
minutes after notification, caps exposure at two $6 positions/$12 total, requires 90% retained
liquidity, uses 250/400 bps base entry/exit slippage plus 30 bps fees, and closes more quickly around
liquidity, -15%, momentum, staged +20%/+50% profit and 30-minute time boundaries. V1/v2 remain
immutable. V3 is an experiment, not proof of executable alpha.

`paper_trade_events` is the append-only cash/PnL audit log. `paper_trades` holds the current
materialized position, and `paper_portfolios` freezes the activation timestamp, starting balance and
strategy config. The paper worker never consumes the `alert` destination and never contacts Telegram
directly; it enqueues `paper-trade` messages for `telegram-notifier`.

DEX Screener remains a paper approximation, not proof that an on-chain order at the modeled price
would have filled. The strategy is an initial hypothesis and must be judged only after the 14-day
chronological paper gate, including rug exposure, liquidity failures, drawdown and profit factor.

## Interruption-safe release discipline

Every multi-stage production change keeps a durable ledger under `reports/` with phase status,
timestamps, exact input SHA/image ID, verification evidence, rollback identity and one next safe
command. On resume, reread actual local/server state before that command; never infer completion from
the ledger. Long file transfers use a `.partial` artifact plus resumable SFTP. Database and image
mutations start only after the newest custom-format dump has matching local/server bytes and SHA-256,
independent PostgreSQL 16 `pg_restore --list` success and a read-back offsite acknowledgement.

Use `scripts/deploy/release-checkpoint.py` for the machine-readable part of that ledger. It performs
optimistic revision checks, validates phase transitions, rejects secret-shaped evidence keys and
writes by fsync plus atomic rename. Dry-run is the default. Write `planned`/`in_progress` before a
mutation and `completed`/`failed` immediately after its independent verification. If a session ends
between them, leave the phase unresolved and reconcile it against actual migration checksums,
artifact hashes and container IDs before retrying. Keep the human reasoning and exact next action in
`docs/agent/work-in-progress.md` as well.

For the migration-038 discovery-coverage release:

1. Pass `npm ci`, repository typecheck, ESLint, the complete PostgreSQL 16 plus zstd test suite and
   every production build off host.
2. Build one immutable worker image off host. Record its image ID, exported tar byte count and
   SHA-256. Upload to a server `.partial`, resume rather than restart, verify SHA, atomically rename,
   then `docker load`. Upload `scripts/deploy/update-release-image-env.py` as a separate `.partial`
   companion, verify its recorded SHA-256 and atomically rename it into the server project. Loading
   an image does not update host-side deployment scripts. Do not build on the shared host.
3. Snapshot every Walletscaner container plus the protected co-tenant identities, disk/memory,
   migration level, restart/OOM counts and `ENABLE_LIVE_EXECUTION=false` immediately before change.
   Parse rendered Compose before every recreate and verify the exact image, CPU, memory and selected
   non-secret environment controls. A runtime `docker update` does not repair the Compose source of
   truth; correct and hash-verify both before acceptance.
4. Stop only `telegram-notifier` and `paper-alert` while the additive migration is applied. Their
   durable outboxes preserve work. Run migration through the exact new ingestion image, never the
   generic local-image migration service:

   ```bash
   WALLETSCANER_INGEST_IMAGE=walletscaner-worker:<immutable-r5-tag> \
     docker compose -p walletscaner -f docker-compose.server.yml --env-file .env.server \
     run --rm --no-deps solana-ingestion npm run db:migrate
   ```

5. Verify migration 038's recorded checksum, cursor column, incident table/constraints/trigger and
   zero invalid indexes. Execute cursor repair through the exact R5 image; the explicit Compose
   `run -e` override is mandatory because `env_file` precedence makes a shell-prefix runtime flag
   unreliable:

   ```bash
   WALLETSCANER_INGEST_IMAGE=walletscaner-worker:<immutable-r5-tag> \
     docker compose -p walletscaner -f docker-compose.server.yml --env-file .env.server \
     run --rm --no-deps -e CURSOR_CHAIN_TIME_APPLY=false solana-ingestion \
     npm run maintenance:backfill-discovery-cursor-time

   WALLETSCANER_INGEST_IMAGE=walletscaner-worker:<immutable-r5-tag> \
     docker compose -p walletscaner -f docker-compose.server.yml --env-file .env.server \
     run --rm --no-deps -e CURSOR_CHAIN_TIME_APPLY=true solana-ingestion \
     npm run maintenance:backfill-discovery-cursor-time
   ```

   It must report every configured program cursor and zero unresolved chain times. Immediately before
   the R5 ingestion recreate, briefly stop only old ingestion, repeat the explicit `-e ...=true`
   command and then the explicit false verification so the cursor cannot move under the old writer,
   and start R5 without unrelated work. A missing cursor, implausible RPC block time or remaining
   NULL blocks startup. Any known historical gap is inserted separately with an idempotent one-shot;
   it is evidence data and must not be hidden in an append-only schema migration.

6. Change only `WALLETSCANER_INGEST_IMAGE` and `WALLETSCANER_SIGNAL_IMAGE`, using an atomic temporary
   file/rename updater. Run the hash-verified host companion without `--apply` first, then repeat the
   exact expected/set arguments with `--apply`; a stale expected value must abort rather than be
   bypassed. Recreate only `telegram-notifier`, `paper-alert`, then `solana-ingestion`, always with
   `--no-build --no-deps`. Verify the actual container image ID after each step.
7. Run a 15-minute bounded canary: fresh per-program WebSocket evidence; decoded/emitted coverage;
   no queue drops, pressure exclusion, parser failure, retry/dead-letter growth, restart or OOM;
   incident transitions and suppression behavior; CPU/RSS/PostgreSQL pressure; disk runway; exact
   target service image IDs; unchanged co-tenant identities; live execution still false.
   Start the 15-minute clock from the last container recreate or runtime/config correction, whichever
   is later. A safely excluded open incident is `degraded-safe`, not a green four-program canary.

Migration 038 is additive and is not rolled back by restoring the database. If R5 ingestion fails,
return only ingestion to its exact R3 image while retaining R5 signal guards or stopping both signal
services. Once an incident exists, older notifier/paper code is fail-open and must not be restarted.
Before any incident exists, signal rollback must preserve the asymmetric prior images (Telegram R2,
paper R1); a single shared signal-tag rollback would incorrectly change paper. Do not use the broad
deployment script, Compose `down`, a host build, a global prune, or any volume operation for this
release.

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
  server generation, uses resumable SFTP with ten bounded attempts, atomically writes
  `~/WalletscanerBackups/_status/latest.json`, and acknowledges the remote copy only after local
  verification. After acknowledgement it invokes the server-side, report-first reconciliation
  script, which validates every dump/sidecar/marker tuple and retains the newest server generation
  before removing an older one. The wrapper invokes that reviewed script through `sh`; it does not
  depend on a POSIX executable bit surviving a Windows-to-Linux artifact copy. SSH defaults to port
  22 and can still be overridden explicitly. A missing SSH connection, unreadable script,
  validation mismatch or Docker daemon fails closed. The Windows task runs hidden at 22:00
  Europe/Istanbul.
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
  The recurring PostgreSQL 16 scheduler uses custom format with `--compress=zstd:1`,
  `--no-owner` and `--no-acl`. Do not restore the former gzip level-6 profile: on the populated
  constrained host it kept a full dump active for more than 100 minutes and competed with canonical
  ingestion, alpha probes and retention I/O.
  Scheduled cycles measure the 24-hour interval from cycle start, so multi-hour dump generation no
  longer moves the next start later every day.
- Perform a full isolated PostgreSQL 16 restore at least weekly and before deleting the last server
  copy of any recovery generation. Record table counts, migration level and invalid-index count.
- Restore current custom-format dumps serially. Do not add `pg_restore --jobs`/`-j`: after migration
  033, a parallel data restore can load `chain_event_payloads` before `archive_segments` is visible
  to the archive-invalidation trigger. The 2026-08-14 production clone reproduced that failure,
  while a serial PostgreSQL 16 restore of the exact same bytes completed successfully. A future
  parallel runbook must explicitly stage pre-data, data and post-data/trigger installation and pass
  a populated restore gate before it may replace the serial default.
- Keep at least one recent server copy and two verified off-host generations. Off-host retention
  must never depend on the same disk or Docker daemon as production.
- Run `npm run db:migrate` as a one-shot job before workers/API.
- Never edit an applied migration: the runner checks SHA-256 and will reject drift.
- Reports and logs are operational views; restoring them without PostgreSQL does not restore the system.

### S3-compatible cold-archive validation

The cold archive is implemented behind the opt-in `archive` Compose profile.
`ARCHIVE_ENABLED=false` and `ARCHIVE_DRY_RUN=true` remain safe defaults. The transport is an
isolated provider subpath, so normal ingestion/research processes neither load the AWS SDK nor pay
its memory cost. Writer and verifier are separate one-shot services, each limited to a 48 MB Node
heap, 128 MB container memory, 4% CPU and one segment per run.
Before export the writer reserves the configured minimum free space and hard-stops the compressed
stream before the artifact can consume that reserve; the verifier requires the reserve plus the
entire expected object size before downloading.

Migration 033 adds the idempotent daily `archive_segments` state machine and append-only
`archive_attempts`. Migration 034 adds the durable, fail-closed future-canary retirement policy.
A source insert invalidates an in-flight revision; an insert into an already
verified UTC day fails closed. The writer streams the partition in primary-key order through
single-thread zstd-3, records exact restored-source and compressed-object hashes, and uploads with
Content-MD5. It disables PostgreSQL gather parallelism on only its own session so the planner cannot
create a large external merge sort. The verifier uses an independent read key, checks metadata,
downloads the complete object, validates every JSONL envelope, and recomputes row count, byte count
and SHA-256. `api-verified` mode additionally calls S3 `GetObjectRetention`; the explicitly weaker
`attested-default-policy` mode does not claim that API evidence. A PUT, ETag, HEAD or zstd frame test
alone is never deletion authority.

Writer and verifier remain available as one-shot jobs in profile `archive`. Profile
`archive-scheduled` runs the same bounded writer hourly and verifier after a five-minute initial
delay and every fifteen minutes; failures wait fifteen minutes rather than spin. The scheduler does
not change either archive safety flag and must remain stopped while `ARCHIVE_ENABLED=false`. Each
invocation claims at most one segment and has a 7,200-second scheduling budget; the interval begins
only after that invocation exits, so a large day cannot create overlapping archive workers.
Daily discovery excludes already-manifested partitions before applying its bounded seed limit; this
prevents the first manifest window from starving every later UTC day after long uptimes.

`record-type-counts` metadata is serialized with sorted keys. Verification may normalize only this
field as a bounded map of non-negative safe integers; content length, archive/source SHA-256, every
other metadata value, Object Lock evidence and the complete streamed restore remain exact. This
avoids treating PostgreSQL JSONB key reordering as corruption without weakening object integrity.
Terminal failed discovery-repair signature rows use their creation time for the same bounded
retention applied to completed repair staging. The failed repair summary and coverage exclusion are
retained; only its no-longer-replayable staging rows age out.

Wallet compact materialization never skips an unresolved older verified archive day. PostgreSQL
timeouts and other operational failures enter the `retry` state with a bounded backoff; only exact
source-count or field-digest disagreement enters `mismatch`. The health report and Telegram summary
show retry and parity-mismatch counts separately. Production defaults retain one day/one connection,
80 MiB and 5% CPU while permitting a 600-second statement and 1,800-second admitted-day budget for
the measured large historical cohorts.

Activate real transport without changing retirement authority by running the atomic updater with
`--activate --execute --preserve-credentials`; `--execute` is rejected without `--activate`, and the
transport-only invocation leaves `ARCHIVE_RETIREMENT_ENABLED=false`. This allows new closed UTC-day objects to
accumulate and be independently restored in B2 while PostgreSQL source partitions remain intact.
Transport activation is not partition-deletion authority.

After the database future-only approval function succeeds, persist the separate runtime gate only
with `--enable-retirement --retirement-approval
approve-future-only-chain-payload-retirement` in addition to the three transport flags above. The
updater rejects that switch unless transport is active and non-dry-run. This switch does not replace
the database policy or per-segment manifest/Object Lock check; all of them must pass on every run.

Maintenance can compact inbox rows or retire a raw-payload partition only while the matching
manifest is `verified`, its observed retention is still in the future, the database policy has been
approved from a non-empty verified day wholly after migration-034 activation, and the maintenance
process has `ARCHIVE_RETIREMENT_ENABLED=true`. The approval one-shot additionally requires the exact
`ARCHIVE_RETIREMENT_APPROVAL=approve-future-only-chain-payload-retirement` phrase and receives no B2
credential. Partition retirement and copying unresolved payloads into
`chain_event_payload_holds` occur in one transaction. Missing, expired or unreadable Object Lock
evidence, less than the configured seven-day remaining lock reserve, a historical-only canary, or
either disabled retirement gate blocks deletion.

The 2026-08-13 P0-P7 validation established the following without starting either Compose project:

- The newest 2026-08-02 custom-format dump matched its sidecar SHA-256 and restored completely into
  an isolated PostgreSQL 16 container with no network or host port. All migrations 001-032 matched
  repository checksums, all indexes were valid and all constraints were validated. The restored
  database occupied 9.72 GB versus the stopped production volume's 13.79 GB, showing roughly 4 GB
  of physical layout/bloat overhead; this is evidence for future partition retirement, not
  permission to run `VACUUM FULL` or replace production storage.
- A deterministic 12,652-event raw envelope sample occupied 228,816,311 bytes. Single-threaded zstd
  level 3 produced 15,036,496 bytes in 0.58 seconds (93.429% reduction), passed the frame test and
  decompressed to the exact original SHA-256. Level 6 saved only another 1.44 MB while taking about
  3.8 times as long, so level 3 is the low-resource default unless a longer representative shadow
  disproves it.
- Backblaze Object Lock was enabled. A new object could be uploaded only with Content-MD5, which is
  the expected Object Lock upload contract. A private object under
  `walletscanner-prod/integration-tests/` passed writer PUT and independent-reader HEAD/GET;
  cross-role and outside-prefix operations were denied. Evidence objects were intentionally retained.
- The real 15,036,496-byte sample was uploaded under `walletscanner-prod/validation/`, independently
  downloaded, zstd-tested and restored to 12,652 rows, 228,816,311 bytes and the exact source
  SHA-256. The object remains in B2.
- The final migration 033 applied to the populated 9.718 GB PostgreSQL 16 restore in 447 ms and added
  163,840 bytes. It produced no invalid index or unvalidated constraint. The archive query over the
  busiest 94,394-row day originally wrote about 1.8 GB of temporary sort data; the final forced
  index-stream plan wrote no temp data and completed in 89.9 seconds on the isolated local restore.
- PostgreSQL integration tests prove source-revision invalidation, post-verification late-write
  rejection, full export/restore equality, missing-manifest deletion blocking, and transactionally
  safe retirement after a verified lock receipt.

The subsequent stopped-stack production gate on 2026-08-13 established:

- a fresh 1,477,469,735-byte custom-format dump passed on-host and independent off-host SHA-256 plus
  PostgreSQL 16 archive-list verification before migration;
- migration 033 applied once with zero invalid indexes and the writer dry run produced no manifest
  or B2 writes;
- an empty-day transport canary and the real 2026-08-01 segment both passed independent full
  restore. The real segment matched 85,039 source/canonical rows and 1,726,640,952 restored bytes,
  compressed to 121,728,534 bytes, and recorded exact 64-character source/archive SHA-256 values;
- the real writer stayed near 65 MiB RSS at its 4% CPU quota. The verifier completed in 771.3
  seconds below 90 MiB observed RSS under the same quota, with no restart or OOM;
- the 85,039-row/721,960,960-byte source partition remained present, staging returned empty, no
  payload was retired, and the archive config was returned to disabled/dry-run before PostgreSQL
  was stopped. Robinhoodscaner container identities and states did not change.

The standard Backblaze key profiles are fixed. Capability inspection on 2026-08-13 confirmed both
keys are restricted to the `walletscaner` bucket and `walletscanner-prod/` prefix. The reader has
read/list capabilities only. The writer also has `deleteFiles` and bucket-management capabilities,
but no application code imports or sends B2 delete, lifecycle, bucket-setting or governance-bypass
commands; only its one-shot process receives that credential. The user explicitly accepted this
residual least-privilege risk.

Neither standard key has `readFileRetentions`, so S3 `GetObjectRetention` cannot be used. Production
therefore selects the explicit `attested-default-policy` evidence mode for the user-configured
30-day Governance bucket default. The independent reader still HEADs, downloads, hashes and fully
restores every object. PostgreSQL records `object_lock_evidence=attested-default-policy` and derives
the expected retain-until time from the durable successful-upload timestamp; it never labels this as
API-verified retention. This is weaker than `api-verified` and relies on the bucket default remaining
Governance/30 days. Do not reduce or remove that default. Do not add lifecycle deletion rules or
delete B2 archive objects. The historical production transport/restore canary passed, but it is not
the required future-only cohort. Source deletion remains disabled until a separately authorized
ingestion restart creates and validates a post-activation daily segment.

The 2026-08-13 live size inventory established that the PostgreSQL volume is 13.79 GB, while all raw
daily payload partitions account for about 2.25 GB. The larger relations are processed wallet
evidence used by the 30/90-day scorer and must not be treated as disposable raw history. Archiving
verified raw partitions will release their files directly; row retention on processed tables
controls future growth but does not immediately shrink their files. Converting that evidence to
archive-backed time partitions is a separate populated-schema migration and must not be attempted
as an emergency delete or `VACUUM FULL` on this host.

On 2026-08-14 the bounded one-shot jobs completed the existing settled backlog. Twelve daily
segments are verified with zero pending, retry or dead-letter state. The three non-empty days total
267,381 source/canonical rows and 5,384,805,390 restored bytes; zstd-3 reduced them to 389,157,080
bytes. Empty days use 13-byte valid frames. The 2026-08-02 segment was the largest at 170,716 rows,
3,441,253,726 restored bytes and 253,062,180 archive bytes. Writer/verifier remained within their
128 MB/4% CPU limits. All PostgreSQL source partitions remained present after this transport and
restore pass.

Later on 2026-08-14, the user separately authorized the normal observe-only profile restart and the
fastest backup-gated disk recovery. The exact 1,477,487,617-byte dump was uploaded to the private B2
bucket and independently downloaded in full; SHA-256
`8870b05fade98784e9280087b6392b159f3191ae240b2a5ee479beac5336bd9b`, PostgreSQL 16
`pg_restore --list`, and the attested Governance/30-day retention receipt all matched. Only after
that proof, an empty `swaps` table was truncated and the deterministic FIFO episode/lot cache was
reclaimed. The operation preserved 1,817,798 canonical wallet trades and 224,397 stored scores,
removed 508,852 derived episodes and 836,308 derived lots, and requeued 10,146 observed wallets for
bounded lazy rebuild. PostgreSQL fell from 13.534 GB to 11.537 GB. Removing one obsolete,
unreferenced Walletscaner image with the project-scoped prune script brought the host to about
84.85% used with about 11.0 GB free; no global Docker or BuildKit cleanup ran.

The data, ingestion, research, paper, notification and operations services then passed staged
startup. The scheduled archive writer/verifier profile is active with `ARCHIVE_ENABLED=true` and
`ARCHIVE_DRY_RUN=false`, while `ARCHIVE_RETIREMENT_ENABLED=false` and
`ENABLE_LIVE_EXECUTION=false` remain enforced. The writer successfully uploaded the next settled
empty day and the independent reader restored and verified it in 4.3 seconds, bringing the manifest
state to 13 verified with zero pending/retry/dead-letter rows. The
earliest retirement-policy canary is the non-empty UTC day beginning 2026-08-15; it cannot be
approved before that full day closes and settles. Until that future-only proof passes, all raw
payload source partitions remain present. `api`, `web` and legacy research stay stopped, and the
protected Robinhoodscaner container IDs/states remain unchanged.

On 2026-08-16 the non-empty 2026-08-15 UTC segment passed the future-only production gate. The
writer and independent reader matched 56,180 source/canonical rows, 1,207,394,029 restored bytes,
an 86,201,706-byte object and both SHA-256 values; the durable policy now identifies segment 55 and
is ready with a seven-day remaining-lock reserve. A dry run made no mutation. The explicitly
approved bounded run then retired 12 verified old raw-payload partitions with zero unresolved holds
and zero durable wallet-trade, entry, outcome or score deletion. After a new 1,871,502,891-byte dump
matched its off-host SHA-256 and PostgreSQL 16 archive-list checks, the older server dump was
removed. Exact Walletscaner-only image retirement then recovered the host from 92% used/about 5.9
GiB free to 84.42% used/about 10.54 GiB free, at which point the unchanged ingestion process
automatically resumed. `ARCHIVE_RETIREMENT_ENABLED=true` is now persisted only for maintenance;
the manifest, Object Lock reserve and database policy remain fail-closed per-partition gates.
`ENABLE_LIVE_EXECUTION=false` remains unchanged, and the protected co-tenant identities/states did
not move.
