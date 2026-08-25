---
status: active
updated_at_utc: 2026-08-25T21:54:00Z
owner: codex
task: make Walletscaner PostgreSQL/B2 storage tiering autonomous and sustainable on the fixed disk
last_safe_checkpoint: production migrations 050/051, R34 archive writer/verifier/materializer/monitor verified; wallet-alpha remains R29
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
