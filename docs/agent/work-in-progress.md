---
status: complete
updated_at_utc: 2026-08-30T20:34:00Z
owner: codex
task: read-only live runtime, data-quality, storage, signal and paper-performance audit
last_safe_checkpoint: read-only audit complete; dated report records verified no-signal/no-profitable-strategy verdict, key/queue/decision-tape/storage gaps and next authorized rollout gates; production unchanged
---

# Walletscaner Work In Progress

## Completed objective — read-only live alpha/performance audit, 2026-08-30

- User requests current data collection/performance, new signals and evidence of a profitable
  strategy, then asks to continue. Scope is diagnosis/report only: no service recreation, deploy,
  migration, data retirement, B2 write, provider change, paper/Telegram enablement or co-tenant action.
- Git pre-state: main at `9a72447`, ahead 237; only the four previously documented transfer partials
  are untracked. Preserve them. This checkpoint/report is the only authorized local writing.
- Live inventory at 20:12-20:27 UTC: 12 Walletscaner services running; PG/Redis healthy; all running
  containers restart0/OOMfalse. Ingestion R45 retains its 29-Aug 06:50 UTC start, alpha R43 is running,
  paper is stopped, migrations end at 051, live execution false. Protected co-tenant has no running
  Compose project. Root free 14,743,478,272 bytes, about 80% used.
- Exact signal queries: both canonical signal tables empty; latest watch/candidate/validated-paper
  query returned zero. V4 outbox has 65 `shadow` candidates (15 in last 24h), not delivered signals.
  All 15 recent candidates are older than 22m, but only 5 retain an exact-pool 20-22m mark; 2 of those
  are marked rugged. This is a completeness diagnostic, not a strategy replay or fill claim.
- Existing paper results: V1 91 closed/-96.9612 USD; V2 3 closed/-3.8678 USD; V3 3 closed/-14.1623
  USD, including two terminal rugs; no open positions. No recent paper execution.
- Alpha 870 cycle sample spans approximately 24h: pending 10,788 -> 18,265 despite 42,150 processed
  wallet revisions and 25,223 low-evidence skips; signals0. Current errors are one evidence-limit
  quarantine, not a general crash. R46 producer-admission fix remains local, not deployed.
- Running ingestion still has neither Pyth nor Jupiter key. Deployed Pyth adapter supports auth;
  latest SOL/USD persisted oracle observation is 26-Aug 16:16 UTC. Historical Pyth requests/errors
  3,435/3,435. One-hour trade sample: 5,419 price-proxy and 186 unpriced observed-balance, zero HQ.
- B2 manifests: 29 raw + 36 wallet-evidence verified, zero pending/dead-letter; compact days36
  verified. Canonical wallet retirement is still not implemented by compact shadow. DB24.10GB;
  monitor 24h DB slope +1.237GB/day and conservative reserve runway4.07d. Latest dump offsite
  acknowledgement is NOW true, superseding the prior 11:01 UTC missing-ack blocker.
- Discovery currently has zero open transport incidents, but 569 closed/unreconciled historical
  intervals remain excluded. Latest incident30-Aug19:27 UTC recovered transport19:29 without proof
  of complete gap repair. Never call these 569 concurrent outages.
- Audit limitations: full latest-score aggregates exceeded bounded SQL timeouts; do not rerun
  unbounded ranking scans. Narrow status/top-observed indexed queries succeeded. No full fresh
  restore or independent chain-wide denominator check was run; old research files are dated evidence.
- Completed bounded2,000-event latency sample: discovery receive p95=2.252s; mixed-origin swaps
  p95=121.950s. Durable origin metadata is absent, so this is not a live-only swap latency claim.
  Last post-state20:28:40 UTC: inbox7/dead0, finality22/unresolved24h0, DB24,136,621,079 bytes,
  free14,728,196,096 bytes, runway4.02d above8GiB reserve. Same service set, co-tenant untouched.
- Local offsite task success30-Aug19:21 UTC independently confirms the latest dump's SHA and
  archive-list check; latest-generation full restore is NOT verified. No backup action was run here.
- Final report: `reports/live-alpha-status-audit-20260830.md`. No-go for live capital; waiting
  unchanged is not enough. Next task requires explicit named-rollout authority: fix deployed
  auth/admission, finish compact reader/retirement gates, then deploy052/053 tape and measure a
  genuinely future-only cohort. No production operation is in progress or needs blind retry.

This is the durable resume point for the current storage incident. It contains no credentials and
does not grant authority beyond the user's current request. On resume, compare this record with Git,
the production ledger, backup files, archive manifests, containers and database state before
repeating any step.

## Active objective — provider credential persistence, 2026-08-30

- User explicitly supplied free Pyth/Jupiter keys and authorized saving them so they are not
  requested again. Values must never appear in source, Git, command output, logs, checkpoints or
  reports. Store only in `/opt/walletscaner/.env.server`, preserving root ownership and mode 0600.
- Scope is exact and reversible: atomically add/replace only `PYTH_API_KEY` and `JUPITER_API_KEY`,
  retain a mode-0600 rollback copy outside the repository, validate exact key names/presence and
  make one bounded authenticated request to each provider. No schema migration, image deploy,
  archive/B2 write/delete, paper/Telegram/live execution or co-tenant action.
- Pre-state at 2026-08-30 10:51 UTC: root disk 13,365,546,304 bytes available (81.6% used), DB
  22,980,443,159 bytes; PostgreSQL/Redis healthy; ingestion R45 restart0/OOMfalse. Both credential
  names absent, `ENABLE_LIVE_EXECUTION=false`, `.env.server` root:root mode0600 size8630.
- Backup exists (latest dump 2,770,884,949 bytes) but current operational report says offsite
  acknowledgement missing/mismatched. Archive pending/verify/dead-letter are 0/0/0. Therefore
  do not restart ingestion or activate/deploy the alpha-tape worker in this phase.
- Rollback is byte-for-byte restoration of the pre-change secret file followed by permission check;
  because services are not restarted, running container environments remain unchanged. A
  non-secret revision-checked release ledger records planned/in-progress/completed states.
- Acceptance: atomic update; only one line per required key; root:root 0600; live execution false;
  no value in output; Pyth authenticated SOL/USD response has expected feed/positive price and
  Jupiter quote-only response is authenticated without taker/transaction submission. Provider
  failure rolls the file back. Next separately gated step is offsite-backup verification followed
  by an explicitly authorized named-service restart/deploy.

### Credential write checkpoint — 2026-08-30 10:56 UTC

- Machine ledger `reports/deploy/provider-credentials-20260830.json` moved planned revision 1 to
  in-progress revision 2 before mutation. It contains no key or fingerprint.
- `/opt/walletscaner/.env.server` was replaced atomically after fsync. `PYTH_API_KEY` and
  `JUPITER_API_KEY` each exist exactly once and match the supplied values inside the verifier;
  output exposed presence only. Ownership remains root and mode 0600.
- Byte-for-byte rollback is `/opt/walletscaner/.env.server.credential-rollback-20260830T105526Z`,
  also root-owned mode0600. Running containers were not recreated/restarted and therefore have not
  consumed the new values yet. No database/B2/co-tenant state changed.
- Next exact action: one no-dependency, temporary, bounded provider-auth probe using the existing
  R45 ingestion image and env file. It performs Pyth latest SOL/USD and Jupiter quote-only `/order`
  with no taker/signing/submission, prints booleans/status only, then removes itself. Failure rolls
  the secret file back; success completes credential persistence but does not authorize restart.

### Completion — 2026-08-30 11:01 UTC

- Existing R45 image received the saved credentials only in bounded one-shot containers. Pyth's
  official new Hermes endpoint, the legacy/default Hermes endpoint and Benchmarks all returned
  authenticated parsed evidence. Jupiter `/swap/v2/order` returned an authenticated USDC-to-SOL
  quote with matching inputs and a route, without a taker or transaction. No provider body, price,
  key, fingerprint, signed object or request credential was printed or retained.
- Both one-shot containers used `--no-deps`, explicit `ENABLE_LIVE_EXECUTION=false`, no signing or
  submission, then were removed. Post-state shows no probe container. Ingestion remains the exact
  R45 image, restart0/OOMfalse and its original start time; root free space is 13,351,292,928 bytes.
  Protected co-tenant inventory remained empty/unchanged.
- Persisted file and rollback remain root:root mode0600; each key name occurs exactly once and
  `ENABLE_LIVE_EXECUTION=false`. Machine ledger revision 3 is completed with boolean evidence only.
- The already-running ingestion container correctly still reports both new variables absent: Docker
  does not reload env files into an existing process. It was deliberately not restarted because the
  latest dump's offsite acknowledgement is missing/mismatched. Thus keys are saved and proven, but
  production Pyth enrichment has not resumed yet. Next separate task: repair/verify offsite backup,
  then perform a named ingestion restart (and later the separately gated 052/053 worker rollout).
- Rollback remains `.env.server.credential-rollback-20260830T105526Z`. There is no active provider
  probe, migration, deploy, upload or cleanup to resume. No local credential copy was created; the
  production secret file is the only required durable location and will be reused by future Compose
  recreations so the user need not supply the keys again.

## Active objective — collection integrity and bounded work, 2026-08-30

- Scope: local Pyth authentication/failure budgets and observable missing-price state; fix tape
  checkpoint dependency races, stale-horizon admission and provider/SQL budgets. No live capital,
  paper/Telegram enablement, production deployment, migration, restart, archive retirement or
  co-tenant change. Do not add a broad history crawler or unbounded raw payload collection.
- Pre-state: `main` at `2e53d02`, ahead 232; tracked tree clean and four protected untracked deploy
  remnants unchanged. Prior tape implementation is `64df1ab`; migration 052 SHA-256
  `8f359e02333caba69c7eda8f4af75a630372c1d08541ee1dcbe295d4f691e2e1` remains unapplied live.
- Read-only production evidence around 08:53 UTC: ingestion R45, alpha R43, migrations through 051;
  DB 22,769,409,047 bytes; filesystem available 13,536,448,512 bytes (~12.6 GiB). Canonical trades
  current; inbox pending 23/processing 1; alpha pending 6,662. No archive dead-letter, one pending
  verification. Recent disk slope includes dump steps and does not prove storage equilibrium.
- Pyth historical request/error counts 2,969/2,969; selected credential-presence booleans for Pyth
  and Jupiter both false. A credential-free public Hermes probe returns HTTP 401. Official Pyth
  upgrade documentation confirms authentication became required 2026-08-26. No secret was read.
- Latest server dump ~2.77 GB with sidecar, but offsite acknowledgement missing/mismatched. This is
  a rollout hard gate, not evidence of data loss. No production mutation authorized or attempted.
- Acceptance: explicit missing-key state and bounded auth/429/outage calls; no later checkpoint
  before initial entry is terminal; late measurements excluded, never relabelled as on-time;
  bounded SQL/HTTP/lease recovery and no provider retry storm; targeted + PostgreSQL 16 + full
  Linux regression gates. Policy changes need additive migration/new future-only version.
- Rollback: source revert of this local phase. Disposable test DB only; no live data changes to
  undo. Resume by inspecting git status/diff and this checkpoint; do not rerun prior migration or
  deploy. Next action: implement and test the provider fix, then checkpoint scheduling changes.

### Implementation checkpoint — 2026-08-30 09:10 UTC

- Pyth public probe confirmed HTTP 401, not merely an inferred auth failure. Missing-key calls now
  fail locally; HTTP auth/429/outage circuits have fixed bounds and sanitized telemetry. Operational
  health reports missing price authentication explicitly; trade raw quantities remain preserved.
- Additive migration 053 creates v2 (4 decisions/UTC hour, seed/claim one, 10-second timing window)
  and a scalar timing-status column. 052 and historical v1 are unchanged. Candidate limiting is
  before expensive enrichment; expired-lease recovery caps at 25; later claims require terminal
  initial evidence. Missed horizons become stale records, not later reconstructed fills.
- Collector uses just-in-time claims, a singleton PG session, SQL 5s/client 6s/connection 5s bounds,
  exact token/pair identity, and no raw response store. Pyth/Jupiter required before activation;
  Jupiter quoted evidence has 1.05s request spacing and auth/rate-limit backoff.
- Initial targeted suite 33/33 and typecheck passed before the last rate-limit/health additions.
  Local Docker Desktop was initially stopped; started hidden for disposable PostgreSQL tests.
  Its API is still initializing; no test DB exists yet and no production test fallback is allowed.
- Next: finish PostgreSQL dependency/timing/pacing tests, current-source full gates, capacity
  verification, then docs/coherent commit. No deployment or migration has occurred.

### Validation checkpoint — 2026-08-30 09:26 UTC

- Docker Desktop could not initialize its inference socket. No reset, Docker data deletion,
  daemon reconfiguration or production fallback was attempted. The two hanging read-only Docker
  CLI probes were stopped by their verified PIDs. The Docker application itself was not reset.
- Instead, official EDB PostgreSQL 16.15 portable binaries were downloaded under
  `C:/Users/Umut/AppData/Local/Temp/walletscaner-pg16-validation` (ZIP SHA-256
  `25e6fcdfb8caec38691bf461125e7564508760666f7b8e5dc6a5f0818f58f81e`). Only bin/lib/share were extracted.
  A disposable, non-service cluster listens only on 127.0.0.1:54329 with 32MB shared buffers and
  30 connections. It contains generated fixtures only, not production data. Stop this exact data
  directory after tests; do not target the unrelated locally installed PostgreSQL 18 instance.
- Test-only zstd 1.5.7 came from the official facebook/zstd release into the same temporary
  directory. Its path is added only to individual test processes, not the persistent machine PATH.
- All 509 tests passed with native PG16/zstd (56 DB cases, zero skips). The last addition tests the
  deadline before waiting on Jupiter's rate limiter, avoiding a request that would start too late;
  final full suite/typecheck/lint/build are currently being repeated. No Linux/cgroup validation is
  claimed while Docker is unavailable.
- Populated 053 rehearsal preserves 100 v1 decision digests, all 600 old checkpoints, the physical
  checkpoint relation identity and old policy. 052 SHA is unchanged. 053 SHA-256 is
  `70c08ef99bea9e1df7ecef5e330b5f8d26be3999869f2d7e5c85b782c679bcd1`.
- Updated capacity benchmark passes with 100 actually due and 100 expired decision candidates:
  1,531,904 table/index bytes; 1,757,152 insert WAL bytes; 91,914,240 conservative 60-day bytes.
  Claim/retention use intended indexes and no temp writes. This is not server-wide equilibrium.
- Final read-only server check 09:23 UTC: same services still running, PG/Redis healthy,
  13,109,682,176 free bytes. No production mutation. Next: verify final test exit, stop only the
  temporary PG16 cluster, commit source/tests/docs, and record exact commit plus unresolved gates.

### Final local verification — 2026-08-30 09:28 UTC

- Final current-source run: 101 test files, 509/509 tests, no skips, PostgreSQL16/zstd included;
  typecheck, ESLint and workspace production build all exited successfully. The populated 053
  upgrade preserves prior evidence/policy and introduces no historical v2 decisions.
- The temporary cluster's data directory was checked through its own SQL session, then only that
  cluster was stopped cleanly. `pg_ctl status` reports no server running and port 54329 has no
  listener. Downloaded tools/fixtures remain in the named temporary directory for reproducibility;
  no production or local user database was removed. Existing PostgreSQL18 was untouched.
- Local code and documentation phase is ready for one coherent commit. Production rollout stays
  blocked by missing Pyth/Jupiter access and unverified latest backup acknowledgement, and is not
  authorized by this checkpoint. There is no ongoing migration/upload/cleanup to resume.

### Handoff — 2026-08-30 09:29 UTC

- Source/tests/docs committed locally as `a7875e9` (`fix: bound price evidence collection and
  checkpoint timing`). No push, server deploy, live migration, provider purchase or credentials
  change occurred. Only the four pre-existing protected transfer remnants remain untracked.
- The implementation phase is complete. Overall live collection improvement is **blocked**, not
  operational: Pyth/Jupiter access must be supplied outside the repository, latest offsite backup
  acknowledgement independently verified, and a worker-only rollout explicitly authorized.
  Docker's Linux image/cgroup validation remains a rollout prerequisite; native PG16 tests do not
  replace it. Do not restart the unrelated PostgreSQL18 or reset Docker data to bypass this gate.
- Resume with git status/log and read-only provider-presence/backup/migration/resource verification.
  Do not rerun migration 052/053 on production or recreate the stopped temporary cluster blindly.
  No source evidence, B2 object or user database has been deleted.

## Active objective — future exact-pool alpha decision tape v1

- Implement a new immutable, future-only research evidence contract. It must not tune or deploy the
  rejected `contextual-wallet-survival-v1-20260829` selector. One decision is keyed by exact pool,
  version and first decision boundary; later checkpoints never rewrite the original features.
- Record separately: critical token/program risk; canonical coverage/finality eligibility; exact
  market state; unique/direct-creator buyer counts; explicit unknown cluster/funder/bundle status;
  and bounded 0/15/30/60/120/300-second price/liquidity/two-way executable quote evidence for
  fixed $6/$25/$100 notionals. A missing/mismatched/stale/failed sell quote remains a failure, never
  an estimated fill. Provider raw payloads are not retained.
- Every claim/attempt has a lease, bounded batch, retry budget and durable terminal state. The
  producer is oldest-first and bounded, the checkpoint set is fixed, and retained scalar evidence
  has an explicit lifecycle. Unknown coverage, risk, program behavior or identity independence is
  fail-closed for any later paper admission.
- Freeze the hypothesis, policy, activation boundary and acceptance contract in schema/docs before
  reading future outcomes. This phase may add code, tests and migration 052 locally, but production
  migration, worker/Compose activation, credentials, Telegram, paper entry and live execution are
  excluded. `ENABLE_LIVE_EXECUTION=false` remains invariant.
- Pre-state: branch `main` at `12a191c888ad17fb14a3bde91c30a7bda0ac4ede`, 230 commits ahead of
  `origin/main`; only four protected untracked deploy remnants are present. No server state was
  inspected or changed for this phase.
- Acceptance: migration clean-install and populated PostgreSQL 16 upgrade; deterministic
  idempotency; duplicate/out-of-order checkpoint behavior; lease expiry/retry/dead-letter;
  exact-pool route rejection; missing-evidence fail-closed behavior; bounded retention query plan
  and byte/day estimate; targeted tests, typecheck, lint, workspace build and applicable full suite.
- Rollback before deployment is source revert plus dropping only new 052 objects in a disposable
  database. A future production rollout requires a separately authorized production-ops phase,
  current backup/headroom proof and an immutable artifact; this checkpoint grants none of those.

## Decision-tape local implementation checkpoint — 2026-08-29 21:30 UTC

- Migration 052 freezes `survival-execution-tape-v1-20260830` with a migration-time activation
  boundary, zero Telegram/paper/live authority, 100 decisions/UTC day, six exact horizons, three
  fixed notionals, six attempts and 60-day compact retention eligibility. `paper_eligible` is
  constrained false. Only future pools at least 120 seconds old and no more than 30 minutes old
  can enter; oldest-first admission and the daily cap expose `hasMore` instead of hiding overflow.
- The decision row is one immutable exact-pool snapshot. Risk, finalized/gap-free coverage,
  creator/direct-creator activity, address-level buyer/seller counts and identity independence are
  separate. Missing funder/cluster/bundle and landing-fee evidence remains explicit; it is never
  promoted to pass. Only risk/coverage/market-eligible rows receive the fixed six-checkpoint work.
- The checkpoint store uses claim leases, `SKIP LOCKED`, expired-lease recovery, bounded retries and
  durable dead-letter. Atomic completion writes at most six normalized scalar quote rows and the
  market/flow snapshot under the same live lease. It stores no raw provider response. Entry uses
  the minimum-output amount from the decision-time buy quote; later checkpoints quote only that
  frozen amount, preventing future entry-size leakage.
- The read-only collector requests an exact DexScreener pair and single-route Jupiter quotes. At
  horizon zero it records $6/$25/$100 buys plus immediate sells; later horizons record three sells.
  A wrong pool, no route, stale price, provider failure or unavailable entry becomes explicit
  non-fill evidence. Fixed-point USDC/SOL raw notionals avoid a JS-number token accounting boundary.
- The standalone worker is disabled by default and refuses to start without an explicit enable flag
  and read-only Jupiter API key. Its isolated `alpha-research` Compose profile is capped at 0.03 CPU,
  80 MiB and two PostgreSQL connections; no service has been created or deployed.
- Verification so far: 20 unit tests pass across config, Jupiter integrity, migration/store and
  checkpoint collection; root typecheck passes; the full migration clean-install plus decision,
  idempotency, checkpoint and atomic quote path passes 2/2 on disposable PostgreSQL 16. The
  temporary test schema was dropped by the test harness. Next: bounded retention owner, populated
  upgrade/EXPLAIN/bytes-per-day evidence, docs and broad gates.

## Decision-tape retention, capacity and documentation checkpoint — 2026-08-29 21:40 UTC

- Normal operational maintenance now owns 60-day decision-tape expiry. It selects only the oldest
  bounded cohort, requires every fixed checkpoint to be terminal (`completed` or `dead_letter`),
  and uses the existing statement/run/batch budgets. Cascades remove only the bounded children;
  provider payload bodies were never stored. This is steady-state page reuse, not an immediate
  filesystem-shrink claim.
- The populated PostgreSQL 16 upgrade test creates 1,000 pre-052 pools, records the pool relation's
  physical file identity, applies migration 052 and verifies that the identity is unchanged and no
  historical decision was imported. The end-to-end integration now passes 4/4: future exact-pool
  admission/idempotency, six-work-item creation, lease/atomic quote completion, and database-level
  rejection of nullable passed-risk or incomplete exact-pool quote evidence.
- The generated worst-case daily envelope is 100 decisions, 600 checkpoints and 2,100 normalized
  quotes. After the current Jupiter Swap V2 fee/provenance fields, its table/index total is
  1,523,712 bytes, latest insert WAL is 1,798,928 bytes (about 1.72 MiB), and conservative 60-day retained
  size is 91,422,720 bytes (about 87.2 MiB). Claim and retention plans use their intended indexes,
  execute below 0.2 ms and write no temp data in the isolated benchmark.
- Architecture, data-model, provider, backtest, operations, storage lifecycle, README, current-state
  and compact build context now distinguish implemented/local from operational/deployed. The
  production state remains migrations through 051; no server, secret, provider, Telegram, paper or
  live-execution state was inspected or changed.
- Final pre-commit review fixed two fail-open boundary errors before any deployment: a discovery
  incident now taints a decision when any part of the pool-creation-to-decision interval overlaps
  the unresolved gap, and direct-creator buys are checked over that full interval instead of only
  the trailing five minutes. The trailing-five-minute buyer/seller features remain unchanged.
  Passed risk now requires directly persisted top-10 concentration evidence at or below 70%; it is
  no longer reconstructed from a risk sub-score. PostgreSQL tests cover an incident beginning
  after pool creation and a creator buy older than the trailing-five-minute flow window.
- Current gates: root typecheck, ESLint, workspace production build and quiet `alpha-research`
  Compose validation pass; 34 targeted tests pass; the full current-source Linux/zstd suite passes
  441/441 with 53 database tests intentionally skipped there; the separate PostgreSQL 16 run passes
  all 53/53 integration tests. The four protected untracked deploy remnants remain untouched.

## Decision-tape completion checkpoint — 2026-08-29 22:12 UTC

- The coherent implementation, migration, tests and aligned documentation are committed locally as
  `64df1ab88aae4e75a4094331c3c0923359d6b54d`. Migration 052 SHA-256 is
  `8f359e02333caba69c7eda8f4af75a630372c1d08541ee1dcbe295d4f691e2e1`.
- Production was not contacted or mutated. No migration, container, provider credential, Telegram,
  paper portfolio or live-execution state changed. The disposable local PostgreSQL 16 test
  container can now be removed; the four protected transfer remnants remain outside Git.
- The next alpha dependency is a separately versioned creator/funder/bundle identity graph followed
  by a separately authorized, backup-gated worker-only rollout. A rollout collects research
  evidence only; it cannot enable paper delivery until the frozen future-day/market gates mature.

## Active objective — contextual-wallet survival research v1

- Replace the failed absolute strict-flow/global-wallet thesis with a falsifiable two-head research
  model: terminal rug/unsellable hazard first, conditional executable return second. Use one
  immutable record per exact pool and decision time; keep wallet realized PnL, bot followability,
  pool risk and fill evidence separate.
- Historical records already inspected through 2026-08-27 are model-development data, never an
  untouched holdout. The first implementation phase is read-only against the restored PostgreSQL
  clone and must use chronological expanding history, deterministic partial pooling, winsorized
  model targets, raw tail evaluation, negative controls and explicit no-signal outcomes.
- Acceptance before any future-shadow schema/worker: the locked policy must beat both the broad
  managed-exit and market-only controls in later chronological windows; positive median and
  average-ex-best, profit factor at least 1.30, best-winner share at most 30%, catastrophic/rug rate
  at most 3%, no hidden missing-fill exclusion and stable distinct-market/day counts. Failure means
  reject the policy rather than tune the same windows.
- Production, migrations, Compose, Telegram delivery, paper portfolios, provider credentials and
  live execution are excluded from this phase. `ENABLE_LIVE_EXECUTION=false` remains invariant.
- Preserve the four pre-existing untracked deploy remnants. Do not touch R46 artifacts or repeat
  its build/test work. If this turn is interrupted, inspect git status and this section before
  running any research command or changing a source file.

## Contextual-survival local implementation — 2026-08-29 20:40 UTC

- Added immutable strategy version `contextual-wallet-survival-v1-20260829`. It processes one
  exact-pool decision chronologically, admits an outcome only when its `frozen_at` is earlier than
  the next decision, models terminal rug/unsellable hazard before conditional non-hazard return,
  uses partial pooling across market context and prior wallet evidence, and applies a one-sided
  uncertainty gate before selection.
- Selection is an online top-decile rule after a 100-mature-market burn-in. Model learning
  winsorizes return at -100/+100 while evaluation preserves the raw positive tail and terminal rug
  floor. All policies share the same chronological/embargo boundaries. Controls are broad
  risk-passed flow, market-only scoring and a deterministic shuffled-wallet-identity negative
  control; a contextual pass must beat both later controls without lowering fixed tail gates.
- Six unit tests pass and root typecheck passes. The audit entrypoint is bounded to a 240-second,
  repeatable-read, read-only transaction over the restored PostgreSQL clone and emits no wallet
  identifiers. It selects the first source-linked `evidence-v1` exact-pool decision at age >=5m,
  uses only mature `tp15-sl20-20m` outcomes, and defines supporters as non-creator/non-pool exact
  pool entries in the prior ten minutes.
- No query/report has run yet. No source claim is validated and no future shadow, paper strategy,
  migration, server mutation or deployment is authorized. Next exact action is compile/test the
  new audit entrypoint, run it once on the disposable local clone, remove the temporary local
  read-only credential, and record the fixed-gate verdict without tuning the same history.

## Contextual-survival first falsification — 2026-08-29 20:42–20:43 UTC

- The bounded local audit completed in 27 seconds over 1,370 eligible markets from 12 July through
  27 August. Its temporary role was removed and the clone has zero roles with that name. The fixed
  policy was rejected: 40 contextual-wallet selections returned -2.03% average, -3.35% average
  excluding the best winner, 0.86 profit factor and 12.5% catastrophic losses despite a 75% hit
  rate and +13.62% median. No later holdout selection survived the risk-uncertainty gate.
- Review showed the five catastrophic selected outcomes were not flagged `rugged`, but all were
  <=-57%. The model correctly classified them as terminal hazards for the hazard count, yet also
  left them in the conditional non-rug return head. That violated the declared two-head separation;
  it was corrected without changing a threshold or using the result to select a new policy. A new
  test proves a non-rug <=-80% loss raises the next decision's survival risk and is not treated as a
  normal conditional return. Seven tests and typecheck pass.
- The first report/hash is diagnostic only and will be atomically overwritten by one rerun on the
  same restored snapshot. A second rejection must remain a rejection; do not tune the 12% survival
  UCB, top-decile rule, priors or acceptance gates on this history.

## Contextual-survival corrected final audit — 2026-08-29 20:52–20:58 UTC

- Two implementation-contract corrections were completed before freezing the result: non-rug
  <=-80% outcomes now enter only the terminal-hazard head, and context evidence no longer inflates
  wallet reliability by double-counting the same completed market already present in global wallet
  history. Neither correction changed a prior, threshold, candidate grid or acceptance gate.
- The final read-only clone audit covers 1,370 exact-pool decisions and has decision SHA-256
  `e674a3a854411b59d52d5fc9cf4225d6608fdb9fb12c51e5d7bfb5c5b4d37fde`. Verdict is `reject`.
  Forty-nine contextual selections returned -1.87% average, -2.94% average excluding best, 0.87
  profit factor and 10.20% catastrophic-loss rate despite +13.63% median and 71.43% hit rate.
  Validation failed; holdout 1 selected none and holdout 2 only one.
- All selected decisions occupied the same launch-program/context bucket. Winners and catastrophic
  outcomes overlapped on persisted liquidity, volume, transaction count, buy share, turnover, pool
  age and top-10 concentration. This falsifies another static threshold search over those fields.
  Missing decision evidence is creator/funder/bundle independence, exact-pool two-way executable
  quotes/sellability, short price/liquidity paths and regime/drift state.
- The temporary local audit role is absent. No migration, production database row, server artifact,
  service, Telegram, paper portfolio or live-execution state changed. The dated/latest Markdown and
  ignored JSON reports contain no supporter wallet identities.
- Verification passes: eight targeted strategy tests; root typecheck; full ESLint; workspace
  production build; and the complete current-source Linux/zstd suite with 91 test files/426 tests
  passed plus 49 intentional database-environment skips. The native Windows suite independently
  reached the same 426 passing tests but could not run three archive cases because no local `zstd`
  binary exists; the Linux gate ran and passed those exact archive tests.
- This history cannot authorize a shadow or paper version. The next alpha phase must implement and
  cost a bounded future decision tape for the missing evidence described in
  `docs/research/contextual-wallet-survival-v1.md`; do not deploy this rejected selector.

## Deferred operational checkpoint — R46 producer admission

- R46 remains implemented and validated at source commit `53b5949dce301f6f20dc9f6d0fea0831a23b80d4`,
  runtime image `sha256:e376cfd6704cd5a0ad799e338b9a3d57ef9c4204eccba81a5efdd439fdf2380b`,
  validation image `sha256:ed7691a1c3fc86b50850520e1e85e84ea2f651a5b4d33d7bd9b5cd1dcc666a52`
  and 463,454,623-byte local transfer artifact SHA-256
  `a505591b7610e68e4b3f34ddfd80caf4b436de91695d2e81d6203e5cf035560c`.
- Production remains exact R45/revision 79. No R46 rollout ledger phase was opened. A future
  separately authorized rollout must begin by rechecking backup/off-site acknowledgement,
  disk/resource/flow identities and the actual production version; it must not assume the
  interrupted 17:35 UTC dump is still active or blindly resume at revision 80.

## Active objective — R46 wallet-alpha producer admission

- Preserve every wallet trade, exact price enrichment and later entry/outcome. Change only whether
  price enrichment increments a redundant score-work revision before a wallet meets the same
  configured admission boundary used by the worker (`trade_count >= minimumTradeEvents OR
recent_entry_count >= minimumEntries`).
- The thresholds must be passed explicitly from ingestion configuration, remain bounded, and be
  optional for repository callers/tests that need unconditional enrichment semantics. Trade and
  wallet-entry writes stay unconditional atomic queue producers; therefore a threshold crossing,
  concurrent trade or wallet that matures later cannot be lost.
- Acceptance: memory and PostgreSQL tests prove sub-threshold price enrichment is persisted but
  does not create a second revision, every trade or entry still creates work, revisions arriving during a lease remain
  pending, priority lanes remain unchanged, and target/type/lint/build plus populated PostgreSQL 16
  gates pass. Do not alter scoring/risk thresholds, current queue rows, CPU/RAM, providers or live
  execution. Production remains exact R45 until a separate immutable R46 canary is fully proven.

## R46 measured baseline — 2026-08-29 17:31 UTC

- At 17:26 UTC the active `evidence-v1` queue had about 7.8k pending; priority 2 was zero. Price
  enrichment dominated with 7,477 pending wallets and 15,998 uncompleted revisions. Over the latest
  64 cycle logs, alpha processed 4,401 wallets with zero cycle failures but queue size moved
  6,884 -> 7,814 (`+930`), so this is producer imbalance rather than a crashed consumer.
- In bounded oldest/newest 500-wallet samples, price-enrichment work had 480/490 wallets with zero
  entries; only 19/3 met the existing `6 trades OR 3 entries` admission boundary. Of then-current
  buy/sell work, 15/21 and 108/146 respectively had zero entries. Evidence persistence is useful;
  scoring those sub-threshold revisions is not.
- Existing indexes cover bounded probes by strategy/wallet/time. Do not add an index or migration
  before the exact SQL and PostgreSQL 16 plans show one is required. Next action is the smallest
  repository/caller/test change locally; no server mutation is open.

## R46 local implementation — 2026-08-29 17:46 UTC

- Concurrency review narrowed the change to price enrichment. Every trade and entry remains an
  unconditional transactional queue producer, so two simultaneous threshold-crossing trades cannot
  suppress discovery. Price enrichment always persists its changed trade rows, then uses the exact
  configured bounded `trade >= 6 OR recent entry >= 3` test only to decide whether it adds another
  derived revision. Repository callers may omit the option for unconditional replay semantics.
- The memory implementation deduplicates enrichment queueing once per changed wallet, matching
  PostgreSQL. Tests prove five trade rows are persisted and enriched with no second revision after
  their initial trade work was completed; the sixth trade still enqueues unconditionally. Memory
  and PostgreSQL suites pass 45/45 combined, including PostgreSQL's complete 34-test evidence suite.
- Typecheck, lint and workspace build pass. The broad Windows suite is 418 passed, 49 intentional
  database-environment skips and only the same three local `zstd ENOENT` failures. A populated-host
  read-only plan used the existing trade and entry strategy/wallet/time indexes; the bounded probes
  themselves were about 6.7ms cold for six trades and 0.4ms for zero recent entries with no temp or
  WAL. The 2.7-second outer candidate scan was diagnostic-only and is not part of the write path.
- Next action is commit the coherent R46 source/tests/docs/recipe, build from exact R45, and run the
  exact Linux/zstd full suite plus targeted PostgreSQL 16 gate. Production remains R45/revision 79.

## R46 exact artifact validation — 2026-08-29 17:53 UTC

- The coherent source/test/documentation change is commit
  `53b5949dce301f6f20dc9f6d0fea0831a23b80d4`. The immutable runtime image is
  `sha256:e376cfd6704cd5a0ad799e338b9a3d57ef9c4204eccba81a5efdd439fdf2380b` and
  carries the same complete source revision plus release
  `alpha-producer-admission-r46-20260829`.
- Validation derivative
  `sha256:ed7691a1c3fc86b50850520e1e85e84ea2f651a5b4d33d7bd9b5cd1dcc666a52`
  was built from the exact R45 validation base with only the R46 changed files. Node 24/Linux
  typecheck and the complete zstd/Python/Compose-aware suite pass: 418/418 tests, with 49
  intentional skips that require a database URL.
- The exact validation image then passed the complete PostgreSQL 16 evidence integration suite
  34/34 against the disposable local clone. The temporary superuser and its owned objects were
  reassigned/removed after the run; no test credential remains.
- Production is still exact R45 and ledger revision 79. Before any mutation, refresh live execution,
  backup acknowledgement, disk/WAL/temp/RAM headroom, protected-project inventory, flow, alpha
  queue baseline and exact container/image identity; open the revision-checked rollout ledger only
  if every hard gate passes.

## R46 production preflight — 2026-08-29 17:54–17:56 UTC

- Only the `walletscaner` Compose project is listed and its 12 intended services run. Ingestion is
  exact R45 image `sha256:bc17668d...33722`, restart/OOM `0/false`, and
  `ENABLE_LIVE_EXECUTION=false`; wallet-alpha, PostgreSQL and Redis are also restart/OOM-free.
  Ledger revision 79 SHA remains exact and completed. No production or ledger mutation was made.
- Host `/` has 15,851,438,080 bytes available at 79% use; available RAM is about 1.04 GB and free
  swap about 1.98 GB. PostgreSQL is 22,761,643,031 bytes and `pg_wal` is about 621 MB. The fresh
  monitor sample has inbox/dead/open-finality/signature `1/0/0/0`, last pool/trade ages about
  3/164 seconds, archive pending/verify/dead `0/0/0`, wallet archive/compact pending/dead/mismatch
  zero, and the latest completed dump is available, checksum-valid and off-site acknowledged.
- The alpha imbalance is still active: 8,515 pending/8,514 ready, P0/P1/P2
  `8,041/474/0`, with 7,924 price-enrichment rows carrying 17,201 uncompleted revisions. Recent
  cycles have no process crash, but producers continue to exceed useful consumption and two new
  per-wallet processing failures raised the failed count to three; this confirms R46 is needed.
- The three error rows are classified, not unexplained data loss: two are transient bounded-probe
  statement timeouts created at 17:43 UTC while database/backup pressure was high; one is the
  intentional 10,000-trade safety-limit quarantine already known for a pathological wallet. They
  remain revision-safe for retry/quarantine, P2 is zero, and R46 does not rewrite or clear them.
- A new daily `pg_dump` generation started at `2026-08-29T17:35:17Z` and was still running at the
  preflight. One-minute load briefly measured 3.01 on the single CPU and host I/O pressure was
  elevated. Therefore transfer, `docker load` and ingestion recreate are deliberately not started
  concurrently with the backup. The safe next action is local-only artifact creation; re-run the
  resource, backup/off-site acknowledgement, disk and flow gates before opening rollout revision 80.

## R46 transfer artifact — 2026-08-29 17:59 UTC

- The exact runtime image was exported locally to
  `C:\Users\Umut\AppData\Local\Temp\walletscaner-r46-artifact\walletscaner-worker-alpha-producer-admission-r46-20260829.tar.zst`.
  It is 463,454,623 bytes, SHA-256
  `a505591b70e12dda67f8372bc52fd19f82047ab2f6a851db6b717e7aadce560c`, and `zstd -t`
  passed. This artifact remains local and the server has not received a partial or final R46 file.
- The uncompressed 463,808,512-byte intermediate also remains in that dedicated local temporary
  directory because the command environment rejected the exact local deletion operation before it
  executed. It is not in the repository or on the production host and must not be mistaken for a
  server transfer artifact. Preserve the verified compressed file until rollout and rollback
  evidence are complete.

## Objective and exclusions

- Recover safe headroom now without shortening the 48-hour raw-payload hot window or deleting
  canonical wallet evidence.
- Complete the newest PostgreSQL dump's normal independent off-site checksum/archive-list gate and
  only then allow the reviewed reconciliation script to retain the newest server generation and
  remove an older acknowledged server generation.
- Let the already recovered R42 compact materializer finish without raising CPU/RAM or bypassing
  parity. This catch-up is now complete: all 34 wallet-evidence segments are verified and none are
  pending or failed.
- Diagnose the chain-inbox payload-compaction capacity deficit and implement/deploy a bounded fix
  only after representative PostgreSQL 16 evidence and current backup/headroom gates pass.
- Keep `ENABLE_LIVE_EXECUTION=false`. Do not change B2 lifecycle/Object Lock, delete B2 objects,
  run global Docker/BuildKit/volume cleanup, use `VACUUM FULL`, retire a payload partition before its
  hot-window boundary, or touch protected co-tenant state.

## Verified pre-state — 2026-08-28 21:31 UTC

- Git `c67e6e5`; branch `main` is 175 commits ahead of origin. Preserve four pre-existing untracked
  deploy remnants; they are outside this task.
- Only Compose project `walletscaner` is listed. Twelve services run; PostgreSQL and Redis are
  healthy. R42 ingestion and materializer have restart/OOM-free identities from the completed
  rollout. Live execution is false.
- Host `/`: 72,648,024,064 total, 15,942,385,664 bytes available, 79% used. Available RAM is about
  1.04 GB and free swap about 1.98 GB.
- PostgreSQL is 21,198,404,631 bytes. Flow is current: inbox 65, dead-letter 0, open coverage
  incidents 0, last wallet trade about 120 seconds at the snapshot.
- Archive manifests: 27 verified chain-payload days and 34 verified wallet-evidence days, with no
  pending/dead-letter state. Wallet compact state is 30 verified and four pending; the earlier
  21-July timeout recovered through fail-closed retry and the newest 20-August day passed parity.
- Raw payload partitions are 26-August 1,270,988,800 bytes, 27-August 1,444,061,184 bytes and the
  open 28-August partition 1,775,902,720 bytes. The 26-August partition is not eligible until its
  full 48-hour post-partition window ends at 2026-08-29 00:00 UTC.
- Payload compaction remains overdue: 357,634 processed inbox rows are uncompacted and the oldest is
  2026-08-26 18:54 UTC. Current bounded maintenance processed 3,250 payloads in its last 42.9-second
  cycle; no partition was retired early.
- Newest server dump `memecoin_alpha_20260828T173517Z.dump` is 2,455,550,148 bytes with sidecar SHA
  `c2e6f93862613e4b8a1563f7c350fa617e4bc94fd1fe5f778d9233f801f17bad`, but lacks off-site
  acknowledgement. The prior 27-August 2,030,534,774-byte generation is sidecar/off-site verified
  and independently present locally. The 28-August scheduled local pull completed before the new
  dump existed, explaining the gap.
- Ledger revision 46 closed the old R42 shadow observation as failed because current storage runway
  is only 2.61 days above reserve. Revision 47/SHA-256 `666e27249fb9...` opened
  `current-offsite-backup-reconciliation=planned`; no data or service changed in either checkpoint.

## Completed checkpoints — 2026-08-28 21:53 UTC

- Ledger revisions 48 and 49 moved `current-offsite-backup-reconciliation` through `in_progress`
  to `completed`. Revision 49 canonical SHA-256 is
  `bfb5458e7cd9dcc930174c2ed411e6bb9f1f1af3978cab76ee43ccd32429cfaf`.
- `scripts/backup/run-offsite-backup.ps1` resumed after one harmless SFTP disconnect and completed
  successfully. The local dump is exactly 2,455,550,148 bytes with SHA-256
  `c2e6f93862613e4b8a1563f7c350fa617e4bc94fd1fe5f778d9233f801f17bad`; PostgreSQL 16 archive-list
  verification passed and the local manifest/acknowledgement were written atomically. A full
  disposable restore was not repeated in this phase; the archive-list gate is the documented daily
  off-site acceptance gate.
- The reviewed server reconciliation retained the newest acknowledged dump and removed only the
  older independently acknowledged server dump. Server free space rose from 15,942,385,664 to
  17,947,631,616 bytes. No database, B2 object, source artifact or container was deleted.
- All 12 Walletscaner services remained running; PostgreSQL and Redis remained healthy and live
  execution remained false. The 21:50 UTC health sample had inbox backlog 1, dead-letter 0, last
  wallet trade age 50.5 seconds and no observed flow outage. Its off-site warning is stale because
  that report preceded the 21:52 UTC acknowledgement; wait for the next autonomous monitor sample
  rather than treating the stale report as current evidence.
- Wallet materialization finished its catch-up: archive inventory is 27 verified chain-payload days
  and 34 verified wallet-evidence days, with no pending or failed segment. This removes the largest
  temporary source of database/WAL growth.
- The 12-hour maintenance series moved its oldest uncompacted payload cursor from
  2026-08-26 06:57:59 UTC to 18:54:06 UTC in about 11 hours 23 minutes, so useful compaction work
  advanced slightly faster than wall time. One inventory query exceeded its 15-second bound and the
  scheduler recovered; isolated live predicates then completed in under one second each, with the
  partitioned price-retention check the slowest at about 0.93 seconds. This is a reliability
  observation, not evidence of a current
  growing compaction backlog, so no CPU increase, schema migration or new image was deployed.
- The 26-August payload archive is independently verified with 125,265 source rows, Object Lock
  `GOVERNANCE`, and retention through 2026-09-26. Its 1,270,988,800-byte hot partition remains intact
  because the 48-hour boundary is not reached until 2026-08-29 00:00 UTC.

## Remaining acceptance gates

1. **Raw partition gate**: after 2026-08-29 00:00 UTC, allow only the existing manifest/Object Lock/
   policy guarded maintenance path to retire the 26-August partition. Verify exact filesystem gain
   and no held/unresolved loss.
2. **Validation**: require a clean post-catch-up 24-hour slope above the 8 GiB reserve before calling
   storage operationally sustainable. Canonical wallet retirement remains a separate future gate.
3. **Conditional capacity fix**: only if the post-catch-up series shows the uncompacted cursor losing
   ground, reproduce it in populated PostgreSQL 16 and deploy a bounded fix as a new immutable
   artifact. Do not tune a stale pre-catch-up growth slope or spend shared-host CPU pre-emptively.

## Active ingestion/queue incident — 2026-08-28 22:14 UTC

- Baseline commit is `00aaaca`; preserve the same four pre-existing untracked deploy remnants.
- The host has about 17.91 GB free, about 1.02 GB available RAM and 1.97 GB free swap. Only the
  `walletscaner` Compose project is listed. All 12 services are running with restart/OOM `0/false`;
  PostgreSQL and Redis are healthy. The current 28-August dump is sidecar/off-site acknowledged and
  independently present locally. Live execution remains false.
- Canonical flow is current: the 22:06 UTC report had inbox backlog 39/oldest 15.3 seconds,
  dead-letter 0, pool age 4.4 seconds, wallet-trade age 104.4 seconds and archive dead-letter 0.
  Direct transport telemetry has no dropped signatures, queue pressure, subscription-ACK timeout,
  heartbeat timeout or handler-admission rejection. All four discovery programs are currently
  `ok`; open coverage incidents are zero.
- Pump.fun (`6EF8...wF6P`) is not stable enough: over the six-hour log window its standard-source
  reconnect count rose by 53. It moved `5 -> 11 -> 57` around 21:52-21:53 UTC while the other three
  programs remained at four reconnects. The external socket close/error did not increment heartbeat
  or ACK timeout counters. The fixed one-second reconnect loop repeatedly reran the 500-signature
  bounded scan. Two recent incidents closed as
  `transport_recovered_gap_unreconciled`; both intervals correctly remain alpha-excluded.
- The transport is presently fresh (`slotLag=0`, raw silence about 0.25 seconds) and recovered for
  more than 30 samples. This is current liveness, not proof that the excluded intervals are complete.
- Telegram itself is healthy. In the last 24 hours it delivered 26 status/transition messages with
  maximum one attempt and no observed notification dead-letter. The intermittent messages are
  symptoms of the real coverage transitions, not Telegram API failures.
- Alpha work is separate from ingestion correctness. At the snapshot it had 6,545 background and
  159 elevated pending revisions, no priority-2 signal work, and three rows carrying an error.
  Across six hours the worker processed 7,854 wallets, but a new low-priority materialization burst
  raised total pending from 416 to about 6,700. One wallet repeatedly fails because a regenerated
  episode has a new id but the same natural episode key; repository code inserts before deleting
  the stale projection. A separate wallet had one bounded trade-probe timeout.

### Exact implementation/rollout sequence

1. Add bounded exponential reconnect backoff to the standard Solana source, reset it only after a
   stable socket window, expose attempt/next-delay telemetry, and test rapid close, stable reset,
   stale generation fencing and stop behavior. Do not change the provider route or repair cap.
2. Reorder incremental PostgreSQL ledger replacement so stale natural-key rows are deleted under the
   existing advisory transaction lock before incoming episode upsert. Add a real PostgreSQL 16
   regression where an episode id changes while its natural key stays constant.
3. Run targeted tests, typecheck/lint and the applicable database integration gate. Before any
   production mutation, build an immutable Linux artifact, verify the current backup/headroom and
   open a revision-checked ledger phase with exact R42/R34 rollback identities.
4. Recreate only `solana-ingestion` and `wallet-alpha`; abort on restart/OOM, growing canonical
   backlog, open incident, co-tenant appearance, resource breach or failed ledger retry. Verify a
   bounded canary, then record exact post-state.
5. Preserve the independent storage task: after 2026-08-29 00:00 UTC verify the existing guarded
   retirement of the 26-August payload partition and begin the clean post-catch-up 24-hour slope.

## Local implementation checkpoint — 2026-08-28 22:25 UTC

- `StandardSolanaEventSource` now uses bounded exponential reconnect backoff with jitter, resets the
  attempt only after a configurable stable-open interval, reports connection state/attempt/next
  delay/last-connect telemetry and fences timers by socket generation. Discovery defaults are one
  second initial, five seconds maximum, 60 seconds stable-open and 20% jitter. This reduces retry
  storms without changing provider routes, gap-repair caps or fail-closed coverage disposition.
- Automatic startup/reconnect backfills are coalesced per address to one running scan plus at most
  one requested rerun. Direct/manual backfill semantics are unchanged. This prevents dozens of
  short-lived sockets from queuing dozens of identical 500-signature scans.
- Incremental PostgreSQL ledger replacement now deletes stale scoped lots/episodes before inserting
  an incoming episode with the same natural key and a new deterministic id. The existing advisory
  transaction lock and database transaction still make replacement atomic.
- Provider gate: `packages/providers/src/solana-event-source.test.ts`, 50/50 passed, including rapid
  failure backoff/stable reset/stale-generation/stop and reconnect-backfill coalescing.
- PostgreSQL 16 gate: disposable `postgres:16-alpine` container, full
  `packages/db/src/postgres-evidence.integration.test.ts`, 33/33 passed. The regression replaced an
  old episode/lot id with a new id under the same natural key and proved only the new pair remained.
  The disposable container was stopped and removed. Formatting and `git diff --check` passed.
- Repository gates: `npm run typecheck`, `npm run lint` and
  `npm run build --workspaces --if-present` passed. The full Vitest run passed 415 tests, skipped 48
  environment-gated tests, and failed only three archive-artifact cases because this Windows host
  has no `zstd` executable (`spawn zstd ENOENT`). The affected archive code is unchanged; rerun the
  applicable archive cases in the zstd-equipped Linux artifact environment before deployment.
- No production file, database, service, provider route or resource limit has changed. The four
  pre-existing untracked deploy remnants remain untouched.

## Pre-artifact production checkpoint — 2026-08-28 22:34 UTC

- Source fix is committed as `13783e8915569ac348f059b44767b7b0890989bb`. The new immutable
  recipe `deploy/r43-pipeline-reliability-20260829.Dockerfile` reconstructs the reviewed R41/R42
  overlays from locally retained R40 before applying only the R43 provider and PostgreSQL files.
- Only the `walletscaner` Compose project is listed and all 12 services run. Ingestion R42,
  wallet-alpha R34 and PostgreSQL have restart/OOM `0/false`; PostgreSQL is healthy. Live execution
  is false. R42 and R34 image ids remain the exact rollback pair.
- Host free space is 17,856,360,448 bytes, available RAM about 1.03 GB and free swap about 1.98 GB.
  The newest 2,455,550,148-byte dump still has sidecar and off-site acknowledgement. Ledger revision
  49 remains completed; no production-ledger phase for R43 has opened yet.
- Latest transport health is currently `ok`: four subscribed programs, zero dropped signatures,
  queue pressure, ACK timeout, heartbeat timeout, handler rejection or open incident. Pump.fun
  remains at 57 reconnects versus four for each other program; its last two six-hour coverage gaps
  closed unreconciled and remain excluded. No new reconnect occurred after the 21:53 UTC storm.
- Canonical flow is active but bursty. The 22:23 monitor saw backlog 216/oldest 64 seconds, pool age
  0.03 seconds, wallet-trade age 70 seconds and no dead letter. A later direct sample saw 851 eligible
  inbox rows/oldest 199 seconds, pool age 5 seconds, wallet-trade age 253 seconds and no dead letter
  or open incident. This requires a second trend sample before rollout; current service liveness is
  not enough to call the backlog stable.
- Alpha queue has 7,012 ready priority-0 revisions and two delayed priority-1 errors. One is the
  expected 10,000-event safety quarantine; the other is the repeatedly observed episode natural-key
  conflict that R43 fixes. No priority-2 signal work is pending.
- Database is 21,346,065,431 bytes. The 26-August raw partition is still exactly 1,270,988,800 bytes;
  its guarded retirement boundary remains 2026-08-29 00:00 UTC and has not been bypassed.

## Immutable artifact checkpoint — 2026-08-28 22:38 UTC

- Built off-host tag `walletscaner-worker:pipeline-reliability-r43-20260829` from the committed R43
  recipe. Image id is `sha256:e87020e75036e6f0f376a516228c6546959cd3c6479840e4547d62f5f928bf3b`;
  labels are release `pipeline-reliability-r43-20260829` and source
  `13783e8915569ac348f059b44767b7b0890989bb`.
- Exact Linux artifact targeted tests passed 63/63 and image typecheck passed. A validation-only
  ephemeral derivative supplied current host Compose plus Python without adding them to the runtime
  image; the complete Linux/zstd unit suite then passed 418/418 with 48 intentional
  environment-gated skips. A disposable PostgreSQL 16 network then passed the full evidence
  integration suite 33/33. Its container and network were removed.
- Exported object is outside the repository at
  `C:\Users\Umut\AppData\Local\Temp\walletscaner-r43-artifact\walletscaner-worker-pipeline-reliability-r43-20260829.tar.zst`:
  462,791,225 bytes, compressed SHA-256
  `d99fcec70c02f5c636373fce085b0258cc0dcbee1ab36b99bde30c2d7de6b7fe`; zstd frame test passed
  and the 463,561,728-byte intermediate tar was removed after verification.
- Server updater/checkpoint scripts exactly match local SHA-256 values
  `5cc745684799...` and `a907032e824f...`; server `zstd` exists. The intended server artifact paths
  do not exist and free space is 17,837,133,824 bytes. No upload, image load, ledger transition or
  service mutation has occurred yet.

## Resumed upload checkpoint — 2026-08-28 23:06 UTC

- The interrupted SFTP/SCP session completed normally. Server staging file
  `deploy/walletscaner-worker-pipeline-reliability-r43-20260829.tar.zst.partial` is exactly
  462,791,225 bytes, matches SHA-256
  `d99fcec70c02f5c636373fce085b0258cc0dcbee1ab36b99bde30c2d7de6b7fe`, and passes server
  `zstd -t` with restored size 463,561,728 bytes. The final artifact path does not exist.
- Server free space after staging is 17,259,290,624 bytes. Ledger revision remains 49 with completed
  phase `current-offsite-backup-reconciliation`. No image was loaded and no service, environment,
  database row, Compose state or provider route changed.

## Loaded-image checkpoint — 2026-08-28 23:09 UTC

- Ledger revisions 50/51 opened `r43-artifact-stage` as planned/in-progress before mutation;
  revision 52 completed it with ledger SHA-256
  `83b5852d40dcab145dd03c042925d3a40142b2fe9e817b5b98e0b40f669ca230`.
- The verified `.partial` was atomically renamed, streamed directly through `zstd -dc` into
  `docker load` without an uncompressed server tar, and loaded as exact image id
  `sha256:e87020e75036e6f0f376a516228c6546959cd3c6479840e4547d62f5f928bf3b`. Release/source labels
  match the off-host evidence. Final compressed artifact SHA remains `d99fcec70c02...`.
- Services and environment are unchanged: ingestion still runs R42 and wallet-alpha still runs R34,
  both restart/OOM `0/false`. Only the Walletscaner Compose project is listed. Server free space is
  17,251,893,248 bytes after image load plus retained compressed transfer evidence.
- A post-stage database sample recovered from the earlier burst to inbox backlog 125, oldest 37.6
  seconds, dead-letter zero, pool age 3.3 seconds, wallet-trade age 64.3 seconds, open incidents zero,
  finality pending 67/unresolved-24h zero and durable signature pending zero.
- The active R34 alpha worker completed 94 wallets in 124 seconds with zero processing failures;
  total pending was 7,749 (7,083 background, 666 elevated, zero signal). The known natural-key row
  remains one of two delayed errors until the R43 wallet-alpha service is actually recreated.

## Ingestion canary started — 2026-08-28 23:11 UTC

- Ledger revisions 53/54 moved `r43-ingestion-canary` through `planned` to `in_progress`; revision
  54 canonical SHA-256 is
  `b019e6218e03c639090c8bec4754847dc6d134a5e9589540e1ea404755564d17`.
- The guarded updater changed only `WALLETSCANER_INGEST_IMAGE` from R42 to exact R43. The resulting
  `.env.server` SHA-256 is
  `daf91b5f2386e9677f358866eb20d1a366775b11f1d74324102395d70cec0d82`; the rendered service keeps
  `ENABLE_LIVE_EXECUTION=false`, 0.20 CPU and 160 MiB memory.
- Only `solana-ingestion` was recreated with `--no-build --no-deps`. Container
  `de09c79caabde22f67c6e81f902525b59bfb21a63fb3765bcdc08d081b55016e` runs exact image
  `sha256:e87020e75036e6f0f376a516228c6546959cd3c6479840e4547d62f5f928bf3b`, restart zero and OOM false.
  `wallet-alpha` remains on R34 and no other service was intentionally changed.
- The interruption occurred immediately after recreation. Do not rerun the updater or recreate the
  service blindly. First verify live connection/backoff telemetry, coverage state, canonical queue
  trend, freshness, resources and co-tenant absence. Complete ledger revision 55 only if those
  gates pass; otherwise atomically restore the R42 ingest key and recreate only ingestion.

## Ingestion canary completed — 2026-08-28 23:20 UTC

- Ledger revision 55 completed `r43-ingestion-canary`; canonical ledger SHA-256 is
  `ebc7c63a7627d3bc347fcccbe66a303020873b7bb9360c4a65d9e9492d68606d`.
- After the official WebSocket endpoint initially rejected/closed the four sockets, exponential
  backoff reached 37 aggregate reconnects and then stabilized. Automatic backfills were coalesced:
  only three 500-signature truncations were created rather than one scan per reconnect. Their
  incidents closed fail-closed and remain alpha-excluded; no interval was claimed complete.
- Four programs reached at least 13 consecutive healthy samples with open connections, reconnect
  attempt zero and no new reconnect after stabilization. Aggregate dropped signatures, queue
  pressure, subscription-ACK timeouts, heartbeat timeouts, handler rejection, parser failures,
  parser claim errors and finality errors were zero. Open coverage incidents, inbox dead letters,
  durable signature backlog, restart and OOM were zero.
- Startup load briefly raised canonical backlog to 322/70.5 seconds, then it drained to 75/74.8
  seconds while the oldest event watermark advanced from 23:17:45 to 23:18:04 UTC. Pools/swaps
  remained fresh and the exact R43 container stayed within 160 MiB. Only the Walletscaner Compose
  project was listed; wallet-alpha still runs R34.
- Next mutation is a distinct `r43-alpha-canary` phase. Record it as planned/in-progress before
  changing only `WALLETSCANER_RESEARCH_IMAGE`; do not repeat the completed ingestion recreation.

## Alpha canary planned — 2026-08-28 23:21 UTC

- Ledger revision 56 opened `r43-alpha-canary=planned`. The preflight proved the current research
  image is exact R34, target is exact R43, the latest 2,455,550,148-byte dump has both sidecar and
  off-site acknowledgement, free disk is 17,232,982,016 bytes and about 1.03 GB RAM is available.
- Guarded research-key dry-run changes exactly one key and predicts final `.env.server` SHA-256
  `f6896892bd831feab384f6ef3136c186a78b2d1a69cfd86dc31459946a890f03`. Target Compose rendering
  keeps wallet-alpha at 0.10 CPU, 160 MiB, `unless-stopped` and live execution false.
- The regression target is wallet `48yt...GZ6SB`, revision/completed `51/27`, priority one, already
  ready, attempt count 294 and natural-key unique-constraint error. The other error is the expected
  10,000-trade evidence-limit quarantine and must not be treated as a canary failure.
- No environment or service changed in this checkpoint. Next exact action is ledger revision 57
  in-progress, then apply only the research image key and recreate only wallet-alpha with
  `--no-build --no-deps`.

## Alpha canary started — 2026-08-28 23:22 UTC

- Ledger revision 57 set `r43-alpha-canary=in_progress`. The atomic updater changed only
  `WALLETSCANER_RESEARCH_IMAGE`; `.env.server` now has the predicted SHA-256
  `f6896892bd831feab384f6ef3136c186a78b2d1a69cfd86dc31459946a890f03` and rendering still proves
  0.10 CPU, 160 MiB and live execution false.
- Only wallet-alpha was recreated with `--no-build --no-deps`. New container
  `1b7df492ccf07f15c72a512e7fb21582ee96332dc1d98d115bfb1a03f11f76c6` runs exact R43 image
  `sha256:e87020e75036e6f0f376a516228c6546959cd3c6479840e4547d62f5f928bf3b`, restart zero and OOM false.
  Accepted R43 ingestion container `de09c79caabd` and PostgreSQL identity did not change; only the
  Walletscaner Compose project is listed.
- The interruption-safe next action is read-only: observe the first R43 alpha claims and query
  wallet `48yt...GZ6SB`. Complete revision 58 only if its natural-key error clears without a new
  failure, the expected evidence-limit quarantine remains fail-closed, and service/resource/queue
  gates pass. Otherwise restore only the research image key to exact R34 and recreate wallet-alpha.

### Bounded regression scheduling decision — 2026-08-28 23:25 UTC

- The R43 worker started normally, stayed restart/OOM-free and began a 100-wallet cycle. The exact
  regression row remained ready and unlocked at attempt 294, but its count of ready priority-one
  predecessors increased from 459 to 547 as older background rows were promoted while retaining
  their earlier `not_before` values. Waiting is therefore not a bounded canary and would not test
  the repository fix promptly.
- The next mutation may update only this one queue row's `not_before` scheduling field to an old
  timestamp, guarded by exact wallet/strategy, revision 51, completed revision 27, attempt 294,
  current unique-constraint error and no active lease. It must not change revision, evidence,
  priority, ledger rows, scores or the expected evidence-limit quarantine. The worker will then
  claim it through the normal R43 code path after its current bounded batch.
- The guarded transaction changed exactly one row and committed. Its revision/completed revision,
  priority, attempt count, error, evidence and lease state remained `51/27`, one, 294, the expected
  natural-key error, unchanged and unlocked; only `not_before` became 1970-01-01 UTC. The next step
  is read-only observation until R43 either completes it or records a new bounded failure.

## Alpha canary completed — 2026-08-28 23:28 UTC

- R43 claimed the exact regression row through its normal worker path. It advanced completed
  revision from 27 to 51, reset attempts from 294 to zero, cleared the unique-constraint error and
  released its lease. The scoped materialization contains seven episodes and fourteen lots with
  zero duplicate natural keys; its latest score was persisted at 23:22:14 UTC.
- The only remaining failed work row is the deliberate 10,000-trade `evidence_limit` quarantine;
  it remains fail-closed and was not modified. No new wallet-alpha failure was observed.
- Ledger revision 58 completed `r43-alpha-canary`; canonical SHA-256 is
  `5e13279ca964f813409d1fcc7ad2bfced2238cd88739035d9cc45bf013e0f62d`.
  Wallet-alpha container `1b7df492ccf` and ingestion container `de09c79caabd` both run exact R43
  with restart zero/OOM false; PostgreSQL identity stayed unchanged and only Walletscaner is listed.
- Post-canary canonical flow recovered to backlog 3/oldest 11.3 seconds, dead-letter zero, fresh
  pool/swap/trade evidence and zero open coverage incidents. The scheduling intervention exposed a
  separate priority-one fairness/capacity risk; it is not evidence corruption and does not block
  this repository-fix canary, but queue equilibrium still needs a measured future window.

## R43 transfer artifact retirement planned — 2026-08-28 23:29 UTC

- The loaded R43 image still has exact id `e87020e75036`. The retained server transfer file and the
  independent local file are both exactly 462,791,225 bytes with SHA-256
  `d99fcec70c02f5c636373fce085b0258cc0dcbee1ab36b99bde30c2d7de6b7fe`.
- Ledger revision 59 opened `r43-transfer-artifact-retirement=planned`; free space before removal is
  17,205,202,944 bytes. The next mutation may remove only
  `deploy/walletscaner-worker-pipeline-reliability-r43-20260829.tar.zst` after revision 60 is
  in-progress. It must preserve the loaded R43 image, R42/R34 rollback images, the local artifact,
  all database/B2 data and every service.

## R43 transfer artifact retired — 2026-08-28 23:30 UTC

- Ledger revisions 60/61 moved the exact retirement through in-progress to completed. The named
  462,791,225-byte server file was rechecked for exact size/SHA, removed and proven absent. The
  local byte-identical file remains; loaded R43, both R43 services, PostgreSQL and rollback images
  remain present and restart/OOM-free.
- Filesystem free space changed from 17,205,202,944 to the directly observed 17,663,750,144 bytes;
  allocation-level gain is 458,547,200 bytes. Revision 61 mistakenly recorded a precomputed
  `free-after=17667973120` and `bytes-recovered=462770176`, which do not match the direct `df` output.
  Do not hide or reuse those two values. Open a new read-only verification ledger phase that records
  the actual figures; no file, service, environment, image or database mutation is needed.
- Ledger revision 62 successfully opened `r43-transfer-retirement-verification=planned`. A direct
  planned-to-completed transition was correctly rejected by the ledger state machine and changed
  nothing else. Resume with revision 63 `in_progress`, then revision 64 `completed`; do not rerun
  file removal.
- Ledger revisions 63/64 then completed the read-only correction. Revision 64 canonical SHA-256 is
  `05dc21dc7e7c9c2767889df9a8a3d7ce8da7a8bf4400f0fd0c4e6a936c3684be`; it explicitly records the
  17,663,750,144-byte removal-time observation and 458,547,200-byte allocation gain. The transfer
  artifact remains absent and no second removal or service/data mutation occurred.

## Autonomous 26-August payload retirement observed — 2026-08-29 00:06 UTC

- The 48-hour hot-window boundary passed at 00:00 UTC. The partition was still present at 00:05:22,
  then the read-only monitor observed `chain_event_payloads_20260826` absent at 00:05:53 UTC during
  the first normal maintenance cycle. No manual maintenance command or `DROP` was run.
- Filesystem free space moved from the last pre-retirement observation of 17,598,472,192 bytes to
  18,864,463,872 bytes. This point-in-time delta is 1,265,991,680 bytes; concurrent ingestion means
  it must not be substituted for the relation's exact pre-drop 1,270,988,800-byte catalog size.
- Next exact action is read-only verification of the completed maintenance record, verified archive
  manifest/Object Lock evidence, unresolved hold count, database/flow state and unchanged service
  identities. Only after all gates pass should a new ledger verification phase be recorded.
- Verification passed. Maintenance completed at 00:06:17 UTC and reported one retired payload
  partition, zero unresolved holds and zero archive blocks. Manifest 99 remains verified for 125,265
  rows, 273,108,927 archive bytes, Governance retention through 2026-09-26. Direct database state
  has no 26-August partition or hold rows; PostgreSQL is 20,355,218,455 bytes.
- Canonical flow remained live at backlog 91/53 seconds, dead-letter/open incident/signature backlog/
  finality-unresolved `0/0/0/0`, with fresh pool/swap/trade evidence. All four inspected services
  kept their identities and restart/OOM `0/false`; only Compose project Walletscaner is listed.
  Host free space is 18,869,415,936 bytes and the current verified backup remains acknowledged.
- Ledger revisions 65-67 completed `26aug-payload-retirement-verification`; revision 67 canonical
  SHA-256 is `9915ecd12af45e5d828786c015ae2e0237691083b7e0952250ae5d43775e1494`.

## Rollback and next exact action

- Rollback/recovery evidence is the independently verified local 28-August dump plus the same newest
  acknowledged server generation. R42 and R34 images remain exact service rollback points; manifest
  99 plus its retained B2 object is the retired raw-payload recovery point.
- Do not rerun either R43 canary, the exact transfer-file removal or the 26-August retirement. Let the
  system run for a clean 24-hour post-retirement window, then recompute recent disk/database slopes,
  reserve runway, compaction cursor progress and archive/compact backlog. In the same future read-only
  review, measure P1 producer/consumer slope and oldest-lane age; P2 signal work must remain current.
  Only a new measured deficit should open another implementation/deployment phase.

## 08:44 TRT read-only flow review — 2026-08-29 06:00 UTC

- R43 discovery is operational: all four program sources are open with reconnect attempt zero,
  797 consecutive healthy samples, no drops, queue pressure, ACK/heartbeat timeout, handler error
  or open coverage incident. The only four incidents in the eight-hour window were startup gaps;
  they closed unreconciled and remain correctly excluded from alpha coverage. Health-sample
  notification-to-observation latency was approximately 0.98s p50, 1.25s p95 and 1.36s p99.
- Canonical flow was current at backlog 3/13.6s, dead-letter zero, fresh pool/swap/wallet-trade
  evidence, signature backlog zero and unresolved 24-hour finality zero. Wallet alpha drained from
  more than 8,500 pending revisions to hundreds; priority one held one normal ready item plus the
  intentional `evidence_limit` quarantine, and priority two remained current at zero.
- The separate exact-pool trade source exposed a real saturation incident. One configured pool,
  ordered per address and limited by `SOLANA_TRANSACTION_REQUEST_INTERVAL_MS=125`, saw queue depth
  rise 0 -> 352 -> 618 -> 721 -> 852 -> 1,050 while queue delay rose to 113,990ms. The existing
  high-water guard then durably marked coverage incomplete and purged 1,081 queued notifications;
  there was no hidden admission or false completeness, but more than 100 seconds of stale work was
  spent before the correct fail-closed outcome. Eight-hour logs show 54 capacity rotations, 49
  cursorless initial backfill truncations and one queue high-water release.
- Do not enable same-address concurrent cursor writes: the ordered cursor invariant and lack of a
  trade durable-signature store make that unsafe. Do not route every fetch through Helius: observed
  request volume would exceed the one-million-credit free allocation. Implement a trade-only,
  bounded maximum live queue-delay option that invokes the existing durable coverage-release path
  well before the 2,000-item queue limit. It must be disabled by default for other source users,
  emit diagnostics, preserve the admitted head and purge only the released address's queued work.
- Storage remains a parallel waiting gate, not forgotten: DB was 21,200,059,415 bytes and disk free
  18,026,479,616 bytes. The latest maintenance run completed, compacted 8,250 payloads and advanced
  oldest uncompacted evidence from 01:59 to 03:46 UTC, but the resulting 7,232-second lag is still
  above the one-hour target. The 26-August partition remains absent, manifest 99 remains verified,
  archive/compact dead-letter and mismatch counts are zero, and a clean 24-hour slope is still
  required before sustainability can be validated.

## R44 local implementation and artifact — 2026-08-29 06:06 UTC

- Commit `1252b2b93e98911377ad101d3ef5fa41cd8b6c5d` adds an optional standard-source
  `maximumLiveQueueDelayMs`, exposes it in diagnostics and reports one deduplicated `stale`
  pressure episode until a fresh event or unsubscribe resets that address. Only the RPC trade source
  wires the 15,000ms bound; discovery behavior is unchanged. The worker reuses its existing durable
  persist-before-unsubscribe coverage release, so the admitted head remains processable while only
  that address's queued work is purged and its interval remains incomplete.
- Provider regression passed 51/51. Local typecheck, lint and workspace build passed. The Windows
  full suite passed 416 tests apart from the three expected missing-`zstd` artifact cases. Exact R44
  Linux targeted tests/typecheck passed; a validation-only derivative added Python and the current
  Compose file without changing the runtime image and passed 416/416 with 48 intentional
  database-environment skips. PostgreSQL schema/repository code did not change; R43's previously
  completed 33/33 PostgreSQL 16 gate remains the database baseline.
- Immutable runtime tag `walletscaner-worker:trade-latency-r44-20260829` has local image id
  `sha256:44e6beae6b0e8c00bb26a466c287109070528cc4663fd99bdfe48a45cd8235cb`, release label
  `trade-latency-r44-20260829` and source label `1252b2b93e98911377ad101d3ef5fa41cd8b6c5d`.
  Recipe commit is `4ea474a`. No production file, environment, image or service has changed yet.
- Before deployment, refresh exact R43 ingestion/DB/service identities, live false, verified backup,
  disk/RAM/WAL/temp headroom, current flow and protected project inventory. Export/hash/load R44,
  prove the rendered service keeps 0.20 CPU/160 MiB and live false, then open a revision-checked
  ingestion-only canary. Recreate no dependency and roll back only to exact R43 on any hard gate.

This checkpoint was committed before any R44 production mutation. On interruption, verify the
production ledger and actual ingestion container/image before exporting, loading or recreating
anything; never infer deployment from the presence of the local image.

## R44 production preflight — 2026-08-29 06:10 UTC

- Only the `walletscaner` Compose project is listed with 12 running services. Exact ingestion is
  still R43 container `de09c79caabd...`, image `sha256:e87020e75036...`, restart/OOM `0/false`,
  0.20 CPU, 160 MiB and live execution false. PostgreSQL remains container `a5c2b747d129...`,
  healthy, restart/OOM `0/false`; no service has been changed.
- Host free space is 17,930,731,520 bytes, available RAM 1,032,515,584 bytes and free swap
  1,993,351,168 bytes. PostgreSQL is 21,277,170,711 bytes and WAL is 536,870,912 bytes. The newest
  dump is still `memecoin_alpha_20260828T173517Z.dump`, 2,455,550,148 bytes, sidecar present and
  off-site acknowledged with SHA-256 `c2e6f93862613e4b8a1563f7c350fa617e4bc94fd1fe5f778d9233f801f17bad`.
- Canonical flow samples were 230/101s then 245/73s pending/oldest, with dead-letter, unresolved
  24-hour finality and signature backlog all zero and wallet trades about 90 seconds fresh. This is
  a bounded fluctuating parser backlog, not a monotonic stop; it remains a canary rollback metric.
- Discovery remains open and current for all four programs with no post-startup incident. The
  separate trade lane confirms the target failure: maximum queue delay 127,100ms, high-water 1,620,
  5,676 purged notifications and 125 coverage-excluded pools. Current queue had returned to nine;
  no false-complete coverage or dead-letter was observed.
- Production ledger remains revision 67/SHA-256
  `9915ecd12af45e5d828786c015ae2e0237691083b7e0952250ae5d43775e1494`. The next safe action is to
  export and hash the already tested R44 image locally, stage it on the server, verify/load it and
  then open a revision-checked ingestion-only canary before changing `.env.server` or a container.

## R44 immutable transfer artifact — 2026-08-29 06:11 UTC

- The tested local image was exported to the non-repository artifact
  `walletscaner-worker-trade-latency-r44-20260829.tar.zst`. Its exact compressed size is
  462,877,766 bytes and SHA-256 is
  `54d9f8a4a1a4aaef7cd4df281fd385d56ad7bf9c816bb61c3bce43851bff35cf`.
- Independent `zstd -t` passed and reported a 463,629,312-byte decoded stream. The temporary
  uncompressed tar was removed only after that verification; the verified compressed artifact and
  loaded local image remain. Production is still unchanged at ledger revision 67 and R43.

## R44 staged production artifact — 2026-08-29 06:19 UTC

- Ledger revision 68 opened `r44-trade-latency-ingestion-canary=planned`; its canonical SHA-256 is
  `d1fd312a5610653cd0e203007bf5d2c3af132ec41056094f311b85f24b8926ed`. The earlier dry-run rejected
  a JSON evidence argument before any mutation; the applied checkpoint uses supported key/value
  evidence and is the authoritative state.
- SCP wrote only the exact `.partial` target. Server size and SHA matched 462,877,766 bytes and
  `54d9f8a4a1a4aaef7cd4df281fd385d56ad7bf9c816bb61c3bce43851bff35cf`; server-side `zstd -t`
  independently passed. Only then was it atomically renamed to the final exact artifact name.
- Running R43, `.env.server`, PostgreSQL and all containers remain unchanged. Next action is a
  low-priority `docker load`, exact R44 image/label verification, then revision 69 `in_progress`
  before the image environment or ingestion container is changed.

## R44 loaded and rollout in progress — 2026-08-29 06:21 UTC

- Server `docker load` produced the exact local image ID
  `sha256:44e6beae6b0e8c00bb26a466c287109070528cc4663fd99bdfe48a45cd8235cb`; release/source labels
  exactly match `trade-latency-r44-20260829` and commit `1252b2b...`. Disk free after staging/loading
  was 17,421,438,976 bytes.
- Ledger revision 69/SHA-256 `8b4711a747194ddaf71a48136d0968379f0b6bf55805ab1a758ba4a094af41ca`
  is `in_progress`. Only `WALLETSCANER_INGEST_IMAGE` was atomically changed from exact R43 to exact
  R44; `.env.server` SHA moved from `f6896892...` to `0273ae86...` without exposing its contents.
- The rendered ingestion service proves image R44, CPU 0.20, memory 167,772,160 bytes and live
  execution false. The old R43 ingestion container is still running at this checkpoint. Next exact
  mutation is `up -d --no-build --no-deps --force-recreate solana-ingestion`, followed immediately
  by identity, resource, flow and fail-closed startup verification. Roll back env/container to exact
  R43 on a hard gate.

## R44 ingestion-only canary running — 2026-08-29 06:23 UTC

- Only `solana-ingestion` was recreated with `--no-build --no-deps`. New container
  `bd9caf7041ec...` runs exact R44 image `sha256:44e6beae...`, restart/OOM `0/false`, 0.20 CPU,
  160 MiB and live false. PostgreSQL `a5c2b747d129...` and wallet-alpha `1b7df492ccf0...` identities
  are unchanged and restart/OOM-free; all 12 Walletscaner services remain running.
- R44 live diagnostics expose `maximumLiveQueueDelayMs=15000`. Trade transport is open/OK with
  queue zero and no new pressure/purge episode. The first startup load briefly showed 236 canonical
  events and 196 seconds oldest age, then drained 236 -> 51 -> 0 with parser claim errors zero.
  Dead-letter, unresolved 24-hour finality and signature backlog stayed zero; wallet trades remained
  fresh.
- Startup opened two expected `backfill_truncated` incidents for `6EF8...` and `pAMM...`; both
  closed after 60 seconds as `transport_recovered_gap_unreconciled`. The next health sample shows
  all four program sources open/OK/current, aggregate discovery OK and open incident count zero.
- The deploy is operational but the new breaker is not yet real-data validated because no new
  post-R44 saturated hot-pool episode has occurred. Keep ledger revision 69 in progress through a
  bounded clean observation, then complete the canary if restart/OOM/backlog/coverage/error gates
  remain clean; real saturation evidence becomes a separate waiting acceptance gate.

## R44 canary accepted — 2026-08-29 06:27 UTC

- Multiple post-startup samples passed. Canonical backlog drained to zero and remained bounded
  (latest point 18/16 seconds), open incidents/dead-letter/unresolved finality/signature backlog were
  zero, discovery stayed all-four current/OK and wallet trades remained fresh. Ingestion restart/OOM
  remained `0/false`; parser errors were zero. Post-deploy trade delay stayed below 5,243ms with no
  pressure/purge event, and the configured breaker remained 15,000ms.
- Independent operations health still says degraded only for storage metrics: database above the
  legacy 12 GiB warning threshold, payload compaction lag about 7,239 seconds and the pre-clean-window
  runway estimate below 14 days. Flow, backup and coverage gates are healthy. One post-deploy trade
  coverage exclusion was normal `rpc-trade-observation-capacity-rotation`, not an error or stale
  breaker activation.
- Ledger revision 70/SHA-256 `757efae5266d4bf14e9c47dc855a997843442927319374e96bdf01336aed858a`
  completed the ingestion-only canary. R44 is operational. Natural hot-pool stale-breaker behavior
  and the clean 24-hour storage slope remain explicitly waiting, not validated.
- The verified 462,877,766-byte transfer artifact still occupies server disk. Before removing only
  that exact file, prove its size/SHA again, prove the byte-identical local artifact, loaded R44 and
  exact R43 rollback image remain, and use a separate revision-checked retirement phase.

## R44 transfer retirement armed — 2026-08-29 06:29 UTC

- The local and server artifacts were rehashed at the exact expected 462,877,766 bytes and
  SHA-256 `54d9f8a4...35cf`. Loaded R44 remains exact image `44e6beae...`; R43 rollback remains exact
  image `e87020e7...`; running ingestion is exact R44 with restart/OOM `0/false`.
- Ledger revisions 71/72 moved `r44-transfer-artifact-retirement` through `planned` to
  `in_progress`; revision 72 canonical SHA-256 is
  `bb85994db674df7957a70f24b29a48a66ddc3d696a17d3e0401cfcae934baad2`.
- Next exact action is one guarded removal of
  `/opt/walletscaner/deploy/walletscaner-worker-trade-latency-r44-20260829.tar.zst`, only if its
  resolved path, size and SHA still match. Preserve all images, the local artifact, database, B2 and
  services; immediately verify absence, disk gain, identities and flow before revision 73.

## R44 natural saturation finding — 2026-08-29 06:33 UTC

- The exact transfer file was removed and revision 73/SHA-256
  `8267911fc993bd3b1b675c8ee31c002f5af8937b4f68c0bd1dcce51222c42b92` completed verification.
  Direct free space moved 17,410,514,944 -> 17,873,399,808 bytes, a 462,884,864-byte allocation
  gain. R44/R43 images, local artifact, database, B2 and all services remain.
- Natural traffic then activated `rpc-trade-queue-stale`: pressure count became one and 14 queued
  notifications were purged through the durable coverage release. Discovery/canonical flow stayed
  healthy, proving fail-closed behavior, but the triggering health sample reported 35,187ms queue
  delay against the configured 15,000ms threshold.
- Root cause is exact: R44 checks queue age only when an item begins processing. If the admitted
  per-address head is blocked in RPC timeout/retry work, no queued item reaches that check at the
  threshold. R44 reduced the prior 127,100ms incident but does not enforce a hard 15-second wall
  bound.
- Do not call the R44 natural breaker validated. Implement a bounded one-timer-per-address watchdog
  that examines only queued live work, fires pressure while the admitted head may remain in flight,
  is cleared on unsubscribe/stop, and records the observed pressure age. Preserve ordered admission,
  durable-before-unsubscribe release and default-disabled behavior. This is R45; production remains
  safely on R44 until its tests and immutable artifact pass.

## R45 local implementation — 2026-08-29 06:38 UTC

- The standard source now owns at most one stale-queue timer per queued address. It scans the bounded
  in-memory queue only when arming/firing, does not poll, and fires `stale` from wall-clock queue age
  even while that address's admitted head remains blocked. Unsubscribe/stop clear timers; discovery
  still leaves the option disabled.
- Pressure diagnostics now record time, reason and observed oldest queue delay. The existing worker
  event includes that delay plus queue size, while durable coverage persistence still completes
  before unsubscribe/purge. No concurrency, retry, CPU/RAM or provider route changed.
- The new blocked-head watchdog test proves pressure fires and the queued item is purged before the
  admitted head is released; the head then finishes alone. Provider regression is 52/52. Typecheck,
  lint, diff-check and workspace build pass. The broad Windows suite is 417 passed/48 intentional
  database skips with only the same three local `zstd ENOENT` artifact failures; an exact Linux/zstd
  full gate is still required before production.
- Production remains exact R44 and ledger revision 73. Next action is commit the coherent R45
  source/tests/docs/recipe, build an immutable R45 from exact R44, run exact-image targeted/full
  gates, then repeat the backup/resource/flow preflight before opening a new revision-ledgered
  ingestion-only canary.

## R45 immutable image and full gate — 2026-08-29 06:40 UTC

- Source/recipe commit is `f17d8216a915845ff408403e31d4f02024f0aa07`. The minimal runtime tag
  `walletscaner-worker:trade-watchdog-r45-20260829` is exact local image
  `sha256:bc17668d2eea1c28692ff819a23419e42548dfa30a0b9be12cc7fdc2e6033722`, labeled with that source
  and release `trade-watchdog-r45-20260829`.
- The exact runtime image passed provider 52/52 and typecheck. A validation-only derivative of the
  prior Python/Compose validation base passed the complete Linux/zstd suite: 417/417 with 48
  intentional database-environment skips. PostgreSQL/schema code is unchanged and the R43 33/33
  PostgreSQL 16 gate remains applicable baseline.
- R44 production is still unchanged and healthy. Next action is refresh current backup, disk/RAM,
  exact R44/service identities, flow/coverage and ledger revision 73; then export/hash/stage R45.
  Open a new ledger phase before the first server artifact mutation and recreate only ingestion.

## R45 production preflight — 2026-08-29 06:41 UTC

- Only the 12-service Walletscaner project is listed. R44 ingestion, PostgreSQL and wallet-alpha
  retain exact identities with restart/OOM `0/false`; ingestion is 0.20 CPU/160 MiB/live false.
  Host has 17,796,046,848 bytes free, about 1.02 GB available RAM and 1.97 GB free swap. PostgreSQL
  is 21,380,217,879 bytes with 536,870,912 bytes WAL.
- Backup remains the verified/off-site-acknowledged 28-August 2,455,550,148-byte dump with SHA-256
  `c2e6f938...17bad`. Ledger is revision 73/SHA-256 `8267911f...42b92` completed. Canonical backlog,
  dead-letter, open incidents and unresolved finality are zero; signature queue is two fresh items,
  wallet trade age 15.5 seconds and all four discovery programs are current/OK.
- R44 natural pressure has now reached two events, maximum dequeue delay 41,406ms and 302 purged
  notifications, reinforcing the blocked-head watchdog requirement. R45 does not change provider or
  resource configuration.
- Alpha work is a separate measured concern: 2,002 pending/2,000 ready, P0/P1/P2 1,906/96/0,
  non-quarantine failures zero and one intentional quarantine. Recent cycles process 71-100 wallets
  with zero cycle failure but producer revisions exceed background drain; the signal lane remains
  current. Do not conflate this with the R45 transport canary or claim alpha equilibrium.

## R45 immutable transfer artifact — 2026-08-29 06:43 UTC

- Local artifact `walletscaner-worker-trade-watchdog-r45-20260829.tar.zst` is exactly 462,948,255
  bytes with SHA-256 `9539118b136ef094d47610e61d4f70d31fb8f98d4a8a675bb6521c26cfd7e80f`.
  Independent `zstd -t` passed and reported a 463,697,408-byte decoded stream. The temporary raw tar
  was removed only after proof; the compressed artifact and loaded local image remain.
- Production is unchanged at R44/revision 73. Next action is open R45 `planned`, copy only to an
  exact `.partial` server path, verify size/SHA/zstd, atomically rename/load and then enter
  `in_progress` before changing only the ingestion image key/container.

## R45 staged and loaded — 2026-08-29 06:49 UTC

- Ledger revision 74/SHA-256 `b1538d7705c5acb78fca82739b6c673258da94055ad2148560721f133ff4763e`
  opened the canary as planned. SCP targeted only `.partial`; server size/SHA and `zstd -t` matched,
  then the artifact was atomically renamed.
- Low-priority load produced the exact local R45 image ID `sha256:bc17668d...3722` and exact
  release/source labels. Server free space after staging/loading is 17,269,272,576 bytes. R44,
  `.env.server`, containers and database remain unchanged.
- Next action is revision 75 `in_progress`, atomically change only `WALLETSCANER_INGEST_IMAGE`, prove
  the rendered 0.20 CPU/160 MiB/live-false contract and recreate only `solana-ingestion` with no
  dependencies. Roll back to exact R44 on a hard gate.

## R45 rollout mutation armed — 2026-08-29 06:50 UTC

- Ledger revision 75/SHA-256 `bae1a762c97fab07feb33244d6204cd70a295483e4aae32ceb704965774968b8`
  is in progress. Only the ingestion image key was atomically moved R44 -> R45; `.env.server` SHA
  moved `0273ae86...` -> `7f6704a8...` without exposing contents.
- Render proves exact R45, CPU 0.20, memory 167,772,160 bytes and live false. The R44 container is
  still running at this checkpoint. Next exact mutation is an ingestion-only no-dependency recreate,
  then immediate identity/startup/backlog/coverage verification.

## R45 natural-traffic audit — 2026-08-29 17:14 UTC

- The interrupted recreate did complete. Production ingestion is exact R45 image
  `sha256:bc17668d2eea1c28692ff819a23419e42548dfa30a0b9be12cc7fdc2e6033722`, container
  `501f8cc817154ae2a2e839375f415ba0128a2435d04140d261d1e7a58f2537d7`, at 0.20 CPU/160 MiB with
  live execution false. PostgreSQL and wallet-alpha identities are unchanged; all three have
  restart/OOM `0/false`. Ledger revision 75 is still `in_progress`, so do not recreate or redeploy.
- Across 568 health samples from 06:51 through 17:14 UTC, the trade source remained current/OK.
  The wall-clock watchdog fired 185 `rpc-trade-queue-stale` durable releases: p50 15,001ms, p95
  15,056ms, p99 15,998ms, maximum 18,374ms, with only one event above 16 seconds and none above
  20 seconds. This is the required real-traffic evidence that R45 closes R44's 35-41 second and the
  earlier 127-second blocked-head gap without increasing CPU/RAM or silently admitting stale work.
- Current canonical flow is healthy: inbox/dead-letter/open incidents/unresolved-24h/signature queue
  are all zero; latest pool and wallet trade were about four and 107 seconds old. Three startup
  `backfill_truncated` incidents closed within 60 seconds. One late callback after a separately
  durable bootstrap rejection logged `Trade backfill truncated for unknown active pool`; it did not
  reopen coverage, create backlog or lose the fail-closed record, but its idempotent race handling
  should be corrected in a separate bounded source phase rather than hidden in this canary.
- Host free space is 15,909,076,992 bytes (79% used), available RAM about 1.04 GB and free swap about
  1.99 GB. PostgreSQL is 22,676,782,103 bytes and WAL 654,311,424 bytes. Payload compaction has
  recovered below its one-hour target (about 23 minutes beyond the 48-hour hot window), with 63
  verified payload archive segments and 35 verified wallet compact segments and no pending/dead
  segment. The 27-August payload partition becomes normally retirement-eligible at 30-August 00:00
  UTC and is about 1.47 GB including indexes; no early retirement is authorized.
- The exact 462,948,255-byte R45 transfer artifact remains on the server. Retire it only after
  revision 76 completes the canary and a separate planned/in-progress ledger phase proves exact
  path/size/SHA, the byte-identical local rollback artifact, running/loaded image identities and
  current backup/headroom.
- Alpha research is a separate operational bottleneck: 8,109 pending jobs, 8,106 ready, oldest ready
  about 5.65 hours, P0/P1/P2 `8108/1/0`, no non-quarantine failures and no signals. Recent cycles
  process 66-100 wallets without cycle errors, but producer revisions exceed background drain. Do
  not spend shared-host CPU blindly; measure revision churn/coalescing and producer ownership first.
- Latest daily dump remains independently sidecar/off-site acknowledged (28 August, 2,455,550,148
  bytes, SHA-256 `c2e6f938...17bad`, about 21 hours old). A scheduled backup is approaching; do not
  create an extra manual dump. The next exact action is a fresh bounded live gate, then either mark
  R45 revision 76 complete or roll back on a newly observed hard failure.

## R45 canary completed — 2026-08-29 17:21 UTC

- A fresh 17:19 UTC health gate remained clean: canonical backlog/dead-letter/open coverage incident
  were `0/0/0`, unresolved 24-hour finality and signature backlog were zero, finality pending was
  seven fresh items, last pool/wallet trade ages were 5.6/24.6 seconds, and archive pending/verify
  pending/dead were `0/0/0`. Ingestion, PostgreSQL and wallet-alpha remained restart/OOM-free.
- Revision-checked ledger revision 76/SHA-256
  `95786f13ba2685f5f7a4da27a2ed353d669de1297abd3387af7ef74c9b384954` completed
  `r45-trade-watchdog-ingestion-canary`. This changed only the machine-readable rollout record; no
  service, configuration, database row, archive object or payload was changed.
- R45 is operational. Storage equilibrium and alpha queue equilibrium remain separate unvalidated
  gates. Next, open a new exact transfer-artifact retirement phase; do not remove any file before
  revision-checked planned/in-progress records and local/server SHA plus rollback-image proof.

## R45 transfer-artifact retirement preflight — 2026-08-29 17:22 UTC

- The local and server transfer artifacts independently match at 462,948,255 bytes and SHA-256
  `9539118b136ef094d47610e61d4f70d31fb8f98d4a8a675bb6521c26cfd7e80f`; a new low-priority server
  `zstd -t` decoded 463,697,408 bytes successfully.
- Running and loaded R45 is exact image `sha256:bc17668d...3722`; exact R44 rollback image
  `sha256:44e6beae...35cb` remains loaded. Ingestion is running with restart/OOM `0/false`. Server free
  space before retirement is 15,896,514,560 bytes. Revision 76 is completed and the latest health
  gate has a verified/off-site-acknowledged dump plus healthy flow.
- The only proposed deletion is the exact staged transfer file under `/opt/walletscaner/deploy/`.
  Keep the byte-identical local artifact, both Docker images, database, archives, B2 and all services.
  Next action is revision 77 `planned`, not file removal.

## R45 transfer-artifact retirement planned — 2026-08-29 17:23 UTC

- Ledger revision 77/SHA-256 `e7d7c3248f240cb484e5d411d00df223a519c09fa8d707a33fc4c5f490dd77da`
  records the exact artifact bytes/SHA, R45/R44 image identities and pre-removal free bytes.
- No file or service changed. Next action is a fresh server path/size/SHA guard followed by revision
  78 `in_progress`; only after that may the one exact server transfer file be removed.

## R45 transfer-artifact retirement armed — 2026-08-29 17:24 UTC

- A fresh resolved-path, 462,948,255-byte and full SHA-256 guard passed. Ledger revision 78/SHA-256
  `456bd4b331d80910ae2b72f7d8901d83862a4b0c54f95d92aaaef5377b99ef85` is `in_progress`.
- The artifact still exists and no service changed. Next action is one guarded removal of only that
  path, followed immediately by absence, allocation gain, image, container and live-flow checks.

## R45 transfer artifact removed — 2026-08-29 17:24 UTC

- The in-shell path/size/SHA guard passed again and only the exact server transfer file was removed.
  It is absent. Free allocation moved 15,890,284,544 -> 16,353,013,760 bytes, a 462,729,216-byte
  gain; filesystem allocation accounts for the small difference from compressed byte length.
- Exact running/loaded R45 and loaded R44 rollback images remain. Ingestion, PostgreSQL and
  wallet-alpha remain running at restart/OOM `0/false`; no container was recreated or restarted.
- Ledger revision 78 remains `in_progress`. Next action is a fresh bounded flow/coverage health read,
  then revision 79 completion if it remains clean. Do not repeat the removal.

## R45 transfer-artifact retirement completed — 2026-08-29 17:25 UTC

- The next monitor sample at 17:24:48 UTC confirmed backlog/dead-letter/unresolved-24h/signature
  queue `0/0/0/0`, last pool/wallet trade ages 1.0/56.0 seconds, archive pending/verify/dead
  `0/0/0`, and no post-removal ingestion error. The exact file remains absent.
- Ledger revision 79/SHA-256 `a0d6bf7ce0d13b1b9495b73fdb602a129faf406226d4e22dfabe1f9db30b6b47`
  completed the phase. The report's transient one-minute load-per-CPU 1.62 warning and existing
  database/runway warnings do not represent a flow outage; no resource limit was increased.
- R45 work is coherently closed. The next phase is read-only diagnosis of the growing background
  alpha revision queue and the single late backfill callback race; neither justifies blind CPU/RAM
  expansion or another production mutation.
