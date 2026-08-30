# Walletscaner Current State

This is a compact, dated handoff for agents. It is not production authority. Refresh live state
before every operational claim or mutation.

## 2026-08-30 21:44 UTC maintenance safety containment

- Only data-maintenance is stopped after confirming its R36 price-retention query uses ctid alone
  across daily partitions. PostgreSQL16 regression proves a fresh row can be deleted through a
  physical-row collision. Local query now uses(tableoid,ctid); historical impact is not yet counted.
- Other11running services remain unchanged, including ingestionR46/alphaR43/PG/Redis/archive/backup;
  protected co-tenant inventory empty. Free14.60GB, WAL486.55MB, temp48KiB, availableRAM1015MiB.
  Current dumpSHA/offsiteACK verified, age25.34h; no canonical data deletion occurred in this task.
- Maintenance ledger reports/deploy/maintenance-r47-20260831.json revision3 records completed
  containment, not completed repair. Do not restart the old unsafe image. A copy-only derivative of
  the exact loadedR36 image avoids local Docker failure and any dependency/network/server build.
- Separate inventory bug:37completed reports/9unhandled inventory timeouts in24h. Local repair
  isolates advisory probes, records unknown/partial/failure explicitly, checks report freshness
  and remains compatible with schema051. Final nativePG16 gate537/537passed with no skips;
  typecheck/lint pass. Exact Linux artifact and named maintenance/monitor canary remain pending.
- Latest21:34 operational snapshot: inbox0/dead0, finality14fresh/unresolved0, wallettrade15s.
  Alpha pending19,893 and growing; DB24.28GB/free14.63GB; canonical-wallet equilibrium not solved.

## 2026-08-30 21:18 UTC queue/storage remediation checkpoint

- R46 ingestion now runs: containerb524cc46b48840767325b9c3746b9308f1ee2664de58c8f31637fec0c2b1eaa3,
  imagee376cfd6704cd5a0ad799e338b9a3d57ef9c4204eccba81a5efdd439fdf2380b,
  source53b5949dce301f6f20dc9f6d0fea0831a23b80d4, start20:58:31UTC. Only ingestion was recreated;
  CPU0.20/memory160MiB unchanged. PG/Redis/alpha identities and protected co-tenant unchanged.
- Pyth/Jupiter saved auth is loaded (no values exposed). New sample1113oracle-converted and19
  observed-execution trades versus79proxy; latest/historical Pyth successful, no historical errors.
  Live execution remains false; no paper/tape/alpha delivery activation or schema change.
- **Capacity acceptance failed:** at21:13UTC alpha pending19,446, still growing. R46 suppresses
  sub-threshold enrichment revisions but does not solve expensive full-history/elevated work.
  Further rollout halted; ledgerrevision3 records failure, not a falsely successful capacity gate.
  SafeR46 remains operational; exactR45 rollback retained. Inbox0/dead0/unresolvedfinality0 and
  openincidents0 in canary. Do not advise an unattended week on this capacity evidence.
- Server ledger reports/deploy/queue-storage-r46-20260830.json revision6 completes only a separate
  exact transfer-file retirement. Rehashes matched;463454208allocated bytes returned to filesystem.
  Free space14,651,949,056bytes. Loaded images/local artifact and all canonical/B2 evidence remain.
  There is no active production mutation to repeat. Wallet storage equilibrium is still unproven.
- Storage audit found a missing accounting invariant:051 round-trip facts do not preserve every
  partial-sale sample, and scalar lots omit exact remaining cost/quality continuation state.
  No reader cutover or canonical retirement is safe based only on those existing parity receipts.
- Local-only `fifo-continuation-v1` shares the existing ledger evaluator, carries bounded open state,
  emits per-sale deltas and rejects late/corrected/precision-changing history. Prebuilt ledgers can
  feed scoring without historical trade rows. Generated9000+120trade test: exactparity,
  5511bytecheckpoint,296msfull vs5msdelta; NOT production/total-size proof. Database CAS/invalidation,
  durable sale facts/followability read, full restore, populated dual-read and retirement remain.
- Current backup independently rehashed on server/local at2,770,884,949bytes; exactSHA and PG16
  archive-list passed, offsite acknowledged. Latest generation full restore still not verified.

## 2026-08-30 20:29 UTC read-only live alpha audit

- No canonical wallet-alpha signals; no latest watch/candidate/validated-paper wallets. V4 has65
  non-deliverable shadow candidates (15/24h), not alpha signals. Only5/15 recent candidates retain
  a same-pool +20–22m price mark;2 are marked rugged. No executable-fill inference is permitted.
- Latest complete contextual-survival backtest remains the29-Aug reject. Paper has no open
  positions and no running worker: V1/V2/V3 cash is$3.04/$96.13/$85.84 from separate$100 starts.
- Live ingestionR45/alphaR43 remain unchanged; all running services restart0/OOMfalse, PG/Redis
  healthy. Last inbox7/dead0; newest wallet trade15s; finality unresolved24h0. Trade coverage remains
  focused on one active pool, not full-network wallet coverage. Zero current transport incidents
  coexists with569 closed/unreconciled historical intervals that remain excluded.
- Pyth/Jupiter keys are still absent from running ingestion, though safely saved earlier. Latest
  persisted SOL/USD oracle is26-Aug16:16 UTC; historical requests/errors3,435/3,435. Recent1h trades:
  5,419price-proxy,186unpriced,0HQ. R46 admission and052/053 decision-tape rollout remain undeployed.
- Alpha pending10,788 ->18,265 across approximately24h/870cycles despite42,150 revision evaluations;
  most pending work is price enrichment. No transient failure in the current queue; one evidence
  quarantine. Do not describe this as healthy waiting or mature alpha.
- B2 raw29/wallet36 segments and compact36days verified; no archive backlog/dead-letter. Canonical
  wallet reader/retirement cutover is still absent, so source plus compact shadow coexist. DB24.14GB,
  free14.73GB, +1.245GB/day24h DB slope, conservative4.02d above8GiB reserve. Not equilibrium.
- **Previous backup-ack blocker cleared:** scheduled local offsite task succeeded30-Aug19:21 UTC;
  newest2.77GB dump SHA/archive-list verified and server acknowledgement true. Full restore of this
  generation remains unverified. No backup/service/B2/data mutation occurred during this audit.
- Detailed evidence, limitations and the smallest next rollout sequence:
  `reports/live-alpha-status-audit-20260830.md`. Do not resume a deploy from this read-only report;
  obtain current named-action authority and refresh hard gates first.

## 2026-08-30 collection integrity, authentication and future tape v2

- **Provider credentials persisted and verified at 11:01 UTC:** the user-supplied Pyth and Jupiter
  free keys now exist exactly once in `/opt/walletscaner/.env.server`, root-owned mode0600. Values
  and fingerprints were not logged or committed. A root-only byte-for-byte rollback copy is
  `.env.server.credential-rollback-20260830T105526Z`; release ledger
  `reports/deploy/provider-credentials-20260830.json` completed revision 3.
- Bounded no-dependency probes using the deployed R45 image passed Pyth new Hermes, legacy Hermes,
  Benchmarks and Jupiter quote-only `/order`; the Jupiter request had no taker, transaction signing
  or submission. Probe containers were removed and live execution remained false.
- **Saved, not loaded into the long-running ingestion process:** R45 remains restart0/OOMfalse at
  its original start time, so its environment still lacks the newly saved variables. It was not
  restarted because the current 2.77 GB dump's offsite acknowledgement is missing/mismatched.
  Verify that backup gate before a named-service recreation. Future Compose starts will reuse the
  saved values; do not request or duplicate them in source/local files.

- **Local implementation, not deployed:** Pyth now fails fast without `PYTH_API_KEY`, performs one
  bounded HTTP attempt and shares sanitized auth/429/outage backoff across latest/historical calls.
  Operational health explicitly exposes absent price authentication. A credential-free Hermes
  probe returned HTTP 401; official documentation confirms the 26-Aug authentication change.
- **Production read-only preflight at 08:53 UTC:** ingestion R45 and alpha R43 are running,
  migrations remain through 051. Canonical trades are current; inbox pending 23/processing 1,
  alpha pending 6,662. Pyth historical requests/errors were 2,969/2,969 and both Pyth/Jupiter key
  presence checks were false. No credential value was read. Missing price evidence is not repaired
  by this local code; raw canonical amounts remain the source for separately verified enrichment.
- **Storage is not at demonstrated equilibrium:** DB 22,769,409,047 bytes (~21.2 GiB), root free
  13,536,448,512 (~12.6 GiB); archive dead-letter zero, one segment awaiting verification. The latest
  ~2.77 GB server dump has a sidecar but its offsite acknowledgement is missing/mismatched. Do not
  deploy or retire data on this evidence. No production or co-tenant mutation was performed.
  A final read-only check at 09:23 UTC found the same running service set, PostgreSQL/Redis healthy,
  and root free space 13,109,682,176 bytes (~12.2 GiB).
- **New future-only v2:** migration 053 preserves 052 and freezes one seed/claim at a time, four
  decisions/UTC hour and a ten-second measurement window. Later sells wait for terminal entry
  evidence. Atomic completion verifies quote timing, mints and entry minimum-output quantity;
  missed observations retain stale evidence. Exact-pair token mismatch is a provider failure,
  not proof of a rug. Unknown funder/cluster/bundle and landing costs still block promotion.
- **Bounded ownership:** one PG advisory-session writer; two connections total; SQL/client/connect
  timeouts 5/6/5 seconds; 25 expired leases recovered per pass; Jupiter spacing 1,050ms with auth/429
  backoff; no raw quote JSON; 60-day terminal-only retention unchanged. Hourly sampling is not
  randomized or a full-chain denominator and does not establish alpha.
- **Verification:** all 509 tests passed on Node 24 with real native PostgreSQL 16.15 and zstd
  (56 database tests included, none skipped). An additional populated 053 upgrade preserves 100 v1
  decision digests, 600 checkpoint rows, physical relation identity and the v1 policy; 7/7 tape
  integration tests pass after this addition. Typecheck/lint/build pass. Docker Desktop's Linux
  engine could not start due to its inference socket error; no Docker reset or host change was
  attempted. A Linux image/cgroup canary is still a deployment gate, not supplied by native tests.
- **Capacity:** 100 generated decisions/600 checkpoints/2,100 quotes use 1,531,904 bytes;
  60-day conservative envelope 91,914,240 bytes; insert WAL 1,757,152 bytes. Real due/expired plan
  candidates use their indexes without temp writes. This does not solve general server growth.
- **Next exact gate:** configure authorized Pyth API access and a Jupiter read-only quote key
  outside the repository; independently validate the current offsite backup acknowledgement;
  obtain a worker-only rollout authorization, validate the immutable Linux artifact, then apply
  052/053 and canary only the named research worker. Live execution, paper and Telegram alpha
  remain disabled. No live provider quality or profit claim has been validated.

## 2026-08-30 future exact-pool alpha decision tape

- **Implemented and locally validated, not deployed:** migration 052 freezes
  `survival-execution-tape-v1-20260830`. It admits at most 100 future decisions per UTC day and
  schedules exact-pool checkpoints at 0/15/30/60/120/300 seconds for fixed $6/$25/$100 read-only
  Jupiter Swap V2 quote-only surfaces. Historical rows are not imported. Telegram, paper and live
  execution are disabled in the persisted policy, and `paper_eligible` is constrained false.
  The coherent local implementation is commit `64df1ab88aae4e75a4094331c3c0923359d6b54d`;
  migration SHA-256 is `8f359e02333caba69c7eda8f4af75a630372c1d08541ee1dcbe295d4f691e2e1`.
- **Fail-closed evidence:** coverage/finality, token/program risk, creator status, address-level
  flow and cluster/funder/bundle independence are separate. Missing identity evidence remains
  `unknown`. Wrong-pool/no-route/stale/provider failures remain non-fill evidence. PostgreSQL
  constraints reject nullable “passed risk” and incomplete or mismatched `quoted-not-filled` rows;
  provider response JSON is not retained. Discovery incidents are checked for any overlap between
  pool creation and decision time. Direct-creator buys are checked over that complete interval,
  while market-flow features retain their fixed trailing-five-minute meaning. Passed risk requires
  the directly persisted top-10 concentration evidence to be present and at most 70%.
- **Bounded runtime/storage:** oldest-first seed is 25 rows, daily admission 100, claim concurrency
  two, attempts six, retention 60 days, worker database pool two, Compose limit 0.03 CPU/80 MiB.
  The worst-case generated day (100 decisions, 600 checkpoints, 2,100 quote rows) occupied
  1,523,712 bytes and generated 1,798,928 bytes (about 1.72 MiB) of WAL; conservative 60-day storage
  is 91,422,720 bytes (about 87.2 MiB). Claim/retention plans used their intended indexes, completed
  below 0.2 ms and wrote no temp data in the generated benchmark.
- **Validated locally:** populated PostgreSQL 16 upgrade did not rewrite the existing 1,000-row
  pool relation or import history. Decision idempotency, lease/atomic completion, exact-pool quote
  constraints, terminal retention and storage plans pass. Production remains migrations through
  051 and its previously recorded service images; no server, secret, Telegram or worker state was
  inspected or changed in this phase.
- **Next measurable gate:** a separately authorized production-ops rollout needs a fresh backup,
  disk/WAL/resource headroom, a configured Jupiter key and a worker-only canary. Even then this is
  evidence collection, not alpha. Cluster/funder/bundle proof must be implemented and at least
  seven future days/30 mature markets must pass the frozen research gates before any paper phase.

## 2026-08-29 contextual wallet survival falsification

- **Implemented and locally audited:** immutable research version
  `contextual-wallet-survival-v1-20260829` uses one exact-pool decision, causal outcome admission,
  separate terminal-hazard/conditional-return heads, context/wallet partial pooling, an online
  top-decile rule, a conservative survival UCB and common chronological embargo windows. Eight
  unit tests, typecheck and targeted lint pass. No production path was changed.
- **Rejected, not alpha:** the restored PostgreSQL 16 audit covered 1,370 eligible markets. Its 49
  contextual-wallet selections had -1.87% average, -2.94% average excluding the best winner, 0.87
  profit factor and 10.20% catastrophic-loss rate despite a +13.63% median and 71.43% hit rate.
  Validation failed and later windows had insufficient selections. The result does not authorize
  a future shadow, paper portfolio, Telegram signal or live execution.
- **Root cause:** all selections occupied the same launch-program/context bucket and winners versus
  catastrophic losses overlapped on persisted liquidity, volume, transaction count, buy share,
  turnover, age and top-10 concentration. Address-level wallet history cannot resolve shared
  funder/bundle/creator clusters, and historical market snapshots are not executable sell evidence.
- **Next measurable gate:** collect a bounded future decision tape with Token-2022/program controls,
  exact-pool two-way quote surfaces, creator/funder/bundle identity graph, cluster-adjusted early
  flow and short price/liquidity paths. Only then freeze a new survival-first hypothesis. See
  `docs/research/contextual-wallet-survival-v1.md` and the dated audit report.

## 2026-08-29 R45 exact-pool watchdog and R46 queue-admission work

- **Operational — R45 ingestion:** only `solana-ingestion` runs immutable
  `trade-watchdog-r45-20260829`, image `sha256:bc17668d2eea...`, source `f17d8216a915...`, at 0.20
  CPU/160 MiB with live execution false and restart/OOM `0/false`. Across 568 health samples and
  10.48 hours, 185 natural blocked-head releases fired at p50 15,001ms, p95 15,056ms, p99 15,998ms
  and maximum 18,374ms; none exceeded 20 seconds. Every release used the existing durable
  coverage-incomplete-before-unsubscribe path. This supersedes R44's dequeue-only 35-41 second
  behavior and the earlier 127-second incident without extra concurrency or provider spend.
- **Operational closure:** ledger revision 76 completed the R45 canary. Revision 79/SHA-256
  `a0d6bf7ce0d1...` then removed only the independently hashed 462,948,255-byte server transfer
  archive, recovering 462,729,216 allocation bytes. The byte-identical local artifact, exact R45
  and R44 rollback images, PostgreSQL, archives and B2 remain. Post-removal flow was
  backlog/dead/unresolved/signature `0/0/0/0` with no new ingestion error.
- **Implemented locally — R46 producer admission:** a 17:26 UTC baseline found the active alpha
  queue dominated by 7,477 `price-enrichment` wallets. Sixty-four recent cycles processed 4,401
  wallets but pending moved 6,884 -> 7,814. In bounded oldest/newest 500 samples, 96%/98% had zero
  entries and only 3.8%/0.6% met the existing `6 trades OR 3 recent entries` floor. R46 persists all
  trade/price evidence but suppresses only redundant price-enrichment revisions below the exact
  configured admission boundary. Trade and entry writes remain unconditional atomic producers, so
  later maturity and concurrent threshold crossings are not lost. Memory tests and the full
  PostgreSQL 16 evidence suite pass; R46 is not yet production.
- **Validated locally — R46 artifact:** exact Node 24/Linux/zstd validation passes 418/418 tests
  with 49 intentional no-database skips, followed by 34/34 PostgreSQL 16 evidence integration
  tests. Runtime image `sha256:e376cfd...380b` and the 463,454,623-byte transfer artifact SHA
  `a505591b...560c` match source commit `53b5949`; production remains R45.
- **Waiting:** the 29-August daily `pg_dump`, started at 17:35 UTC, was still active during the
  17:54 UTC preflight and single-CPU/I/O pressure was elevated. No R46 rollout phase was opened.
  Repeat backup acknowledgement, disk/resource, flow and identity gates after it completes; only
  then start the ingestion-only canary.
  After rollout, require a negative one-hour producer-adjusted queue slope, unchanged evidence
  persistence/freshness, P2 latency within five minutes, no failures/restarts/OOM and no CPU/RAM
  increase. Storage still needs the normal 27-August partition retirement and a clean 24-hour slope.

## 2026-08-29 R44 bounded exact-pool trade latency rollout

- **Operational — R44 ingestion:** only `solana-ingestion` was recreated on immutable
  `trade-latency-r44-20260829`, image `sha256:44e6beae6b0e...`, source `1252b2b93e98...`.
  It retains 0.20 CPU, 160 MiB, live execution false and restart/OOM `0/false`; PostgreSQL,
  wallet-alpha and all other service identities were unchanged. The source-level option is disabled
  by default and only the exact-pool trade lane sets `maximumLiveQueueDelayMs=15000`.
- **Correctness behavior:** the former one-address ordered lane reached 127.1 seconds queue delay,
  high-water 1,620 and 5,676 purged notifications before its existing fail-closed capacity release.
  R44 invokes the same durable persist-before-unsubscribe coverage path once live queue age reaches
  15 seconds. It preserves the admitted head, purges only the released pool's queued work and leaves
  the affected interval incomplete; it does not add same-address concurrency or Helius HTTP spend.
- **Operational canary:** startup's two capped gaps closed after 60 seconds as unreconciled and
  alpha-excluded. Four discovery programs then became open/OK/current, canonical backlog drained
  `236 -> 51 -> 0`, and dead-letter/open incident/unresolved-finality/signature backlog were zero.
  R44 diagnostics were present; post-deploy trade delay remained below 5.243 seconds with no new
  pressure/purge, parser error, restart or OOM. Ledger revision 70 completed the canary.
- **Operational cleanup and recovery:** the 462,877,766-byte R44 transfer artifact was removed only
  after local/server SHA-256, loaded R44 and exact R43 rollback proof. It recovered 462,884,864
  allocation bytes; R44, R43, the byte-identical local artifact, database and B2 data remain.
  Ledger revision 73 completed removal verification.
- **Waiting — not validated:** a natural post-R44 saturated pool must demonstrate fail-closed release
  near 15 seconds. Storage is flowing and the verified 26-August payload partition was retired by
  normal guarded maintenance, but sustainability still requires the clean post-retirement 24-hour
  disk/database slope. The current `DEGRADED` state is storage-only: database warning threshold,
  roughly two-hour compaction lag and an immature runway window; it is not a discovery outage.

## 2026-08-29 R43 discovery/ledger reliability rollout

- **Operational — exact R43 ingestion:** `solana-ingestion` runs immutable
  `pipeline-reliability-r43-20260829`, image `sha256:e87020e75036...`, source `13783e891556...`,
  live execution false and restart/OOM `0/false`. Exponential reconnect backoff stabilized an
  opening endpoint-close burst after 37 aggregate reconnects; per-address coalescing produced only
  three capped backfills. Their gaps closed unreconciled and remain alpha-excluded. All four
  programs then reached at least 13 healthy samples with attempt zero and no drop, pressure, ACK,
  heartbeat, handler, parser or finality error.
- **Operational — exact R43 wallet alpha:** only wallet-alpha was subsequently recreated on the
  same image and retained its 0.10 CPU/160 MiB limits. Production wallet `48yt...GZ6SB`, which had
  failed 294 times on the episode natural-key constraint, completed revision 51 with attempts/error
  cleared. Its scoped state has seven episodes, fourteen lots and zero duplicate natural keys. The
  sole remaining failed work row is the intentional 10,000-trade `evidence_limit` quarantine.
- **Operational post-state:** only Compose project `walletscaner` is listed; ingestion, wallet-alpha
  and PostgreSQL are restart/OOM-free and PostgreSQL identity did not change. Canonical flow
  recovered to inbox `3/11.3s`, dead-letter/open incident `0/0` with fresh pool/swap/trade evidence.
  Ledger revision 58 completed both canaries; no live execution or alpha threshold changed.
- **Operational cleanup:** after a byte-identical local copy and loaded-image proof, only the exact
  462,791,225-byte R43 server transfer archive was removed. The removal-time filesystem observation
  was 17,663,750,144 bytes free; revision 64 transparently corrects two precomputed revision-61 disk
  figures. R43 plus R42/R34 rollback images and the local artifact remain.
- **Waiting — not validated:** priority-one work can still be delayed when promoted old background
  rows retain earlier scheduling times; signal priority two is empty, but lane equilibrium needs a
  future measured window. The verified 26-August raw-payload partition remains intact until its
  2026-08-29 00:00 UTC hot-window boundary and the first normal guarded maintenance cycle. Storage
  sustainability still requires a clean post-catch-up 24-hour slope above the 8-GiB reserve.

## 2026-08-27 R42 bounded ingestion/materializer rollout

- **Operational — exact R42 ingestion:** `solana-ingestion` runs immutable R42
  `sha256:4d9cbf85ada0...` from source `423559147ea6...`, live execution false, restart 0/OOM false.
  Public discovery repair resumes are capped at 500 signatures and oversized historical intervals
  close only as alpha-excluded. The fixed shared-host profile uses one exact-pool observation slot;
  its 336-second canary ended at `1/1/1`, zero trade queue/dead-letter/incident and fresh flow.
- **Operational — exact R42 compact materializer:** the same immutable image runs only the bounded
  materializer at 0.05 CPU, 80 MiB, 64 PIDs, one day/1,800 seconds and 600 seconds per statement.
  Its first oldest production retry completed in 112,917 ms and passed count plus two-digest parity
  for 1,477 episodes, 1,341 open lots and 700 mature followability facts. Compact state became seven
  verified/two retry with 26 independently verified days left; it advances one oldest day every
  thirty minutes without a second worker.
- **Operational — recovery and cleanup:** current dump
  `memecoin_alpha_20260827T173517Z.dump` is 2,030,534,774 bytes; server sidecar/off-site marker,
  PostgreSQL 16 archive-list and the independent local generation pass. Five exact release-transfer
  artifacts had byte-identical local copies and were removed from the server. The reviewed
  Walletscaner-only image cleanup preserved every container image plus R42 current and R30 rollback,
  recovered 7,340,040,192 filesystem bytes and did not touch BuildKit, volumes, B2 or canonical data.
- **Operational post-state:** only Compose project `walletscaner` is listed. Host free disk is
  20,495,110,144 bytes (72% used), PostgreSQL is 19,111,582,743 bytes and migrations reach 051 with
  zero invalid indexes. Final flow was inbox `43/14s`, dead-letter/open incident `0/0`, pool/trade
  age `18/18s` and 415 wallet trades/five minutes. Ingestion and materializer are exact R42,
  restart 0/OOM false; every non-target identity remained unchanged.
- **Waiting — validation, not implementation:** ledger revision 45/SHA-256 `141c96ac8acd...`
  tracks `r42-storage-shadow-observation`. Wait for 26-day compact catch-up, a clean 24-hour storage
  slope and the existing seven-day dual-read gate before claiming equilibrium or retiring canonical
  evidence. Paper/live and alpha delivery remain unauthorized.

## 2026-08-26 R36 archive-integrity and terminal-repair retention rollout

- **Operational — R36 storage operations:** archive writer/verifier, wallet-evidence materializer,
  data maintenance and operations monitor run immutable R36 image
  `sha256:24bcc3fa77d3a0a9e4369eb43ec4d33084b4985f1feedcc41db97cde1548d00a`.
  Wallet alpha remains R34, ingestion R30, sampler R29 and Telegram R23. All 12 Walletscaner
  services are running; every changed service is restart 0/OOM false, live execution false and
  retains its previous CPU/RAM limit.
- **Operational — archive false-positive repaired:** wallet segments 67/69 had matching object
  length, compressed SHA-256 and semantic record counts; only JSON key order differed between the
  upload metadata and PostgreSQL JSONB readback. R36 writes sorted metadata and permits only that
  bounded integer map to compare semantically while every SHA, other metadata value, Object Lock
  check and full GET/restore remains strict. A guarded retry independently verified 2/2 objects in
  9.5 seconds. Archive dead-letter count is now zero; neither object was overwritten or deleted.
- **Operational — failed gap staging is bounded:** maintenance now retires signature rows from both
  completed and terminal failed repairs after the configured three-day audit horizon. Previously a
  20,000-cap failed repair retained pending rows forever because they never acquired
  `completed_at`. The repair/incident summary and alpha-excluded disposition remain durable.
- **Operational — current flow:** the post-rollout report has pipeline backlog/dead-letter 0/0,
  last pool age 0.13 seconds and no archive dead letter. One Pump.fun historical repair was still
  replaying oldest-first at 16,409/17,228 with its exact boundary reached; that interval remains
  excluded while current live discovery continues. Wallet-alpha P2/signal work is zero and recent
  cycles have zero processing failures.
- **Waiting — bounded storage equilibrium:** PostgreSQL is about 15.07 GB and host free space is
  about 18.70 GB after exact transfer-artifact cleanup. The recent window still estimates about
  0.93 GB/day database growth and 1.48 GB/day disk consumption, or 6.55 days above the 8-GiB
  reserve. This window includes reclaim/rebuild and rollout activity and is not a clean equilibrium
  proof. Canonical wallet retirement remains disabled until archive catch-up, compact parity,
  dual-read and seven future shadow days pass.
- **Interruption-safe boundary:** server rollout ledger revision 15 is
  `storage-equilibrium-observation-r36=in_progress`, SHA-256
  `6224c45bef08aa2c9a5d09e96bd5e71fd06aaa4b1a54b0d02af023a24c7f2c67`. R34/R36 images and the
  local SHA-identical R36 transfer artifact remain rollback evidence; the server transfer tar was
  removed without Docker prune.

## 2026-08-26 wallet-evidence storage shadow (R34 operational, validation waiting)

- **Operational — bounded hot/cold shadow:** migrations 050/051 are deployed with repository-exact
  checksums. Archive writer, independent verifier, compact materializer, operations monitor and
  wallet-alpha run immutable R34 image
  `sha256:178566f7955762dbfdd6b9c2e4a0269e9b6b1004f6725c5d43c93f579504ba4f`.
  Ingestion remains R30, sampler/maintenance R29 and Telegram R23. All 12 Walletscaner services were
  running with restart 0/OOM false and selected workers reported `ENABLE_LIVE_EXECUTION=false` at
  the 2026-08-25 22:24 UTC boundary.
- **Operational — archive/compact first cohort:** one full wallet-evidence UTC day is independently
  uploaded/restored/verified in B2 and one matching compact day has passed parity. Nine seeded
  historical wallet days remain pending; compact mismatch/retry count and archive dead-letter count
  are zero. Canonical wallet retirement is not implemented or enabled by this shadow.
- **Operational — guarded derived-cache reclaim:** the reconstructible
  `wallet_position_episodes`/`wallet_position_lots` cache was reclaimed only after an immutable B2
  backup receipt, zero-qualified-wallet gate and transaction-safe rehearsal. Canonical
  `wallet_trade_events` remains present at an approximately 2,042,285-row catalog estimate and
  4,496,990,208 relation bytes. Wallet-alpha restarted on R34 and is rebuilding current derived
  state; the queue sample moved from 16,840 to 16,423 with failures remaining at one pre-existing
  item and P2/signal work at zero.
- **Operational — recovery/headroom:** the current 2,053,352,363-byte PostgreSQL dump has a SHA
  sidecar and off-site acknowledgement. Exact server transfer tars were removed only after local
  SHA-identical copies and loaded R34/R35 image IDs were proven. Host free disk is 18,594,758,656
  bytes and the database is 15,149,702,167 bytes at the boundary above.
- **Waiting — storage validation:** the latest health report is intentionally `degraded`. Its recent
  24-hour window includes image transfers, archive catch-up and the derived reclaim/rebuild, so it
  reports a conservative 2.06 GB/day disk-consumption slope and 4.88 days above the 8 GiB reserve.
  A clean post-catch-up 24-hour slope plus seven future shadow days are still required. Point-in-time
  load-per-CPU samples oscillated 3.14 -> 1.17 -> 2.35; bounded Walletscaner stats and `vmstat`
  showed no OOM/restart or continuous hard CPU saturation, but the observation gate must keep
  measuring it. Do not call storage validated or authorize canonical retirement from elapsed time
  alone.
- **Interruption-safe boundary:** server rollout ledger revision 9 is
  `storage-shadow-observation=in_progress`, SHA-256
  `b3d98e772c112b656ea7f8735b56b8177c052bd480f559de72094fc772e4f0f1`. The human resume point is
  `docs/agent/work-in-progress.md`; every future resume must compare both records with live state
  before retrying an operation.

## 2026-08-25 pipeline/storage hardening release (R29/R30 rollout)

- **Operational — scoped release:** `solana-ingestion` runs immutable R30
  `pipeline-storage-r30-20260825` from `039f1c5`; evidence sampler, wallet alpha, maintenance and
  operations monitor run immutable R29 from `b3ab4c8`. Telegram remains on the compatible R23
  notifier. Every recreated container has restart `0`, OOM `false` and its prior CPU/RAM ceiling.
  PostgreSQL, Redis and Telegram identities remained unchanged during the scoped recreations.
- **Validated — exact gate:** the post-migration-049 Node 24/Linux image plus disposable PostgreSQL
  16 passed 89/89 test files and 428/428 tests; the two migration-heavy PostgreSQL suites ran
  sequentially to avoid test-only schema-install lock contention. TypeScript, ESLint and the
  production workspace build pass. R30 additionally
  proves that a finalized failed transaction is a valid immutable repair boundary while still
  producing no discovery event; exact slot, full replay, finality and append-only proof gates remain.
- **Operational — maintenance capacity:** the first normal R29 cycle compacted 6,750 archived raw
  payloads in 43.726 seconds with zero timeout using 250-row batches and the unchanged 4% CPU/64 MiB
  limit. Recent ingress measured 6,082 rows/hour versus about 13,500 rows/hour compaction capacity.
  The 48-hour compaction boundary was still 11.05 hours late, so equilibrium is waiting rather than
  claimed.
- **Operational — bounded alpha processing:** R29 split the trades/entries/outcomes upper-bound
  probes into separate indexed five-second statements. Observed cycles processed 72, 92 and 90
  wallets with zero current-cycle failure; the last completed in 36.577 seconds. Migration 048 plus
  the R29 producer reserve P2 only for latest watch/candidate/validated-paper wallets. The 207
  legacy P2 rows were consumed/reclassified without deleting evidence and legacy P2 is zero.
  Migration 049 now preserves an active transient retry boundary when new revisions coalesce, so a
  frequently updated timeout wallet cannot become immediately claimable and starve its lane. A
  PostgreSQL 16 integration gate passed 32/32 and a rolled-back production canary preserved both
  revision and retry time.
- **Operational canary — measured resource correction:** cgroup counters proved alpha and PostgreSQL
  were quota-throttled while the host stayed about 71% idle. A restart-free 7%->10% alpha and
  18%->21% PostgreSQL canary improved a comparable light cycle from 201.5 to 132.5 seconds and a
  heavy cycle from 46 to 54 completed wallets; pending work moved 8,531 to 8,495 across those two
  cycles. Container identities, memory ceilings, restart/OOM and low CPU shares did not change. A
  negative one-hour slope is still required; otherwise revert the two CPU limits. After migration
  049, a later approximately 32-minute read-only sample moved evidence-v1 total pending from about
  8,550 to 7,560 and P1 from 6,686 to 5,649; P2 stayed zero. This is encouraging operational
  evidence, not yet the one-hour equilibrium gate.
- **Operational with excluded gaps — discovery:** R30 reconciled the completed Pump repair after
  independent PublicNode and official-RPC checks proved its exact target finalized at slot
  441,602,989; the target transaction failed and therefore emitted no pool event. Restart-created
  PumpSwap reached the reviewed 20,000-signature cap and closed only as unreconciled/alpha-excluded.
  CPMM reached its exact boundary with 15,941 signatures and was replaying oldest-first; it was the
  only open incident, at 2,800 completed signatures in the 18:52 UTC observation. Current live
  transport remains active with no terminal inbox/dead-letter failure; aggregate status remains
  degraded until that historical CPMM interval resolves.
- **Waiting — backup and storage validation:** dump `memecoin_alpha_20260825T150924Z.dump` is
  2,053,352,363 bytes with SHA-256
  `ba26a3c89fdb8dc671d92976659ae177a6d8f76be40a45b8b8f774bb54238160`; its sidecar and PostgreSQL
  16 archive-list pass, but this generation is not yet off-site acknowledged. The scheduler now uses
  zstd level 1 and blocks another generation until acknowledgement. Host headroom is about 17.2 GB.

Do not call storage validated until compaction lag reaches zero and a clean post-catch-up 24-hour
slope preserves the 8 GiB reserve. Do not call alpha validated: no watch-or-better signal or
profitable chronological paper cohort has passed the documented gates.

## Last verified boundary

- Observation: 2026-08-25 18:52 UTC, R30 plus migration-049 canary on the shared host.
- Live capital: `ENABLE_LIVE_EXECUTION=false`; paper v3 is paused with zero open positions and v4
  remains a non-deliverable causal shadow.
- Releases: ingestion R30; sampler/alpha/maintenance/operations R29; Telegram R23. PostgreSQL 16,
  Redis 7 and the archive schedulers remain active. API, web, paper-alert and legacy research remain
  stopped. Migrations through 049 are deployed.
- Shared-host state: one Walletscaner Compose project was listed; no protected co-tenant service,
  secret or runtime was inspected or changed.

## Operational discovery transport and bounded repair

- **Operational — official live WebSocket / PublicNode HTTP hybrid:** PublicNode acknowledged the
  Pump.fun and PumpSwap sockets but delivered zero live notifications for several minutes. Bounded
  same-host canaries against `api.mainnet-beta.solana.com` delivered 24,169 Pump.fun notifications
  in 20 seconds and 15,449 PumpSwap notifications in 23 seconds while the existing official sockets
  stayed active. All four reviewed discovery programs now use the official WebSocket; HTTP
  transaction fetch, cursors and bounded repair remain on PublicNode. The first post-route sample
  had fresh Pump.fun, PumpSwap and CPMM notifications at zero slot lag. No Helius discovery credits
  or new credential are used. The route still needs a future observation window; a short canary is
  operational evidence, not the 99% coverage validation gate.
- **Operational — exact-finalized durable repair:** migrations 044-046 stage reconnect
  signatures durably, collect without moving the live cursor and replay oldest-first. Completion is
  bound to the immutable collected target rather than the moving live cursor. A separate
  history-aware signature-status request must prove the exact signature/slot finalized. Transaction
  success is recorded as audit metadata, not required for ordering: a finalized failed transaction
  is replayed and correctly produces no discovery event. An append-only PostgreSQL proof row plus
  post-incident WebSocket evidence are required before `coverage_reconciled_at` can be set. The
  rollout normalized and reconciled the
  previous 11,143-signature CPMM repair and 731-signature Pump.fun repair; their former moving cursor
  slots remain in the proof audit rows. The re-route startup Pump.fun, PumpSwap and CPMM scans each
  reached the reviewed 20,000-signature cap, closed as
  `current-transport-healthy-repair-cap-exhausted`, and retained only those historical intervals as
  `alpha_excluded_unreconciled`. At 17:09 UTC, open incidents were zero and all four program
  transports reported `ok`; Pump.fun, PumpSwap and CPMM were at zero slot lag and LaunchLab at two.
- **Operational — fail-closed repair-cap retirement:** R20/R22 close only current transport state
  after two fresh samples when a repair reaches the reviewed 20,000-signature cap. Those repairs
  remain `failed`, the affected historical intervals remain alpha-excluded, and later current data
  is not blocked indefinitely. This bounds RPC/rows/replay and removes the incident/recovery loop
  without pretending that an unrepaired gap was complete.
- **Operational — Telegram transition delivery:** transition messages remain outbox-backed and
  deduplicated. Exact reconciliation and capacity-retirement events are emitted once per incident.
  After convergence, there were no pending, retry, processing or dead-letter Telegram rows.

## Operational wallet-alpha priority queue

- **Operational — wallet-alpha priority wake queue:** migration 043 and the R13 worker keep one
  coalescing three-lane queue: background `0`, score-changing `1`, and
  fail-closed risk-passed source entry `2`. Highest ready priority is claimed first; a concurrent
  newer revision keeps its priority after an older lease completes. Commit-bound PostgreSQL
  `NOTIFY` wakes the single worker, with 30-second backlog and 300-second idle recovery polling.
  No second scorer was added; the existing 7% CPU, 112 MiB heap and 160 MiB container limits remain.
- PostgreSQL 16 migration, revision-race, priority-order, notification and worker checks pass. The
  exact production runtime tree passed 18/18 queue tests on the host; disposable PostgreSQL 16
  integration passed 27/27. The local 10,000-row synthetic queue used the priority partial index
  and claimed in 0.201 ms/eight buffers; local commit-to-refresh was 181 ms at 67.65 MiB RSS.
- The accepted one-CPU canary started ingestion alone, added sampler, then alpha. Final ingestion
  telemetry had four of four programs current, minimum 20 consecutive healthy samples and zero
  queue/active/in-flight/drop/reject/unresolved/open-incident/breach/parser/finality error. Sampler
  wrote live observations with zero provider error; alpha held one PostgreSQL listener, completed a
  243.117-second bounded cycle and refreshed one P2 wallet with zero refresh failure at 121.04 MiB
  RSS. Pre-alpha lanes were P2/P1/P0 `31/224/3,079`; 30 P2 rows drained in the first cycle.
- The remaining P2 row is the known over-10,000-trade wallet, deferred for about 24 hours rather
  than ready. Production future-event latency percentiles remain waiting; do not substitute the
  local 181 ms sample or this catch-up canary for the p95/p99 gate. Full evidence is in
  `reports/wallet-alpha-priority-r13-rollout-20260824.md`.

## Operational changes and evidence

- **Operational — bounded discovery reconnect repair:** R14 used a hard-coded five-signature
  discovery backfill on initial connection and every reconnect. LaunchLab reached seven reconnects
  and eight truncations before rollout; each reconnect opened and then closed a durable
  `backfill_truncated` incident and produced a Telegram incident/recovery pair. R15 uses a strict
  `100 x 5 = 500` signature scan profile with a product hard cap of 2,000, validates configuration
  at startup and exposes the active profile in health telemetry. The last pre-rollout LaunchLab
  cursor had 288 newer signatures, proving the new window could reach its boundary. R15 startup
  reached it with zero LaunchLab truncation, and a subsequent natural reconnect changed the live
  counters to `1 reconnect / 0 truncations`; status remained `ok`, coverage remained current, and
  queue/workers/dropped/unresolved remained `0/0/0/0`. Pump.fun, PumpSwap and CPMM each saturated
  the bounded startup window, correctly opened one fail-closed historical-gap incident, and closed
  it after two healthy samples; those three gaps remain excluded rather than being called repaired.

- **Operational — backup:** dump `memecoin_alpha_20260823T150923Z.dump` is 1,505,940,747 bytes,
  SHA-256 `2f8831a3a9bde0e6e19c89099444b2404bc950f30ae9c7f20865e38c0f43fdba`. Server,
  off-host bytes, PostgreSQL 16 archive-list, sidecar and acknowledgement passed; the scheduled
  task completed with result zero.
  The next server dump `memecoin_alpha_20260824T150923Z.dump` also completed PostgreSQL archive-list
  validation and local SHA generation at 1,692,713,492 bytes. It is not yet an off-host verified
  generation; the 2026-08-23 verified server/off-host recovery point remains present until that
  acknowledgement arrives.
- **Operational — finality gate:** migrations 041-042 are deployed. The R10 terminal-state sweep
  repairs events that arrive after their signature was already finalized. The live mismatch count
  fell from three to zero, the blocked inbox fell from 803 to normal working-set levels, and the
  20:09 UTC monitor reported backlog/dead letters `0/0`. No restart or OOM occurred.
- **Operational — PostgreSQL-safe chain payload admission:** a live PumpSwap transaction contained
  `U+0000` in parsed JSON text. PostgreSQL JSONB rejected it, the per-address ordering barrier
  correctly refused to advance, but the source retried the same handler forever while its RAM queue
  grew from 574 to 729. R13/R14 replace only forbidden NUL code points with an explicit literal escape,
  adds an occurrence count plus original-payload SHA-256 marker, and purges queued work when a pool
  is fail-closed/unsubscribed. The first live R13 pool processed 122 backfill and 45 live events;
  queue/unresolved/dropped/parser failures were `0/0/0/0`, one subscription was active and fresh
  live provider latency was 1.80 seconds. R14 restores a zero-copy fast path for normal payloads and
  also covers NUL object keys. Its first sample processed 304 backfill events with queue, unresolved,
  dropped and parser failures all zero. Ingestion limits were not raised.
- **Operational — SQL telemetry:** migration 040 and PostgreSQL preload/I/O/slow-query settings are
  active. `pg_stat_statements` identified the real wallet-alpha scans.
- **Operational — wallet-alpha bottleneck:** R12 orders claims by the existing
  `(strategy_version, not_before, updated_at, wallet_address)` partial index and constrains both
  sides of the outcome join by strategy. Live means changed from 628.57 ms to 4.99 ms for claims
  and from 1,224.68 ms to 25.50 ms for outcomes. A 100-item cycle changed from 200-242 seconds to
  26.31 seconds without raising the 7% CPU, 112 MiB heap or 160 MiB container ceilings. Queue
  pending moved `475 -> 375 -> 275 -> 175 -> 75` before new R13 trade catch-up revisions arrived.
  A completed cycle reported 206 pending; a subsequent read-only sample saw 644 coalesced revisions
  while ingestion backfill was active. The next bounded cycle processed 45 admitted wallets in its
  240-second budget and reduced the queue to 265 with zero failure at 94.7 MiB RSS. This is a fresh
  transient producer/CPU-I/O-contention burst, not the former full-table claim bottleneck, and must
  still be watched for sustained net drain after ingestion catch-up.
  One wallet remains intentionally isolated by the 10,000-trade safety ceiling.
- **Operational — creator enrichment:** 1,798 of 1,868 tokens first seen after the R9 rollout have
  a creator address (96.25%). Pump instruction creator decoding is the dominant successful path.
- **Implemented / waiting — Token-2022:** dangerous extensions fail closed in code and tests, but
  the first 19 live post-rollout assessments contained no extension warning sample. This is not a
  production validation claim.
- **Operational / catching up — raw archive:** 22 verified chain-payload segments cover
  2026-07-31 through 2026-08-23 00:00 UTC and contain 765,680 source rows. Maintenance compacted
  4,000 payloads in its latest run with no timeout. At 20:13 UTC, 10,962 verified, retention-eligible
  payloads remained at 20:13 UTC. The next two successful runs compacted 4,000 and 3,000 payloads;
  the oldest uncompacted boundary advanced by about 32 minutes, but lag was still 7.80 hours at
  20:35 UTC. The recurring 30-minute worker is making net progress and must be observed until zero.

## Capacity and remaining hard gates

- At 17:09 UTC PostgreSQL was 14,525,111,319 bytes and the host had about 19 GB free / 73% used.
  Aggregate operations status remains legitimately `degraded` even though discovery is `ok` and
  open coverage incidents are zero: the new daily dump awaits B2 acknowledgement, database size is
  above the 12 GiB warning, chain-payload compaction lag is about 14.1 hours and conservative runway
  is 2.61 days above the 8 GiB reserve. The recent disk-consumption regression includes allocation
  of the new 1.69 GB dump, while measured database growth is still about 0.58 GB/day. Do not hide or
  relabel these capacity warnings as transport health.
- The 95-day detailed wallet evidence layout is still not at proven disk equilibrium. Do not delete
  canonical trades, entries or outcomes until B2 wallet-evidence export, deterministic compact
  ledger dual-read parity, isolated restore, backup and stopped-cutover gates pass.
- Continuous WAL/PITR is not operational. The verified daily dump limits data loss but is not PITR.
  A bounded spool/sidecar, measured WAL rate, B2 restore rehearsal and reserve-failure behavior are
  required before enabling PostgreSQL archiving on this fixed disk.
- The raw live exact-log prefilter does not yet persist an ordered transport checkpoint. On a
  restart, a high-volume program can saturate the 500-signature startup scan even if its prior
  socket was current, because the canonical cursor intentionally advances only across durably
  admitted or transaction-level excluded work. Current repair is bounded, fail-closed and can
  retire the historical interval without blocking future live data; eliminating this restart gap
  requires a separate ordered checkpoint design that cannot overtake pending durable admission.
- Jupiter exact/direct quote support is implemented but not operational because no approved API key
  is configured. DexScreener observations remain market context, not executable fills.
- Reviewed optional Meteora/Orca/Raydium manifests are implemented but disabled. Base ingestion
  must remain stable and each venue needs independent denominator/decoder proof before sockets are
  enabled; Raydium AMM v4 still needs a reviewed account-state adapter.
- Wallet-alpha signals remain `0`. There is no validated alpha or live-capital authorization. Keep
  the future-only seven-day/market, 14-day paper, exact-fill, rug/tail and independence gates.

## Verification summary

- R13 exact-image queue/wake tests passed 18/18 locally and on the production host. Disposable
  PostgreSQL 16 evidence integration passed 27/27; the scoped atomic image updater passed 3/3.
  Production runtime-tree SHA-256 was
  `399b9449952176b23a2e8115dbc2da9f5a9bd29830a39e19e92350c3c671cba3`.
- TypeScript, ESLint and the workspace production build passed after R15. The complete Windows
  suite passed 335 tests with 34 intentional skips once the verified zstd 1.5.7 binary was placed
  on the test-process PATH.
- Disposable PostgreSQL 16 evidence/coverage integration passed 30/30 and archive pipeline
  integration passed 4/4. The exact Linux/amd64 R15 image passed 67/67 critical discovery,
  supervisor, reconnect and archive-artifact tests.
- PostgreSQL 16 integration passed 24/24 locally, including NUL values and object keys. Exact R14
  image provider/queue plus Linux archive regressions passed 43/43; exact R12 image query tests
  passed 2/2.
- R10 finality PostgreSQL integration passed 21/21 and Linux critical zstd/finality/migration suite
  passed 19/19. The broader post-R13 Windows run passed 329 tests; two archive tests failed only
  because the Windows host lacks `zstd`, then passed 3/3 in the exact Linux R13 image.
- Rollback points include the immutable R14 ingestion image, older R13/R10 ingestion images and the
  verified current dump. R15 changed no schema or canonical row. Only the exact temporary R15 image
  transfer file created for this rollout was removed after SHA/image verification; no volume, B2
  object, canonical data or unrelated service was deleted.
