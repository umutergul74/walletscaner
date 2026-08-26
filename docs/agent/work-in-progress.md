---
status: active
updated_at_utc: 2026-08-26T01:43:15Z
owner: codex
task: repair archive integrity/dead-letter and discovery coverage, then establish a bounded Walletscaner storage equilibrium on the fixed disk
last_safe_checkpoint: read-only production refresh completed; no mutation for this phase yet; R34 services remain operational, server ledger revision 9 remains in progress, canonical retirement remains disabled
---

# Walletscaner Work In Progress

This is the durable resume point for an interrupted multi-step task. It contains no credentials and
does not grant production authority. On resume, verify every recorded fact before continuing; never
blindly repeat the last mutation.

## Objective and acceptance criteria

- Keep the host above the 8 GiB hard reserve and target a steady free-space band near or above the
  current roughly 17 GiB, without emergency manual deletion.
- Keep only latency-critical/reconstructive hot state in PostgreSQL; move replay/audit detail to B2
  through immutable, independently restored and verified segments.
- Make archive, verification, compaction/retirement, retry and monitoring autonomous, bounded and
  fail closed.
- Prove deletion/retirement capacity exceeds peak ingress and a clean 24-hour post-catch-up slope
  before calling storage validated.

## Non-negotiable boundaries

- Keep `ENABLE_LIVE_EXECUTION=false`.
- Do not delete canonical wallet or chain evidence until exact B2 object, SHA, restore, coverage,
  compact-fact parity and reader dual-read gates pass for that cohort.
- No B2 delete/lifecycle/bucket/Object Lock change, `VACUUM FULL`, global Docker prune, volume
  mutation, destructive DDL or protected co-tenant operation.
- PostgreSQL remains the current hot-window and compact operational system of record.

## Known safe baseline

- Source HEAD before this task: `50f060d`; branch was 19 commits ahead of origin.
- Previous production observation: database 16,142,654,487 bytes, about 17.2 GiB host disk free,
  verified server dump 2,053,352,363 bytes, newest dump off-site acknowledgement still waiting.
- Raw `chain_event_payloads` daily B2 archive/verification/retirement is operational.
- The unresolved gap is the 95-day detailed wallet trade/entry/outcome model. A populated clone
  benchmark measured a 92.62% reduction for compact facts plus three-day staging, but live
  archive/dual-read/cutover gates are not implemented.
- The untracked `deploy/.tmp-pipeline-storage-r28-2dc66ab.tar817264887` is a stale local transfer
  artifact. It is not production data and must not be committed or confused with an R30 rollback
  image.

## Current phase

1. Read-only inventory: relation/index/TOAST sizes, age distribution, daily rows/bytes, WAL,
   retention owners, B2 manifests, compaction lag, dump/archive state and disk slope.
2. Map every consumer of trades, entries, outcomes, lots and episodes; define minimum hot/compact
   fields and deterministic replay/restore contracts.
3. Select the smallest design that continuously returns filesystem space; reject plain DELETE from
   unpartitioned relations as a permanent solution.
4. Implement additive schema/archive/compact-state changes and tests locally; rehearse on a
   populated PostgreSQL 16 clone.
5. Deploy only after backup/off-site/headroom gates; shadow dual-write/read first. Source retirement
   remains disabled until cohort restore/parity and future canary gates pass.

## Verified live inventory at 2026-08-25 19:22 UTC

- Host `/` had 18,820,648,960 bytes free (17.53 GiB); PostgreSQL was 16,193,281,047 bytes
  (15.08 GiB). The latest hourly sample at 19:12 UTC was 16,183,409,687 database bytes and
  17,140,256,768 free disk bytes. From 01:10 to 19:12 UTC the database grew about 1.70 GB, so the
  current backfill-heavy slope is materially above the older 0.58 GB/day estimate and cannot be
  treated as steady state.
- Largest relations: trades 4,468,891,648 bytes; entries 1,545,306,112; outcomes 1,477,165,056;
  lots 891,969,536; scores 847,462,400; episodes 623,755,264. These six total about 9.18 GiB.
- Raw daily payload partitions were 609 MiB for August 23, 998 MiB for August 24 and 1,056 MiB for
  the still-open August 25 partition. This is consistent with the 48-hour hot raw-payload window;
  old verified daily partitions are being dropped rather than retained indefinitely.
- B2 raw archive had 24 independently verified/Object-Locked segments from July 31 through the end
  of August 24: 932,555 rows, 20,028,508,873 source bytes and 1,516,093,140 compressed bytes. No
  pending/retry/dead-letter segment existed. The August 24 writer took 4,359 seconds under its 4%
  CPU ceiling, so raw throughput still exceeds one daily cohort but leaves limited shared archive
  budget for a second source unless scheduling is made source-aware.
- New wallet evidence is accelerating during catch-up: August 24 produced 58,252 trades / 14,206
  entries / 27,620 outcomes; the partial August 25 day already had 65,709 / 16,472 / 33,755.
- The newest 2,053,352,363-byte server dump now has its off-site verified acknowledgement (written
  2026-08-25 19:14 UTC). No backup file was deleted.
- `archive_segments`, the writer, verifier and retirement policy currently support only
  `chain-event-payloads`. There is no wallet-evidence B2 manifest, exact exporter, restored
  validator, compact materializer or partition-drop path in production.

## Recovery and resume

- No production mutation has occurred in this task; there is nothing to roll back.
- First resume action: inspect this file, `git status/log`, current-state and live read-only storage
  metrics. Do not repeat an upload, migration, archive run or cleanup without checking its durable
  manifest/migration/hash first.

## Interruption checkpoint at 2026-08-25 20:28 UTC

- Git HEAD remains `3b8af11`; the compact-shadow phase is intentionally uncommitted. Preserve the
  unrelated untracked `deploy/.tmp-pipeline-storage-r28-2dc66ab.tar817264887` file.
- Added migration 051, the bounded wallet-evidence materializer, its scheduled Compose service and
  a PostgreSQL integration path. TypeScript and ESLint pass.
- Built the exact Linux/Node 24 test artifact
  `walletscaner-worker@sha256:2daf3bea6a38d6468403bfff2197c92589859eb98afe8a5670f89b8144884500`.
  Its PostgreSQL 16 archive/materializer integration passed 5/5, including independent restore,
  digest parity and correction revision preservation.
- Restored the verified 25 August dump into the local disposable PostgreSQL 16 database
  `walletscaner_storage_lab` in container `walletscaner-pg16-r31`; the restored database is about
  11 GB. Migrations 050 and 051 applied successfully. Compact receipt count is still zero, so the
  populated materializer benchmark has not yet run.
- Restore-progress messages showing 1.6, 3.1 and 7.3 GB were intermediate filesystem observations,
  not separate or abandoned restores. The still-running clone was rechecked after the later
  interruption at 12,357,852,183 database bytes (11.51 GiB), including a 4,058,816,512-byte
  `wallet_trade_events` relation. The completed benchmark rows below are present in that same
  clone, proving the restore advanced from the 7.3 GB intermediate point rather than being skipped.
- No production command or mutation occurred during this phase. The next exact action is to export,
  independently validate and locally mark one full wallet-evidence day on the populated clone,
  then run the materializer and measure counts, parity, runtime and relation sizes. Only after that
  result should this phase be committed and production preflight refreshed.
- The populated-clone export/restore gate completed for the full 2026-08-24 UTC cohort under the
  production writer ceilings (128 MiB and 0.04 CPU). Local segment 65/revision 1 is `verified`.
  Exactly 100,078 records (58,252 trades, 14,206 entries and 27,620 outcomes) produced
  174,558,627 canonical bytes and a 16,034,890-byte zstd artifact in 562,489 ms. Independent
  restore reproduced counts, 174,558,627 bytes and source SHA-256
  `5bba6ee2fa6a5a03fa6e9e4394c4ebe19efe64e1bf986d1d98933e97699d43ab` exactly. The local clone
  uses a clearly labelled simulated verification receipt; this is benchmark evidence, not proof of
  a B2 upload.
- The exact 0.03-CPU/80-MiB Docker Desktop run twice timed out before opening a Node PostgreSQL
  connection; `pg_isready` independently proved the database/port healthy and no transaction or
  compact row was created. At the revised 0.05-CPU/80-MiB/120-second-statement ceiling the real
  materializer completed in 260,459 ms. It verified count and dual-digest parity for 218,492
  episodes, 251,460 non-realized lots and 27,498 mature followability facts. The fact tables occupy
  185,548,800 bytes and dimensions 3,219,456 bytes on this clone. The deprecated same-client
  concurrent-query warning observed during the gate was fixed by serializing the six aggregate
  queries; rerun the targeted tests after rebuilding the exact image.
- Added wallet archive/compact backlog, age and parity telemetry to operational health and the
  bounded Telegram summary. Same-revision materializer failures wait six hours; a corrected archive
  revision is immediately eligible. Missing source episodes are removed from the affected shadow
  wallet/strategy scope and covered by a correction-revision integration test.
- Final local gate: typecheck and ESLint passed; exact Linux/Node 24/PostgreSQL 16 storage,
  correction, telemetry and alert tests passed 17/17. The broader exact-image suite passed 421/430;
  its nine failures were only deploy/backup tests requiring Python or the root Compose file, neither
  of which is included in the worker image. Those seven files then passed 17/17 in the Windows host
  environment, and the workspace production build passed. The final tested artifact is
  `walletscaner-worker@sha256:178566f7955762dbfdd6b9c2e4a0269e9b6b1004f6725c5d43c93f579504ba4f`.
  The generated local 24-Aug benchmark artifact was removed after recording its hashes and counts.
- Coherent source/tests/docs commit: `0f12784` (`feat: materialize verified wallet evidence
  compactly`). Production remains unchanged. Next exact step is a read-only production preflight:
  refresh host disk/RAM/load, both Compose project names/statuses, Walletscaner live-execution state,
  migration level, newest off-site-acknowledged dump, B2/archive manifests and current database
  growth. Do not deploy unless all hard gates still pass and the exact R34 artifact is staged and
  hash-verified.

## Local implementation checkpoint

- Added migration 050, `wallet-evidence-daily-v1` exact exports and immutable
  `archive_segment_generations`; no retirement policy for wallet evidence was added.
- Writer/verifier now require independent restored record-type counts as well as source/archive
  SHA-256. Chain payload claims retain priority over wallet catch-up.
- FIFO derived persistence now keeps scalar episodes and only non-realized lots. No production
  cache has been truncated or deleted yet.
- Local TypeScript and ESLint passed. Archive/unit/maintenance tests passed 25/25. Disposable
  PostgreSQL 16 archive plus evidence integration passed 37/37, including a three-record wallet
  artifact and correction revision that preserved generation 1.
- Production has not received migration 050 or this image. Next safe step is a coherent commit,
  then exact Linux-image tests and populated-clone export sizing before any deploy.

## Resume audit and production preflight at 2026-08-25 21:10 UTC

- The interruption record, Git state and production state were compared before any repeat. Local
  HEAD was `ad6b0f4`; only the pre-existing untracked
  `deploy/.tmp-pipeline-storage-r28-2dc66ab.tar817264887` remained. Production is not a Git
  worktree, still records migrations only through 049 and has neither
  `archive_segment_generations` nor `wallet_evidence_compact_days`. No R34 artifact, migration or
  materializer had been partially applied.
- The shared host had 18,733,531,136 bytes free (75% used), about 1.078 GB available memory and
  2.012 GB free swap. One `walletscaner` Compose project with 11 running services was listed. No
  protected co-tenant process, file, secret or service was changed or inspected.
- PostgreSQL was 16,394,984,471 bytes. The newest server dump remained
  `memecoin_alpha_20260825T150924Z.dump` at 2,053,352,363 bytes with checksum sidecar and previously
  verified off-site acknowledgement. Wallet B2 segments remain absent; the 24 existing verified
  segments are all `chain-event-payloads`.
- Current rollback identities remain ingestion R30, operations/research R29, Telegram R23 and the
  existing archive image ID beginning `f9635002b9b8`. Live execution was previously and currently
  intended false; recheck the selected container value immediately before the first server
  mutation without printing any full environment.
- The resume audit caught a deployment-source defect before rollout: the archive writer/verifier
  anchors still selected `walletscaner-worker:local`, so changing `WALLETSCANER_OPERATIONS_IMAGE`
  would not have activated the reviewed wallet archive code. Both anchors now select the immutable
  operations image, covered by `scripts/archive/archive-scheduler-compose.test.ts`. The focused test,
  typecheck and ESLint pass. Local Compose renders successfully.
- Reviewed local artifact remains
  `walletscaner-worker@sha256:178566f7955762dbfdd6b9c2e4a0269e9b6b1004f6725c5d43c93f579504ba4f`.
  Local SHA-256 values: Compose
  `e47d91862243e63ff6999b6059aa949a9e40e54d1779b01e2b535538d727a0bb`, migration 050
  `fa0e8372ae65cf39e83fc1f7c92c9608bffd4b3531eb6e2ce3ffbd21d4e96886`, migration 051
  `bceaa2f4493f4791f1125c6a74074c86184fa150d2d2c4de7069fd7f838ab856` and guarded image updater
  `5cc7456847993197d3b291e29799c9936101134850f564e8d2570081b2ee359b`.
- Next exact action: commit the immutable-image routing correction, export/tag/hash the already
  tested R34 image, stage every artifact under a `.partial` name, verify local/server hashes and
  atomically rename. Loading/staging is not activation. Before migration, refresh backup, free
  disk, selected live-execution value, service identities and migration level once more.
- Immutable-image routing correction is committed as `37ea707`. The exact tested image was tagged
  locally as `walletscaner-worker:storage-r34-20260826`, exported and compressed to 463,144,001
  bytes. Its transfer SHA-256 is
  `69cfaa79bda475d43557d86212dabf8d8e8cd9534caf6897fd8d11793b2756e1`; the contained Docker image
  ID remains `sha256:178566f7955762dbfdd6b9c2e4a0269e9b6b1004f6725c5d43c93f579504ba4f`.
- The image now exists on the server only as
  `/opt/walletscaner/deploy/walletscaner-worker-storage-r34-20260826.tar.zst.partial`. Server byte
  count and SHA-256 match the local artifact exactly. Free disk after transfer is 18,261,045,248
  bytes. No image was loaded, no production source file was replaced, no migration ran and no
  service was recreated.
- Next exact action: stage migration 050, migration 051, Compose and the guarded env updater as
  `.partial` files; independently match every hash; then create a bounded rollback directory and
  atomically rename the reviewed files plus image artifact. Loading remains separate from
  activation.
- All five server staging artifacts matched their local SHA-256 and were atomically renamed at
  2026-08-25 21:20 UTC. The old Compose and updater are preserved under
  `/opt/walletscaner/deploy/rollback-storage-r34-20260825T2119Z`; the old Compose SHA-256 is
  `ae54b1e10b92246405f0026e56eb1a463b22dac35056839342658d5c970d1bcd`. The updater was unchanged
  and has the same hash on both sides.
- This checkpoint changes only inert host files. The R34 image tar is not loaded, migration level
  remains 049, all existing containers retain their pre-rollout image/container identities and no
  PostgreSQL or B2 data was changed.
- Next exact action: stream-decompress the verified tar into `docker load`, prove the loaded tag
  resolves to image ID `sha256:178566...ba4f`, and remove neither transfer artifact nor rollback.
  Then perform another pre-activation inventory before changing the operations/research image
  selectors or applying migrations.
- The verified artifact was loaded at low CPU/I/O priority. Server tag
  `walletscaner-worker:storage-r34-20260826` resolves exactly to
  `sha256:178566f7955762dbfdd6b9c2e4a0269e9b6b1004f6725c5d43c93f579504ba4f`. Loading consumed
  Docker layer space and left 16,863,121,408 bytes free (77% used), still above the 8 GiB hard
  reserve. The transfer artifact and rollback files remain intact.
- No container has been recreated and migration level remains 049. Next exact action is a fresh
  pre-activation inventory followed by a dry-run of the guarded env update. Only if the expected
  R29 operations/research tags match will those two selectors be atomically moved to R34; ingestion
  R30 and signal/Telegram R23 must remain unchanged.
- Pre-activation gates passed again. The env updater dry-run matched exact R29 operations/research
  values and would produce `.env.server` SHA-256
  `8e3f9dac0fccb524bdbed831986420daa826e1f0e60c42217a5a3c8931be60a4`; no env write has happened.
  Image-internal migration hashes match the staged source hashes.
- Migrations 050 and 051 were applied once through an R34 `solana-ingestion` one-shot using
  `--rm --no-deps` and an explicit `ENABLE_LIVE_EXECUTION=false`. Both recorded checksums match
  exactly, all five compact/archive tables exist, invalid-index count is zero and the database is
  16,407,870,487 bytes. This is an additive schema checkpoint; no source row or B2 object was
  deleted or altered.
- Next exact action: update only `WALLETSCANER_OPERATIONS_IMAGE` and
  `WALLETSCANER_RESEARCH_IMAGE` with the already dry-run guarded updater, verify the resulting file
  hash and rendered exact target images, then recreate named services one at a time with
  `--no-build --no-deps`. Stop and roll back on image/resource/live-execution mismatch.
- The guarded env update applied exactly once. `.env.server` now has SHA-256
  `8e3f9dac0fccb524bdbed831986420daa826e1f0e60c42217a5a3c8931be60a4`. Operations and research
  select `walletscaner-worker:storage-r34-20260826`; ingestion remains R30, signal remains R23 and
  `ENABLE_LIVE_EXECUTION=false`. No container was recreated by this file change.
- Rollback for configuration is the updater with the exact inverse expected/set pair or the
  preserved pre-rollout file state; do not overwrite the whole secret-bearing env file from an
  unverified copy. Next exact action is rendered Compose verification followed by named service
  recreates, one checkpoint at a time.
- Rendered Compose selected R34 exactly once for each of archive writer/verifier, compact
  materializer, operations monitor and wallet alpha. The archive writer was the first and only
  recreated service at this checkpoint. Container ID begins `1783bc88b4db`; image ID is the exact
  R34 SHA, state is running, restart 0, OOM false, memory 128 MiB, CPU 0.04 and live execution
  false. The old writer container ID began `cdacea4a580c` and old archive image ID began
  `f9635002b9b8`.
- Next exact action: allow a brief bounded writer observation and verify its manifest/log/resource
  state. Then recreate verifier, materializer, operations monitor and wallet alpha individually,
  checking each identity and hard limit before continuing.
- The writer is bounded at about 4.04% CPU and 40.82 MiB while preparing its first eligible wallet
  cohort. It has no restart/OOM evidence. A read-only telemetry probe requested a nonexistent
  `attempt_count` column and failed without mutation; subsequent queries must use the real schema.
- Archive verifier is now R34: container ID begins `991e36b72a96`, exact image ID, running,
  restart 0, OOM false, 128 MiB, CPU 0.04 and live execution false. Its old container began
  `4d00f872c681`.
- Next exact action: add the new compact materializer scheduler with `--no-build --no-deps`, verify
  its 80 MiB/0.05 CPU/live-false boundary, then checkpoint before monitor and wallet-alpha rollout.
- The compact materializer scheduler is newly operational in shadow mode. Container ID begins
  `2d4c0816add0`; it uses the exact R34 image, is running with restart 0/OOM false, 80 MiB memory,
  CPU 0.05 and live execution false. Its deliberate initial delay is 600 seconds, so no compact
  cohort is expected yet.
- Next exact action: recreate only operations monitor on R34 and verify that it emits a current
  report using the new schema without query errors. Then recreate wallet alpha so future derived
  persistence retains only open lots.

## Interruption audit at 2026-08-25 21:39 UTC

- The prior turn was interrupted after the production operations monitor had been recreated but
  before its post-mutation checkpoint was committed. The pre-mutation checkpoint above made that
  ambiguity explicit. On resume, the service was not recreated again: live inspection proved
  container `e1f6b8bf3215` had already run R34 for nine minutes with restart 0/OOM false.
- The R34 monitor produced new reports at 21:27 and 21:32 UTC using migrations 050/051. The second
  report observed inbox backlog 7/dead-letter 0, fresh pool/wallet evidence, database
  16,427,727,895 bytes and 16,848,568,320 bytes free disk. Its degraded state is fail-closed and is
  explained by catch-up/storage runway plus wallet archive lag, not a monitor crash.
- R34 archive writer seeded ten bounded historical wallet days and exported one in 9.699 seconds.
  R34 verifier independently verified that cohort in 5.591 seconds. There are nine wallet cohorts
  still pending, zero archive dead letters and one newly verified compact-eligible day. No
  canonical source row was retired.
- Production service boundary now proven: archive writer/verifier/materializer/monitor use exact
  R34; ingestion remains R30, wallet alpha remains R29, evidence sampler/data maintenance remain
  R29 and Telegram remains R23. Migrations 050/051 remain checksum-correct.
- Next exact action: verify the materializer's first delayed cycle and compact parity receipt. Only
  after it succeeds, recreate wallet alpha alone on R34 so future ledger persistence keeps open
  lots without touching canonical trades. Immediately record its container/image/limits and then
  begin a bounded post-rollout canary.
- The first delayed production materializer cycle completed in 3,531 ms with processed 1,
  verified 1, failed 0 and a durable `verified` compact receipt for the 2026-07-06 UTC cohort.
  It materialized 494 mature followability facts; this cohort had zero episode/open-lot facts.
  Compact mismatch count is zero, the process is running with restart 0/OOM false and is idle at
  this checkpoint.
- Next exact action is now authorized by the preceding gate: recreate only `wallet-alpha` with
  `--no-build --no-deps`, verify exact R34 image, 160 MiB/0.10 CPU, live execution false,
  restart/OOM, queue continuity and bounded logs. Do not truncate the old derived cache during
  this rollout.
- Wallet alpha was recreated alone. Old container `cf9463ad96ce` used R29 image ID
  `sha256:ecfc1960...`; new container `d87ca91a1b72` uses exact R34 image ID
  `sha256:178566f7...`, is running with restart 0/OOM false, 160 MiB memory, CPU 0.10,
  112 MiB Node heap, PostgreSQL parallel gather disabled and live execution false. No table was
  truncated and no canonical or derived row was deleted as part of the recreate.
- All intended R34 runtime targets are now activated. Next exact action is a bounded post-rollout
  canary: verify wallet queue progress/no lost leases, archive/compact progression, monitor
  freshness, ingestion freshness/backlog, resource ceilings, service restarts/OOM, disk/DB growth,
  backup evidence and unchanged non-target image identities. Do not delete artifacts or source data
  during this canary.
- The first complete R34 wallet-alpha cycle passed: 92 wallets processed, 8 low-evidence wallets
  safely skipped, zero cycle failures, zero oversized wallets and zero signal-refresh failures in
  237,297 ms. RSS at cycle completion was 107.52 MiB under the 160 MiB cgroup boundary. The cycle
  ended with 333 pending, one processing and one pre-existing failed queue item; signal lane was
  zero. Listener remained active and no signal was emitted.
- No queue lease was lost by the recreate. Next exact action remains read-only canary verification,
  including a second health sample and exact service identity/resource inventory. If those pass,
  document the rollout as operational-shadow, not storage-validated; seven future days and a clean
  24-hour equilibrium slope are still required before any canonical retirement.
- Interruption hardening is now implemented locally in `scripts/deploy/release-checkpoint.py`.
  It maintains an fsync-plus-atomic-rename JSON ledger, requires an exact expected revision,
  validates `planned -> in_progress -> completed/failed` transitions, rejects secret-shaped
  evidence keys and defaults to dry-run. Three ledger tests plus the archive Compose test pass;
  typecheck, ESLint and Python compilation pass. `AGENTS.md` and operations guidance now require
  both this machine ledger and the human WIP checkpoint for production phases.
- Next exact action after committing this coherent tooling change: hash and stage only the ledger
  script on the server, dry-run then create an `in_progress` `post-rollout-canary` ledger at
  revision 1. This is an inert operational record, not a service change. Then finish the read-only
  R34 canary and mark that phase completed only if actual runtime evidence passes.
- Rollout-ledger tooling commit is `7eed5f4`. Server script SHA-256 is
  `a907032e824f79ae97d378fc51c1f66276105402dc58015fa0901a0a690158ef`, identical to local.
  After a successful dry-run, `/opt/walletscaner/deploy/storage-r34-rollout-state.json` was created
  atomically at revision 1 with phase `post-rollout-canary`, status `in_progress` and SHA-256
  `d8bc2a8ff1d1826ae272be0d6b4046f53d894a6fde498366276bcfb10f0c9d86`. It records only non-secret
  image/migration/cycle/archive evidence.
- On any further interruption, inspect that server ledger revision plus this file, then reconcile
  both with actual migrations and containers. Do not mark the phase completed merely because the
  ledger exists. Next exact action is the final bounded read-only canary snapshot.
- The bounded rollout canary passed its scoped operational gates. All 12 Walletscaner services are
  running with restart 0 and OOM false. Exactly the intended archive writer/verifier/materializer,
  operations monitor and wallet-alpha services use R34; ingestion remains R30, Telegram R23 and
  non-target research/maintenance services R29. All selected runtime services report live execution
  false and their Compose memory/CPU ceilings match the reviewed values.
- Migration checksums remain exact and invalid-index count is zero. One wallet archive cohort is
  independently verified: 792 records, 959,527 source bytes and 84,780 archive bytes. Its compact
  receipt is verified with 494 mature followability facts, no parity mismatch and no archive dead
  letter. The first full R34 wallet cycle passed as recorded above. Pipeline backlog/dead-letter was
  0/0 in the latest report with fresh pool/swap/wallet evidence.
- The current 2,053,352,363-byte dump retains its SHA sidecar and off-site acknowledgement. Host
  free disk is about 16.84 GB, above the 8 GiB hard reserve. Overall health remains deliberately
  degraded for historical wallet archive catch-up, database size and an approximately 3.52-day
  recent-slope runway above reserve. That slope includes catch-up and release-layer transfer; it
  must be remeasured over a clean 24 hours.
- The scoped `post-rollout-canary` phase may now be marked completed at ledger revision 2, with the
  next phase remaining a seven-day operational shadow plus a clean 24-hour capacity slope. This is
  **Operational**, not **Validated**. Canonical wallet evidence retirement remains disabled and no
  source deletion is authorized by the canary result.
- The first completion dry-run was rejected because a shell variable did not preserve the quoted
  multi-word next action; revision 1 remained byte-for-byte unchanged. The explicit-argument retry
  passed dry-run and apply. Server ledger is now revision 2, phase `post-rollout-canary`, status
  `completed`, SHA-256
  `70d26facf5e696b66d8c18201dc8caedfdf0b3629f135addce1c8f0070b2adbb`.
- Overall task status remains `active`: the operational shadow is running, but sustainable
  equilibrium and canonical retirement are not validated. Before waiting seven days, measure the
  reconstructible derived-ledger cache reclaim candidate and its exact current backup/qualified
  wallet gates; do not execute it unless every guard passes and the action is recorded as a new
  machine-ledger phase.
- Read-only reclaim sizing found `wallet_position_episodes` at 627,097,600 bytes/about 428,047
  rows and `wallet_position_lots` at 897,835,008 bytes/about 813,155 rows. These are reconstructible
  derived caches; canonical `wallet_trade_events` remains 4,491,526,144 bytes/about 2,042,285 rows
  and is outside this reclaim.
- An index-only latest-score query completed under a 30-second ceiling: zero current
  watch/candidate/validated-paper wallets, 16,442 observed, 141 excluded and 210,477 insufficient.
  The qualifying-wallet hard gate is therefore currently clear, but it must be rechecked inside the
  reclaim transaction.
- The available immutable B2 database receipt is
  `postgres-backup-verified-20260814T052837Z.json`, SHA-256
  `8870b05fade98784e9280087b6392b159f3191ae240b2a5ee479beac5336bd9b`, independently full-GET/
  SHA/PG16-list verified, with attested GOVERNANCE retention until 2026-09-13. The newer 25 August
  server dump additionally has its sidecar and off-site acknowledgement. Policy attestation is not
  mislabelled as API-verified retention.
- Pre-execution inspection caught that `derived-ledger-reclaim` inherited the floating/local image.
  It now explicitly selects `WALLETSCANER_OPERATIONS_IMAGE`, with a Compose test proving R34,
  64 MiB/0.02 CPU and the read-only receipt mount. Focused tests 4/4, typecheck and ESLint pass.
- Next exact action: commit this source correction, stage/hash/atomically replace only the server
  Compose file with rollback proof, then start machine-ledger phase `derived-cache-reclaim` as
  `in_progress`. Stop wallet alpha gracefully, rerun all transactional guards through exact R34,
  and restart/verify it whether reclaim succeeds or fails. No canonical/B2 deletion is permitted.
- Source correction commit is `9a8ea1e`. The server rollout ledger is revision 3,
  `derived-cache-reclaim=in_progress`, SHA-256
  `79586ecf118fd2909108402b91a19ee1db1e8db420a8af5796654fffb080cac5`.
- Server Compose was replaced atomically after exact pre/post hash checks. Current SHA-256 is
  `a745ac3977b939c61baf72cae18c00cc189be4e2a8c330d1a5ffd8a5479d52bb`; the immediately previous
  R34 Compose is preserved with SHA-256 `e47d9186...` in the existing rollback directory. Rendered
  `derived-ledger-reclaim` selects exact R34. No running container changed from this file update.
- Next exact action: refresh disk, live execution, backup receipt and qualified-wallet gates once
  more; stop only wallet alpha; execute the guarded derived-only transaction with explicit receipt,
  SHA and approval values; then restart wallet alpha in a finally-equivalent operational sequence.
- The first guarded reclaim attempt failed closed before `TRUNCATE`: its combined preflight query
  exceeded the 30-second statement timeout. The transaction rolled back. Post-check proved the
  derived tables remain populated (801,294 exact lots and 431,318 exact episodes; about 898 MB and
  627 MB), database 16,494,107,671 bytes. No canonical or B2 data changed.
- The remote shell's EXIT trap restarted wallet alpha on exact R34. It is running, live execution
  false, restart 0/OOM false and resumed bounded queue processing. This validates the failure path.
- Root cause: one preflight statement combined three large exact counts with the latest-score scan;
  the standalone latest-score gate needs about 24 seconds at current volume, leaving insufficient
  budget. The correct fix is not a larger timeout: use a fast source `EXISTS` plus relation sizes,
  materialize latest wallet statuses once into a transaction-local temporary table and reuse it for
  both the qualified-wallet guard and observed-wallet requeue.
- Next exact action: mark machine-ledger revision 4 as `derived-cache-reclaim=failed` with timeout
  and data-intact evidence. Then implement/test the bounded preflight change locally before opening
  a new revision-controlled retry. Do not rerun the current image/script.
- Server ledger revision 4 records `derived-cache-reclaim=failed`, statement timeout, data intact
  and wallet-alpha R34 running; SHA-256 is
  `e4a169b87278a35a913e942b63252351127192d4e8a24dcff1c747120df09cd5`.
- Implemented the bounded preflight fix in a separately testable core. It now uses canonical source
  `EXISTS` plus relation-size/catalog estimates, materializes latest wallet statuses once in a
  transaction-local table and reuses that table for the qualified-wallet gate and observed-wallet
  requeue. Statement timeout remains 30 seconds; no resource limit was raised.
- Disposable PostgreSQL 16 integration passed both real transaction paths: derived tables truncate
  and only current observed wallets requeue on success; a newer qualified status causes full
  rollback with derived rows/revision intact. Combined focused tests pass 6/6. Typecheck, ESLint and
  workspace production build pass.
- Next exact action: commit the coherent fix, build a new immutable R35 image rather than mutating
  R34, run the integration inside the exact Linux/Node image, then stage/hash/load it. Do not reopen
  ledger retry until image identity and target test evidence pass.
- Bounded reclaim fix commit is `36dc4b4`. Immutable image
  `walletscaner-worker:storage-r35-20260826` has image ID
  `sha256:621489c53b9114d6edcf85b32e0040e32195d6c9538da43f3b49262995814cfc`.
- The exact Linux/Node 24 image passed the real PostgreSQL 16 reclaim/rollback integration 2/2.
  An initial combined image command also included two host-only suites and therefore reported four
  expected infrastructure failures: the worker image intentionally lacks the root Compose file and
  Python. Those same Compose/ledger suites pass 4/4 on the host; they are not image-runtime gates.
  The exact-image core-only rerun is green and removes that ambiguity.
- Next exact action: export/compress/hash R35, transfer by resumable `.partial`, verify server hash,
  atomically rename and load. Loading/staging is not activation. Reopen the failed reclaim phase
  from ledger revision 4 only after the loaded image ID matches exactly.
- R35 export is 463,101,233 bytes with transfer SHA-256
  `3de195342dde97166a3be1786d948004f5151caf5719a3152cbc531b247c832f`. Resumable SFTP completed;
  server `.partial` byte count and SHA-256 match exactly. Host free disk after transfer is
  16,317,476,864 bytes, still above reserve. No service or data changed during transfer.
- Next exact action: atomically rename the verified artifact, load it at low CPU/I/O priority and
  prove the server tag resolves to exact image ID `sha256:621489...14cfc`. Preserve both the
  artifact and R34 rollback image until the guarded retry completes.
- The verified artifact was atomically renamed and loaded at low CPU/I/O priority. Server tag
  `walletscaner-worker:storage-r35-20260826` resolves exactly to
  `sha256:621489c53b9114d6edcf85b32e0040e32195d6c9538da43f3b49262995814cfc`. Free disk is
  16,303,284,224 bytes after loading. R34 remains active for normal services and retained for
  rollback; R35 is not activated globally.
- Next exact action: verify the reclaim core/script hashes inside server R35, transition the failed
  machine-ledger phase from revision 4 back to `in_progress` revision 5 with `retry-image=R35`, then
  rerun the same stop/trap/restart sequence while overriding only the one-shot reclaim image to
  R35. Do not change operations/research env selectors during this retry.
- R35 internal core/CLI SHA-256 values match local exactly (`c3224a2b...` and `690b7a9b...`). The
  server machine ledger is revision 5, `derived-cache-reclaim=in_progress`, SHA-256
  `6f8e7e391ee9edd69ca9345e2e3622924813a7849e3eecff0d6ea1789d24fd9b`, explicitly naming the R35
  retry image and bounded preflight fix.
- Next exact action is the guarded retry described above. If it errors, prove transaction rollback
  and alpha restart, mark revision 6 failed and stop. If it succeeds, prove canonical counts remain,
  derived relations are empty immediately after commit, filesystem space returned and alpha R34
  restarted before marking revision 6 completed.
- The guarded R35 retry completed and committed. It proved canonical trade source present,
  qualified wallets 0, pre-reclaim derived estimates 428,047 episodes/813,155 lots and reclaimed
  627,417,088 episode bytes plus 898,252,800 lot bytes. Exactly 16,442 current observed wallets were
  requeued. The immutable B2 receipt/SHA and seven-day remaining-retention guards passed.
- The finally-equivalent trap sequence restarted normal wallet alpha on R34 (not R35): running,
  live false, restart 0/OOM false, 160 MiB/0.10 CPU. Its new cycles report zero failures while
  rebuilding only current derived state.
- Post-check: canonical `wallet_trade_events` exists with unchanged catalog estimate 2,042,285 and
  4,496,007,168 relation bytes. At observation time the rebuilt derived state was only 2,308 lots
  and 2,254 episodes (about 2.51 MB and 3.33 MB). Database size is 15,014,452,247 bytes. Host free
  disk rose from 16,303,284,224 after R35 loading to 17,816,268,800 bytes, returning about 1.51 GB
  to the filesystem.
- Queue after requeue is 16,794 pending, one active lease, one pre-existing error and P2/signal lane
  zero. This is bounded rebuild work, not data loss; keep monitoring its slope and resource limits.
- Next exact action: mark machine-ledger revision 6 `derived-cache-reclaim=completed` with these
  measurements. Then, as a separate revision-controlled phase, remove only the two verified server
  image-transfer tar files after rechecking loaded R34/R35 image IDs and local transfer copies. Do
  not prune Docker images or touch database/B2 files.
- Machine ledger revision 6 records `derived-cache-reclaim=completed`, SHA-256
  `69158cbc26a8e7ad940533550b61ae7b9edba25bda8059f83c669c8dfa55e178`.
- Both server transfer tars exactly match retained local copies: R34 is 463,144,001 bytes/SHA
  `69cfaa79...`, R35 is 463,101,233 bytes/SHA `3de19534...`. Loaded server image IDs remain exact.
  Server free disk before artifact cleanup is 17,795,112,960 bytes.
- Machine ledger revision 7 is `release-artifact-cleanup=in_progress`, SHA-256
  `51340b3bed01a1082f997fc8a12c0907c8a68c2d1f8064fa31dc1269a88d4f48`.
- Next exact action: delete only
  `/opt/walletscaner/deploy/walletscaner-worker-storage-r34-20260826.tar.zst` and
  `/opt/walletscaner/deploy/walletscaner-worker-storage-r35-20260826.tar.zst`; then prove both paths
  absent, both Docker image IDs present and disk gain near 926,245,234 bytes before closing revision
  8. No wildcard or image prune is allowed.
- Exact artifact cleanup succeeded. Both paths are absent; R34 and R35 still resolve to exact image
  IDs `sha256:178566...ba4f` and `sha256:621489...14cfc`. Host free disk is now
  18,700,431,360 bytes (75% used), a gain of about 905 MB from the immediately preceding sample;
  small concurrent database growth explains the difference from nominal tar bytes.
- Next exact action: close machine-ledger revision 8 as `release-artifact-cleanup=completed`, then
  open `storage-shadow-observation=in_progress` revision 9. The observation phase must track archive
  catch-up/restore parity, compact mismatch, rebuild backlog, DB/disk slope and 8 GiB reserve over a
  clean 24 hours and seven future days. It must not authorize canonical retirement by itself.
- Server runtime and cleanup state were refreshed before closing the phase: all 12 Walletscaner
  services are running with restart 0/OOM false; selected services report live execution false;
  both exact transfer paths remain absent and R34/R35 image IDs remain loaded. Current free disk at
  that sample was 18,644,029,440 bytes.
- Machine ledger revision 8 records `release-artifact-cleanup=completed`, SHA-256
  `469dae1c1893c45c3ece1d022c3b9fb4d77ab72bb0f63d2aa84b2fc04b4c5440`.
- Next exact action: dry-run and open revision 9 as
  `storage-shadow-observation=in_progress`. Its evidence must state that canonical retirement is
  disabled and that only one wallet archive day is currently verified. Do not treat starting the
  clock as validation.
- Live PostgreSQL refresh before opening the phase found 24 verified chain-payload days; wallet
  evidence has one verified and nine pending days. Compact shadow has one verified day, zero
  mismatch/retry days and latest verified range end 2026-07-07 00:00 UTC. Database size is
  15,125,945,367 bytes and invalid-index count is zero.
- Server machine ledger revision 9 is now
  `storage-shadow-observation=in_progress`, SHA-256
  `b3d98e772c112b656ea7f8735b56b8177c052bd480f559de72094fc772e4f0f1`. Its evidence records
  canonical retirement false, 18,644,029,440 free disk bytes, one verified/nine pending archive
  days, one compact verified/zero mismatch days and the 16,436-item rebuild sample.
- Next exact action is read-only observation, not another rollout mutation: capture current
  migrations, service identities/restarts/OOM/live flag, archive/compact receipts, rebuild slope,
  latest health report, database/filesystem growth and backup evidence. Keep this phase in progress
  until both a clean post-catch-up 24-hour slope and seven future shadow days pass; do not authorize
  canonical retirement from elapsed time alone.
- The local clone was rechecked again instead of trusting earlier progress messages. The same
  running PostgreSQL 16 container `walletscaner-pg16-r31` contains database
  `walletscaner_storage_lab` at 12,357,852,183 bytes, a 4,058,816,512-byte
  `wallet_trade_events` relation, one verified compact day and exact compact fact counts of 218,492
  profitability episodes, 251,460 open-lot facts and 27,498 followability facts. This directly
  proves the 1.6/3.1/7.3 GB observations were intermediate stages of the completed 11.51 GiB
  restore, not a skipped or replaced restore.
- Final bounded live snapshot: migration 050/051 checksums match the repository; 24 chain-payload
  days and one wallet-evidence day are verified; nine wallet days remain pending; compact state is
  one verified/zero mismatch. Canonical wallet trades remain at a 2,042,285-row catalog estimate
  and 4,496,990,208 relation bytes. The rebuild queue is 16,423 pending, one active, one
  pre-existing failed, P2 zero. Database size is 15,149,702,167 bytes, invalid-index count zero and
  host free disk 18,594,758,656 bytes.
- The latest health report remains deliberately degraded because the recent 24-hour slope contains
  rollout transfers, archive catch-up and reclaim/rebuild activity; it is not clean equilibrium
  evidence. The load-per-CPU sample fell from 3.14 to 1.17, all 12 services remained restart 0/OOM
  false and bounded container stats did not show sustained saturation. Current dump
  `memecoin_alpha_20260825T150924Z.dump` retains its SHA sidecar and off-site acknowledgement.
- Current-state, storage lifecycle and build handoff are aligned in commit `c07c7e2`. No immediate
  mutation remains. On the next observation, first verify server ledger revision 9/hash and actual
  runtime state, then measure archive catch-up, compact parity, queue slope and a clean post-catch-up
  24-hour storage window. Do not close revision 9 before the seven-future-day gate also matures.
- Final post-documentation read-only sample at 2026-08-25 22:26 UTC again proved 12/12 services
  running, restart 0/OOM false and live execution false on every selected worker. Server ledger is
  still revision 9 with the same SHA-256. Pipeline backlog/dead-letter was 0/0, pool evidence age
  1.5 seconds and wallet-trade age 304.5 seconds. The health report remains degraded for database
  size, nine-day wallet archive catch-up, rollout-contaminated 4.83-day runway and an oscillating
  load sample of 2.35; current-state commit `d8dadd7` records that this must remain under observation.

## Active incident/storage phase at 2026-08-26 01:32 UTC

- User-authorized scope: make Walletscaner storage sustainable on the fixed host and verify/repair
  its data flow. Exclusions remain canonical/B2 deletion without gates, live execution, global host
  cleanup, `VACUUM FULL`, destructive DDL, provider purchase and every protected co-tenant action.
- Local branch is `main` at `b8139bf`, 56 commits ahead of `origin/main`. Preserve the three
  untracked transfer artifacts exactly as found; none is a production database or an authorized
  cleanup target.
- Read-only production refresh found all 12 Walletscaner services running with restart count zero,
  OOM false and live execution false. Pipeline inbox backlog/dead-letter is currently 0/0; current
  discovery transports are live, but unreconciled historical gaps remain alpha-excluded.
- PostgreSQL is about 15.01 GB and its data volume about 15.40 GB. Host free space is about
  18.81 GB. WAL is bounded near 352 MB and `/opt/walletscaner` has no archive-staging leak.
  The latest rolling window still reports roughly 1.11 GB/day database growth and 1.60 GB/day
  filesystem consumption, so the existing shadow-only wallet archive is not yet a proven steady
  state.
- Largest durable growth sources include `wallet_trade_events` (about 4.51 GB), daily raw payload
  partitions (bounded to 48 hours), entries/outcomes, scores and a 235 MB
  `ingestion_gap_repair_signatures` relation. Canonical wallet retirement is still disabled because
  dual-read and seven-future-day gates have not passed.
- Exactly one wallet-evidence archive segment is dead-lettered: segment 67, range 2026-07-08,
  upload succeeded but HEAD metadata verification failed. Neighboring days verify normally and no
  local staging file leaked. A likely deterministic JSON key-order mismatch in
  `record-type-counts` must be confirmed before changing code or retry state.
- Latest verified server dump is `memecoin_alpha_20260825T150924Z.dump`, 2,053,352,363 bytes, with
  SHA sidecar and off-site acknowledgement. Existing immutable B2 generations and Object Lock
  policy remain untouched.
- Server release ledger remains revision 9 / SHA-256
  `b3d98e772c112b656ea7f8735b56b8177c052bd480f559de72094fc772e4f0f1`, phase
  `storage-shadow-observation=in_progress`. Before any rollout mutation, open a new
  revision-controlled repair phase and record exact artifact/rollback identities.
- Next exact action is read-only: compare segment 67's expected and remote HEAD metadata
  semantically without printing credentials or metadata values, then query exact open discovery
  incident/repair cursor state. Only after both causes are proven may code/tests be changed.
- Segment 67's remote HEAD was inspected with the verifier's existing read-only credential without
  printing credentials or metadata values. Content length and archive SHA-256 match. The only raw
  mismatch is `record-type-counts`: PostgreSQL JSONB returns entry/outcome order while B2 stores
  outcome/entry order; parsed keys/counts are semantically identical. This proves a serializer
  ordering defect rather than object corruption.
- The local repair now writes record-type counts in sorted-key form and permits only this metadata
  field to compare as a validated, bounded integer map. Content length, SHA-256, every other
  metadata value, Object Lock and full streamed GET hash remain strict. Integrity errors name only
  mismatch keys, never metadata values.
- Operational maintenance now ages staged signatures from both `completed` and terminal `failed`
  gap repairs. Failed 20,000-signature sessions previously remained forever because their pending
  rows have no `completed_at`; the new predicate uses the immutable `created_at` fallback while
  retaining the repair/incident summary and alpha-excluded disposition.
- Targeted archive/runtime/maintenance tests pass 29/29. TypeScript and ESLint pass. No production
  row, object, file, service or configuration has changed in this phase.
- Live repair refresh at 2026-08-26 01:37 UTC found Pump.fun actively replaying its exact boundary:
  14,450/17,228 complete with 2,778 pending. LaunchLab and CPMM exact repairs are complete. The
  latest PumpSwap repair is terminal at the reviewed 20,000-signature cap and remains correctly
  alpha-excluded; current transport has already recovered. This is historical coverage exclusion,
  not current event-flow stoppage.
- Next exact action: commit the coherent local repair, run the applicable production build/full
  gate, build an immutable Linux image and verify its exact tests. Do not reset segment 67 or deploy
  until artifact, backup/headroom, ledger and rollback gates pass.
- Repair commit is `89e3042`. The full host test run passed 390 tests and skipped 47 integration
  tests; its three failures were exclusively `spawn zstd ENOENT` on Windows. The exact Linux/Node 24
  image then passed all 33 relevant archive/artifact/runtime/maintenance tests with zstd present.
  The root Compose pinning test separately passed on the host. TypeScript, ESLint and the production
  workspace build pass.
- Immutable candidate image `walletscaner-worker:storage-r36-20260826` resolves locally to
  `sha256:24bcc3fa77d3a0a9e4369eb43ec4d33084b4985f1feedcc41db97cde1548d00a`.
  One deliberately combined image test also included the known host-only Compose suite and failed
  only because the worker image intentionally omits `/app/docker-compose.server.yml`; the separated
  exact-image and host reruns above remove this infrastructure ambiguity.
- Next exact action: commit this evidence, export/compress/hash R36, then refresh production
  backup/headroom/ledger/runtime identities before staging. Loading is not activation. The rollout
  must change only the operations image selector and named archive/maintenance/monitor services;
  ingestion, sampler, wallet-alpha, Telegram and protected co-tenant state stay untouched.
