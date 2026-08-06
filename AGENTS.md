# Walletscaner Agent Operating Contract

## Scope and precedence

This file governs the entire repository. Read it before inspecting, changing, testing, or
operating the project. Then use `skills.md` to select the task-specific playbook.

Apply instructions in this order:

1. The user's current request and explicit scope boundaries.
2. This file.
3. The task route in `skills.md`.
4. Architecture and operations documents.
5. Existing implementation and tests.

If two sources conflict, do not silently choose one. Verify current code and runtime state,
identify the conflict, and use the higher-precedence instruction. Never broaden a task from
diagnosis into implementation or from local development into production mutation without
authorization.

## Project contract

Walletscaner is a Solana evidence, wallet-intelligence, and paper-trading research system. It
discovers newly tradable tokens, derives verified wallet trades, materializes deterministic FIFO
ledgers, measures both wallet profitability and post-detection followability, applies token-risk
gates, and produces explainable research or paper signals.

The system is not:

- a live execution bot;
- a blind copy-trading bot;
- a price-momentum-only signal generator;
- an EVM indexer;
- a production writer based on the legacy `market-watch` or `live-alpha` file-state paths.

Keep `ENABLE_LIVE_EXECUTION=false`. Do not add private-key handling, transaction signing, or live
order execution unless the user creates a separately authorized phase with an explicit security
design and acceptance process.

## Current operational mode

On 2026-07-24 the user explicitly stopped every Walletscaner service because the shared-host disk
was nearly full. The bounded-storage upgrade passed its PostgreSQL 16 populated-upgrade,
repository-integration and partition-retirement gates; a current byte-identical off-host backup was
verified; and migrations 025-032 were applied to production on 2026-07-28. The stopped migration
reduced the database from about 18.9 GB to 10.55 GB and moved the host from 96% used/2.8 GB free to
85% used/11.2 GB free without `VACUUM FULL`. On 2026-07-28 the user explicitly authorized restart;
the intended profile below passed its staged data/ingestion/research/paper canary and is running.
The matching bounded-storage image, migration 032, off-host-acknowledged backup, disk gate and
`ENABLE_LIVE_EXECUTION=false` were verified immediately before startup. The protected
Robinhoodscaner state remained unchanged throughout.

On 2026-08-01 the latest completed server dump (`20260729T101629Z`, 1.494 GB) was copied off host,
matched byte-for-byte by SHA-256 and passed `pg_restore --list`; its off-host acknowledgement was
then written before the older verified server generation was retired. This recovered the host from
about 87% used/9.91 GB free to about 83% used/12.5 GB free. The alpha-v2 deployment and the next
bounded dump temporarily moved the host to 87% used/about 9.87 GB free. The new dump remains a
completed `20260801T120111Z` custom-format generation of 1.009 GB. It passed SHA-256 and
`pg_restore --list` both on-host and off-host, was acknowledged atomically, and replaced the Jul29
server recovery point only after those checks. The host then returned to 85% used/about 11.11 GB
free. Keep the Aug1 server generation and at least two verified local generations; the normal next
dump must still pass the newest-size-plus-2-GiB gate.

On 2026-07-15 the user explicitly cleared the operational hold and authorized the fixed-disk,
observe-only shared-host profile. The intended running Walletscaner services are:

- data: `postgres`, `redis`;
- ingest/research: `solana-ingestion`, `evidence-sampler`, `wallet-alpha`;
- operations: `data-maintenance`, `operations-monitor`, `postgres-backup`.
- notifications: `telegram-notifier`.
- paper: `paper-alert` running only `qualified-pool-paper-v2`; v1 is frozen as an immutable
  negative-control cohort.

Keep `api`, `web` and every legacy-research service stopped. Live execution remains disabled. The
user authorized Telegram research/status notifications and the isolated $100 qualified-pool paper
phase on 2026-07-16; this is not permission to trade real capital, activate every Compose profile,
consume private keys, or relax a risk gate.

`telegram-notifier` is the only approved Telegram API consumer in the active profile. It consumes
the `alert` signal destination plus durable qualified-pool, paper-trade and status outbox messages;
it never consumes the `paper` signal destination. New-token messages require the configured
liquidity and five-minute volume gates plus known/passed token-risk evidence. Do not replace this
with raw pool-created spam or expose Telegram credentials.

`paper-alert` is authorized only for `qualified-pool-paper-v2`: a separately activated future-only
$100 portfolio, at most two $8 positions/$16 aggregate exposure, five-minute exact-pool
confirmation, fresh zero-risk/warning-free admission and append-only paper events. V1 remains
unchanged with no open position at the v2 activation boundary. V2 must not consume the alert
destination, backfill notifications from before its own activation timestamp, pretend a post-rug
stop filled, inherit v1 cash/trades, or contact Telegram directly. Keep its direct Node/tsx command,
40 MB heap, 80 MB container ceiling and 2% CPU quota unless measured evidence justifies a smaller
bound.

The notifier was activated on 2026-07-16 after a fresh custom-format backup was SHA-256 and
`pg_restore --list` verified both on-host and off-host. Migrations 015-032 are applied and the pool
candidate index is valid/ready. Production uses a 30-second poll, one-message claim batches, a 40 MB
Node heap, an 80 MB container ceiling and a 2% CPU quota. The direct Node/tsx command is intentional:
adding an npm wrapper previously raised measured container memory from roughly 41 MB to 78 MB. The
first qualified-pool notification and startup status were delivered exactly once in the durable
outbox; wallet-alpha signal count was still zero at activation.

The fixed-disk policy is deployed and active. Canonical metadata and
its immutable payload SHA-256 remain in `chain_event_inbox`; full provider JSON is atomically stored
in daily `chain_event_payloads` partitions. Processed payloads retain 48 hours, rare unresolved old
payloads move to `chain_event_payload_holds`, and whole expired partitions are dropped so heap,
TOAST and index files return to the filesystem. `price_observations` uses daily partitions with a
two-day horizon and a compact global idempotency-key table. Processed or rolled-back inbox metadata
and buy-only first-entry bridge swaps retain three days; failed-risk/excluded wallet evidence
retains three days; admitted wallet trade/entry/outcome evidence retains 95 days; superseded
wallet-alpha scores retain seven days. Row-oriented pruning remains bounded to 5,000-row batches
and a 30-second mutation-scheduling budget. The three-day `swaps` horizon runs before processed
inbox-row pruning inside that shared budget; otherwise a continuously eligible inbox can starve
swap retirement. The
maintenance PostgreSQL pool allows at most 15 seconds for the initial read-only eligibility
inventory, then lowers the same single connection to a five-second server-side statement timeout for
mutations. Mutation SQLSTATE `57014` is a bounded stage stop; prior completed batches remain
committed and the run still emits its health summary. This is required because checking a JavaScript
deadline before a query does not stop an individual PostgreSQL statement from exceeding the
30-second run ceiling. The
durable buy/sell ledger remains `wallet_trade_events`; `swaps` is not a second permanent ledger.
Maintenance and monitoring run through direct Node/tsx commands with 32 MB heaps and 64 MB
container ceilings.
At least one verified server dump and two verified off-host generations must remain. An
unacknowledged generation blocks the next dump; after acknowledgement, old verified server copies
are removed before allocating a new dump, and newest-dump-size plus 2 GiB headroom is mandatory.
Do not disable retention, weaken offsite acknowledgement, run `VACUUM FULL`, or accumulate extra
server dumps without a capacity review.

On the 2026-07-28 restart canary, the evidence sampler's npm wrapper consumed about 78.3 MiB of its
80 MiB ceiling; direct Node/tsx reduced it to about 45.8 MiB. Wallet-alpha now has a dedicated
production worker separate from the on-demand report. It invokes Node/tsx directly, disables
PostgreSQL gather parallelism only on its own connections, leases one wallet at a time, processes at
most 100 work items or 240 seconds per run, and sleeps five minutes between runs. Reads hard-cap at
10,000 trades, 2,000 entries and 4,000 outcomes per wallet; an oversized wallet is isolated for a
24-hour retry while later wallets continue. Before a full ledger/score load, a two-stage bounded
admission probe reads at most six trades and three entries. A wallet below both thresholds has its
current revision completed without a score; its durable evidence remains and any later evidence
requeues it automatically. Never push these correlated checks into the ordered claim SQL: the
2026-08-01 canary proved that formulation can become a 56+ second disk scan. Keep two-way
persistence concurrency, 112 MB heap, 160 MB container ceiling and 7% CPU quota. Do not restore npm
wrappers, multi-wallet evidence loads, periodic full reports or per-query PostgreSQL parallelism
without new shared-host evidence.

Solana RPC transaction ingestion has an explicit 80% signature-queue pressure gate. Crossing it
removes the affected hot-pool subscription and durably marks its trade coverage incomplete; that
pool is excluded from wallet evidence rather than silently dropping signatures and claiming full
coverage. Health logs expose queue pressure, address count, high-water mark and coverage exclusions.
Do not turn a queue overflow into a best-effort drop path or re-admit an incomplete pool without a
separately verified repair.

On 2026-07-16 the canonical backlog hot path was replaced with a recursive partition-head
skip-scan, eight-row claims, four-way cross-partition processing and 90-second leases. Delayed swaps
now hydrate immutable pool context from PostgreSQL instead of depending on the two-hour sampling
map. Historical SOL/USD lookup reuses durable observations and bounded caches, serializes external
requests at a minimum 1.2-second interval and backs off on HTTP 429. The Pyth Benchmarks client uses
the single-timestamp endpoint; the interval endpoint returns an array and must not be parsed as one
price response. The r13 shared-host sample completed 1,314 canonical events with zero worker
failures, zero Pyth errors and zero rate limits while ingestion stayed below 100 MiB. This resolves
the immediate throughput/provider storm, but the seven-day shadow gate and bounded repair of older
explicit `lookup-failed` price evidence remain open acceptance work.

Never assume this note is the sole source of truth. Before an operational change, verify exact
container state, live-execution state, disk, memory/swap, database size, backup validity and both
Compose projects. Preserve the active profile unless the user's request requires a scoped change.

## Protected co-tenant: Robinhoodscaner

The production host is shared. `robinhoodscaner-intel` is outside this project's scope and must
not be changed, restarted, stopped, rebuilt, inspected for secrets, or otherwise disturbed.

Known boundaries:

| System          | Compose project         | Working directory           |
| --------------- | ----------------------- | --------------------------- |
| Walletscaner    | `walletscaner`          | `/opt/walletscaner`         |
| Robinhoodscaner | `robinhoodscaner-intel` | `/root/RobinhoodScaner_new` |

For every server operation:

- Target the exact Compose project, service, container, directory, and file.
- Capture Walletscaner and Robinhoodscaner container status before and after the operation.
- Prefer `docker compose -p walletscaner -f docker-compose.server.yml ...` from
  `/opt/walletscaner`.
- Use exact label filters such as `com.docker.compose.project=walletscaner` when enumerating
  containers.
- Treat host CPU, RAM, swap, disk, Docker daemon settings, networking, firewall, package updates,
  reboots, and provider quotas as shared resources.

Unless the user explicitly authorizes a host-wide action after seeing its impact, never:

- run an unscoped `docker compose down`, `docker stop`, or `docker restart`;
- run `docker system prune`, delete Docker volumes, or delete database directories;
- modify `/root/RobinhoodScaner_new` or a `robinhoodscaner-intel-*` container;
- change shared firewall rules, Docker daemon configuration, ports, swap, kernel settings, or host
  packages;
- reboot, resize, or migrate the shared host;
- use a wildcard or generated container list without first verifying every resolved target.

For obsolete Walletscaner worker images, use
`scripts/deploy/prune-walletscaner-images.sh` with explicit release/rollback tags. Its default is
report-only and it protects every container-referenced image ID. Do not replace it with a host-wide
image or BuildKit-cache prune.

`scripts/deploy.sh` is not a safe default deployment entrypoint. It performs remote setup,
`rsync --delete`, environment transfer, stack shutdown, and rebuild. Review it line by line and
obtain explicit deployment authority before using it. Treat old `market-watch` status commands as
legacy unless the task explicitly concerns offline research.

## Mandatory first pass

Before substantial work:

1. Read `README.md` and `.superstack/build-context.md`.
2. Read `docs/architecture.md`, `docs/operations.md`, and the task-specific documents routed by
   `skills.md`.
3. Inspect `git status --short --branch`; preserve unrelated user changes.
4. Locate applicable `AGENTS.md` files before editing nested paths.
5. Map the request to current source files, schema, tests, and runtime ownership.
6. Separate verified facts, hypotheses, and recommendations.
7. For server work, begin with read-only inventory and health checks.

Do not read or print `.env`, `.env.server`, private keys, tokens, webhook URLs, passwords, or full
container environments. Inspect variable names or explicitly selected non-secret operational
values only. Redact secrets from logs and reports.

## Source-of-truth map

- `README.md`: product boundary, supported venues, commands, public acceptance gates.
- `.superstack/build-context.md`: compact architecture handoff and current implementation state.
- `docs/architecture.md`: canonical event flow and service ownership.
- `docs/data_model.md`: persistence semantics and relationships.
- `docs/providers.md`: provider roles and constraints.
- `docs/wallet_intelligence.md`: wallet evidence and alpha definitions.
- `docs/scoring.md` and `docs/risk.md`: deterministic scoring and fail-closed risk policy.
- `docs/backtesting.md`: historical and paper validation rules.
- `docs/operations.md`: production configuration, monitoring, retention, backup, and rollout gates.
- `scripts/migrations/*.sql`: ordered database contract. Never rewrite an applied migration.
- `docker-compose.server.yml`: intended server service topology.
- `reports/`: generated evidence, never a substitute for canonical PostgreSQL state.

When architecture changes, update code, tests, relevant docs, and
`.superstack/build-context.md` together. Do not allow these sources to describe different systems.

## Architectural invariants

Preserve these unless the user explicitly authorizes an architecture change:

1. PostgreSQL is the production system of record. Redis is hot/cache/rate-limit state only.
2. Every chain event is durably and idempotently written to `chain_event_inbox` before parsing
   side effects.
3. Inbox and outbox work uses unique keys, leases, retries, attempts, and dead-letter states.
4. Store Solana `slot` and chain event time. Keep `occurred_at`, `received_at`, `processed_at`,
   and `finalized_at` semantically distinct.
5. Do not advance a partition cursor past an unresolved older event.
6. Exact token quantities use decimal-string raw amounts plus decimals. JavaScript `number` is for
   display compatibility, not accounting.
7. Execution prices require explicit provenance. DEX Screener is market context and outcome
   evidence, not canonical execution price.
8. Wallet identity must be a verified signer, fee payer, or venue authority. Pool, vault, program,
   and infrastructure addresses are not traders.
9. FIFO ledger output must be deterministic under duplicate delivery and input reordering.
10. Wallet profitability and bot-observed followability remain separate measurements.
11. Unknown or failed critical risk evidence blocks downstream paper signals.
12. Direct creators are excluded. Missing funder/cluster/insider coverage must be reported, not
    treated as passed.
13. Live execution remains disabled.

Raw provider payloads may be retained only alongside parsed canonical fields and an explicit cost,
retention, and reprocessing purpose. Do not create unbounded raw-JSON stores.

## Engineering workflow

### Diagnose

- Reproduce or observe the issue before editing.
- Follow data from source to durable record to transformation to consumer.
- Check logs, metrics, database state, and relevant code together.
- Find the root cause; do not stop at a cosmetic symptom.
- A healthy process or zero backlog is not proof of complete coverage or correct output.

### Plan

- State the desired outcome and measurable acceptance criteria.
- Identify data migrations, rollback strategy, provider cost, operational load, and co-tenant risk.
- Prefer the smallest coherent change that fixes the invariant violation.
- Distinguish immediate containment from the durable design.

### Implement

- Preserve module boundaries and existing user changes.
- Keep provider I/O behind adapters and business logic deterministic.
- Add idempotency and bounded retries to external or durable work.
- Use pagination, streaming, incremental materialization, or bounded batches for growing datasets.
- Never load an unbounded production table into memory.
- Avoid full-table rewrites in periodic jobs; process changed partitions or wallets.
- Make retention capacity greater than peak ingestion capacity.
- Add migrations for schema changes and make them safe to apply on populated tables.

### Verify

- Run targeted tests first, then the full required gate.
- Validate behavior, resource use, idempotency, and failure recovery—not only compilation.
- For data changes, compare counts, hashes, or deterministic outputs before and after replay.
- For provider changes, use fixtures plus bounded live/devnet checks when authorized.
- For operations, verify both Compose projects after the change.

### Handoff

Report:

- the outcome;
- files and behavior changed;
- tests and checks run, including skipped checks;
- migrations or operational actions;
- current server state;
- residual risks and the next hard gate.

Do not describe an implementation as production-ready when only unit tests have passed.

## Database and migration rules

- Add a new numbered migration; never modify an applied migration to change production state.
- Make writes idempotent and define the conflict key intentionally.
- Use `NUMERIC` or exact raw strings for token accounting.
- Design indexes from actual query predicates and ordering.
- Consider lock duration, table size, WAL, temporary disk, replication/backup impact, and rollback.
- Use concurrent index creation or a staged migration when a populated production table requires it.
- Test migrations against PostgreSQL 16 with representative volume before server execution.
- Do not run destructive DDL, mass deletes, `VACUUM FULL`, restore, or reindex operations on the
  shared production host without an external verified backup, disk-headroom proof, a rollback
  plan, and explicit approval.
- Deleting rows does not guarantee filesystem space is returned. Prefer time partitioning and
  partition retirement for high-volume time-series data.

## Performance and reliability rules

- Every recurring job needs bounded memory, bounded concurrency, timeout, retry/backoff, and
  progress/heartbeat reporting.
- Every queue or polling loop needs lag, throughput, error, retry, dead-letter, and staleness
  metrics.
- Every long-lived in-process `Map`/`Set` that grows from chain activity needs an explicit TTL or
  capacity, bounded cleanup cost and an exposed size/limit metric. Persisted idempotency remains the
  correctness boundary; process memory is only a bounded optimization.
- Measure rates and percentiles; a latest-value snapshot is not sufficient for an acceptance gate.
- Forecast disk exhaustion from growth rate and include backup/WAL headroom.
- Alert before a shared host reaches emergency thresholds.
- A crash loop must back off or trip a circuit breaker; it must not repeatedly rewrite large data.
- Raising a heap or container limit is not a substitute for incremental processing, especially on
  the shared host.

## Validation matrix

Use Node.js 22 or newer; CI currently uses Node.js 24. Keep `package-lock.json` authoritative.

For implementation changes, the default final gate is:

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build --workspaces --if-present
```

Database integration tests require a disposable PostgreSQL 16 instance and
`TEST_DATABASE_URL`. A green suite with the integration file skipped is not the full gate.

Additional requirements:

- Provider/parser change: fixture tests, duplicate replay, malformed input, reconnect/gap path.
- Ledger/scoring change: ordering and duplicate invariance, partial sells, reopened positions,
  holdout and risk-gate tests.
- Migration change: clean install plus upgrade from representative populated state.
- Worker/performance change: production-scale fixture or generated load with memory/runtime bounds.
- API change: typed contract, error path, pagination, and envelope tests.
- UI change: production build and empty/loading/error/large-data states.
- Operations change: pre/post inventory, health, persistent mounts, backup state, and co-tenant
  verification.

If a required check cannot run, say exactly why and do not silently downgrade the result.

## Production acceptance gates

Do not enable user-facing alerts or advance the research phase until relevant gates are proven:

- supported mainnet instruction parse coverage at least 99%;
- ingest lag p95 below 3 seconds and p99 below 10 seconds;
- reconnect gaps closed within 5 minutes;
- no growing backlog, dead-letter accumulation, or stale report;
- high-quality execution coverage at least 90% for candidate wallets;
- duplicate replay leaves ledger and score hashes unchanged;
- seven-day stable shadow run;
- at least fourteen days of paper-only evidence with chronological holdouts;
- finalized reconciliation/rollback behavior verified;
- alert latency and single-delivery guarantees verified;
- storage, backup, and retention proven sustainable at measured peak rates.

Passing a time gate requires mature data and successful measurements, not merely elapsed calendar
time.

## Known priorities that must not be hidden

Keep resolved incidents separate from open acceptance work:

- The production wallet-alpha process previously exhausted a roughly 970 MB Node heap because it
  loaded the full evidence history and rebuilt every ledger. The replacement revisioned dirty-wallet
  queue, one-wallet leases, capped evidence reads and bounded scorer pass PostgreSQL 16 tests. A
  generated 99-normal-plus-one-oversized workload completed under the 112 MB heap/160 MB container
  boundaries and proved that the oversized wallet does not block later work. Production ranking
  refresh now filters qualified rows before an indexed anti-join; its measured plan fell from a
  40+ second score-history scan to 1.426 ms. Periodic status-count history scans were removed from
  the worker and remain on-demand only. Under a concurrent bounded backup, the final two-stage
  admission canary completed 26 queue revisions in 245.3 seconds: 12 wallets scored, 14 low-evidence
  revisions completed without scoring, zero failures/oversized rows, 96.27 MiB process RSS, zero
  restarts and no OOM. Treat this as code-complete but not production-accepted until the seven-day
  shared-host shadow gate passes. Never regress to a full-history periodic job, a multi-wallet
  evidence load, a claim-time correlated evidence scan or a larger heap as a substitute.
- The previous price sampler stored repeated full provider payloads at a rate that dominated database
  growth. In production, ownership was reduced to `evidence-sampler`, lowering durable price ingress
  from roughly 16,000 rows/hour to 168 rows/hour; a bounded cycle deleted 50,000 old rows in 30
  seconds. Pool-state writes are five-minute/transition/rug gated and outcome writes are
  lifecycle-driven. Treat the writer amplification as resolved, but keep the seven-day
  relation/filesystem/WAL shadow open until autovacuum reuse and retention lag are stable.
- Canonical inbox growth previously depended on rehashing multi-kilobyte JSON after 48 hours, which
  could not catch live ingress. Insertion now computes the immutable JSONB hash once; migration 020
  selects only prehashed 48-72 hour work and three-day processed retention lets transitional legacy
  rows age out. The bounded production canary deleted 5,000 eligible processed rows and the planner
  used the new valid/ready partial index. Do not lengthen the hot horizon or reintroduce database-side
  payload hashing without a measured capacity proof.
- Live `swaps` previously duplicated both sides of every durable wallet trade even though its only
  production consumer materializes first-buy entries. It is now buy-only with a three-day indexed
  hot horizon; the full buy/sell FIFO evidence remains in `wallet_trade_events`. Entry rows copy the
  immutable source id and flow evidence, so the hot-row FK was removed and the id remains an archival
  reference after expiry. Two legacy indexes with zero production scans were removed concurrently.
  Do not extend swap retention or restore sell duplication merely for generic history; use the
  canonical inbox/backups or an explicit historical backfill workflow. On 2026-08-01 the monitor
  exposed about 3.2 hours of swap-retention lag because inbox pruning exhausted the shared deadline;
  the maintenance order now gives expired swaps the first row-oriented budget. A PostgreSQL 16
  smoke deleted ten expired rows in two five-row batches. Keep the production lag shadow open until
  it returns below one hour under concurrent backup/ingestion load.
- The standard RPC diagnostic `unresolvedTransactionCount` is cumulative and combines several failure
  classes. Use deltas plus backlog/coverage/freshness evidence for decisions until fetch-null,
  block-time and handler failures are exposed separately.
- Historical price acquisition is now bounded and the Pyth single-timestamp response is parsed
  correctly. Rows written before r13 with explicit `priceEvidence.rejected='lookup-failed'` remain
  truthful but incomplete. Repair them only through a bounded, idempotent enrichment design that
  preserves quote provenance and requeues affected wallet-alpha revisions; do not fabricate prices
  or run an unindexed full-table periodic update.
- `wallet-alpha-managed-v2` is implemented only as a bounded read-only model-selection shadow over
  `evidence-v1`. It uses the frozen managed-exit outcomes plus explicit rug/catastrophic-loss rates
  instead of relaxing the fixed-horizon v1 gate. It does not persist scores, emit signals, claim the
  work queue or contact Telegram. Do not schedule or promote it until threshold-crossing fill
  realism, query/RSS bounds, a future-only shadow cohort and the normal chronological acceptance
  gates pass.
- Creator/funder/cluster coverage, finalized reconciliation and Meteora/Orca launch coverage remain
  rollout work. They block live-capital readiness even if the shadow canary is stable.
- Migrations 025-032 and the associated repository/maintenance changes implement the
  fixed-disk architecture: daily chain-payload and price partitions, filesystem-releasing
  retention, fail-closed risk admission, a 95-day admitted-evidence cap and ingestion disk
  hysteresis. The disposable PostgreSQL 16 populated upgrade, repository integration and partition
  retirement gates passed on 2026-07-28; the production migrations were then backup-gated and
  completed with all new indexes valid. The matching application image was installed into stopped
  containers and passed its image-level type/admission gate. The fixed-disk profile has been
  explicitly restarted; the seven-day fixed-disk shadow remains an open acceptance gate.
  Do not run migration 027 or 028 casually: both intentionally rebuild/drop legacy storage.
- The repository currently has no established commit history or remote. Preserve immutable source and
  database rollback artifacts before deployment; establish a reviewed baseline commit before the
  next risky refactor.

Update this section only when reproducible evidence proves a priority resolved or changes its state.

## Definition of done

Work is done only when:

- the requested behavior is implemented within scope;
- relevant invariants are preserved;
- tests and required integration/performance checks pass;
- failure and recovery paths are covered;
- schema/config/docs are synchronized;
- no secret or unrelated user change is exposed or overwritten;
- operational impact and rollback are understood;
- production state is changed only when authorized and verified;
- the handoff states remaining limitations honestly.

Never present placeholders, mocks, stale reports, process liveness, or waiting-state artifacts as a
completed real-world result.
