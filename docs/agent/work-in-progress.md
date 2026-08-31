---
status: active
updated_at_utc: 2026-08-31T22:44:00Z
owner: codex
task: bounded alpha producer and sustainable wallet evidence storage
last_safe_checkpoint: R51 staged and current backup verified; live exactR43/migration051 unchanged; production rollout preflight passed and no mutation is in progress
---

# Active objective

The user authorizes fixing the diagnosed queue/storage problems and asks what Pyth does.
Implement and verify bounded producer work plus the missing compact-reader lifecycle. Production
actions are scoped to Walletscaner named-service canaries; live execution remains false. No global
cleanup, co-tenant action, B2 deletion/policy change, threshold relaxation or canonical retirement
without documented independent restore/dual-read/coverage gates. Do not enable paper or tape.

## Resume protocol

Read this file, Git state, and server release ledger; compare actual image/container, artifact and
schema identities before repeating an operation. Earlier completed work is in Git at ec4850d and
docs/agent/current-state.md, not repeated as competing active objectives here.
Checkpoint after every visible phase. Reconcile partial deployments; never blindly rerun them.

## Verified pre-state, 2026-08-30 20:45 UTC

- Git main ec4850d, ahead238. Four unrelated untracked deploy remnants remain untouched.
- Only Walletscaner has running containers (12); protected robinhoodscaner-intel inventory empty.
- IngestionR45 image bc17668d2eea1c28692ff819a23419e42548dfa30a0b9be12cc7fdc2e6033722,
  container501f8cc81715, original29-Aug start; alphaR43, PG/Redis healthy; restarts0/OOMfalse.
- Live execution false; saved Pyth/Jupiter credentials not loaded into current ingestion.
- Host free14,711,435,264bytes, availableRAM~1.01GB, WAL503,324,672bytes; temp48KiB.
  DB24,169,602,071bytes, positive growth; reserve runway4d. No active backup dump.
- Flow inbox0/dead0, finality8fresh/unresolved24h0, wallettrade15s. Archive queues/dead0,
  compact mismatch0; canonical wallet retirement remains absent.
- Current dump memecoin_alpha_20260829T173517Z.dump: 2,770,884,949bytes,
  SHA566487ea4fdbc074ed81bd83853a1147dbdcb962bddb3d9f96b3112ae9f06478,
  sidecar/offsite acknowledgement true. Local scheduled check30-Aug19:21UTC verified SHA
  and PG16 archive list. This generation has NOT passed full restore; no destructive operation.
- Last audit: alpha pending10,788 ->18,265/24h, mostly redundant price enrichment;
  preserve canonical evidence rather than clear the queue to improve this number.

## Phase1: ingestion-only R46 canary

- Tested source53b5949dce301f6f20dc9f6d0fea0831a23b80d4. No migration required.
- Image sha256:e376cfd6704cd5a0ad799e338b9a3d57ef9c4204eccba81a5efdd439fdf2380b.
- Exact local artifact:
  C:/Users/Umut/AppData/Local/Temp/walletscaner-r46-artifact/walletscaner-worker-alpha-producer-admission-r46-20260829.tar.zst
  463,454,623bytes; freshly measuredSHA
  a505591b70e12dda67f8372bc52fd19f82047ab2f6a851db6b717e7aadce560c.
  The old deferred summary contained an incorrectSHA; the exact artifact section and actual file
  agree on the hash above. Never use a505591b7610... from that summary.
- Prior tests: exactLinux418/418 plus PG16evidence34/34; artifact source unchanged.
- Stage/hash/load R46, guarded image-key update, recreate ONLY solana-ingestion using
  --no-build --no-deps. Loads already-saved provider auth. PreserveCPU0.20/memory160MiB.
- Rollback: exactR45 remains loaded; atomically revert only ingestion image key and recreate only
  ingestion. Do not restore credentials to missing or erase queue/canonical data.
- Gates: fresh backup acknowledgement, identities/mounts, zero unresolvedfinality/deadletters,
  durable startup gaps, provider refresh, stable memory, noOOM/restart/error increase. Measure
  producer/drain rates; short negative slope is not long-run equilibrium.
- Next exact action: inspect server release ledger and rendered named-service safety settings,
  verify current backupSHA/list evidence, then open revision-checked plannedR46 phase.

### R46 planned checkpoint, 20:49 UTC

- Independently rehashed local and server2.77GB dump; both match566487ea...06478. Fresh server
  PG16 archive-list exits successfully. This is sufficient for the non-schema ingestion rollout;
  a latest full restore remains mandatory before canonical retirement.
- Server reports/deploy/queue-storage-r46-20260830.json revision1 is planned, no service changed.
- Next: transfer exact local R46 to /opt/walletscaner/deploy/...tar.zst.partial; verify size/SHA,
  zstd integrity, rename/load with low priority; then verify exact image before in_progress.

### R46 staged checkpoint, 20:57 UTC

- Transfer completed, size463454623/SHAa505591b70e12...560c independently match; zstd-t passed
  decoded463808512bytes. Exact file renamed from.partial; no source file or data removed.
- Server ledger revision2 in_progress, SHAfa9b79212c4c70cdbaeb2adcc2a2d5f721549fdb96378d3c93c817c7934ccccc.
- Low-priority image load started (local exec session30112); ingestion remainsR45. Next read:
  inspect whether exactR46 image is loaded before any repeat. Then guard image update and recreate
  only ingestion; observe a complete canary with existing source exclusions still fail-closed.
- Load completed; exact image/source labels match. Guarded ingestion image-key update applied
  (env SHA36ac1fff...66959 ->8576a8ff...3b555); renderedCPU0.20/160MiB/livefalse and saved auth pass.
  R45 rollback image preserved; no migration. Next exact operation: named ingestion recreate.
- Recreate completed20:58:31UTC. ExactR46 containerb524cc46b488...1eaa3, restart0/OOMfalse,
  auth-presence true/livefalse; memory79.64MiB/160MiB at21:00UTC. PG/alpha identities unchanged.
  Ledger stillrevision2 in_progress; observe until at least21:13:31UTC and independently verify
  price freshness, queue, coverage, errors and resources before completing. Do not recreate again.
- 15-minute check21:13UTC: all12services remain; only ingestion identity changed. PG/Redis healthy,
  restart0/OOMfalse, inbox0/dead0, unresolvedfinality0, openincidents0. New priced sample1113
  oracle-converted/19observed-execution/79proxy. Pyth auth and historical/latest feeds work again.
- Capacity acceptance FAILED: pending19,446; no negative queue slope. Do not declare R46 a complete
  queue fix or promote another service. Serverledger revision3 marks the phase failed and halted.
  Safe R46 ingestion is retained because data/provider safety passed; exactR45 rollback remains.
  The remaining bottleneck is useful elevated-work/full-history processing, not just low-evidence
  price revisions. User needs the incremental reader, not another arbitrary waiting period.
- Transfer cleanup is now separately armed: revisions4planned/5in_progress. Exact local/server
  SHA rechecked at21:17UTC; currentR46 and rollbackR45 images match. Next action: guarded removal
  of ONLY /opt/walletscaner/deploy/walletscaner-worker-alpha-producer-admission-r46-20260829.tar.zst.
  This is the463454623-byte transfer file, not evidence or a Docker image/volume.
- Exact transfer removal completed; ledgerrevision6 SHAe6fde53129cc2ea4b7e05632403b33de75029e870744b138016094bc7839c2d2.
  Filesystem free14,188,494,848 ->14,651,949,056bytes; current image/restarts unchanged. No production
  operation is in progress. Do not repeat deletion, deploy or credentials work.

## Phase2: storage implementation (local work in progress)

Map compact materializer -> FIFO/scorer consumer -> source retirement. Add reader continuation,
parity/replay and invalidation gates before retirement. Rehearse on populatedPG16 and prove bounded
work/WAL/temp and preserved open lots. Keep B2 full evidence and fail closed on unavailable
archive/restore/parity. No emergency DELETE/TRUNCATE/VACUUM FULL is authorized by this plan.

- New finding: migration051 stores round-trip episode aggregates, but scoring counts every partial
  sale separately; its scalar lots also omit continuation cost/quality counters. Existing parity
  proves only copied fields, not full scorer/continuation equivalence. Do not switch the reader.
- Local core now has an additive serialized FIFO continuation API sharing the existing evaluator.
  It emits per-sale deltas, retains open lots/counters, rejects late input/precision changes and
  has row/market/byte bounds. No production caller/schema uses it. Tests are the next exact step.
- Targeted31/31tests pass, including every fixture split/restart, partial-sale sample parity,
  close/reopen, duplicates, late-correction rejection and quantities beyond JS safe integers.
- Generated9000-history/120-suffix run: exact parity; checkpoint5511bytes, full296ms vs delta5ms,
  peakRSS130.35MiB under112MiBheap. NOT production or total-storage proof; historical sale facts
  are emitted separately and must remain durable in the future database adapter.
- npmci passed, no vulnerabilities; typecheck/lint/build passed. First parallel full run519pass/2
  default5s fixture timeouts; serial520pass/1archive fixture timeout. That existing fixture launches
  multiple child materializers with30s bounds; its outer deadline was incorrectly5s. Outer test
  deadline only now30s (SQL/child/production budgets unchanged); full521-test serial run in progress.
- Serial full gate now521/521passed, no skips (PG16.15/zstd). Added scorer-input parity test after
  that run:40targeted tests/typecheck/lint pass. Full522-test rerun is next before commit.
- Final serial full gate522/522passed,102files, no skips; typecheck/lint passed. Workspace build
  passed. Source/tests/docs committed7c6a3da (main ahead240). No source/scorer thresholds,
  provider routes or production timeouts changed.
- Local disposable PG16.15 is running only127.0.0.1:54329 with32MiBshared buffers. Initial launch
  accidentally used default5432; it was stopped immediately and relaunched correctly. No user DB
  or production PostgreSQL was touched. Stop this exact local cluster when tests finish.

## Phase2b: independent maintenance inventory (local, not deployed)

- New live finding21:32UTC: last24h has37completed maintenance reports and9unhandled statement
  failures. The monolithic eligibility inventory at prune-operational-data.ts:96 times out before
  any cleanup. Latest successful report20:29UTC remains on disk, hiding the failed attempt.
- Implement bounded independent advisory probes, explicit unknown states and fresh failure reports.
  Unknown inventory must never grant archive deletion authority; payload priority fails closed.
  Retention predicates/periods and resource limits stay unchanged. No schema mutation is planned.
- Local Docker start did not yield a working Linux engine. Only our hung CLI clients18736/23540
  were stopped at21:32UTC; Docker backend was not reset/stopped or reconfigured. No Linux artifact
  or populated latest-dump restore is running. Native PG16 remains available for integration.
- Next: test one inventory timeout does not block unrelated maintenance and unknown is not false;
  preserve schema051 compatibility for the not-yet-deployed optional decision tape. Then full gate,
  immutable Linux artifact and guarded maintenance-only canary; no canonical source retirement.

### Urgent price-partition safety repair, verified21:43UTC

- Live R36 maintenance SQL deletes price rows using ctid only. PostgreSQL16 regression reproduced
  one expired row selecting/deleting a fresh row in another partition with the same ctid. New SQL
  uses (tableoid,ctid); regression retains fresh row. Historical impact is unknown, not asserted zero.
- Exact maintenance containercbaaa228eae8f5af851dc25626958140b38fcb315c4df2bbd8eac110fce9d1b3,
  image24bcc3fa77d3a0a9e4369eb43ec4d33084b4985f1feedcc41db97cde1548d00a,
  tagwalletscaner-worker:storage-r36-20260826;CPU0.04/memory64MiB, restart0/OOMfalse.
- Preflight21:43:52UTC: free14,604,664,832bytes;availableRAM1015MiB;WAL486,547,456bytes;
  temp49152bytes;backup current SHA/offsiteACK stillpass (age25.34h);all12running,co-tenantempty.
- Next exact mutation: revision-ledgered stop ONLYdata-maintenance to prevent another unsafe price
  cleanup. Ingestion/alpha/archive/backup/PG/Redis must remain unchanged. Keep old image as evidence,
  but do not automatically resume known-unsafe retention if the new canary fails.
- Docker fallback: narrowly scoped copy-only derivative of the exact already-loaded R36 image,
  no dependency install/network build/full repository build. Hash source overlay, test the exact
  Linux artifact, then read-only/dry-run canary before named-service replacement. No host reset.
- Stop completed21:44:39UTC; maintenance exited, all11other running services unchanged andPG/Redis
  healthy. Ledgermaintenance-r47-20260831.json revision3 SHA669fedecd016f492fb0ce1497a5543441fbc17cde7e2fb2e3e4fd14c6c5f9620.
  No stop operation is pending; do not restart the old unsafe image. Next: copy-only artifact gates.
- Full current nativePG16 suite537/537passed106files/no skips;typecheck/lint pass. Exact source-only
  tar C:/Users/Umut/AppData/Local/Temp/walletscaner-maintenance-r47-20260831.tar is118784bytes,
  SHA f63395b611b1464580c1bbd50e84f8ce5f71929f4bbd86fedfdfa05970dc904b. No production upload yet.
- Source committedf2472a937b0b3de3bc1709082b2983d036952738;final workspace build passed.
  Overlay uploaded/hashed and copy-only build completed (~5s, no RUN/install/download): R47 image
  sha256:7f2125d2b1c78b0cf50d9c1166a25a0cdd38ac97f60ad8b8fe75752bcf92db68.
  Server ledgerrevision5 in_progress; exactLinux unit test is next/running before marking artifact
  completed. No production service has been started or replaced since containment.
- ExactLinuxunit30passed;the1PG-dependent test intentionally omitted in networkless Linux unit
  container and passed in nativePG16 full537suite. Both dry-run/read-only canaries completed on
  schema051, no writes/provider alerts, inventory no timeout/deferred. Monitor correctly identifies
  dry-run, DB size and compaction lag instead of falsely healthy. Ledgerrevision8 in_progress.
- Next: complete read-only phase, planned/in_progress named activation, guarded operations image-key
  updateR36->R47, recreate ONLYdata-maintenance andoperations-monitor, verify identities/resources,
  then one bounded maintenance pass under its existing64MiB/0.04CPU to check fresh-price preservation.
  Other operations schedulers remain on their original image/container; no migration or data rebuild.
- Activation guard safely aborted BEFORE environment or service mutation: configured operations
  baseline isR42, even though maintenance/monitor currently ranR36. Ledgerrevision11 failed with
  reason pre-state mismatch. Do not retry with a guessed expected value and thereby regress future
  archive schedulers toR36. Build a new immutable R47b derivative of configuredR42 instead.
- ExactR42 image4d9cbf85ada0981a79b394bf445465fcd4d7134b52c2aecbc9dca784c54fdcb6,
  source423559147ea6b4f8c4c08a6bde8ccc5db528b565. Samef2472a9patch/overlaySHA and tests;
  newtagmaintenance-r47b-20260831 must pass exactLinux/dry-run again. OldR47tag is not retagged.
- R47b built with exactR42layers+2copylayers;image6d59cc34ddfdbc6bbf5b771fdd4911dc9bb24b53c1898af81edee100ba9e1a65.
  ExactLinuxunit30passed again. Ledgerrevision16 read-only canary running (native tests remain537).
  reports/deploy/maintenance-r47-price-sample.json holds100fresh price keys for post-retention check.
  Local disposable PG16 was stopped21:58UTC after all tests; no local restore/service is running.
- R47b dry-run/monitor passed again. Guarded operations image-key R42->R47b applied (envSHA
  c84d7a01e31a12cac3e2b131f4d3ba12ba584d090f1083b8f26701a20f912e23). ONLYtwo services recreated
 22:01:14UTC: maintenancee157811111946fc1d2a256b8d3197e9b460c4c78795d1b0b308f21658c335863,
  monitor9805e30f76699295d43ae3945b52c49d710cd995b8def0f5a709ea3e084da439.
  Both exactR47b/restart0/OOMfalse,64MiB and0.04/0.03CPU, mounts unchanged;other10services unchanged.
  Ledgerrevision19 in_progress. Next: one bounded manual pass inside maintenance (its scheduled
  startup delay remains unchanged), then verify100fresh prices and zero canonical-wallet retirement.
- First actual bounded pass22:02:52UTC completed43.805s:19expired prices,2000verified payloads,
  3502swaps,15000terminal repair signatures,252superseded scores;zero canonical wallet rows retired.
  All100protected fresh prices remain. Inventory timeout/deferred0, restart/OOM0. Only the
  pre-existing completed-signature timeout remains (honestly reportedpartial, not completed).
- Exact live EXPLAIN shows why:5000batch chooses full165944-row sequential-scan/hash join;500batch
  uses composite-PK nested loop. Local follow-up caps only this stage to min(inboxBatchSize,500),
  without longer SQL budgets, schema changes, retention changes or dropping unresolved signatures.
  R47b stays running while the small R48 follow-up is tested. Ledger19 activation verification
  remains open until automatic first cycle/post-state is checked; do not repeat recreate/manualrun.
- R48 local full nativePG16 gate539/539passed106files/no skips;typecheck/lint pass. New fixture
  verifies500+500+0 expired-completed retirement while preserving50fresh-completed and50pending
  signatures. Next: commit the coherent follow-up, build an immutable copy-only derivative of the
  exact runningR47b image, repeat exactLinux/read-only gates, then recreate ONLYdata-maintenance.
- Follow-up committed089d1ae69f83409dcc6609008ed00e470c17b990. Exact overlay tar119808bytes,
  SHA8eb88e086669da1df13e07aa1b2d05f92a812eebfc85d68d81fd3668dbb62576.
  Preflight22:18UTC:runningmaintenanceexactR47b/restart0/OOMfalse;free14,546,493,440bytes,
  availableRAM986MiB,WAL486,547,456bytes,temp49152bytes;currentbackupSHA/offsiteACKtrue;
  protectedco-tenantempty. Workspace build is still running; artifact may stage/test but no named
  service recreate until it passes. R47b remains rollback/stable current image.
- Workspace build passed. R48 copy-only image is
  sha256:fb863a2940e172ebe502c0fa46509dd04ecaecc4fcae95ccdc91ba1f00e2bbf2,
  exactR47b layers+2copy layers; exactLinux31tests passed,1PG test intentionally skipped there and
  passed in nativePG16 full539suite. Ledgerrevision22 in_progress. Next: schema051 read-only dry-run,
  then guarded R47b->R48 operations key and recreate ONLYdata-maintenance if it passes.
- R48 read-only schema051 canary passed83ms with zero inventory timeouts/deferred/mutations. Guarded
  operations image key R47b->R48 applied (envSHA5e5f1a8c...b35f94); ONLYdata-maintenance recreated
  at22:20:53UTC:container486754e5ead692441e206b2572cf97d87d5e3cadb1504fd0c8b21c1b7841b666,
  exactR48/restart0/OOMfalse/64MiB/0.04CPU. Monitor and other10services unchanged. Ledgerrevision25
  in_progress.
- Bounded R48 pass22:22:17UTC completed44.983s:4250verified payloads,1173swaps,
  22288expired completed Solana signatures and129superseded scores retired;zero prices and zero
  canonical wallet trades/entries/outcomes/episodes retired. All100protected fresh prices remain.
  Completed-signature timeout is cleared; inventory timeout/deferred are zero; restart0/OOMfalse.
  Report remains honestly partial only because the separate ingestion-gap-repair-signatures stage
  timed out. Disk free14,518,800,384bytes after the pass. Alpha cycle still processes only45wallets
  in246.603s while20384jobs remain (18360background/2024elevated), so neither queue nor global
  storage equilibrium is proven. Next exact production action: mark activate-r48 completed in the
  revision ledger with the residual gap-repair timeout explicit; do not recreate or rerun R48.
- After the ledger closes, stop the exact local127.0.0.1:54329 PG16 validation cluster and pivot to
  the bounded incremental wallet reader/CAS design. Gap-repair retention optimization remains a
  separate non-blocking follow-up; do not hide it by increasing timeouts or lowering safety gates.
- R48 activation ledger closed at revision26, SHA
  24ae4d864f9ebe8530da7a51a1ae7d9a67ec7b286e4b20fd927837fb72e258c0; phaseactivate-r48 is
  completed with rollbackR47b and residual gap-repair/global-equilibrium caveats recorded. The
  local PG16 validation cluster127.0.0.1:54329 was cleanly stopped. No R48 operation is pending.

## Phase3: incremental wallet materialization (active, local design only)

- Objective: replace each alpha job's unbounded full wallet-history reload/rebuild with a bounded,
  deterministic continuation while preserving exact scorer/FIFO parity, correction invalidation,
  temporal ordering and fail-closed coverage. No queue clearing, threshold relaxation, canonical
  deletion, production migration or service restart is authorized by this design checkpoint.
- Verified baseline at22:22UTC: latest cycle processed45wallets in246.603s with20384pending jobs
  (18360background/2024elevated), zero failures/signals and64.87MiBRSS. The existing continuation
  core commit7c6a3da proves calculation parity locally but has no database adapter, CAS revision,
  correction replay boundary, per-sale facts or populated dual-read proof.
- Next exact read-only action: map the current alpha worker repository calls, ordered evidence keys,
  migrations051+ and scorer inputs; define the smallest additive schema/adapter contract and its
  invalidation/rollback gates before editing any migration or production configuration.
- Mapping found a lower-risk Phase3a before any continuation schema: every cycle already performs
  a bounded100-wallet admission probe, but then claims/completes each below-threshold revision one
  at a time. A live indexed sample found68/100background candidates below the configured6-trade or
  3-entry threshold;100/100elevated candidates were admitted. A3000-candidate diagnostic correctly
  hit its12s bound and made no mutation; the100-per-lane probe completed in4.279s.
- The active scorer never reads WalletTradeEvidence.raw, yet its hot PostgreSQL method selects and
  transports full provider JSON. One live admitted sample had540trades/423929raw bytes/696425row
  bytes; scalar projection reduces planned row width1208->500 and sort memory1105KiB->355KiB.
  Cache order prevents treating the413ms-vs2ms run as a clean latency ratio, so only byte/width
  reduction is accepted as evidence.
- Phase3a local change: (1) bulk-complete only exact, currently unlocked low-evidence candidate
  revisions already measured by the existing admission probe; a concurrent revision mismatch must
  remain pending, and (2) add an alpha-ledger scalar trade projection returning raw={} without
  changing the general evidence reader. No threshold, strategy, schema, retention, worker resource
  limit or producer is changed. Acceptance: memory/PostgreSQL concurrent-revision tests, score and
  FIFO parity, full native PG16 gate, bounded benchmark, immutable Linux artifact and named alpha-
  worker-only canary. Do not deploy if useful-wallet throughput or queue slope is not improved.
- Phase3a implementation/typecheck/lint passed. PostgreSQL integration36/36passed, including exact
  revision-CAS preservation and full-reader raw versus scorer-reader raw={} separation. Initial
  full run was invalid because zstd was absent from PATH:535tests passed and6archive tests failed
  with explicit spawn zstd ENOENT/timeouts. After adding only the existing local zstd1.5.7 binary to
  the test-process PATH, the isolated archive set passed9/9 and the full serial nativePG16 gate
  passed541/541 across106files with no skips. No timeout or product gate was relaxed.
- Workspace production build passed. Generated one-oversized+99-useful-wallet benchmark processed
  all99 useful wallets and quarantined only the10001-trade wallet in412.22ms at38.41MiBheap and
  119.75MiBRSS (limits30s/100MiBheap/160MiBRSS). This is anti-regression evidence, not live queue
  slope. Next: stop localPG16, inspect/commit the coherent source+tests+docs, then stage a copy-only
  Linux artifact from the exact running wallet-alpha image. Production activation must be ledgered,
  alpha-service-only and accepted only by useful throughput plus net lane slopes; R48 is untouched.
- Local source committed3cf1a4e. Preflight22:46UTC: alpha container1b7df492... exactR43 image
  sha256:e87020e75036e6f0f376a516228c6546959cd3c6479840e4547d62f5f928bf3b,
  restart0/OOMfalse,160MiB/0.10CPU; disk free14,346,936,320bytes, availableRAM1,028,472KiB,
  WAL620,765,184bytes. Current2,770,884,949byte dump SHA sidecar/offsiteACKtrue, age~26.4h;
  latest full restore remains unproven, so no schema/source retirement is permitted. Protected
  co-tenant inventory empty; all other Walletscaner identities captured and unchanged.
- New docker/alpha-hotfix.Dockerfile is copy-only (noRUN/install/network) and includes only the
  alpha repository/report sources plus their exact tests. Next: commit this artifact recipe, create
  a content-addressed overlay tar, hash locally/server-side, then build from exactR43. Do not update
  Compose or recreate a named service before exact Linux tests and a schema051 read-only/run-once
  canary pass.
- Artifact recipe committed86ab6b702559cbbbf27a47638e4869a944a8bfcc. Exact seven-file overlay
  is435712bytes/SHAca42e9c9e32a9aff9cfc267022a7d5700bdd602ca4916059197196664b93d696;
  local listing was reviewed. Server release ledgeralpha-phase3a-r49-20260831.json is revision2
  build-copy-only-artifact/in_progress. Upload landed at the exact deploy path with matching server
  SHA/size; no service/config/image has changed. Next exact action: create a fresh context, build with
  network=none from exactR43 image and verify parent layers/labels before running Linux tests.
- First build attempt failed before image creation: Docker treated FROMsha256:e870... as a registry
  repository reference and refused resolution. The seven-file context exists, targetR49 tag does
  not, and no service/config changed. Record revision2 failed before retry. Correct retry may use
  the local tag only after `docker image inspect` proves that tag still resolves to exactR43 ID;
  preserve the failed history and do not recreate/re-extract the context.
- Correct tagged-base build succeeded: R49 image
  sha256:7c5d1788e10ba5c5ff6006a9af0dfc70275603c0bb84d7be1bb293f9707ee830;
  exact31R43 layers are the prefix and exactly2COPY layers were added. First read-only Linux test
  invocation stopped before tests because Vitest could not create `/app/node_modules/.vite-temp`;
  this is a canary mount failure, not a code/test failure. Retry the same immutable image with an
  exact32MiB tmpfs at that path; keep network none and do not rebuild.
- Exact immutable Linux retry passed18/18; bounded benchmark at0.20CPU processed99useful/1oversized
  in3922.07ms at16.32MiBheap/105.2MiBRSS. Read-only live canary used
  `default_transaction_read_only=on`,5s per-statement timeout and no dependencies:100candidates,
  0low-evidence/100admitted,2978scalar trade rows,raw payload empty and first-row canonical identity
  parity true; pending21505. The top lane is currently admitted work, so batch low-evidence cleanup
  will engage only after elevated work advances; no ordering/gate is changed.
- Next exact mutation: complete artifact ledgerrevision5, then planned/in_progress activation. Guard
  `.env.server` research image from exactR43tag to exactR49tag, retain a root-only rollback copy and
  recreate ONLYwallet-alpha with `up -d --no-deps --force-recreate`. Verify all other container IDs,
  resource limits, live=false, DB/Redis/co-tenant and first full cycle. Roll back on OOM/restart,
  failure growth, useful throughput regression or non-alpha identity change.
- First activation guard failed before R49 start because Compose config was rendered without the
  research profile, so wallet-alpha was absent from JSON. The rollback trap restored exactR43 env
  and recreated only alpha:container43c80632..., exactR43,restart0/OOMfalse,limits unchanged.
  DB/Redis/co-tenant gates pass. A diagnostic initially reported maintenance/monitor changes only
  because its comparison included human `Up N minutes` status text; use ID+image only. Record
  activation revision8 failed, then retry under a new phase with `--profile research config` and a
  fresh ID+image-only pre-inventory. Do not reuse the earlier success assumption.
- Profile-aware activation changed ONLYwallet-alpha to exactR49 container e5563475...,restart0/
  OOMfalse,limits/live=false unchanged; other ID+image pairs,DB/Redis/co-tenant passed. First full
  cycle failed capacity acceptance:248017ms,39useful processed,21low-evidence skipped,0failures,
  RSS108.96MiB; pending21505->21976 (background20126/elevated1850/signal0). Prior comparable
  baseline was45useful/246603ms. R49 is safe but does not improve useful throughput or net slope.
  Mark activation failed and restore only alpha via the exact profiled rollback env/R43 image;
  retain R49 image/artifacts as evidence. Do not call this queue/storage resolution.
- Rollback completed: ONLYwallet-alpha recreated as container24e887ca..., exactR43 image
  sha256:e87020e75036e6f0f376a516228c6546959cd3c6479840e4547d62f5f928bf3b,
  restart0/OOMfalse; config/limits/live=false restored. All other ID+image pairs unchanged and
  DB/Redis/co-tenant gates pass. Release ledgerrevision15 phase rollback-alpha-r43/completed,
  SHAd9d49641b2b1d3121648289ecaaae5b2aa029554c9b18b7181189ef4c8e49a65.
  No R49 production mutation is pending. Next exact local design: additive transactional FIFO
  checkpoint/CAS with source correction invalidation and durable partial-sale facts; do not deploy
  another queue-only optimization before populated parity and benchmark evidence.

## Phase4: transactional FIFO continuation foundation (active, local only)

- Rejected approach: a wallet-level invalidation trigger that takes advisory locks per changed row.
  Multi-wallet price enrichment can acquire scopes in different orders and deadlock; a global lock
  would serialize ingestion. Do not implement either.
- Selected invariant: one `wallet_trade_revisions` row per chain/wallet/strategy. Every canonical
  trade insert/update, price enrichment and historical materialization transaction increments it
  once per affected wallet and retains the lexicographically earliest dirty trade order. A worker
  checkpoint commit locks this row and succeeds only at the revision it read. Later append-only
  evidence can continue from the suffix; an old/updated/unknown boundary requires full rebuild.
- Additive migration054 will add the revision row, bounded integrity-hashed FIFO checkpoint and
  durable per-partial-sale facts. It does not redirect readers, delete source, change score gates or
  run in production. First implementation checkpoint: producer revision function/calls, schema and
  race/order integration tests plus expanded realization metadata. Reader/commit cutover follows
  only after this foundation passes nativePG16 and populated-clone parity.
- Local implementation checkpoint: migration054 now defines the non-seeding revision table,
  4MiB-bounded/hash-checked continuation table, durable partial-sale facts and a row-locking
  expected-revision commit function. `saveWalletTradeEvent`, price enrichment and historical
  materialization record one oldest-dirty revision per affected wallet in their existing
  transaction; partial-sale metadata now carries exact raw/remaining quantity, decimals and
  open/close/quality fields. Static and nativePG16 concurrency tests are written but not yet run.
  No production schema/image/config/service changed. Next exact action: start the disposable local
  PG16, run migration054 via the complete clean-schema integration setup, fix any SQL/type failure,
  then run the focused core+DB tests before a coherent commit. Do not deploy at this checkpoint.
- Foundation verification completed locally. Migration054 also adds nullable exact raw-quantity and
  decimals columns without a default/rewrite; new exact evidence round-trips through the scalar
  reader, while historical unknowns remain NULL. Raw-payload-only merges preserve the repository's
  changed return value but do not advance FIFO revision or enqueue scorer work. Producer tests prove
  save/enrich/historical changes coalesce once per affected wallet, stale CAS rejection, and that a
  producer blocked behind the checkpoint row lock advances revision/dirty state after commit.
  Typecheck, lint and workspace production build passed. The first fully parallel test invocation
  passed499 unit tests but three concurrent migration-suite hooks exceeded their unchanged10s setup
  budget; rerunning the identical complete suite with one worker (no timeout/gate relaxation) passed
  all107files/544tests with zero skips. Next: stop disposablePG16, commit this independently safe
  foundation and record its hash. No production migration/deploy is authorized by this result;
  reader/fact commit integration and populated-clone parity remain required.
- Foundation is committed as `b15282f` (`feat: add transactional FIFO continuation foundation`);
  the workspace returned to only the four preserved pre-existing deploy temp/partial files.
  Phase4b is now active and local-only. Next implementation boundary: typed repository load/commit
  APIs, exact suffix query using the same `(slot, observed_at, signature C, idempotency_key C)`
  order, atomic full-vs-incremental projection/fact persistence under migration054 CAS, and a
  dual-read worker path that fails closed to full rebuild whenever the dirty order is unknown or at
  /before the checkpoint. It must prove score/ledger hashes against the unchanged full reader and
  benchmark a populated clone before any migration/image/deploy. Production remains exactR43.
- Phase4b implementation is present locally and remains undeployed. Repository interfaces and the
  PostgreSQL/Memory implementations now load the revision/checkpoint/facts, read an exact ordered
  suffix, persist full-or-append facts through the expected-revision CAS, and merge the current
  ledger projection without deleting older closed episodes. The worker seeds from full history,
  uses suffix continuation only when the dirty boundary is strictly after the checkpoint, and
  fails closed to a full rebuild for old, unknown or inconsistent corrections. Targeted core,
  Memory and nativePG16 tests prove first-full/second-suffix behavior, byte-for-byte score parity,
  stale-CAS rollback and old-correction fallback; typecheck and lint pass. The full serial gate and
  coherent commit are the next exact actions.
- Resume verification on 2026-08-31 found that the disposable PostgreSQL instance is only about
  22MiB and has no `public.wallet_trade_events`; the earlier multi-GiB temporary restore is no
  longer present. This is not production data loss, but populated-clone parity is therefore still
  unproven and must not be claimed. After the full source gate and Phase4b commit, locate or obtain
  a hash-verified dump and restore it into an isolated local clone before any production migration,
  image or service change. Production remains exactR43 throughout this checkpoint.
- Phase4b source gate completed on Node 24 with the native disposable PostgreSQL 16 instance:
  typecheck, lint and workspace production build pass; the complete serial suite passes all
  107 files / 547 tests with zero skips. An initial full run had one Windows-only transient
  `EPERM` while replacing the materializer's generated latest-report file; its focused 5-test
  integration suite then passed without deleting/resetting either report, and a second complete
  547-test run passed. No schema, image, config or service has been changed in production. Next:
  review/stage only the Phase4b files, commit the coherent local checkpoint, stop the disposable
  PG, then locate a hash-verified dump and measure populated-clone parity/capacity.
- Phase4b source was committed as `7e3464a` (`perf: continue wallet FIFO ledgers transactionally`). The
  disposable local PostgreSQL instance was then stopped cleanly and status confirms no server is
  running. The only remaining workspace files are the four preserved pre-existing deploy
  temp/partial artifacts. Next exact action is read-only discovery of the named verified dump and
  local disk headroom; do not start a restore until its SHA/provenance and isolated target are
  established. Production remains exactR43 and migration054 remains unapplied there.
- Populated-clone source is now established read-only at
  `C:/Users/Umut/WalletscanerBackups/memecoin_alpha_20260829T173517Z/` (dump size
  2,770,884,949 bytes). A fresh local SHA-256 calculation, the server sidecar and the offsite
  acknowledgement all match
  `566487ea4fdbc074ed81bd83853a1147dbdcb962bddb3d9f96b3112ae9f06478`; the acknowledgement says
  `offsite-sha256+source-postgres16-byte-identical`. Local C: free space is about 66.45GiB. Next:
  verify the custom archive list with local PostgreSQL16, start the disposable cluster, create only
  `walletscaner_populated_20260829`, restore with no owner/ACL, measure the result, then apply 054
  and run full-vs-continuation parity/capacity. Do not alter production or the verified dump.
- PostgreSQL18 `pg_restore --list` read the PG16.14 custom/zstd archive successfully: 617 TOC
  entries (628 list lines), with `pg_stat_statements` and `pgcrypto`; exit zero. The disposable
  PostgreSQL16.15 cluster is running only on local 127.0.0.1:5432 and the isolated empty database
  `walletscaner_populated_20260829` was created (7,930,383 bytes). No other database exists beyond
  `postgres` and templates. Next exact action is one `--exit-on-error --no-owner --no-privileges`
  restore from the verified immutable dump. If the PG18 client emits any PG16-incompatible command,
  record failure, discard only this isolated clone and obtain matching PG16 restore tooling.
- The guarded PG18 restore stopped before schema/data at its first command because PG16 correctly
  rejects PG18's `SET transaction_timeout`; the isolated database remains empty-sized and this is
  not accepted as a restore. PostgreSQL.org routes Windows binary archives to EDB; the current
  matching 16.15 Windows x64 archive is EDB file id `1260468` (HTTP 200, 332,445,137 bytes). Next:
  download it only to the local temp validation directory, extract it separately, verify
  `pg_restore --version` is 16.15, then rerun the same exit-on-error restore. No production action.
- Official PG16.15 client archive was downloaded to local temp (exact advertised 332,445,137
  bytes), extracted separately and reports `pg_restore (PostgreSQL) 16.15`. Its guarded two-job
  restore completed with exit zero. The isolated clone is 17GB on PostgreSQL16.15, has
  `pg_stat_statements`/`pgcrypto`, zero invalid indexes and 2,603,821 `wallet_trade_events`; largest
  relations include wallet trades 4,689MB and payload partitions 2,012/1,390/648MB. Restored
  migration state ends at 051, so populated upgrade must correctly apply ordered 052, 053 and 054,
  not 054 alone. Next: capture wallet table relfilenode/size and WAL LSN, run the normal checksum
  migration runner on this isolated clone, then prove no table rewrite/invalid index and record
  elapsed/WAL/disk. The verified dump stays immutable and production remains untouched.
- Populated 051->054 upgrade passed: normal checksum runner applied 052/053/054 in 9,907ms,
  generated 950,272 WAL bytes, retained wallet trade relfilenode 172701 (no 4,689MB rewrite), and
  left zero invalid indexes. Historical exact quantity remains honestly NULL; continuation tables
  start empty. A new read-only, localhost/database-name-guarded benchmark proves a 3,337-trade
  wallet at ledger+score hash parity: full read/build 925/88ms versus 100-row suffix read/build
  13/14ms, 680,142-byte checkpoint, 125.91MiB RSS. However the only sampled backlog wallet with
  material entry/outcome evidence has 11,857 trades, 667 entries and 1,332 outcomes; the current
  10,000 first-seed limit fails closed. Its last score is observed (2,686 positions, realized median
  +1.47%, followable median -37.28%), so neither silently excluding it nor merely raising one-batch
  memory is acceptable. Next Phase4c: prove bounded multi-page first seeding with the exact
  checkpoint order on this populated clone, then implement only if checkpoint/RSS/time remain under
  hard limits. Production remains R43/unmodified.
- Phase4c populated testing exposed a real order mismatch: core used locale-sensitive string
  comparison and `compareObservedAt` placed idempotency before signature, unlike the documented
  PostgreSQL C-order boundary. Local core now uses explicit code-unit order and the exact persisted
  `(slot, observed_at, signature, idempotency_key)` tuple. Regression covers same-slot mixed-case
  signatures with opposing idempotency order. A 5,000-row chunked read-only run on the 11,857-trade
  wallet then passed ledger+score parity with 667 entries/1,332 outcomes and a 2,644,019-byte
  checkpoint. Its baseline+continuation comparison process held both full ledgers and used206.77MiB
  RSS, so this is not yet a worker memory acceptance pass.
- Local worker now uses exact-order pages (default1,000), an explicit optional20,000 first-seed
  budget, and suffix-only bounds after seeding; it no longer retains source pages for scoring.
  New Memory test proves150-row seed under25-row pages with100-row suffix budget and a later
  successful append despite total history exceeding100. PostgreSQL page/bounds test and core
  targeted tests pass; existing report-builder spy assertions were updated to the new page API and
  all10report tests pass. Next exact action: run the actual one-shot worker with112MiB heap on only
  the named heavy wallet in the isolated clone, capture peakRSS/elapsed, then full native tests.
  Clone mutation is limited to that wallet's derived queue/ledger/continuation/score; no canonical
  trades, dump, B2 or production service may be changed by this benchmark.
- Actual112MiB-heap local worker seeded the heavy wallet successfully:11,857trades/12pages,
  667entries/1,332outcomes,1,239episodes/4,997lots, cycle5,413ms, no failure/quarantine. PeakRSS was
  171,488KiB (167.47MiB), so the160MiB production ceiling gate FAILED despite currentRSS149MiB.
  Next: reset only this wallet's derived continuation/facts/revision in the guarded isolated clone,
  requeue only this wallet, and repeat with the same112MiB old-space ceiling plus a4MiB semi-space
  cap. Do not raise production resources or call the seed capacity accepted until peakRSS has margin.
- The isolated-clone retry with `--max-old-space-size=112 --max-semi-space-size=4` completed the same
  11,857-trade seed in about3.15s with a measured peak RSS of111,416KiB (108.8MiB), below the
  unchanged160MiB production ceiling with margin. A subsequent no-new-trade wake completed in947ms,
  read zero trade rows, kept continuation generation1 and checkpoint row `ctid=(0,2)` unchanged,
  and peaked at103,032KiB (100.6MiB). This proves both bounded first seeding and the no-op path on
  populated PostgreSQL without a wide checkpoint rewrite. The verified source dump and canonical
  clone tables were not changed; only the named wallet's disposable derived state was exercised.
  Next exact action: rerun the full native repository gate with a durable captured exit code, then
  typecheck/lint/build and the synthetic worker benchmark. If all pass, commit Phase4c, stop the
  disposable PostgreSQL instance, and perform a fresh read-only production preflight before any
  separately ledgered migration or wallet-alpha-only canary. Production remains exactR43 and
  migration054 is still unapplied there.
- The refined full local gate is now green: native PostgreSQL16+verified zstd1.5.7 passed107test
  files/550tests with no skips or failures; typecheck, ESLint and workspace production build passed.
  The synthetic bounded worker benchmark processed99 useful wallets in474.73ms at29.62MiB heap and
  118.11MiB RSS, quarantining only its intentional10,001-trade suffix-limit fixture under the
  30s/100MiBheap/160MiBRSS gates. Next exact action: inspect/stage only the18 listed Phase4c files,
  commit the coherent local checkpoint, stop the disposable localPG16 instance cleanly, then run a
  fresh read-only production inventory. Any production migration/artifact/config/service mutation
  must be separately recorded in the release ledger and must retain exactR43 as rollback.
- Local Phase4c was committed as `eae80ee`. The disposable17GB PostgreSQL process was stopped
  cleanly; its data directory is preserved for evidence and no local server remains running. Fresh
  production preflight at2026-08-31T18:10Z found exactR43 alpha image
  `sha256:e87020e75036e6f0f376a516228c6546959cd3c6479840e4547d62f5f928bf3b`,
  restart0/OOMfalse, live=false,160MiB/0.10CPU; PostgreSQL/Redis are healthy, migration051 is latest,
  FIFO tables are absent as expected, database24,656,870,423bytes, disk free13,128,605,696bytes,
  WAL687,874,048bytes and temp53,248bytes. The only listed Compose project is Walletscaner; the
  protected co-tenant is absent. Queue has39,700pending (39,135background/565elevated),39,366 ready,
  one active lease and two errors; recent R43 cycles process19-60items per roughly246-257s while
  arrivals exceed drain. Canonical wallet trades remain fresh (~64s at the sample).
- A new scheduled backup is actively writing
  `backups/memecoin_alpha_20260831T173517Z.dump.tmp`:930,506,276bytes at18:13Z and growing across a
  three-second sample; pg_dump is alive at bounded low CPU. It is not yet a recovery artifact.
  Do not migrate or activate until it becomes a final dump, passes pg_restore-list/SHA and leaves
  adequate disk. Existing verified29-August dump/offsite marker and the complete localPG16 restore
  remain the rollback evidence. While the backup runs, the copy-only Dockerfile was narrowed to the
  exact current core/DB/report/worker tests and migrations052-054 required over exactR43; no image,
  upload, Compose file, environment, database or service has changed yet.
- Copy-only R50 staging artifact is exactly699,904bytes/SHA-256
  `4146e62ac63250d6ede3f9efe5ce1dcc33434705b30b394bbb1c0b60b83de906` with19 reviewed entries:
  the Dockerfile/Compose file, current FIFO core+tests, repository+integration tests, ordered
  migrations052-054, worker/report+tests/benchmark and the two guarded deployment helpers. It does
  not contain environment or credential files. Next: wait for the active31-August backup to become
  a final list-readable SHA sidecar generation, then create R50 release ledger revision1 `planned`
  before uploading this exact artifact. No production mutation has occurred at this checkpoint.
- Backup progress was rechecked: the31-August temp generation grew from929,815,600 to930,506,276
  bytes in three seconds; its `pg_dump` process is alive and isolated from the deployment artifact.
  It need only gate schema/service activation, not a content-addressed upload or an unused image
  build. Revised next exact action: create the R50 release ledger as `planned`, upload/hash/build/test
  the unused copy-only image with network disabled while the backup continues, but do not run any
  migration, edit the active Compose/env files or recreate wallet-alpha until the backup finalizes
  and is independently list/SHA verified.
- R50 unused-image staging passed exactR43 rootfs-prefix verification (31base+5COPY layers),45/45
  network-disabled Linux tests and the bounded benchmark at3,707.16ms/107.97MiBRSS; release ledger
  revision3 marks staging complete. Pre-activation dependency review then found a hard correctness
  gate: migration054 exposes `record_wallet_trade_revision`, but live ingestionR46, samplerR29 and
  materializerR42 predate the repository calls that invoke it. Activating only the new alpha reader
  would therefore leave post-seed writes/corrections outside CAS and could advance a checkpoint past
  a concurrent or older change. R50 must remain unused. Next: add a new immutable migration055 with
  statement-level transition-table invalidation that coalesces each affected wallet once per SQL
  statement (including legacy producer paths), remove duplicate explicit revision calls from the
  new repository path, and prove insert/accounting-update/delete plus raw-only no-op behavior in
  PostgreSQL16. Do not mutate production while this gate is open; active alpha remains exactR43.
- Migration055 now implements three statement-level transition-table triggers. Inserts, non-
  diagnostic updates and deletes call the054 revision primitive once per affected wallet in stable
  C order; raw/provider-only updates are ignored. New repository code no longer makes duplicate
  explicit calls. Targeted legacy/repository tests pass4/4 and the entire PostgreSQL evidence file
  passes41/41 (one prior run had two unrelated timing/state failures; an immediate full rerun passed
  without threshold changes). Populated054->055 normal-runner upgrade took2,089ms/98,984WAL bytes,
  retained relfilenode172701 and4,917,100,544-byte wallet table, four total non-internal wallet-table
  triggers and zero invalid indexes. A rolled-back1,000-row/100-wallet insert executed in210.483ms;
  migration055's coalesced trigger used35.226ms/one call, versus79.702ms/1,000calls in the existing
  archive trigger. Next: full native gate/type/lint/build, commit R51 source, create a new immutable
  artifact and Linux gate. Production remains exactR43; the active backup still gates migration.
- R51 source/docs are committed as `c25f147`; the full native gate passed107files/552tests plus
  typecheck, ESLint and production build. The exact20-entry copy-only artifact is710,144bytes with
  SHA-256 `07266ba5b5ad0276ecb1e09aef3c2bfcc0c460968df5c0874c6b4f4c059e2597` and includes immutable
  migration055. Next: create a fresh R51 release ledger, upload/hash/build from exactR43 with network
  disabled, and run Linux tests/benchmark. The image may remain unused while the31-August backup
  runs; no migration/activation is allowed until that generation is final and verified.
- Immutable R51 server staging is complete: image
  `sha256:11040e46acec558b3b37fec3103e4367efe0ade8b1ee62c3234dcd22079e0a49`
  preserves exactR43's31-layer prefix and adds5COPY layers; network-disabled Linux tests pass46/46
  and the0.20CPU benchmark passes3,311.62ms/108.58MiBRSS. Release ledger revision3 marks staging
  complete. The live server Compose SHA is
  `8c57d28c53145bbd7fe5669c53eb1329047c2821e748e8d24553d01937ae3288`; copying the repository
  Compose would incorrectly add the undeployed alpha-decision-tape service. A server-file-derived
  one-line candidate instead changes only wallet-alpha NODE_OPTIONS to add4MiB semi-space and hashes
  `94296952e45819eeed18ad50beaca2238036be6f629d1587473129a041d31270`. It has not been uploaded or
  applied. Next remains final backup verification, then ledgered migration/config/env/alpha-only
  canary with exactR43 plus original Compose/env as rollback.
- The31-August pre-change backup is now a verified recovery artifact:
  `memecoin_alpha_20260831T173517Z.dump`,2,804,194,002bytes,SHA-256
  `112599cf58e915dd57993fa780b84cfc7e5c2fed22368d7e6b211fd80aa3e4ad`.
  Scheduler pg_restore-list passed before atomic rename; an independent low-priority host SHA and a
  second PostgreSQL16 `pg_restore --list` both passed. Two older off-host-verified generations remain
  (16July and29August);13,331,984,384bytes disk remain. Next exact mutation sequence: ledger R51
  migration planned/in-progress; capture IDs/image/live/limits/relfilenode/LSN; run only migrations
  052-055 from the immutable R51 image with5s lock/60s statement bounds; verify checksums/tables/
  triggers/no rewrite/no invalid indexes. Then atomically stage the exact one-line Compose candidate
  and guarded research-image env change, recreate only wallet-alpha with `--no-deps`, and accept or
  roll back on identity/live/resource/OOM/restart/failure/useful-throughput/net-lane gates. All other
  Walletscaner containers and ingestion must retain identity.
- Fresh resume/pre-mutation reconciliation at2026-08-31T22:39:06Z proves the previous operation did
  not partially continue: live wallet-alpha is still container24e887caab3d/exactR43 image
  `sha256:e87020e75036e6f0f376a516228c6546959cd3c6479840e4547d62f5f928bf3b`, restart0/OOMfalse,
  live execution false,160MiB/0.10CPU and Node old-space112MiB without the staged semi-space cap.
  Migration051 remains latest, all three FIFO tables are absent, wallet trade relfilenode60487,
  size6,217,736,192bytes and zero indexes are invalid. Current DB size is25,067,830,295bytes,
  WAL553,648,128bytes, root free13,230,452,736bytes and available RAM about1.02GB. Canonical wallet
  trades were14seconds fresh. Evidence-v1 has39,500pending (39,193background/307elevated/0signal),
  39,498ready and one pending error; recent R43 cycles alternate between short admission passes and
  120-248second expensive work, so the positive queue slope remains the acceptance problem.
  The only listed Compose project is Walletscaner and the protected co-tenant inventory is empty.
- The immutable R51 image remains exact
  `sha256:11040e46acec558b3b37fec3103e4367efe0ade8b1ee62c3234dcd22079e0a49`; its labels retain exactR43
  as the base and patch `c25f147-c075c51`. The active server Compose SHA is still
  `8c57d28c53145bbd7fe5669c53eb1329047c2821e748e8d24553d01937ae3288`; the server-derived one-line
  candidate remains local-only at SHA
  `94296952e45819eeed18ad50beaca2238036be6f629d1587473129a041d31270`. The31-August dump retains
  exact size2,804,194,002bytes and its existing sidecar; the preceding checkpoint already records
  independent SHA and PostgreSQL16 list verification. No hash process or partial backup is active.
  Next exact action after committing this checkpoint: transition the existing R51 release ledger
  revision3 to a new migration phase planned, then in_progress; stop only wallet-alpha, run the
  exact R51 one-shot migration with explicit5s lock/60s statement limits, and independently verify
  migrations052-055/checksums/triggers/relfilenode/indexes before any config or service activation.
- The server rollout ledger is now revision4, phase `migrate-fifo-schema`, status `planned`, SHA-256
  `a7037697be0864fecc7d6886573e8b4d2fb2a8d543f437a56232669660fba224`. Its dry-run and atomic apply
  both passed; an independent JSON readback confirmed the revision/phase/status. No service, schema,
  Compose or environment value changed in this phase. A trailing CRLF-only shell diagnostic occurred
  after the readback and has no state ambiguity. Next: re-read revision4, transition this same phase
  to `in_progress`, stop only wallet-alpha, apply the bounded exact-image migration once, then verify.
- Production migrations052/053/054/055 are now applied through the immutable R51 one-shot container;
  their recorded checksums exactly match the local files. The original wallet-trade relfilenode
  remains60487, all three FIFO tables and all three migration055 statement triggers plus the prior
  archive trigger exist/enabled, five required functions exist and invalid indexes remain zero.
  Live legacy ingestion immediately populated known-order wallet revision rows while alpha was
  stopped, proving producer-independent invalidation is operational. DB size25,070,902,295bytes,
  WAL directory553,648,128bytes, wallet-trade freshness19seconds and root free13,216,702,464bytes.
- Only wallet-alpha was stopped. Its exactR43 container remains as rollback evidence with exit137,
  OOMfalse/restart0; it exceeded the30-second graceful stop window rather than crashing. Every other
  Walletscaner container ID/image remained unchanged and the protected co-tenant inventory remained
  empty. The one-shot migration container was removed. Release ledger revision6 is migration phase
  `completed`, SHA-256
  `aa24bdc8d64725623ca917955a67033c48ecfd42e36bc03cba64d65d4ebb5fd6`.
  Next exact action: open a new activation phase as planned/in_progress, hash-upload only the
  server-derived one-line Compose candidate, preserve root-only rollback copies of the active
  Compose/env files, dry-run then atomically change only the research image, and recreate only
  wallet-alpha with `--no-deps`. Restore the original Compose/env and exactR43 alpha on any hard gate.

## Completion conditions

Queue arrivals below useful drain, preserved trade/enrichment evidence, bounded lag and failure
recovery; retention exceeds measured ingress and retains8GiB reserve. Finite disk cannot guarantee
perpetual collection through unlimited B2/provider outage; backpressure must preserve evidence.
