---
status: active
updated_at_utc: 2026-09-01T06:47:00Z
owner: codex
task: R52 wallet-alpha admission checkpoint and queue equilibrium
last_safe_checkpoint: read-only diagnosis complete; no mutation or service stop is in progress
---

# Objective and exclusions

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

Commit the coherent R52 source/tests/docs checkpoint while preserving the four unrelated deploy
remnants. Then refresh production read-only state and backup/restore evidence, create a fresh R52
release ledger and build/hash the immutable transfer artifact. No clone restore, local migration or
local reconciliation needs to be repeated.

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
