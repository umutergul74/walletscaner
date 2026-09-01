---
status: active
updated_at_utc: 2026-09-01T09:40:00Z
owner: codex
task: R53 end-to-end queue, FIFO and maintenance recovery
last_safe_checkpoint: all three source fixes implemented; targeted unit/type/PG16 gates pass; no production mutation
---

# Active R53 objective and exclusions

Restore end-to-end, bounded Walletscaner flow after the R52.1 admission rollout by fixing three
verified faults: the growing Pump.fun durable signature queue, incremental FIFO episode natural-key
conflicts, and recurring operational-maintenance SQL `42P18` failures. Prove negative/zero queue
slope, current canonical freshness, bounded resource use and storage progress before declaring the
release operational.

Keep `ENABLE_LIVE_EXECUTION=false`. Do not delete canonical evidence, clear queues, skip unresolved
signatures silently, lower alpha/risk gates, mutate B2 objects/policy, run global prune, touch a
co-tenant, or normalize a coverage gap as healthy. The latest unacknowledged server dump must not be
removed. Provider fallback must be bounded and observable rather than an unmetered Helius credit
path.

# Active R53 resume protocol

Before every resumed action compare this file with `git status --short --branch`, `git log -8`, the
new R53 release ledger if it exists, production container/image identities, applied migrations,
backup evidence, disk/memory and live queue snapshots. Determine whether the previous test, image
build, upload, migration or recreate actually completed before retrying it. Update this file after
every source commit, populated-data proof and production mutation.

# Active R53 verified pre-state

- Local Git is `27a9052`; `main` is ahead of `origin/main` by 270. Preserve four unrelated untracked
  deploy remnants: `.tmp-pipeline-storage-r28-2dc66ab.tar817264887` and three storage-r34/r35/r36
  `.partial` files.
- Production has twelve Walletscaner services. Wallet-alpha R52.1 image is
  `sha256:3666f0c616ada4894cc6b24fd03c867577f2a92c9e68704b57ebb985996aea70`;
  Solana ingestion is `walletscaner-worker:alpha-producer-admission-r46-20260829`; maintenance is
  `walletscaner-worker:maintenance-r48-20260831`. Affected containers have restart 0/OOM false and
  live execution is false. R52.1/R52/R43 and the current ingestion/maintenance images are rollback
  points.
- At 2026-09-01 09:02 UTC the canonical inbox was zero with no dead letter, finality was current,
  open coverage incidents were zero, DB was 24,666,176,535 bytes and root free space was
  11,362,369,536 bytes. One verified chain-payload archive segment was being independently checked;
  archive dead letters were zero.
- The latest server dump `memecoin_alpha_20260831T173517Z.dump` is 2,804,194,002 bytes and has prior
  SHA/archive-list proof, but its off-site acknowledgement is absent. The independently verified
  29-Aug off-host generation remains. No backup may be retired in this task without fresh recovery
  proof and separate gate satisfaction.

# Active R53 root-cause evidence

## Pump.fun durable signature queue

- Pending `solana-rpc-discovery` rows belong only to program `6EF8...wF6P`: 35,357 rows, oldest
  75,296 seconds. Operational samples grew 34,362 -> 35,294 in 67.6 minutes and a later snapshot
  reached 35,357, so the queue has positive slope.
- The WebSocket is open/head-current and durable admission/drop counters are 55,729/0, but only
  20,537 rows have reloaded. Four workers are occupied behind old unresolved fetches; the latest
  queue delay is 75,929,572 ms. Diagnostics show 95,000 transaction requests, 74,434 null responses,
  22 timeouts and 11,940 unresolved cycles. `processSignatureUntilResolved` retries forever and the
  schema has only pending/completed state, so a few permanently unavailable transactions create
  head-of-line blocking. Transport liveness is therefore not end-to-end coverage.

## Incremental FIFO

- Evidence-v1 has 12 pending/error wallets and 3,143 coalesced revisions. Nine rows repeatedly fail
  the natural-key constraint
  `(chain,wallet_address,token_address,strategy_version,episode_index)`; two hit the inventory budget
  and one is the intentional >10,000-trade guard.
- `replaceWalletPositionLedger` removes a stale deterministic episode ID before insert and has a
  regression test. `mergeWalletPositionLedger` deletes only open lots, preserves prior episodes,
  then handles only `ON CONFLICT(id)`. A changed deterministic ID with the same natural key therefore
  reaches the second unique constraint and rolls back. Canonical trades remain intact.

## Maintenance/storage

- Maintenance attempts at 07:49, 08:20 and 08:51 UTC failed in `bounded-retention` with PostgreSQL
  code `42P18`; inventory probes also time out independently. The exact statement was isolated:
  the future alpha decision-tape prune used `$2` for batch size while the shared bounded-prune
  runner also supplied an otherwise untyped `$1`, so PostgreSQL could not infer parameter one.
- From 07:50 to 08:58 UTC DB size grew 203,718,656 bytes and disk free fell 270,979,072 bytes.
  Current monitor status is degraded, with 1.24 conservative days above the 8 GiB reserve. A roughly
  301 MB verifier staging artifact is temporary, but failed maintenance means storage equilibrium is
  not proven.

# Active R53 planned phases and hard gates

1. Add bounded durable-signature retry/lease/error state and a provider fallback policy that cannot
   advance coverage silently past an unresolved older signature. Test duplicates, restart replay,
   unavailable-primary/fallback success, retry exhaustion, concurrency and cursor ordering.
2. Fix incremental ledger natural-key replacement without deleting prior unrelated closed episodes;
   add the missing merge-path PostgreSQL regression and deterministic continuation tests.
3. Reproduce and fix maintenance `42P18`; retain independent one-second advisory probes and bounded
   deletion budgets. Test timeout isolation and the exact production-shaped SQL.
4. Run targeted tests, typecheck/lint/full gate, Linux image tests and populated PostgreSQL 16 proof.
   Measure queue throughput, RSS/CPU, locks/WAL/temp and rollback.
5. Before production mutation create an atomic R53 release ledger and refresh exact backups,
   headroom, mounts, service identities and live=false. Deploy only named affected services; stop or
   roll back on any coverage, data, resource, migration or co-tenant hard gate.
6. Acceptance requires Pump pending/oldest-age negative slope, no new alpha error class, maintenance
   completion, inbox/finality freshness, no dead-letter growth, archive progress, bounded CPU/RAM and
   a storage trend that no longer consumes the emergency reserve.

# Active R53 next exact action

Run the complete local and populated PostgreSQL gates, document the new durable signature state,
then build an immutable Linux worker artifact. Before any server mutation, refresh backup/headroom,
write the revision-checked R53 release ledger and prove the exact migration/image rollback path. No
production mutation is currently in progress.

# Active R53 completed checkpoints

- Incremental FIFO merge now deletes only an incoming stale projection ID that conflicts on the
  same deterministic natural key. The new changed-ID regression plus prior suffix-preservation and
  replace-path tests pass against disposable PostgreSQL 16.
- The decision-tape retention SQL now gives `$1` an explicit 60-day conservative time predicate;
  22 maintenance tests pass (one optional test remains intentionally skipped).
- Migration `057_durable_solana_signature_retry.sql` adds persistent attempt count, due time,
  last error and terminal dead-letter evidence, plus the explicit `unresolved_transaction`
  fail-closed coverage reason. It applied cleanly on disposable PostgreSQL 16.
- Discovery no longer holds a worker in an infinite in-process transaction loop when a durable
  signature is unavailable. It performs one bounded primary request, optionally one metered
  archival fallback, persists exponential deferral, continues with other due signatures and opens
  coverage evidence on retry exhaustion. No signature is silently completed or deleted.
- Targeted provider/migration/maintenance tests pass 73/73; targeted populated PostgreSQL tests
  pass 3/3; repository-wide TypeScript typecheck passes. The first retry integration run exposed
  millisecond truncation caused by stringifying a PostgreSQL `Date`; the new queue timestamp path
  now preserves exact ISO milliseconds and the rerun passes.

# Completed R52 history

Make the wallet-alpha queue sustainable without losing canonical Solana evidence or creating a
discovery gap. Separate cheap, durable admission from expensive FIFO/scoring work; preserve future
eligibility for deferred wallets; activate the already-tested FIFO continuation only after
populated-data and production gates pass. Live execution remains disabled.

Do not clear or delete canonical evidence, lower alpha/risk gates, stop ingestion merely to improve
the queue number, touch the protected co-tenant, mutate B2 policy/objects, prune Docker globally, or
retire source data. A wallet that is not yet capable of passing the current alpha gate may be marked
durably deferred at its exact queue revision; later qualifying evidence must automatically wake it.

# Resume protocol

Before any resumed action, compare this file with `git status --short --branch`, `git log -5`, the
server release ledger, applied migrations, exact image/container identities and a fresh queue/flow
snapshot. Never blindly rerun a migration, reconciliation batch, image load or service recreate.
Update this file immediately after every externally visible checkpoint.

# Verified pre-state and root cause

- Local Git: `adcfa301e17f3da929d8b9319b85984c328777f5`; main ahead 267. Preserve four
  unrelated untracked deploy remnants exactly as found.
- Production at 2026-08-31 23:16 UTC: Walletscaner 12 services; wallet-alpha exact R43 container
  `7313793b5a18...`, image `sha256:e87020e75036...f928bf3b`, restart 0, OOM false,
  `ENABLE_LIVE_EXECUTION=false`, 160 MiB / 0.10 CPU. All other services are unchanged. Protected
  co-tenant inventory is empty.
- Host free 12,840,861,696 bytes, available RAM about 1.02 GB; DB 25,294,158,871 bytes; latest
  wallet trade age 71 seconds. This task does not authorize canonical retirement.
- Queue snapshot: 40,212 pending, 40,161 unseeded, 51 seeded; 39,688 background and 521 elevated;
  five failures. Reasons: buy-trade 29,925, price-enrichment 9,763, sell-trade 330,
  signal-outcome 189. Total revision gap 76,860. In the previous hour 776 new wallet rows and 2,892
  queue revisions arrived.
- Active R43 drains 31-47 wallets per approximately 246-second cycle, while 2,108 trades from 854
  wallets arrived in one measured 15-minute window. CPU/RSS remain bounded; producer cardinality,
  not a memory leak or crash loop, causes the positive queue slope.
- The oldest-first 300-wallet background sample had 158 wallets with at least eight sells, but only
  one with eight recent entries and eight mature outcomes. Therefore only 1/300 could even satisfy
  the current fixed-horizon watch sample minima. The current `6 trades OR 3 entries` admission
  spends full-history work on wallets that cannot emit alpha.
- Error inventory is not the main backlog: two fail-closed FIFO inventory limits, one >10,000 trade
  limit, one revision-CAS retry and one page-budget expiry. The last is amplified because a wallet
  may be claimed with almost no time remaining in the shared 240-second cycle.
- R51 continuation is implemented and migrations 052-055 are applied, but its canary was rejected
  and exact R43 restored because 99.87% of pending wallets had no seed. R51 must not be reactivated
  until the admission cohort is bounded and a populated proof shows negative queue slope.

# Planned phases and acceptance gates

1. Add an additive admission-checkpoint migration. Existing/unknown strategies preserve behavior;
   `evidence-v1` uses upper-bound prerequisites aligned with the immutable score policy. Persist
   ready/deferred reason and checked time on the queue. Deferral advances only the queue's
   `completed_revision`; it does not delete evidence, scores, revisions or future wakeups.
2. Make every producer use the database admission function so old immutable producer images cannot
   bypass the gate. Already-seeded or currently qualified wallets remain refreshable. A bounded,
   restart-safe reconciler transitions the historical pending cohort without one giant update.
3. Fix tail-of-cycle claims so insufficient remaining time is not recorded as a wallet failure.
   Add ready/deferred/seeded telemetry and tests for duplicates, future promotion, concurrent
   revisions, qualified-wallet preservation and fail-closed database errors.
4. Run targeted tests, full repository gate and populated PostgreSQL 16 proof. Measure admission
   false-negative safety against the current watch policy, batch runtime/WAL/temp, producer rate,
   worker drain rate and resource ceilings.
5. Before production mutation, verify current backup/restore evidence, disk/WAL/temp, mounts,
   live=false, co-tenant inventory and rollback images. Apply only new migration(s), then deploy
   named Walletscaner services needed by the code path. Do not stop ingestion. If containment is
   required, stop only wallet-alpha and record the exact checkpoint.
6. Production acceptance requires zero signal-lane starvation, no growing error/dead-letter count,
   fresh ingestion, deferred wallets automatically promoting on qualifying evidence, bounded CPU/
   RAM/WAL/temp and a sustained negative or zero ready-work slope. Roll back images on a hard gate;
   additive checkpoint columns remain inert and evidence-preserving.

# Next exact action

No rollout action remains. Leave the system collecting evidence and measure future queue/error/
storage slopes from fresh production state. Do not rerun migration, reconciliation or cleanup. A
future alpha-threshold or live-execution change is a separate research/security task.

# Local implementation checkpoint, 2026-08-31 23:32 UTC

- Added migration 056 with additive admission status/reason/time, producer-independent database
  gating and a bounded restart-safe legacy reconciler. Other strategy namespaces preserve legacy
  behavior. No canonical row or derived score is deleted.
- Added repository reconciliation API, worker batch control and a 15-second minimum remaining-time
  guard before claiming another wallet. A tail-of-cycle wallet is no longer converted into a false
  page-budget failure.
- Targeted unit/continuation tests: 27/27. PostgreSQL 16 integration: 42/42 after adding tests for
  exact revision deferral, future promotion, bounded legacy reconciliation and qualified bypass.
- Populated clone `walletscaner-postgres-1` is the independently restored 29-Aug generation:
  17,633,754,135 bytes before migrations, 2,603,821 wallet trades, 338,178 wallets and 7,603 pending
  alpha jobs. It was already running when this task began; it is local only.
- Migrations 054/055/056 applied to the clone in 540/336/571 ms. Migration 056 SHA-256 at this
  checkpoint is `7581249d86fb12cfdcf068148928f0de55083ff48c3483a74368164d68a6e551`.
- Reconciliation outcome: 7,595 deferred, 8 retained ready, zero unchecked pending. The first cold
  500-row batch took 3.985 seconds; subsequent batches became faster. Database grew 655,360 bytes,
  WAL was 46 MiB and PostgreSQL temp bytes/files did not increase. This is a queue checkpoint only;
  evidence remains intact and future producer calls re-evaluate deferred rows.

# Populated worker proof, 2026-09-01 00:15 UTC

- The current R52 worker processed all eight retained-ready clone rows in 17.350 seconds with zero
  failures. The heaviest wallet had 11,857 trades, required 12 pages and completed in 5.530 seconds;
  peak worker RSS was 113.66 MiB, below the production 160 MiB container limit.
- Final clone state: zero pending, zero errors, 7,595 deferred and eight continuation checkpoints.
  PostgreSQL temp bytes/files did not increase. The ephemeral local test role was removed.
- Typecheck, lint, 42/42 PostgreSQL integration tests and the latest 26/26 targeted worker/Telegram
  tests passed. The prior full-test process is no longer live and its final exit result was not
  retained by the terminal session, so it must not be represented as passed; one bounded-output
  full gate is the next action.

# Full local gate, 2026-09-01 06:47 UTC

- Windows full suite: 105/107 files and 548/554 tests passed. The only six failures were archive
  tests whose child process could not find `zstd` (`spawn zstd ENOENT`); no R52 test failed.
- Clean Linux worker image `walletscaner-worker:r52-local-gate` was built from the current tree with
  Node 24, PostgreSQL 16 client and zstd. The exact archive subset then passed 9/9, covering all six
  Windows environment failures. A Linux full run passed 540/554; its fourteen failures were only
  host-tool/repository-context tests because the runtime image intentionally lacks PowerShell,
  Python and `docker-compose.server.yml`. Those same fourteen passed in the Windows full run.
  Together the platform-appropriate runs cover all 554 tests without an application failure.
- Workspace production build passed. Wallet-alpha benchmark processed 99 healthy wallets in
  459.87 ms, failed only the intentional >10,000-trade guard, used 31.62 MiB heap and 116.64 MiB
  RSS versus limits of 30 seconds / 100 MiB heap / 160 MiB RSS.
- `git diff --check` passed. Migration 056 SHA-256 remains
  `7581249d86fb12cfdcf068148928f0de55083ff48c3483a74368164d68a6e551`.

# Production preflight and artifact, 2026-09-01 06:55 UTC

- Coherent implementation commit: `93f3b2e`. Release ledger
  `reports/deploy/wallet-alpha-r52-admission-20260901.json` is revision 1 / preflight planned.
- Production still runs 12 Walletscaner services. Wallet-alpha remains exact R43 container
  `7313793b5a18...` / image `sha256:e87020e75036...f928bf3b`, restart 0, OOM false and live execution
  false. No protected co-tenant Compose project is running. No service has been stopped or changed.
- Root filesystem has 14,087,897,088 bytes free; available memory is about 1.01 GB. PostgreSQL is
  24,235,146,263 bytes. Migration 055 is latest. Wallet trade freshness was 162 seconds.
- Queue is 40,960 pending with 75,336 unresolved revisions and three error rows; 6,567 unresolved
  revisions were touched/created in the last hour. This confirms ongoing positive arrival pressure.
- Current server dump `memecoin_alpha_20260831T173517Z.dump` is 2,804,194,002 bytes; SHA-256
  `112599cf58e915dd57993fa780b84cfc7e5c2fed22368d7e6b211fd80aa3e4ad` matched and PostgreSQL 16
  `pg_restore --list` passed. The 29-Aug off-host-verified generation remains present.
- Immutable image `walletscaner-worker:wallet-alpha-admission-r52-20260901` has ID/digest
  `sha256:fc8180ea4e9dac79b28d06d01968ab0d872cb82784a7c1540dd8572d3a2606b1` and size 464,364,975
  bytes. Transfer artifact `deploy/walletscaner-alpha-admission-r52-20260901.tar.zst` is 463,823,701
  bytes with SHA-256 `4601c35858af4df45f952c08905d1ade69e104b676653de747185c94858d664b`.
- The remote artifact SHA and zstd frame matched. Docker loaded the exact image ID above while the
  R43 wallet-alpha container remained running and unchanged. Release ledger revision 4 is
  `migration/planned`; preflight is terminal `completed` in its history.

# Migration checkpoint, 2026-09-01 07:08 UTC

- Release ledger revision 5 is `migration/in_progress`. Only wallet-alpha was stopped; the exact
  hash of the other eleven running service IDs remained
  `12bf221a6477b1f760a3c00c02b5324f30c5f33ce0069a97b6d0b7b19ff8d266`.
- The first one-shot invoked a nonexistent `npm run migrate` script and exited 1 before database
  access; it made no schema change. The verified repository entrypoint `npm run db:migrate` then
  applied only `056_wallet_alpha_admission_checkpoint.sql`.
- Production records the exact expected migration checksum
  `7581249d86fb12cfdcf068148928f0de55083ff48c3483a74368164d68a6e551`; all three additive columns
  and three functions exist. Wallet-alpha remains exited. The historical cohort is 40,933 pending,
  all `unchecked`, so reconciliation has not started and is safe to resume exactly once.

# Reconciliation checkpoint, 2026-09-01 07:23 UTC

- Eighty-two non-empty transactions examined 40,874 historical rows: 40,783 deferred and 91 ready.
  Producers concurrently classified/promoted additional rows through the same database gate.
- Final queue snapshot before rollout: 41,178 deferred with zero pending/errors; 157 ready and
  pending with three pre-existing errors; zero `unchecked` pending. Unresolved revision gap fell
  from 75,336 to 3,396, a roughly 95.5% reduction, while pending wallets fell by about 99.6%.
- Canonical wallet trade freshness was 151 seconds. Database size was 24,272,051,223 bytes. Other
  service ID hash remained `12bf221a...d266`. Root free space was 11,893,678,080 bytes; most of the
  preflight decrease is the newly loaded rollback-preserving image plus the still-present transfer
  artifact, not queue-table growth.
- The exact server release updater SHA matches local
  `5cc7456847993197d3b291e29799c9936101134850f564e8d2570081b2ee359b`; dry-run proves only
  `WALLETSCANER_RESEARCH_IMAGE` will change from R43 to R52.

# R52 acceptance finding, 2026-09-01 07:27 UTC

- R52 container `75d2c1494a1e...` runs exact image `sha256:fc8180ea4e9d...06b1`, restart 0, OOM
  false and live execution false. Other service IDs remain unchanged.
- Across eight approximately 45-second samples, pending fell 161 -> 100 and revision gap
  3,442 -> 3,245; `unchecked` pending stayed zero. Wallet trade freshness reached 17-20 seconds,
  worker RSS stayed 52-65 MiB and CPU was generally below 2% with one 4.75% sample.
- The hard error gate did not pass: failed pending increased 3 -> 5. Both new rows are expected
  producer/worker CAS races (`Wallet FIFO revision changed`), not evidence loss. The older claimed
  revision was superseded by new evidence, but the generic catch path wrote `last_error` and a
  five-minute retry. Treating this normal concurrency path as failure makes telemetry dishonest and
  delays a wallet unnecessarily. Rollout ledger remains revision 11 / `rollout/in_progress`.

# R52.1 artifact checkpoint, 2026-09-01 07:32 UTC

- Hotfix commit `b1180c5`; typecheck, lint, 12/12 targeted tests and bounded benchmark passed.
  Benchmark: 471.68 ms, 31.33 MiB heap, 116.48 MiB RSS.
- Copy-only context is 45,056 bytes, SHA-256
  `64d7f7b09be5976c8c98af5c3cf5a7cbf07a2cdc38b6b57d3a263d21eb00580c`. It contains only the
  Dockerfile and `wallet-alpha-report-builder.ts`; remote SHA matched and build used `--network=none`.
- Production image `walletscaner-worker:wallet-alpha-admission-r52-1-20260901` is
  `sha256:3666f0c616ada4894cc6b24fd03c867577f2a92c9e68704b57ebb985996aea70`, size 464,376,316 bytes.
  Its base label is exact R52 `sha256:fc8180...06b1` and patch label is `b1180c5`. R52 still runs;
  the new image has not yet been bound to a service.

# Completion checkpoint, 2026-09-01 07:39 UTC

- R52.1 is operational as container `0baf5d420db1...`, exact image
  `sha256:3666f0c616ada4894cc6b24fd03c867577f2a92c9e68704b57ebb985996aea70`, restart 0, OOM false and
  live execution false. All other Walletscaner service IDs remained unchanged; ingestion never
  stopped and open discovery coverage incidents are zero.
- The acceptance cycle processed 23 wallets with zero failures and one actual superseded revision.
  The superseded revision emitted `wallet-superseded`, kept newer work pending and did not increase
  `last_error`. Final queue is three pending / three pre-existing fail-closed errors / zero signal /
  zero unchecked; final wallet trade age is 37 seconds.
- Root free space is 11,961,954,304 bytes after deleting only the exact generated transfer/context
  artifacts. R52.1, R52 and R43 images remain for runtime/base/rollback. No canonical evidence,
  backup or B2 object was removed.
- Implementation commits: `93f3b2e` and `b1180c5`. Release ledger
  `reports/deploy/wallet-alpha-r52-admission-20260901.json` is revision 15 / cleanup completed, SHA-256
  `968ad3297c8e6eb447a1ca543bf3e7b7725d37b12707928069fd836775f9d1e2`.
