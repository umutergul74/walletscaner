---
status: active
updated_at_utc: 2026-08-27T20:27:00Z
owner: codex
task: repair archive integrity/dead-letter and discovery coverage, then establish a bounded Walletscaner storage equilibrium on the fixed disk
last_safe_checkpoint: R41 canary failed the five-minute gap-repair gate and was rolled back exactly; ingestion runs R30 container d4e2eb0, R37 materializer is stopped, live execution is false, and rollout revision 34 is failed
---

# Walletscaner Work In Progress

This is the durable resume point for an interrupted multi-step task. It contains no credentials and
does not grant production authority. On resume, verify every recorded fact before continuing; never
blindly repeat the last mutation.

## Resume dashboard — 2026-08-27 20:07 UTC

This task has six bounded phases. Four are complete, phase five is ready to start and phase six has
not started:

1. **Complete — root cause:** R40 proved the trade-observation lane can collect wallet trades, but
   also exposed a real async bootstrap race: three provider subscriptions could be configured/ACKed
   while the scheduler reported only two occupied slots.
2. **Complete — source repair:** commit `5902ac0` reserves scheduler occupancy synchronously,
   coalesces duplicate bootstrap and fails closed through exclusion/provider errors.
3. **Complete — regression evidence:** focused 67/67, host type/lint/build, classified Linux suite,
   Linux deploy tools 19/19, fresh PostgreSQL 16 ingestion gate 8/8, and byte-identical compact
   materializer PostgreSQL evidence all pass.
4. **Complete — recovery/artifact:** the current 27-August dump is server-verified and independently
   off-site verified; immutable R41 image/artifact/local recovery copy have exact recorded identities.
5. **Ready — ingestion-only production canary:** atomically select R41 for only
   `solana-ingestion`, recreate no dependency, then hold at least five minutes across scheduler
   rotations. Pass requires stable active/configured/ACK equality, fresh wallet trades, no growing
   inbox/dead-letter and zero unresolved coverage incidents. Any hard-gate failure rolls only this
   service back to exact R30.
6. **Pending — compact catch-up and bounded cleanup:** only after phase five passes, select R41 for
   only the stopped materializer, run an oldest-first bounded canary/catch-up, then remove only exact
   Walletscaner release artifacts/images whose recovery copies and hashes are already proven. No
   canonical wallet evidence or B2 object may be retired in this phase.

Fresh production pre-state: only Compose project `walletscaner` is listed; disk free is
14,314,131,456 bytes; PostgreSQL is 18,464,439,319 bytes; inbox unresolved/dead-letter is 12/0;
archive dead-letter is zero; open discovery incidents are zero; newest pool/wallet trade ages are
18/97 seconds. Ingestion is exact R30 container `ee10d1074016...`; materializer is exact R37 stopped
with exit 143; `ENABLE_LIVE_EXECUTION=false`. R41 resolves to image
`sha256:229148f8616c...`, source `5902ac0c3cdb...`. Rollout ledger revision 32 is completed and its
next action is the R41 ingestion activation. An accidental read-only Cartesian preflight query was
found as PostgreSQL PID 284274, explicitly terminated, and independently verified absent; it made
no data change. The next exact mutation is ledger revision 33 plus the guarded one-key R30-to-R41
ingestion selector update.

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
- R36 export is 463,137,765 bytes with transfer SHA-256
  `991d4d6e1db53bc96f6bdc6ea39a5d92e2c16ef2fbe8cc83aa7e1fd73ec2ef06`. The resumable transfer
  completed to the server `.partial` path; remote byte count and SHA-256 match exactly. Host free
  space after staging is 18,279,837,696 bytes.
- Production preflight proved 12 Walletscaner services running, all selected live flags false,
  restart 0/OOM false, current verified/off-site-acknowledged dump intact and only the Walletscaner
  Compose project listed. R34 archive/monitor/materializer and R29 maintenance are the exact
  rollback identities; ingestion R30, sampler R29, wallet-alpha R34 and Telegram R23 are excluded
  from recreation.
- The old shadow observation was closed as `failed` at server ledger revision 10 because two
  archive dead letters invalidated that observation. Revision 11 is
  `storage-integrity-repair-r36=in_progress`, ledger SHA-256
  `75f557733aa0012bb8faec5c3d521f3e613d698ef87028ca4d9dd614a8fc8963`.
  Both dead letters (segments 67 and 69) independently match remote content length/SHA and differ
  only by semantically equal record-count JSON key order.
- Next exact action: atomically rename the verified artifact and load it at low CPU/I/O priority;
  prove the loaded image ID before touching the operations selector or any container. Preserve the
  transfer artifact and R34/R29 rollback images until the repair canary completes.
- The verified artifact was atomically renamed and loaded at low CPU/I/O priority. Server tag R36
  resolves exactly to image ID
  `sha256:24bcc3fa77d3a0a9e4369eb43ec4d33084b4985f1feedcc41db97cde1548d00a`.
  Host free space after loading is 18,265,366,528 bytes. No selector, container, PostgreSQL row or
  B2 object changed during loading.
- Next exact action: use the guarded release-image updater in dry-run and apply mode to move only
  `WALLETSCANER_OPERATIONS_IMAGE` from exact R34 to exact R36. Verify the resulting env hash and
  rendered service images before recreating named services one at a time with `--no-build --no-deps`.
- The guarded updater changed only `WALLETSCANER_OPERATIONS_IMAGE` from exact R34 to exact R36.
  `.env.server` moved from SHA-256 `8e3f9dac...` to
  `a0b216d52eba4a5913ef42b31c4875a9d889bd597083b0c8dcda491e7748f84e`. A selector change alone
  does not recreate a service; every current container still has its previous identity.
- Rollback is the same guarded updater with the exact inverse pair, while R34 remains loaded. Next
  exact action: parse rendered Compose without emitting environment values, recreate verifier
  alone, prove R36/resource/live gates, then transactionally reset only proven segments 67/69 to
  `retry_verify` and run a bounded two-segment verifier canary.
- Rendered Compose selects R36 for the five named operations services. Verifier alone was recreated:
  old container `991e36b72a96...`, new `8933757576cc...`, exact R36 image, running, restart 0/OOM
  false, 128 MiB/0.04 CPU and live execution false. No other container changed at this checkpoint.
- Next exact action: in one guarded PostgreSQL transaction, require segments 67/69 to remain
  revision 1/dead-letter with the proven generic HEAD mismatch, clear only their active error/lease
  fields and set `retry_verify`. Then run one exact R36 verifier with max two segments and explicit
  live-false/no-dependencies. Any real SHA/count/Object-Lock/GET mismatch must still dead-letter.
- The guarded transaction matched exactly segments 67/69 at revision 1 and moved only those rows
  from `dead_letter` to `retry_verify`; prior attempt audit rows and counters remain. A bounded exact
  R36 one-shot then independently downloaded and verified both in 9,495 ms: processed 2, verified
  2, failed 0. Global archive summary became verified 29 / pending 27 / dead-letter 0.
- No B2 object was uploaded, overwritten or deleted during the retry. Content length, archive/source
  SHA, semantic record counts, full restored envelopes and retention evidence all passed.
- Next exact action: recreate writer, data maintenance, compact materializer and operations monitor
  individually on R36 with `--no-build --no-deps`; after each, prove exact image, prior limits,
  restart/OOM and live-false. Then run a bounded maintenance canary and refresh health/data flow.
- Writer, data maintenance, compact materializer and operations monitor were recreated individually
  on exact R36. Their old identities were recorded; every new container is running, restart 0/OOM
  false, live false and retains its reviewed 128/64/80/64 MiB and 0.04/0.04/0.05/0.03 CPU limits.
  Ingestion R30, sampler R29, wallet-alpha R34 and Telegram R23 container identities did not change.
- The first maintenance one-shot invocation accidentally inherited the service's infinite scheduler
  command. It was interrupted before its 300-second initial sleep elapsed and its exact transient
  container auto-removed; it performed no maintenance. The corrected explicit Node command then
  completed in 11,992 ms under R36. It compacted 356 verified raw payloads, retired 564 old swaps,
  reported zero compaction lag and zero terminal repair signatures yet eligible under the unchanged
  three-day retention. One bounded inbox-metadata statement timed out and was reported; no job or
  transaction failed.
- Fresh health is `degraded`, no longer `down`: pipeline backlog/dead-letter 0/0, archive dead-letter
  0, last pool age 0.13 s, database about 15.07 GB and disk free about 18.25 GB. Degraded reasons
  are catch-up age, rolling growth/runway, database warning and a point load sample, not a stopped
  transport or data-loss error.
- One Pump.fun historical incident remains open while its exact oldest-first repair progresses:
  boundary reached, 16,409/17,228 replayed and 819 pending at the last sample. Current live transport
  and new pool discovery continue. Three completed and three terminal 20,000-cap repairs from the
  last 24 hours remain explicitly alpha-excluded as designed.
- Wallet alpha's last five cycles had zero failures/OOM and 53-100 processed wallets each; P2/signal
  lane remains zero. The broad requeue is roughly stable near 13.3k because catch-up continues, but
  it is not blocking fresh signal-priority work.
- Next exact action: close machine-ledger revision 12 as the R36 integrity repair completed. Then
  open a separate artifact-cleanup phase, recheck server/local artifact SHA and loaded R36/R34 image
  IDs, and delete only the exact server R36 transfer tar. No Docker image prune or database/B2
  deletion is permitted.
- Server ledger revision 12 closed `storage-integrity-repair-r36=completed`; revision 13 opened
  `r36-artifact-cleanup=in_progress`, SHA-256
  `541e3c5ffdcfa70a9061a7032b02790889beaad033de30914b4656def7043baa`.
- The server R36 transfer tar exactly matched the retained local 463,137,765-byte copy and SHA.
  R36 and R34 image IDs were re-proven before deleting only that exact server file. Both loaded
  images remain. Free disk increased by 463,142,912 bytes to 18,701,819,904 bytes. No wildcard,
  Docker prune, database row or B2 object was touched.
- Next exact action: close artifact cleanup at ledger revision 14, then open a fresh storage
  equilibrium observation. That observation must not be called validated: wallet archive catch-up,
  compact parity, the Pump repair and the clean 24-hour/seven-future-day gates remain outstanding.
- Server ledger revision 14 closed exact R36 artifact cleanup. Revision 15 opened
  `storage-equilibrium-observation-r36=in_progress`, SHA-256
  `6224c45bef08aa2c9a5d09e96bd5e71fd06aaa4b1a54b0d02af023a24c7f2c67`. The server transfer tar
  is absent while exact R34/R36 images and the local SHA-identical R36 artifact remain available
  for rollback.
- Final verified rollout sample: all 12 Walletscaner services were running; every changed service
  was exact R36, restart 0/OOM false, live execution false and retained its reviewed CPU/RAM
  ceiling. Ingestion R30, sampler R29, wallet-alpha R34 and Telegram R23 were not recreated.
- Pipeline backlog/dead-letter was 0/0, current pool age 0.13 seconds, archive dead letters zero and
  PostgreSQL about 15.07 GB. Host free space after exact artifact cleanup was 18,701,819,904 bytes.
  One Pump.fun historical repair was still progressing oldest-first at 16,409/17,228; current live
  discovery continued and the incomplete historical interval remained fail-closed.
- The recent observation window still estimated about 0.93 GB/day database growth and 1.48 GB/day
  filesystem consumption, only 6.55 days above the 8-GiB reserve. That window includes rollout,
  archive catch-up and derived-state rebuild and therefore is not accepted as equilibrium.
- No additional production mutation is currently authorized or safe. Next exact action is a
  read-only refresh of revision 15, the remaining Pump repair, archive/compact parity, queue slope,
  backup, database/disk slope and service restart/OOM/live state. Do not retire canonical wallet
  evidence until archive catch-up, restored cohort parity, reader dual-read, a clean post-catch-up
  24-hour slope and seven future shadow days all pass.

## Compact catch-up incident and permanent-lifecycle phase at 2026-08-26 05:41 UTC

- Resume reconciliation started from Git `c6b3951`; the four pre-existing untracked transfer
  artifacts remain untouched. No interrupted migration, upload, cleanup or service operation was
  found after R36. Server ledger revision 15 remains the declared observation boundary; its actual
  file location/hash must be re-proven before any future rollout mutation.
- The exact Pump.fun repair that previously had 28 signatures remaining is now complete. Open
  discovery incidents are zero, and there are no collecting/replaying repair sessions. Current
  pipeline backlog/dead-letter is 0/0. The gap was not skipped or relabeled: it completed through
  the durable oldest-first replay path.
- At 05:29 UTC health remained `degraded`, but not because live ingestion stopped. Pool age was
  5.43 seconds, finality unresolved-24h zero and archive dead letters zero. PostgreSQL was about
  15.74 GB and the host had about 17.69 GB free. The recent 24-hour estimate improved to roughly
  0.36 GB/day database growth and 0.72 GB/day disk consumption, still only 12.68 days above the
  8-GiB reserve and therefore below the 14-day warning gate.
- Wallet evidence advanced to nine verified days with 23 pending. Compact state has six verified
  days and two rows labelled `mismatch` for 12/13 July. Both active errors are exactly PostgreSQL
  statement timeouts, not digest/count differences: one occurred after 150.9 seconds on a
  17,669-trade day and one after 137.1 seconds on a 54,933-trade day. The current implementation
  incorrectly records every exception as `mismatch`, then skips the six-hour retry and claims a
  later day. This misstates parity health and violates intended oldest-first compact catch-up.
- No source row may be retired while those rows are unresolved. The next exact action is local and
  additive: identify the timed-out materializer phase, separate operational `retry` from proven
  digest `mismatch`, prevent claims from advancing past an unresolved older verified day, and make
  the expensive materialization bounded. Verify on PostgreSQL 16 representative data before any
  image or production change.
- The existing compact facts are not yet a complete scorer reader. Wallet alpha still loads the
  detailed trade/entry/outcome relations directly, and the profitability fact currently stores
  episode scalars rather than each partial-sale return observation used by scoring. Deleting source
  rows now would change score hashes. Reader parity and filesystem-returning source cutover remain
  separate hard gates; `DELETE` or normal vacuum is not an acceptable shortcut.

## Retry-safe compact catch-up checkpoint at 2026-08-26 05:52 UTC

- Source, tests, Compose defaults and operator documentation are committed atomically as Git
  `687c14d` (`fix: make wallet compact catch-up retry-safe`). The four pre-existing untracked local
  transfer artifacts remain untouched. No production image, Compose file, database row or service
  has been changed by this checkpoint.
- Candidate selection now identifies the oldest unresolved verified archive day before applying its
  `not_before` gate. A backed-off older day therefore blocks newer days instead of being skipped.
  Count/digest disagreement alone is persisted as `mismatch`; statement timeout, lock, connection
  and other operational errors are persisted as `retry` with a 30-minute backoff. Health and
  Telegram distinguish retry from parity mismatch.
- The disposable PostgreSQL 16 full-data clone completed the 2026-08-24 cohort with exact parity in
  208,827 ms: 218,492 episode facts, 251,460 open-lot facts and 27,498 mature followability facts.
  The largest measured phases were dimensions 63,760 ms and open lots 61,860 ms. A separate 1 ms
  statement-timeout injection failed in `source-counts`, wrote `retry` with attempt 1 and a future
  `not_before`, and did not write `mismatch`. The disposable clone is intentionally left with that
  retry receipt; production is unaffected.
- Targeted verification passed 13/13 tests. `npm run typecheck`, `npm run lint` and workspace build
  passed. The full local suite passed 394 tests with four files/47 database integrations skipped;
  three archive-artifact tests could not start because the Windows host has no `zstd` executable
  (`spawn zstd ENOENT`). Those three are an explicit unresolved verification gate and must run in
  the exact Linux image before rollout.
- Compose defaults remain one admitted day, one database connection, 80 MiB and 0.05 CPU. Only the
  historical catch-up budgets change from a 120-second statement/300-second run admission window to
  600/1,800 seconds, justified by the measured 208.8-second high-volume cohort. This does not grant
  source retirement or change live execution.
- Next exact action is read-only/local: locate and verify the server release-ledger artifact, refresh
  backup, free disk, database/WAL slope, all Walletscaner service identities and protected co-tenant
  presence, then build the exact Linux R37 candidate and rerun the archive tests with `zstd` plus the
  relevant database tests. Only if those gates pass may a new revision-checked rollout phase be
  opened. The two production rows currently labelled `mismatch` must not be rewritten until their
  exact segment/revision/error preconditions are re-proven immediately before a guarded transaction.

## Exact R37 candidate gate at 2026-08-26 06:02 UTC

- The server ledger was re-read from `/opt/walletscaner/deploy/storage-r34-rollout-state.json` and
  still exactly matches revision 15, phase `storage-equilibrium-observation-r36`, status
  `in_progress` and SHA-256
  `6224c45bef08aa2c9a5d09e96bd5e71fd06aaa4b1a54b0d02af023a24c7f2c67`.
- Production remains current-flow operational but storage-degraded: open coverage incidents and
  dead letters are zero, recent pool/wallet ages were 5/38 seconds, finality unresolved-24h is zero,
  PostgreSQL was 15,805,045,783 bytes and free disk was about 17.69 GB. Archive catch-up advanced
  to nine verified wallet days and 23 pending. Three compact rows, exact segments 71/72/73 revision
  1 for July 12/13/14, are labelled `mismatch`; every one has the same statement-timeout error.
  This is the R36 classification defect, not observed count/digest divergence.
- All running Walletscaner containers remain restart 0/OOM false and every selected worker reports
  `ENABLE_LIVE_EXECUTION=false`. Ingestion and archive writer/verifier continue to make progress.
  The protected Compose project was not listed by Docker and was not inspected or touched.
- Immutable Linux/amd64 candidate `walletscaner-worker:storage-r37-20260826` was built off host from
  Git `529af29` and resolves to image ID
  `sha256:3978e4156d887c09b0e6b0484b7332c8b5b57183acd8a6c0f3f5fa51eeab4e8a`.
  Its Node 24.18.0, zstd 1.5.7 and PostgreSQL client 16.14 runtime is explicit.
- The exact image passed 49/49 relevant zstd/archive/materializer/maintenance/health/Telegram tests.
  Host-only Compose and Python rollout tests passed 8/8 and both Python tools compile. A deliberately
  broad worker-image test had 13 environment-only failures because that runtime intentionally omits
  Python and the root Compose file; this matches the already documented R36 split gate and is not
  counted as product verification.
- A new isolated PostgreSQL 16 container with a new isolated network then ran the four database
  integration files serially through the exact R37 image: archive pipeline 5/5, coverage lifecycle
  8/8, canonical evidence 32/32 and derived reclaim 2/2. The exact disposable container/network were
  removed afterward; the populated performance clone and its evidence remain untouched.
- Next exact action: export, compress and hash only R37; then revalidate the newest production dump
  sidecar/offsite marker and restore-list evidence, available disk and exact runtime identities. Do
  not load or activate R37 until ledger revision 15 is closed with observed failure and a new
  revision-checked R37 rollout phase is opened.

## R37 artifact checkpoint at 2026-08-26 06:04 UTC

- The exact R37 image was exported off host, compressed with single-thread zstd-3 and finalized only
  after hashing. Local artifact
  `deploy/walletscaner-worker-storage-r37-20260826.tar.zst` is 462,694,845 bytes with SHA-256
  `f28c2ffbbfa0a70ae4eedef17371e83f4ddac2afbeffea12acdd597a8eb158ba`; the uncompressed temporary
  tar was removed. The artifact is ignored by Git and the four older pre-existing partial artifacts
  remain untouched.
- Next exact action is production read-only validation of the newest dump file, SHA sidecar,
  offsite marker and `pg_restore --list` evidence under low I/O priority. If that passes, transfer
  R37 to a server `.partial` path with resume support, compare exact bytes/SHA, and only then close
  ledger revision 15 and open an R37 rollout phase. Loading remains distinct from activation.

## Production preflight and ledger checkpoint at 2026-08-26 06:15 UTC

- The newest server recovery dump is
  `backups/memecoin_alpha_20260825T150924Z.dump`, 2,053,352,363 bytes, SHA-256
  `ba26a3c89fdb8dc671d92976659ae177a6d8f76be40a45b8b8f774bb54238160`. A complete low-priority
  content hash passed, its sidecar and offsite marker match, and PostgreSQL 16 `pg_restore --list`
  passed. The first host-side check used the sidecar's container path and therefore could not open
  the file; the correct mounted-container check then passed without changing the artifact.
- Immediately before rollout bookkeeping, server free disk was 17,859,948,544 bytes. The R37
  partial/final paths and R37 image tag were absent. R36 resolved to exact image
  `sha256:24bcc3fa77d3a0a9e4369eb43ec4d33084b4985f1feedcc41db97cde1548d00a`.
  Rendered R36 materializer state was live false, one day, 80 MiB, 0.05 CPU, 300-second run and
  120-second statement timeout; its container was running, restart 0 and OOM false.
- Revision 15 was closed as `storage-equilibrium-observation-r36=failed` because three compact days
  timed out under the old budget. A separately dry-run and applied transition opened revision 17 as
  `r37-artifact-staging=in_progress`; ledger SHA-256 is
  `0904429432a19324ec4066a9c8fac2f51008897085b937359436c0aab2a079e0`. The next exact action encoded
  there is resumable transfer to `.partial`, exact byte/SHA verification, then load. No service,
  selector, database row or B2 object changed during these ledger transitions.

## R37 server artifact checkpoint at 2026-08-26 06:22 UTC

- Initial `sftp reput` correctly refused because no remote partial existed and made no file. The
  first transfer then used `put` to the exact `.partial` name; a future interruption could have
  resumed that path with `reput`. It completed at exactly 462,694,845 bytes.
- A one-shot read-only R36 verification container, capped at 0.04 CPU/64 MiB, recomputed the remote
  SHA-256 as `f28c2ffbbfa0a70ae4eedef17371e83f4ddac2afbeffea12acdd597a8eb158ba`.
  Only after local/remote bytes and SHA matched was the partial atomically renamed to
  `/opt/walletscaner/deploy/walletscaner-worker-storage-r37-20260826.tar.zst`. Server free disk after
  staging is 17,340,116,992 bytes.
- Ledger revision 17 remains `r37-artifact-staging=in_progress`; no image was loaded, no selector or
  Compose file changed, no service recreated and no database/B2 mutation occurred. Next exact action
  is low-priority zstd stream plus `docker load`, followed by exact image-ID verification before any
  activation.

## R37 image-load checkpoint at 2026-08-26 06:23 UTC

- The verified server artifact was decompressed single-threaded with low CPU/I/O priority and loaded
  as `walletscaner-worker:storage-r37-20260826`. The server image resolves exactly to local image ID
  `sha256:3978e4156d887c09b0e6b0484b7332c8b5b57183acd8a6c0f3f5fa51eeab4e8a`.
- Loading did not recreate or alter the materializer: its exact container ID remains
  `aee9d1fe0f94f9fe63c23477aa490c2a2a68a81b0eebfc8c57b92cfb9055ee25`, still R36, running,
  restart 0 and OOM false. Server free disk after load is 17,319,981,056 bytes.
- Next exact action: close artifact staging at ledger revision 18 and open a separate activation
  phase at revision 19. Then stage/hash the exact Compose file, verify the guarded image updater,
  change only `WALLETSCANER_OPERATIONS_IMAGE`, render the resulting one-day/600s/1800s/live-false
  service, and recreate only the materializer before its canary. Do not touch ingestion, wallet
  alpha, sampler, Telegram, PostgreSQL, Redis or the protected project.

## R37 configuration checkpoint at 2026-08-26 06:28 UTC

- Artifact staging closed at ledger revision 18. Revision 19 is
  `r37-materializer-activation=in_progress`, ledger SHA-256
  `0a422c660544b2d6e9177a188ce8bfbe541d5fcfd6e19c310714b92a56bdb3f5`.
- The exact local Compose file was staged to a server partial, SHA/config validated, and atomically
  installed. Current SHA-256 is
  `8c57d28c53145bbd7fe5669c53eb1329047c2821e748e8d24553d01937ae3288`; exact R36 rollback copy
  `deploy/docker-compose.server.r36-a745ac39.rollback.yml` has SHA-256
  `a745ac3977b939c61baf72cae18c00cc189be4e2a8c330d1a5ffd8a5479d52bb`.
- The server's guarded image updater matched local SHA-256
  `5cc7456847993197d3b291e29799c9936101134850f564e8d2570081b2ee359b`. Dry-run and apply changed
  only `WALLETSCANER_OPERATIONS_IMAGE` from exact R36 to exact R37; `.env.server` moved from SHA
  `a0b216d52eba4a5913ef42b31c4875a9d889bd597083b0c8dcda491e7748f84e` to
  `b1e6ce998c6217b99d16eb09d9d67afcb354cb264649703690a4f85b8246f9cd`.
- Rendered target is now exact R37, live false, one day, one connection, 80 MiB, 0.05 CPU,
  600-second statement and 1,800-second admission budget. The existing materializer is deliberately
  still exact R36 and unchanged at this checkpoint. Next exact action is a named, no-dependency,
  no-build materializer recreate followed by exact identity/resource/live verification before any
  compact receipt rewrite or canary.

## R37 materializer activation checkpoint at 2026-08-26 06:30 UTC

- Only `wallet-evidence-materializer-scheduler` was recreated with exact project/file/env, profile,
  `--no-build --no-deps --force-recreate`. Old container
  `aee9d1fe...`/R36 was replaced by `4b784501...` on exact R37 image
  `sha256:3978e4156d887c09b0e6b0484b7332c8b5b57183acd8a6c0f3f5fa51eeab4e8a`.
- The new materializer is running, restart 0/OOM false, memory 83,886,080 bytes, NanoCPUs
  50,000,000, pids 64, live execution false, max days 1, max run 1,800 seconds and statement timeout
  600,000 ms. Exact identities of ingestion, wallet-alpha, sampler, Telegram, PostgreSQL and Redis
  remained unchanged; the protected-project identity set also remained unchanged.
- No compact receipt has been rewritten yet. Next exact action is a guarded transaction that must
  match exactly segments 71/72/73, revision 1, status `mismatch`, attempt 1 and the statement-timeout
  error before changing only those statuses to `retry` with `not_before=NOW()`. Then run one R37
  materializer one-shot with explicit live false/no dependencies and observe the oldest July 12
  cohort. Any count/digest mismatch or unexpected pre-state aborts without mutation.

## Compact receipt correction checkpoint at 2026-08-26 06:30 UTC

- One transaction matched exactly all three required tuples: July 12/13/14, segments 71/72/73,
  revision 1, archive status verified, compact status mismatch, attempt 1 and exact PostgreSQL
  statement-timeout text. It updated exactly three compact receipts to `retry` with
  `not_before=NOW()` while preserving attempt/error audit. Pre- and postcondition `DO` blocks passed
  and the transaction committed.
- No trade, entry, outcome, compact fact, archive segment, B2 object or source count changed. The
  oldest unresolved day is now July 12 and, under R37, blocks July 13/14 until it resolves.
- Next exact action is one explicit R37/no-dependencies/live-false materializer canary. It must use
  the rendered 600-second statement and one-day limit, then prove exact image/resources, digest
  parity, updated receipt, current ingestion freshness and no restart/OOM/dead-letter regression.

## R37 canary failure checkpoint at 2026-08-26 17:06 UTC

- The explicit R37 one-day canary remained within exact 80 MiB/0.05 CPU limits and did not block
  current ingestion: sampled wallet/pool ages were 17.8/2.8 seconds, inbox/dead-letter 4/0,
  materializer RSS about 36-39 MiB and PostgreSQL about 22% CPU. The periodic scheduler acquired no
  duplicate work while the advisory lock was held and later logged a zero-work completed cycle.
- The canary did not pass. After 953,879 ms it failed in `open-lots` with exact error
  `wallet_open_lot_facts_episode_hash_fkey`; R37 correctly persisted this as operational `retry`, not
  parity `mismatch`. The transaction rollback preserved source and compact fact state. No source
  retirement, B2 action or canonical deletion occurred.
- Revision 19 remains `r37-materializer-activation=in_progress`; it must not be marked completed.
  The next exact action is read-only: for the oldest July 12 cohort compare the episode set selected
  by `materializeEpisodes` and `materializeOpenLots`, prove which wallet/token/strategy dimension or
  parent fact is absent, and reproduce on the populated PostgreSQL 16 clone. No second production
  canary is allowed until the invariant and regression test are fixed in a new immutable candidate.

## R37 retry-loop containment checkpoint at 2026-08-26 17:12 UTC

- After the interrupted observation window, the periodic R37 materializer had retried the same
  oldest day through attempt 12. The latest receipt remained `retry`, not mismatch, with an
  `episodes` statement timeout and a 30-minute backoff. One advisory lock was active at the refresh;
  the scheduler has not advanced past July 12.
- Repeated 600-second historical attempts are bounded and preserve data, but they impose needless
  PostgreSQL load while the consistent-snapshot defect is unresolved. The next exact production
  action is therefore to stop only `wallet-evidence-materializer-scheduler` and verify that
  ingestion, writer/verifier, wallet-alpha, PostgreSQL and Redis identities remain unchanged.
  Stopping this derived compact shadow worker does not stop canonical data collection or B2 archive
  catch-up. Do not restart it until an R38 snapshot-consistency candidate passes clone concurrency
  and production preflight gates.

## R38 repair start checkpoint at 2026-08-26 17:16 UTC

- Resume verification found local HEAD `1fc78d4`, branch 80 commits ahead of origin, with only the
  four pre-existing ignored/untracked transfer artifacts. No interrupted source edit or R38
  artifact exists.
- Production still has only the Walletscaner Compose project listed. The exact R37 materializer
  container `4b784501...` is stopped with exit 143, restart 0 and OOM false. Its retry loop is
  contained; no active compact-fact query was observed. Canonical ingestion, wallet alpha,
  sampling, Telegram, PostgreSQL, Redis and the R36 archive writer/verifier remain running. No
  protected co-tenant resource was changed or inspected.
- The host has 16,328,011,776 bytes free and PostgreSQL is 16,978,803,735 bytes. Inbox work/dead
  letter was 12/0. The first freshness query used the wrong pool relation name and stopped before
  those two ages were returned; repeat it with the canonical health query before any rollout.
- The production-only foreign-key failure is explained by a statement-snapshot race: the R37
  materializer uses READ COMMITTED, while wallet alpha transactionally replaces episode/lot
  snapshots between the episode-fact and open-lot statements. A local static clone cannot expose
  this race. Repeated historical cohorts also rewrite unchanged episode facts and delete/reinsert
  every open lot, causing avoidable WAL and timeout risk.
- Next exact action is local-only: change the materializer transaction to REPEATABLE READ, suppress
  unchanged episode/open-lot updates, replace delete-all/reinsert open-lot reconciliation with an
  affected-scope stale-lot prune plus idempotent upsert, and add control-flow plus PostgreSQL
  regression evidence. Do not create or deploy R38, restart the production materializer, rewrite a
  compact receipt, retire source rows or mutate B2 until the exact candidate passes the populated
  clone concurrency/performance gate.

## R38 local correctness checkpoint at 2026-08-26 17:27 UTC

- The local R38 source now begins every day with `REPEATABLE READ`, suppresses no-op episode and
  open-lot conflict updates, and replaces the former affected-scope delete-all/reinsert lot pass
  with a same-snapshot stale-lot anti-join plus idempotent upsert. There is no schema migration and
  no reader/retirement change.
- Unit control-flow tests passed 5/5; TypeScript and targeted ESLint passed. Windows could not run
  the archive integration because the host has no `zstd`, matching the recorded environment gap.
  The exact R37 Linux runtime (Node 24 plus zstd), with only the R38 source/tests bind-mounted
  read-only, then passed the materializer and PostgreSQL archive integration 10/10 against a new
  disposable PostgreSQL 16 database.
- The regression holds an `ACCESS EXCLUSIVE` lock at the open-lot boundary, commits a concurrent
  episode/lot generation for the same touched wallet, and proves the materializer neither mixes
  child/parent generations nor violates the foreign key. It also proves a retry over unchanged
  facts preserves both `updated_at` values and that a source lot becoming realized prunes only its
  stale compact continuation fact.
- The disposable test container is `walletscaner-pg16-r38-test` on loopback port 55435; it contains
  no production data and may be removed after the exact R38 image gate. The populated clone
  `walletscaner-pg16-r31` has not yet been mutated in this R38 phase.
- Next exact action: commit this coherent source/test/document checkpoint, then inspect the
  populated clone's exact archive/receipt state before any reset. Run one full-day R38 retry there,
  record phase durations and PostgreSQL WAL/temp deltas, and compare with the prior 208,827 ms R37
  baseline. Production materializer remains stopped and no R38 artifact or rollout ledger phase
  exists yet.

## R38 populated-clone canary checkpoint at 2026-08-26 17:33 UTC

- The exact 24-August clone receipt pre-state was segment 65/revision 1 verified with 100,078
  archive rows; compact status was the intentionally induced `retry` from the earlier 1 ms timeout.
  Existing facts were 218,492 episodes, 251,460 open lots and 27,498 followability outcomes.
- R38 ran in a named interruption-safe canary container under the production 80 MiB/0.05 CPU,
  one-day, 600-second-statement and 1,800-second-run limits. It exited 0, OOM false, in 185,957 ms
  with exact count/two-digest parity. Peak observed worker RSS remained about 37 MiB. Phase times
  were dimensions 65,323 ms, reconcile 3,230, episodes 20,487, open lots 43,889, followability
  10,867 and all six parity reads 40,675 ms. This is about 11% faster than the prior 208,827 ms
  populated-clone R37 pass.
- Database size increased only 180,224 bytes, showing that unchanged episode/open-lot facts were
  not rewritten. The otherwise idle clone recorded 152,507,785 WAL bytes and 1,777,372,739 temp
  bytes/36 temp files during the run. The remaining WAL is materially larger than a no-op receipt
  should require because followability still deletes/reinserts all 27,498 daily facts; temp I/O is
  bounded and released but must remain part of the production headroom gate.
- No production or B2 mutation occurred. The production R37 materializer remains stopped. The
  clone canary container is exited with its exact log retained; its fixed local-only test role is
  still present solely for the next R38 measurement.
- Next exact action: apply the same field-distinct upsert and same-day stale anti-join to
  followability facts, add idempotent `updated_at` and stale-fact integration assertions, rerun the
  isolated PostgreSQL gate and then rerun the same populated-clone day from a controlled `retry`.
  Compare WAL/temp/runtime before building or deploying an R38 image.

## R38 followability/no-op measurement at 2026-08-26 17:39 UTC

- The followability stale-prune plus field-distinct conflict update passed the isolated exact-Linux
  PostgreSQL gate, including stale outcome-hash removal and unchanged `updated_at` preservation.
- The second full 24-Aug populated-clone retry exited 0/OOM false with exact 218,492/251,460/27,498
  parity in 151,604 ms. Followability fell from 10,867 to 4,275 ms and total runtime is now about
  27% below the original 208,827 ms R37 baseline. Database size did not increase at all.
- WAL still increased 125,375,012 bytes and temp increased exactly 1,777,372,739 bytes/36 files.
  The persistent-size result is correct, but PostgreSQL `INSERT ... ON CONFLICT DO UPDATE WHERE`
  still performs conflict work for roughly 497,000 unchanged episode/lot/outcome facts. This is the
  remaining no-op WAL source; temp remains the repeatable read/aggregate work area.
- The local source now uses PostgreSQL 16 `MERGE` for all three compact fact families. Its desired
  source set is joined once; matched rows update only when fields differ and unmatched rows insert,
  avoiding speculative conflict writes for unchanged facts. Stale anti-joins remain separate and
  use the same repeatable snapshot. Unit, typecheck, targeted lint and isolated exact-Linux
  PostgreSQL archive/materializer tests pass 10/10 after this change.
- Next exact action: retain the second exited canary log until this checkpoint is committed, then
  run one third guarded populated-clone retry with the MERGE source and compare DB/WAL/temp/runtime.
  Do not build or deploy R38 if parity, concurrency, stale correction or resource bounds regress.

## R38 MERGE populated-clone gate at 2026-08-26 17:46 UTC

- The third full 24-Aug retry used the final PostgreSQL 16 `MERGE` source under exact
  80 MiB/0.05 CPU/one-day/600-second/1,800-second limits. It exited 0, OOM false, in 118,427 ms
  with exact 218,492 episode, 251,460 open-lot and 27,498 followability count/two-digest parity.
  This is about 43% faster than the 208,827 ms R37 populated-clone baseline.
- Permanent database size changed by zero bytes. WAL increased only 50,327 bytes, down about
  99.96% from the preceding 125,375,012-byte no-op conflict run. The changed phase times were
  episodes 4,764 ms, open lots 15,103 and followability 1,613; dimensions remains largest at
  52,838 ms.
- Temp work increased 1,860,661,329 bytes across 39 files. This space is statement-scoped and was
  released, not a permanent database-growth source, but production activation must reserve at
  least 2 GiB of additional temp headroom above the 8 GiB hard disk reserve and must not overlap a
  heavy archive/export run during the canary.
- The final exact-Linux isolated gate still passes 10/10 with concurrency, correction, stale-prune
  and `updated_at` idempotence assertions. No production/B2 action occurred; the production R37
  materializer remains stopped. The third exited clone-canary log is retained until commit.
- Next exact action: commit the MERGE/source/test/docs checkpoint, run the full repository test,
  typecheck, full lint and workspace builds, then build an immutable R38 image and rerun the four
  isolated PostgreSQL integration files through that exact image. Only after that may production
  backup/headroom/live-flow/ledger preflight be refreshed.

## R38 repository gate checkpoint at 2026-08-26 17:49 UTC

- Full Windows test discovery ran 445 tests: 394 passed and 47 integration tests were intentionally
  skipped without `TEST_DATABASE_URL`. Three archive-artifact tests failed only because Windows has
  no `zstd`, the same recorded platform gap. The release-checkpoint test crossed its default
  five-second limit while the test, lint, typecheck and build jobs were deliberately run in
  parallel; it passed 3/3 alone under a 30-second ceiling in 3.55 seconds.
- Full typecheck, full ESLint and the production Next.js workspace build passed. The isolated
  exact-Linux archive/materializer PostgreSQL gate already passes 10/10 with zstd present.
- Git checkpoint commits are `7b42c70` (repeatable snapshot/concurrency/stale reconciliation) and
  `ee6255c` (MERGE/no-op WAL elimination). The working tree contains only this WIP update plus the
  four pre-existing untracked transfer artifacts; no source edit is uncommitted.
- Next exact action: commit this test checkpoint, build immutable
  `walletscaner-worker:storage-r38-20260826`, record its image ID/runtime versions, and run the
  zstd/materializer unit gate plus all four isolated PostgreSQL 16 integration files through that
  exact image. The production materializer remains stopped.

## Exact R38 image gate at 2026-08-26 17:50 UTC

- The first default-root build attempt failed before creating an image because this repository
  intentionally has no root `Dockerfile`. The corrected reviewed path is
  `docker/worker.Dockerfile`; no production action resulted from the failed attempt.
- Immutable local tag `walletscaner-worker:storage-r38-20260826` resolves to Linux/amd64 image ID
  `sha256:81a987394f6e3470c8d9b901ef1ced21b28f03f1c554191479a85cd7239c44dc` with Node 24.18.0,
  zstd 1.5.7 and PostgreSQL client 16.14.
- The exact image passed the zstd/archive/materializer/Telegram/operational-health unit gate 28/28.
  Against the isolated PostgreSQL 16 test container, the four files ran serially and passed 47/47:
  archive pipeline 5, ingestion coverage 8, canonical evidence 32 and derived reclaim 2.
- The exact image has not been exported, transferred, loaded or selected on production. The server
  ledger remains R37 revision 19/in-progress until live state is refreshed; production materializer
  remains stopped.
- Next exact action: commit this checkpoint, remove only the named exited local clone canary and
  disposable R38 integration database, drop only the disposable clone role, then export R38 to an
  uncompressed temporary tar, zstd it single-threaded to `.partial`, verify bytes/SHA and atomically
  rename. Preserve all four pre-existing untracked transfer artifacts.

## R38 release artifact checkpoint at 2026-08-26 17:52 UTC

- The exited clone canary and disposable R38 PostgreSQL integration container were removed only
  after their evidence was recorded. The fixed local-only `r38_materializer` clone role had zero
  sessions and was dropped. The populated PostgreSQL clone and all four pre-existing untracked
  transfer artifacts remain intact.
- Exact image `walletscaner-worker:storage-r38-20260826` was exported to a temporary tar, compressed
  with zstd level 3/single-thread/checksum, frame-tested and finalized only after hashing. Local
  artifact `deploy/walletscaner-worker-storage-r38-20260826.tar.zst` is 462,868,480 bytes with
  SHA-256 `1976fce09466f15a67352301deca0731d1ccaba484ad7d9951f034b4248c28d9`. The uncompressed tar was
  removed after its resolved path was verified inside the repository deploy directory.
- No server file, image, selector, service, database row or B2 object changed. Next exact action is
  production read-only preflight: release-ledger revision/SHA, dump plus off-site/restore-list proof,
  disk/RAM/load/temp headroom, Compose identities, exact live-false values, archive activity,
  canonical freshness/coverage/dead letters and current R37 materializer stopped state. Do not
  transfer R38 unless the 2 GiB temp margin above the 8 GiB reserve and all hard gates pass.

## R38 production preflight hold at 2026-08-26 17:58 UTC

- Read-only production preflight confirms 15,838,797,824 bytes free, about 1.04 GB available RAM
  and 1.97 GB free swap. Staging plus image load plus the measured 1.86 GB temp run still leaves
  more than the 8 GiB hard reserve, but current load is not an activation window.
- Canonical flow is operational: coverage incidents 0, inbox/dead letter 8/0 at the sample, pool age
  23 seconds, 255 trades from 90 wallets in the later 15-minute sample, no active compact query and
  live execution false in every selected worker. Six compact days are verified; July 12/13/14 are
  the three retry rows from the R37 timeout failure. Wallet archive is progressing with 17 verified,
  15 pending and zero dead-letter segments.
- The one transaction older than five minutes is the normal daily `pg_dump`, actively copying the
  25-Aug raw payload partition. It explains the elevated one-CPU load and must not be interrupted or
  overlapped by R38 transfer/load/canary. The latest completed dump remains the 2,053,352,363-byte
  25-Aug file with sidecar and off-site marker; its full SHA/restore-list recheck waits until the
  current dump completes.
- Server ledger is exactly revision 19, current phase `r37-materializer-activation`, status
  `in_progress`, SHA-256 `0a422c660544b2d6e9177a188ce8bfbe541d5fcfd6e19c310714b92a56bdb3f5`.
  R38 artifact paths and image are absent. Current Compose/env still select R37 for operations, but
  the only R37 materializer is stopped exit 143; running operations/archive services remain exact
  R36 and all non-target identities are unchanged.
- Next exact production mutation is limited to release bookkeeping: hash-match the checkpoint tool,
  dry-run then close revision 19 as failed with the proven FK/snapshot/WAL canary evidence. Do not
  open R38 staging or transfer anything until `pg_dump` exits cleanly, its new or prior complete
  recovery artifact passes checksum/off-site/restore-list gates, and load falls to a safe window.

## R37 terminal ledger checkpoint at 2026-08-26 18:00 UTC

- Local/server `scripts/deploy/release-checkpoint.py` SHA-256 matched exactly at
  `a907032e824f79ae97d378fc51c1f66276105402dc58015fa0901a0a690158ef`.
- Revision-19 transition was dry-run with the exact prior ledger SHA and then atomically applied.
  Server ledger is now revision 20, `r37-materializer-activation=failed`, SHA-256
  `40a97af41a6082d34f2abb625046c125f4e9d8fcef445591481dab451bc3d659`.
  Evidence records the FK/snapshot/rewrite-WAL failure, exact R38 test gate, operational canonical
  flow and stopped materializer. No service, selector, database or B2 object changed.
- Current production hold remains the active daily `pg_dump`. Next exact read-only action is to
  poll that one transaction and backup container exit/progress without interrupting it. Only after
  it finishes may the newest complete dump be selected and its checksum, off-site marker and
  `pg_restore --list` proof revalidated before opening revision 21 for R38 artifact staging.

## Resume audit while daily backup remains active at 2026-08-26 18:26 UTC

- The interruption checkpoint was compared with Git and production before any mutation. Local HEAD
  is `9b04199`; the only working-tree artifacts are the same four pre-existing untracked partial
  transfers. Exact local R38 remains 462,868,480 bytes with SHA-256
  `1976fce09466f15a67352301deca0731d1ccaba484ad7d9951f034b4248c28d9`. No R38 server artifact,
  image, selector or ledger phase has been assumed or opened.
- Server ledger is still revision 20 with `r37-materializer-activation=failed`; canonical flow and
  the stopped R37 materializer state recorded there have not been changed. The only listed Compose
  project is `walletscaner`; no co-tenant target was inspected or mutated.
- The daily `pg_dump` PID 2698043 remains active and low priority. Its temporary generation
  `memecoin_alpha_20260826T173517Z.dump.tmp` grew monotonically from the pre-interruption 694,465,101
  bytes to 1,059,111,465 bytes at 18:24 UTC and then 1,116,030,136, 1,137,781,624 and
  1,140,682,624 bytes through 18:26 UTC. PostgreSQL progress moved from the 26-Aug raw-payload
  partition to `swaps`; no OOM, restart or failed backup log is present.
- Host free disk is 15,199,555,584 bytes, available memory about 1.03 GB and free swap about
  1.97 GB. This still passes the eventual 8-GiB reserve plus measured 2-GiB materializer-temp gate,
  but R38 transfer/load/canary must not overlap the active dump.
- Next exact read-only action is to continue bounded polling until the temporary dump is atomically
  finalized and its sidecar appears. Then verify the completed dump's full SHA against its sidecar,
  PostgreSQL 16 `pg_restore --list`, and off-site acknowledgement (or retain the prior already
  verified generation as the recovery gate while acknowledgement safely catches up). Only after
  the backup process and any heavy off-site transfer are idle may revision 21 be opened for
  `r38-artifact-staging`.

## Daily recovery artifact checkpoint at 2026-08-26 19:12 UTC

- The same uninterrupted `pg_dump` completed normally after progressing through the large wallet
  tables. Its temporary path was atomically finalized as
  `backups/memecoin_alpha_20260826T173517Z.dump`, 1,936,729,703 bytes. The scheduler's internal
  PostgreSQL 16 `pg_restore --list` passed before rename, then it wrote a 112-byte SHA sidecar and
  returned to its normal sleep interval; no temporary dump remains.
- The generated SHA-256 is
  `5bb6961e89655a8033aec9fa5c3a42a7d367046d45b31d6e1ea5f6a899d7b9c0`. A second, independent
  low-I/O-priority `sha256sum -c` reread the full 1.94-GB file and passed, followed by another
  successful PostgreSQL 16 `pg_restore --list`. This generation is a valid server recovery
  artifact but is not yet off-site acknowledged.
- The Windows `Walletscaner-Offsite-Backup` task ran at its normal 22:00:01 local time before the
  new sidecar was ready and failed closed with result 1. The older 25-August dump remains present
  with its matching sidecar and off-site acknowledgement, so recovery coverage was never lost.
- After verification the host has 13,985,484,800 bytes free, about 1.01 GB available RAM and
  1.98 GB free swap. The new dump plus prior verified generation temporarily explain the lower
  disk headroom. Do not begin R38 while the retrying off-site transfer is active.
- Next exact action: invoke the existing reviewed off-site task once now that the completed dump and
  non-empty sidecar are stable. Wait for its local checksum/archive-list verification and matching
  server `.offsite-verified` acknowledgement, verify the marker digest, and let only the reviewed
  reconciliation path retire the older server generation. Then refresh disk/load/flow/ledger gates
  before opening revision 21 for `r38-artifact-staging`.

## Off-site recovery gate completed at 2026-08-26 19:29 UTC

- The existing reviewed `Walletscaner-Offsite-Backup` task was invoked once after the server dump
  gate. It resumed/downloaded to a generation-specific `.partial`, reached the exact
  1,936,729,703-byte server size, verified SHA-256
  `5bb6961e89655a8033aec9fa5c3a42a7d367046d45b31d6e1ea5f6a899d7b9c0`, passed PostgreSQL 16
  archive-list validation and only then atomically finalized the local file. The task completed
  with result 0 at 19:28:04 UTC.
- The server acknowledgement now contains the exact same digest. The reviewed reconciliation kept
  the new verified server generation and removed the superseded 25-August server copy; the older
  off-host recovery generation remains local. No database, B2 object or canonical evidence was
  deleted.
- Server free disk recovered from the two-generation low point to 16,061,800,448 bytes. Available
  memory is about 1.07 GB, free swap 1.98 GB and load is settling after backup/transfer. The backup
  scheduler is sleeping and no hash, dump, restore-list or SFTP process remains.
- Next exact action: refresh the complete R38 production preflight against actual revision 20,
  selected images, stopped R37 materializer, Compose projects/services, live-false controls,
  migration checksums, database/archive/coverage/queue freshness, active transactions, disk/RAM/
  swap/load and absence of R38 server paths/image. If every hard gate passes, dry-run then apply
  revision 21 `r38-artifact-staging=in_progress` before the first R38 transfer byte.

## R38 final production preflight at 2026-08-26 19:34 UTC

- Server ledger remains exact revision 20/SHA-256
  `40a97af41a6082d34f2abb625046c125f4e9d8fcef445591481dab451bc3d659`; Compose remains
  `8c57d28c53145bbd7fe5669c53eb1329047c2821e748e8d24553d01937ae3288`. Release-checkpoint and
  guarded image-updater hashes still match local. No R38 server path or image exists.
- The new 1,936,729,703-byte recovery dump is now reported `offsiteAcknowledged=true` with exact
  digest `5bb6961e89655a8033aec9fa5c3a42a7d367046d45b31d6e1ea5f6a899d7b9c0`. Server, independent
  reread, local off-host bytes/SHA and both PostgreSQL 16 archive-list checks passed.
- Migrations 050/051 are present with repository-exact SHA-256 values
  `fa0e8372ae65cf39e83fc1f7c92c9608bffd4b3531eb6e2ce3ffbd21d4e96886` and
  `bceaa2f4493f4791f1125c6a74074c86184fa150d2d2c4de7069fd7f838ab856`. PostgreSQL is
  17,254,906,903 bytes at the query boundary; no transaction older than five minutes exists.
- Canonical flow is operational: open coverage incidents 0; health backlog/dead-letter 0/0; pool,
  swap and wallet-trade ages 6/31/45 seconds at the direct sample; 377 trades from 135 wallets in
  the preceding 15 minutes. Alpha ready work is 1,042 (priority lanes P1/P0 518/526), one
  fail-closed quarantine and two retained error rows; this backlog has fallen materially from the
  earlier 13,481 and is not the materializer target.
- Archive state is 25 verified chain-payload days and wallet evidence 18 verified/14 pending with
  zero dead letter. Compact state is actually 6 verified/3 retry, not three parity mismatches; R36
  health uses the stale mismatch label. Writer and verifier are sleeping after a zero-work verifier
  cycle, and backup/hash/SFTP are idle.
- All selected workers report `ENABLE_LIVE_EXECUTION=false`. Ingestion R30, wallet-alpha R34,
  Telegram R23, PostgreSQL and Redis are running restart 0/OOM false. Running archive/maintenance/
  ops stay R36. The exact R37 materializer remains stopped exit 143, restart 0/OOM false. Only the
  `walletscaner` Compose project is listed.
- Free disk is 16,053,837,824 bytes, available memory about 1.08 GB, free swap 1.98 GB and load1
  settled to 1.17. This exceeds the 8-GiB hard reserve plus the measured 1.86-GB materializer temp
  requirement after staging headroom. Local R38 was independently rehashed at 462,868,480 bytes and
  SHA-256 `1976fce09466f15a67352301deca0731d1ccaba484ad7d9951f034b4248c28d9`.
- Next exact mutation: dry-run then apply revision 21
  `r38-artifact-staging=in_progress`, with rollback to the absent R38 paths plus loaded/stopped R37
  and running R36 operations. Then transfer only the exact R38 artifact to a `.partial` path,
  verify server bytes/SHA in a bounded R36 container and atomically rename before image load.

## R38 staging ledger opened at 2026-08-26 19:35 UTC

- Revision 20 was dry-run against exact prior SHA
  `40a97af41a6082d34f2abb625046c125f4e9d8fcef445591481dab451bc3d659`, then the same guarded
  transition was atomically applied. Server ledger is revision 21,
  `r38-artifact-staging=in_progress`, SHA-256
  `413e1c8ce247074ebb03334db9ab413468b5df6b0d31386ad93c1da480d7819b`.
- The ledger records the exact 462,868,480-byte artifact, transfer SHA, candidate image prefix,
  verified backup SHA and pre-staging free disk. No artifact byte, image, selector, service,
  database row or B2 object changed during this bookkeeping step.
- Next exact action is the ledger-encoded resumable transfer to
  `/opt/walletscaner/deploy/walletscaner-worker-storage-r38-20260826.tar.zst.partial`; verify exact
  server size and SHA before atomically renaming. Loading and activation remain separate phases.

## R38 server artifact checkpoint at 2026-08-26 19:43 UTC

- R38 was transferred with a 16-Mbit/s SFTP ceiling to the exact `.partial` path and the session
  exited cleanly. The server file reached exactly 462,868,480 bytes.
- A network-disabled one-shot R36 container with a read-only artifact mount, 64 MiB memory,
  0.04 CPU and 32-pid limits independently computed SHA-256
  `1976fce09466f15a67352301deca0731d1ccaba484ad7d9951f034b4248c28d9`, exactly matching the local
  artifact. Only after that proof was the partial atomically renamed to
  `/opt/walletscaner/deploy/walletscaner-worker-storage-r38-20260826.tar.zst`.
- Server free disk is 15,577,153,536 bytes. Ledger revision 21 remains staging in progress. No image
  was loaded, selector/service/database/B2 state changed, and the R37 materializer remains stopped.
- Next exact action is a low-I/O/CPU single-thread zstd stream into `docker load`, followed by exact
  tag/image-ID verification against local
  `sha256:81a987394f6e3470c8d9b901ef1ced21b28f03f1c554191479a85cd7239c44dc`. Do not activate if the
  loaded identity differs.

## R38 image-load checkpoint at 2026-08-26 19:45 UTC

- The verified artifact was decompressed single-threaded under the 0.04-CPU/64-MiB R36 container
  boundary and streamed to low-I/O-priority `docker load`. The command exited 0.
- Server tag `walletscaner-worker:storage-r38-20260826` resolves exactly to Linux/amd64 image ID
  `sha256:81a987394f6e3470c8d9b901ef1ced21b28f03f1c554191479a85cd7239c44dc`, matching the locally
  tested artifact. Free disk is 15,553,445,888 bytes.
- Selector remains R37 and materializer container ID `4b784501...` remains exited 143, restart 0,
  OOM false on exact R37. All other services and Compose project state remain unchanged.
- Image load temporarily raised load1 to 2.70. Next exact read-only action is to wait for load1 and
  archive activity to settle, then close ledger revision 21 as completed and open a separate R38
  materializer-activation phase. Do not change the selector while the host is above the canary
  load gate.

## R38 artifact staging completed at 2026-08-26 19:48 UTC

- Host load settled and the archive verifier completed a zero-work cycle in 2.2 seconds; no
  archive/export/backup process is active.
- Revision 21 was dry-run against exact prior ledger SHA, then atomically closed. Ledger revision
  22 is `r38-artifact-staging=completed`, SHA-256
  `8bfaafe4904188bcf346842f235d3e75d99f967d4f6a7c8d801e09dc6bea9143`, with exact remote
  bytes/SHA and loaded image prefix recorded.
- Selector, services, database and B2 remain unchanged. Next exact mutation is to dry-run then open
  revision 23 `r38-materializer-activation=in_progress` before changing the operations selector.

## R38 materializer activation opened at 2026-08-26 19:49 UTC

- Exact pre-state is env SHA-256
  `b1e6ce998c6217b99d16eb09d9d67afcb354cb264649703690a4f85b8246f9cd`, Compose SHA-256
  `8c57d28c53145bbd7fe5669c53eb1329047c2821e748e8d24553d01937ae3288`, selector R37 and stopped
  materializer ID `4b784501...` on image `sha256:3978e4156d88...`.
- Revision 22 was dry-run then atomically advanced. Ledger revision 23 is
  `r38-materializer-activation=in_progress`, SHA-256
  `2147e09f375ee362e62c52560e240e41a8b83cb49ede06769835c3aa2596fc21`.
- No selector or service changed while opening the phase. Next exact mutation is the guarded
  updater dry-run/apply changing only `WALLETSCANER_OPERATIONS_IMAGE` from exact R37 to exact R38,
  followed by Compose rendering and inspection before any named service recreate.

## R38 selector checkpoint at 2026-08-26 19:50 UTC

- The repository/server hash-matched guarded updater dry-ran and applied exactly one change:
  `WALLETSCANER_OPERATIONS_IMAGE` from exact R37 to exact R38. `.env.server` SHA-256 changed from
  `b1e6ce998c6217b99d16eb09d9d67afcb354cb264649703690a4f85b8246f9cd` to
  `1299945c9b7b6a4643272552901fcd00ff059ecda316dfb95d4478c4f9f1ad91`.
- `ENABLE_LIVE_EXECUTION=false` remains selected. No container was recreated; the stopped
  materializer is still exact R37 and running operations/archive services remain exact R36.
- Rollback is the inverse guarded one-key update to R37 using exact current R38 as pre-state.
  Next exact read-only action is to render only the intended materializer service and verify exact
  R38 image, live false, one-day/one-connection, 80-MiB/0.05-CPU, 600-second statement and
  1,800-second run limits before recreating it with `--no-deps --no-build --force-recreate`.

## R38 materializer service checkpoint at 2026-08-26 19:52 UTC

- Secret-free Compose rendering passed: exact R38 image, live false, one day, one connection,
  80 MiB, 0.05 CPU, 64 pids, 600,000-ms statement timeout and 1,800-second run budget.
- Only `wallet-evidence-materializer-scheduler` was recreated with exact project/file/env/profile,
  `--no-deps --no-build --force-recreate`. New container `b3704aca94ee...` runs exact R38 image ID
  `sha256:81a987394f6e3470c8d9b901ef1ced21b28f03f1c554191479a85cd7239c44dc`, restart 0/OOM false,
  with the rendered resource/live controls.
- Ingestion, wallet-alpha, R36 operations/archive/maintenance, Telegram, PostgreSQL and Redis retain
  their exact pre-state container IDs, restart 0/OOM false. The target scheduler is inside its
  600-second initial sleep, so it cannot overlap the one-shot canary.
- Recreate temporarily raised load1 to 2.21. Next exact read-only action is to wait for host load
  and archive jobs to settle, then inspect the exact three retry receipts and run one R38 one-shot
  with explicit live false/no dependencies. Stop and roll back the selector/service on any timeout,
  parity mismatch, OOM, resource-reserve breach or unexpected receipt transition.

## R38 automatic first run in progress at 2026-08-26 20:22 UTC

- Interruption reconciliation found that the recreated scheduler's 600-second initial delay had
  elapsed at about 20:01 UTC and its exact R38 worker was already materializing. No duplicate
  one-shot was started. Container `b3704aca94ee...` remains restart 0/OOM false on exact image
  `sha256:81a987394f6e3470c8d9b901ef1ced21b28f03f1c554191479a85cd7239c44dc`.
- The active Node PID is `2741013`; PostgreSQL backend `213565` is progressing through the
  bounded wallet lot/digest query with no blocking PID. The three pre-run receipts remain exactly
  6 verified and 3 retry until the transaction publishes a terminal result; do not interpret or
  retry them before this process exits.
- During the run, free disk remains about 15.4 GB. On the one-vCPU host, load1 ranged about
  2.0-3.3 while sampled CPU idle remained 60-78%. Canonical ingestion remained fresh at the
  acceptance sample: inbox backlog/dead-letter 20/0 with oldest unresolved 27.2 seconds, pool age
  3.3 seconds, swap age 9.3 seconds and wallet-trade age 38.3 seconds.
- Next exact action is read-only: wait for PID `2741013` to exit, then inspect scheduler logs,
  receipt transition/count/digests, backend/locks, exit/OOM state, database/WAL/temp/disk deltas,
  canonical-flow freshness and every non-target container ID. Do not start another materializer
  while PID `2741013` or backend `213565` exists.

## R38 first-run failure and rollback plan at 2026-08-26 20:27 UTC

- The existing scheduler run ended fail-closed after 1,474,428 ms. It processed only the oldest
  2026-07-12 receipt and reported `verified=0`, `failed=1`: the R38 `open-lots` statement reached
  the explicit 600,000-ms timeout. No process was OOM-killed, no blocking PID existed and no
  canonical/archive/B2 row was deleted.
- The 2026-07-12 receipt atomically remained `retry`; attempt count advanced from 12 to 13 and its
  terminal error is the bounded open-lots timeout. Compact aggregate is unchanged at 6 verified / 3
  retry. The scheduler is now in its 900-second failure sleep, so there is no active materializer
  backend and no safe basis for calling R38 operational.
- Pre-rollback selector is exact R38, env SHA-256
  `1299945c9b7b6a4643272552901fcd00ff059ecda316dfb95d4478c4f9f1ad91`; target container is
  `b3704aca94ee...`, running exact R38, restart 0/OOM false. Ledger revision 23 remains
  `r38-materializer-activation=in_progress` with rollback ref to selector R37 and a stopped R37
  materializer.
- Next exact mutations: stop only `wallet-evidence-materializer-scheduler`; use the guarded updater
  dry-run/apply to change only `WALLETSCANER_OPERATIONS_IMAGE` from exact R38 to exact R37; render
  and recreate only that named service with `--no-deps --no-build --force-recreate`, then stop it so
  the rollback state is a stopped exact-R37 materializer. Verify every non-target ID, live false,
  flow freshness and resource reserve, then close ledger revision 23 as failed. Do not retry the
  materializer until the open-lots query is redesigned and repopulated-clone evidence passes.

## R38 scheduler stopped at 2026-08-26 20:29 UTC

- Only `wallet-evidence-materializer-scheduler` was stopped through the exact Walletscaner Compose
  project/file/env/profile. Container `b3704aca94ee...` is now exited 143, OOM false, restart 0 on
  exact R38. No materializer Node process remains, so the 900-second failure-delay retry cannot run.
- The selector is still exact R38 and ledger revision 23 remains activation in progress. Next exact
  mutation is the reviewed updater dry-run and apply changing only the operations image selector
  from exact R38 to exact R37; do not recreate or touch another service.

## R38 rollback completed at 2026-08-26 20:31 UTC

- The guarded updater changed only `WALLETSCANER_OPERATIONS_IMAGE` from exact R38 back to exact R37;
  `.env.server` returned byte-for-byte to SHA-256
  `b1e6ce998c6217b99d16eb09d9d67afcb354cb264649703690a4f85b8246f9cd`. Live execution remains
  false. Secret-free Compose rendering preserved one day, 1,800-second run, 600-second statement,
  80-MiB, 0.05-CPU and 64-pid limits.
- Only the materializer was recreated as exact R37 image
  `sha256:3978e4156d887c09b0e6b0484b7332c8b5b57183acd8a6c0f3f5fa51eeab4e8a` and immediately stopped
  during its initial sleep. New target `28e6a9099e69...` is exited 143, restart 0/OOM false. All 12
  non-target Walletscaner container IDs, states, image IDs, restart and OOM values matched exactly
  before/after; no co-tenant service was touched.
- Post-rollback database state is 17,346,362,391 bytes; materializer backend and transactions older
  than five minutes are both zero. Compact receipts remain 6 verified / 3 retry, with 12 July at
  attempt 13. Free disk is 15,496,060,928 bytes, available RAM about 1.06 GB and swap free about
  1.97 GB.
- Server ledger revision 24 closes `r38-materializer-activation=failed`, SHA-256
  `d8790ddb765601aabcda17446a0f33eb9d0c94da1d2402e85119d4eae5ac89a9`. The next allowed path is
  an open-lots query redesign and populated-clone acceptance; do not activate R38 or another
  materializer build on production before that evidence passes.
- Canonical flow at the immediate rollback sample had backlog/dead-letter 0/0 and pool age 1.3
  seconds. Swap and wallet-trade ages were both 316.3 seconds after being 9.3/38.3 seconds during
  the canary; resample this before classifying it as a transport/parser fault.

## Open-lots redesign baseline at 2026-08-26 20:36 UTC

- The populated 12.48-GB PostgreSQL 16 clone `walletscaner-pg16-r31` is intact and contains
  2,175,963 wallet trades, 424,013 episodes, 807,507 lots, 218,492 compact episode facts and
  251,460 compact open-lot facts. This is the restored full-data test target; do not repeat the
  restore.
- For 2026-07-12, the current wallet-wide scope expands 4,043 touched wallet/strategy identities
  into 191,922 historical episodes and 210,827 non-realized lots. The intended direct dirty scope
  uses day-touched wallet/token/strategy pairs plus episode interval overlap and yields 1,556
  episodes / 1,520 lots. All 1,556 episodes opened or closed that day are included; uncovered
  opened/closed episodes are zero.
- Root cause: compact materialization reprocessed virtually the whole historical ledger for every
  wallet with any daily trade, including unrelated tokens and old episodes. R38 removed no-op WAL
  rewrites but did not bound this read/compare cardinality, so production's one-vCPU PostgreSQL
  backend still reached the 600-second open-lots timeout.
- Next exact implementation: make the shared affected-episode CTE token-aware and interval-bounded;
  use it in dimensions, episode materialization, open-lot reconciliation/MERGE and episode/lot
  parity; make stale-episode reconciliation pair-aware so deleted facts remain removable. Add an
  integration negative control proving an unrelated same-wallet token is neither materialized nor
  counted. Do not change retention, receipt ordering, archive manifests or production.
- Acceptance before any new artifact: targeted unit/integration gates pass; the populated clone
  materializes one eligible full day under the existing 600-second statement/1,800-second run
  limits; source/fact digests match; repeat run causes no fact rewrite; dirty episode/lot counts are
  bounded near 1,556/1,520 rather than 191,922/210,827; permanent DB/WAL/temp/runtime and OOM are
  measured. Production remains R37 materializer stopped until these gates pass.

## Bounded dirty-scope implementation checkpoint at 2026-08-26 20:44 UTC

- `wallet-evidence-materializer.ts` now derives affected episodes from distinct daily
  chain/wallet/token/strategy pairs and requires the episode interval to overlap that day. The same
  materialized CTE drives token dimensions, episode MERGE, open-lot stale reconciliation/MERGE and
  episode/lot parity. Missing-episode cleanup is also token- and interval-bounded, so it can remove
  corrected current-day facts without deleting an unrelated historical same-wallet position.
- A PostgreSQL integration negative control adds an unrelated same-wallet token/episode/lot and
  proves neither compact fact is created or counted. Typecheck, full ESLint and targeted unit 6/6
  pass. The first Windows integration attempt was non-evidence because host `zstd` is absent; an
  immutable Linux candidate image then passed the full archive pipeline file 5/5 against a new
  localhost-only PostgreSQL 16 gate.
- Local candidate tag `walletscaner-worker:storage-r39-candidate-20260826` exists only off host. It
  has not been exported, transferred or selected. Production remains selector R37 with exact R37
  materializer stopped and ledger revision 24 failed.
- The populated clone has only one real wallet-evidence archive segment, 2026-08-24, so it cannot
  directly claim the production 2026-07-12 retry. Next local mutation is isolated: create a new
  `r39_canary` schema containing a structural copy of `archive_segments`, a synthetic July-12
  verified manifest whose counts are computed from immutable public sources, migration-051 compact
  tables, and copied existing compact facts. Connect through a temporary least-privilege
  `r39_materializer` role and `search_path=r39_canary,public`.
- Public clone sources, public compact tables/receipt, production, B2 and canonical retention must
  remain unchanged. After the bounded first and no-op repeat canaries, capture parity/counts,
  phase durations, WAL/temp/permanent size and fact timestamps, then drop only the named temporary
  role/schema and disposable PG16 integration container after recording evidence.

## Populated-clone shadow ready at 2026-08-26 20:48 UTC

- One transaction created `r39_canary`, a structural local copy of `archive_segments`, migration
  051 compact tables and exact copies of the existing compact dimensions/facts. It committed only
  after all copies and sequences succeeded: 11,589 wallets, 4,081 tokens, one strategy, 218,492
  episode facts, 251,460 open-lot facts and 27,498 followability facts.
- The isolated synthetic 2026-07-12 verified manifest derives its counts directly from public
  immutable sources: 17,669 wallet trades, 688 entries and 1,130 outcomes, total/canonical 19,487.
  The public clone still has exactly one unchanged compact receipt for 2026-08-24 and no synthetic
  public segment/receipt.
- Clone database size after the shadow copy is 12,670,442,519 bytes. Pre-canary cumulative counters
  are temp 11,822,036,928 bytes / 430 files and WAL 12,745,282,422 bytes; only deltas from these
  baselines are evidence.
- Next exact mutation is local-only: create `r39_materializer` with generated ephemeral credentials,
  public read plus `r39_canary` compact write/sequence grants, run the exact R39 candidate under
  80 MiB/0.05 CPU/64 pids, one day, 600-second statement and 1,800-second run limits, then drop the
  role. Capture report phase durations, receipt/parity/counts, fact rows updated since run start,
  DB/WAL/temp deltas and OOM/exit state before any repeat canary.

## R39 populated first canary passed at 2026-08-26 20:50 UTC

- Exact local candidate image manifest `sha256:9976fb847721...` ran with 80 MiB memory, 0.05 CPU,
  64 pids, one day, 600-second statement and 1,800-second run limits. Named container
  `walletscaner-r39-populated-canary-1` exited 0, OOM false, restart 0.
- The isolated 2026-07-12 shadow receipt verified in 12,100 ms versus the failed production R38
  run's 1,474,428 ms. It proved exact source/fact dual-digest parity for 1,556 episodes, 1,520 open
  lots and 700 mature followability rows. Main phase durations were dimensions 1,835 ms,
  reconcile-episodes 5,267 ms, episodes 224 ms, open-lots 1,776 ms and followability 285 ms; every
  parity query was below 170 ms.
- Because the copied Aug-24 global facts did not yet contain every July-12 entity, this first run
  legitimately inserted/updated 1,018 episode, 968 lot and 700 followability facts. Shadow totals
  became 219,510 / 252,428 / 28,198. Database size grew 2,736,128 bytes; WAL increased 20,838,999
  bytes; cumulative temp bytes/files did not change.
- The public clone receipt remained exactly the single 2026-08-24 row. The ephemeral role's direct
  drop was initially refused because its grants were dependencies; `DROP OWNED BY` revoked only
  those grants and the role then dropped. Role count is zero. The exited canary remains temporarily
  for recorded identity evidence.
- Next exact action: set only the shadow July-12 receipt to eligible `retry`, create a fresh
  ephemeral least-privilege role, capture a new baseline and run the same exact candidate/limits.
  Acceptance is verified parity with zero fact `updated_at` changes, no permanent DB growth, small
  bounded WAL/temp and exit 0/OOM false. Do not touch production.

## R39 populated no-op canary passed at 2026-08-26 20:52 UTC

- The same exact candidate/80-MiB/0.05-CPU/64-pid limits reran the eligible July-12 receipt after
  facts were complete. Named container `walletscaner-r39-populated-canary-2` exited 0, OOM false,
  restart 0 in 5,174 ms. Dimensions took 500 ms, reconcile-episodes 1,363 ms, episodes 146 ms,
  open-lots 717 ms, followability 96 ms and every parity query at most 163 ms.
- Episode/open-lot/followability source and fact dual digests matched exactly for 1,556 / 1,520 /
  700 rows. Fact rows with `updated_at` at or after run start were exactly 0 / 0 / 0. Cumulative
  temp files/bytes increased 0 / 0, WAL increased only 84,541 bytes and database size increased a
  bounded 16,384 bytes for the receipt/page write.
- Public clone receipt remained the single 2026-08-24 row. The second ephemeral role was revoked
  with `DROP OWNED` and dropped successfully; no `r39_materializer` role remains. Production was
  not contacted or changed during either local canary.
- The populated acceptance gates are now met: the original 210,827-lot production-shaped scan is
  bounded to 1,520 lots; first reconciliation is about 122x faster than the failed R38 run and the
  steady repeat is about 285x faster, without parity loss or fact rewrite churn.
- Next exact action is regression breadth, not deployment: run the full non-integration repository
  gate with zstd inside the exact candidate, the four PostgreSQL 16 integration files serially,
  local workspace builds, then inspect git/image identity. Keep shadow schema and named exited
  canaries until evidence is recorded; production remains R37 materializer stopped.

## R39 regression gates passed at 2026-08-26 20:56 UTC

- Exact Linux candidate passed the valid image-scoped storage/zstd gate 31/31 and the four serial
  PostgreSQL 16 integration files 47/47. Host repository compose/Python/deploy tests passed 23/23;
  full typecheck, ESLint and workspace Next.js build exit 0.
- An exploratory whole-suite run inside the worker image passed 386 tests and skipped the expected
  47 DB integrations, but its 13 failures are not code evidence: two require the intentionally
  excluded root Compose file and eleven spawn Python, which the production worker image does not
  contain. Those exact tests passed in their host repository environment above. This invalid
  cross-environment run is recorded, not normalized into a passing full-image gate.
- Candidate is Linux/amd64 image ID
  `sha256:9976fb84772180e6dde4dbda94243fe04ea4c41a619cb81337e257a9e68e7eba` with Node 24.18.0,
  zstd 1.5.7 and PostgreSQL client 16.14. Image/local hashes match exactly for the materializer
  (`a64b479b...`), its unit test (`3d308cc5...`) and archive integration test (`d6c6fc4...`).
- Git source checkpoint is `142d25e`; subsequent commits only record test evidence. Working tree
  contains only the four pre-existing ignored/untracked transfer remnants. Next exact local
  mutation is to add immutable tag `walletscaner-worker:storage-r39-20260826` to this exact image,
  verify unchanged image ID/runtime/hashes, then remove only named disposable test containers,
  role/schema and integration database after a final public-clone comparison.

## R39 local release cleanup completed at 2026-08-26 21:00 UTC

- Immutable local tag `walletscaner-worker:storage-r39-20260826` resolves to the exact tested
  Linux/amd64 image ID `sha256:9976fb84772180e6dde4dbda94243fe04ea4c41a619cb81337e257a9e68e7eba`;
  the candidate alias points to the same image.
- Before cleanup, public clone state exactly matched its baseline: one 2026-08-24 receipt and
  218,492 / 251,460 / 27,498 public episode/open-lot/followability facts. Only after this proof,
  transactionally dropped named schema `r39_canary`; public counts remained exact. Both named
  exited canaries and the `--rm` localhost PG16 gate were removed. Temporary role/schema counts are
  zero; populated clone `walletscaner-pg16-r31` remains running and intact.
- Next exact local operation is deterministic release packaging: export only exact R39 to a named
  uncompressed temporary tar, compress it through the network-disabled exact image with zstd
  level 3/single-thread/checksum under low CPU/memory, frame-test and SHA-256 the `.partial`, then
  atomically rename inside the repository `deploy` directory. Preserve the four pre-existing
  transfer remnants and delete only the named uncompressed R39 tar after verification.
- No production action is authorized by this packaging checkpoint. After artifact identity is
  recorded, refresh server ledger/backup/offsite, free disk/RAM/load, heavy jobs, flow freshness,
  coverage, receipts, selector/materializer and all Compose identities before opening an R39 phase.

## R39 release artifact ready at 2026-08-26 21:02 UTC

- Exact R39 exported to a 463,433,216-byte temporary Docker tar. A network-disabled exact-image
  container compressed it at zstd level 3/single-thread/checksum under 64 MiB/0.05 CPU and the
  frame test passed.
- Docker Desktop retained the bind-mounted `.partial` lock briefly after the compressor exited, so
  the first final rename failed closed. No compression was repeated: compressor container absence,
  source tar, final absence, partial bytes and SHA were rechecked, then only the rename was retried
  after the lock released.
- Final ignored release artifact
  `deploy/walletscaner-worker-storage-r39-20260826.tar.zst` is 462,870,167 bytes with SHA-256
  `9800833736f00c7f7355e87f17ba2e1b81cf015ce61fbafe047b8e464cb3b744`. The final hash matches the
  verified partial and the uncompressed tar is absent. The four pre-existing transfer remnants
  remain untouched.
- No server byte/image/selector/service/database/B2 state changed. Next exact action is a fresh
  read-only production preflight and flow resample. Do not open ledger R39 artifact staging unless
  revision 24 is still failed, selector/materializer rollback is exact, recovery evidence is
  current, no heavy job is active and staging plus temp margin remains above the 8-GiB reserve.

## R39 rollout held on silent trade-coverage gate at 2026-08-26 21:04 UTC

- The fresh production preflight kept the R39 artifact off host. Pool discovery, canonical inbox,
  finality and discovery coverage were current, but the bounded RPC trade lane had converged to
  zero configured/subscribed pool addresses. Swap and wallet-trade evidence therefore stopped
  advancing even though discovery and backlog telemetry looked healthy. This is a hard data-
  coverage gate, not an acceptable idle period and not permission to deploy the storage worker.
- Root cause is deterministic in the current source. RPC mode subscribes only after a pool has
  complete trade coverage, controlled market flow and known/passed token risk. The delayed first
  subscription requests historical backfill; a saturated/truncated bounded backfill correctly
  fails that pool closed forever. Pools that do not reach the downstream alpha/risk gate consume
  no observation slot, so the three-slot lane can legally reach zero and collect no wallet trades.
- Official Helius documentation currently gives the free plan one million monthly credits and
  standard LaserStream WebSocket methods, while `transactionSubscribe` requires a paid plan.
  Standard WebSocket traffic is metered at two credits per 0.1 MB and inactive sockets may close
  after ten minutes. The accepted design therefore keeps standard exact-pool subscriptions
  bounded; it does not move program-wide transaction traffic to Helius or purchase a provider.
- The required architecture change separates **observation admission** from **alpha admission**.
  A cheap, deterministic market pre-gate may occupy one of the existing three exact-pool trade
  slots before token-risk enrichment completes. Strict controlled-flow, known/passed risk and
  complete-from-boundary coverage remain mandatory downstream. Eviction, queue pressure or an
  unrepairable historical prefix must persist an explicit coverage gap; partial observation must
  never be labelled complete wallet profitability evidence.
- Acceptance before production: a pure bounded scheduler has deterministic priority, a hard slot
  cap, minimum hold/anti-thrash behavior and explicit eviction disposition; tests prove an
  eligible observation pool fills an empty lane without weakening alpha admission, and prove
  incomplete/evicted pools cannot reactivate as complete. Health must report zero active trade
  subscriptions as degraded whenever recent market-qualified pools exist. Then run targeted
  provider/worker tests and the repository gate, build a new immutable image (do not mutate R39),
  rehearse exact identity, and only then repeat the production backup/headroom/ledger preflight.
- Production remains unchanged: selector R37, exact R37 materializer stopped, live execution
  false, ledger revision 24 failed. Next exact action is read-only production cohort measurement
  for recent market-qualified pools, followed by the local pure scheduler/test implementation.

## Bounded trade-observation lane implemented at 2026-08-26 21:16 UTC

- Read-only production measurement found 52,935 Solana pool rows created in the last 24 hours;
  102 passed the exact configured-default cheap market gate and six passed it in the last hour.
  Seventy-nine of the 24-hour market cohort still had complete/unrecorded coverage and 23 were
  already excluded, while the live exact-pool lane remained empty. This proves starvation was
  orchestration, not absence of market candidates. The query changed no server state.
- New pure `trade-observation-scheduler` separates market observation from alpha admission. It
  fails closed for ineligible/incomplete pools and invalid capacity, fills available capacity,
  enforces the hard three-slot cap and five-minute hold, deterministically rotates only the oldest
  non-alpha-protected observation, and never evicts a controlled/risk-passed subscription for an
  exploratory pool. Invalid/unknown bounds fail closed rather than becoming unbounded.
- RPC pool sampling now admits a cheap-market candidate even while critical token risk remains
  unknown. Strict downstream `controlledFlow && tokenRiskKnown && tokenRiskPassed &&
  tradeCoverageComplete` is unchanged. A subscription is no longer dropped merely because a later
  market/risk sample is temporarily ineligible. Rug, active-window expiry and capacity rotation
  use a durable-before-unsubscribe transition; persistence failure restores the in-memory state
  and leaves the subscription intact for retry.
- Restart hydration no longer labels an RPC pool alpha-controlled before fresh risk reassessment.
  It may fill observation capacity from the latest stored market gate, requests bounded bootstrap
  backfill, and retains the existing truncation/queue fail-closed behavior. Health now distinguishes
  legitimate no-candidate idle state from eligible-lane starvation and subscription-ACK gaps.
- `.env.example`, architecture, provider and operations contracts document the new
  `RPC_TRADE_MINIMUM_OBSERVATION_HOLD_SECONDS=300` control and partial-coverage disposition.
  Typecheck and full ESLint pass; the scheduler/coverage/sampling/transport/provider target set
  passed 63/63 tests across five files.
- No production, artifact, database, B2, selector, service or ledger state changed. Next exact
  action is a coherent source commit, then the complete repository tests/build. If those pass,
  build a new immutable Linux image that includes both exact R39 compact-materializer bytes and
  this trade-lane fix; do not reuse or mutate the already hashed R39 artifact.

## Trade-lane source checkpoint and host gates at 2026-08-26 21:17 UTC

- Source/docs checkpoint `b56be24` contains the bounded trade observation lane. The four historical
  untracked transfer remnants are still the only unrelated working-tree artifacts and remain
  untouched. Exact R39 local image/tag remains
  `sha256:9976fb84772180e6dde4dbda94243fe04ea4c41a619cb81337e257a9e68e7eba`;
  populated PostgreSQL 16 clone `walletscaner-pg16-r31` remains running and intact.
- Host `npm test` produced 403 passed / 47 skipped and three failures only in
  `archive-artifact.test.ts`: Windows has no `zstd` executable (`spawn zstd ENOENT`). This is
  recorded as an invalid host environment for those three tests, not a passing full gate.
  Database suites were skipped without `TEST_DATABASE_URL`. The earlier targeted trade/provider
  set remains 63/63; typecheck and ESLint pass.
- `npm run build --workspaces --if-present` completed the Next.js production build successfully.
  Next exact action is to build a new local Linux/amd64 R40 candidate from `b56be24`, verify it
  contains the exact R39 materializer plus the new scheduler bytes, run the zstd-dependent tests
  inside that image and run the applicable PostgreSQL 16 integration suites serially. No export,
  server transfer or rollout is allowed until those gates and an isolated observation-lane canary
  pass.

## R40 candidate and first PostgreSQL 16 gate at 2026-08-26 22:55 UTC

- Local-only Linux/amd64 candidate `walletscaner-worker:storage-r40-candidate-20260826` resolves to
  image ID `sha256:c5af5a7f1b004a46c94e8866db2d3a96d9cd41d89694508042d73b95cc465f99`
  (463,403,065 bytes), with Node 24.18.0, zstd 1.5.7 and PostgreSQL client 16.14. Its embedded
  materializer SHA remains exact R39 `a64b479b...`; watch/scheduler/test hashes match local source.
- Inside the exact network-disabled candidate, the valid application/package suite passed 299/299;
  the 45 PostgreSQL integrations were intentionally skipped for the isolated database pass. This
  includes the three zstd artifact tests that Windows could not execute.
- A fresh disposable PostgreSQL 16 serial pass produced 44/45. PostgreSQL evidence passed 32/32
  and ingestion coverage passed 8/8. Four of five archive-pipeline cases passed; the wallet archive
  case hit only Vitest's fixed 5,000-ms test timeout at 5,016 ms, with no reported digest/parity or
  SQL failure. This is not normalized as pass. The named disposable container/network were removed
  and no credential was printed or retained.
- Next exact action is a new empty PostgreSQL 16 instance running only the archive-pipeline file.
  If it passes 5/5, record the first result as cumulative cold-start timing sensitivity; if it
  repeats, stop and diagnose the archive test/runtime regression before any canary or deployment.
  Production and the populated clone remain unchanged.

## R40 archive isolation passed; unsubscribe ordering hardening at 2026-08-26 22:57 UTC

- The archive-pipeline file passed 5/5 on a second fresh PostgreSQL 16 instance. The heavy wallet
  archive case completed in 4,793 ms; the file completed in 9,603 ms. The first 5,016-ms timeout is
  retained as cumulative cold-start/timing sensitivity, not a data or query regression. The second
  disposable database/network were removed.
- Pre-canary review found two remaining source/order mismatches. Cheap-market observation was still
  scheduled after awaited token-risk enrichment, and legacy queue-pressure/backfill handlers could
  unsubscribe before the coverage-gap update reached PostgreSQL. Next local implementation moves
  observation reconciliation ahead of risk I/O and routes queue pressure plus truncation through
  one in-flight-guarded durable-before-unsubscribe path. Persistence failure must retain the live
  subscription and restore the prior coverage state. Rebuild/retest the exact candidate afterward;
  do not reuse the current candidate identity as final release evidence.

## Durable-before-unsubscribe hardening implemented at 2026-08-26 23:00 UTC

- Cheap-market observation reconciliation now runs before awaited token-risk enrichment. Risk is
  still evaluated immediately afterward and remains mandatory for `controlledFlow`; no alpha,
  entry, score, signal or notification threshold changed.
- Capacity rotation, age expiry, rug, queue pressure and known-pool backfill truncation now share
  one guarded release function. It stages fail-closed coverage, keeps the occupied slot visible
  while PostgreSQL commits the gap, restores every prior field on persistence failure, and only
  then unsubscribes. Concurrent release requests for the same pool coalesce. Unknown-pool provider
  state still unsubscribes and throws because there is no canonical row that can record a gap.
- Release failures are explicit health diagnostics. Observation health also detects both missing
  ACKs and provider subscriptions that exceed in-memory active state; zero candidates/zero provider
  addresses remains legitimate idle state. Typecheck, ESLint and the five-file trade/provider set
  pass again at 63/63.
- No production or database mutation occurred. Next exact action is commit this hardening, rebuild
  the candidate to a new exact image identity and rerun Linux application plus serial PostgreSQL
  gates before any production preflight.

## Rebuilt R40 regression gates passed at 2026-08-26 23:02 UTC

- Rebuilt local Linux/amd64 candidate now resolves to exact image ID
  `sha256:011298f24f34d1a2eff6a47a79123ceaf515bd7b5abe9bf28f194147975469c2`
  (463,403,436 bytes). Embedded hashes match local source; the R39 materializer remains exact
  `a64b479b...`, watch is `1b70d735...`, scheduler `7c35433c...` and its test `e4e9e4e1...`.
- The rebuilt exact image passed 299/299 valid Linux application/package tests with 45 database
  integrations intentionally separated. Three fresh, serial PostgreSQL 16 gates then passed
  archive 5/5 (heavy case 4,655 ms), ingestion coverage 8/8 and PostgreSQL evidence 32/32. Every
  named disposable database and network was removed; the populated clone was not used or changed.
- Before final image/tag, move durable release orchestration into a directly testable coordinator.
  Its acceptance tests must prove persist-before-unsubscribe ordering, exact rollback on persist
  failure, same-pool in-flight coalescing and no unbounded state. After that small refactor, rerun
  type/lint/target tests and rebuild the final candidate; the current image is evidence but will not
  be the immutable release artifact.

## Trade coverage release coordinator passed at 2026-08-26 23:04 UTC

- `TradeCoverageReleaseCoordinator` now owns the bounded per-pool in-flight set, staged gap,
  persist-before-unsubscribe order, exact rollback and cleanup. Unit tests prove ordering, retain
  the subscription and restore every state field on database failure, and coalesce a concurrent
  same-pool release without a second persistence/unsubscribe. The main worker only supplies the
  repository persist and provider unsubscribe operations.
- Typecheck and full ESLint pass. The updated five-file trade/provider set passes 66/66. No runtime,
  database or provider state changed. Next exact action is a coherent source commit, final R40
  candidate rebuild and exact Linux/PG16 regression. Do not tag/export/deploy an earlier candidate.

## Final R40 local regression gates passed at 2026-08-26 23:11 UTC

- Coordinator source checkpoint is `b816481`. The final Linux/amd64 candidate
  `walletscaner-worker:storage-r40-candidate-20260826` resolves to image ID
  `sha256:909ee9932bb7aa394fe3e0897eb823cbc65a5cb3f3e1a5adea5f80d50b8ba474`
  (463,404,236 bytes). Its embedded materializer SHA remains exact R39 `a64b479b...`; watch,
  scheduler and release-coordinator bytes match the committed source.
- The exact network-isolated candidate passed all 302 valid application/package tests. The 45
  database integrations were intentionally separated. On three fresh PostgreSQL 16 instances,
  archive passed 5/5 (heavy wallet case 4,598 ms), ingestion coverage passed 8/8 and canonical
  PostgreSQL evidence passed 32/32. The interrupted terminal no longer existed after resume, so the
  last two uncertain results were rerun rather than inferred. Every named disposable database and
  network was removed after its gate.
- The post-refactor workspace production build passed. Typecheck, full ESLint and the 66/66 focused
  trade/provider tests were already green for this exact committed source. The four historical
  untracked transfer remnants and the populated R31 clone remain untouched.
- No production, provider, database, B2, selector, service or release-ledger state changed. Next
  exact local action is to tag only image ID `sha256:909ee993...` as immutable
  `walletscaner-worker:storage-r40-20260826`, verify the tag and embedded hashes, then create and
  frame-test a checksummed single-thread zstd release artifact under bounded resources. Do not
  stage or activate it until a fresh production backup/headroom/flow/rollback preflight passes.

## Immutable R40 tag verified at 2026-08-26 23:13 UTC

- `walletscaner-worker:storage-r40-20260826` now resolves to the exact tested Linux/amd64 image ID
  `sha256:909ee9932bb7aa394fe3e0897eb823cbc65a5cb3f3e1a5adea5f80d50b8ba474`; the candidate alias
  resolves to the same ID.
- Local and embedded SHA-256 values match exactly for the materializer (`a64b479b...`), Solana
  watcher (`e7772a68...`), scheduler (`7c35433c...`), release coordinator (`b1c57c02...`) and its
  tests (`5ea48ad6...`). No production state changed.
- Next exact action is to export this immutable tag to one named temporary tar, compress with zstd
  level 3/single-thread/checksum in a network-disabled bounded container, frame-test the partial,
  record its SHA-256 and atomically rename it. Preserve every older partial/remnant unchanged.

## R40 release artifact ready at 2026-08-26 23:16 UTC

- Exact R40 exported to a 463,437,312-byte temporary Docker tar. A network-disabled exact-image
  container compressed it with zstd level 3, one thread and frame checksum under 64 MiB/0.05 CPU;
  an independent `zstd -t` frame check passed.
- Final ignored artifact `deploy/walletscaner-worker-storage-r40-20260826.tar.zst` is 462,733,489
  bytes with SHA-256
  `71ecf11c435d0449db2e9107f88abc25c1a9ad93ce2283bfcc8d28d490de6f07`. The final bytes/hash
  match the verified `.partial`; the named temporary tar and R40 partial are absent. All four
  historical transfer remnants remain untouched.
- No production byte/image/selector/service/database/B2 or ledger state changed. Next exact action
  is a fresh read-only production preflight: reconcile ledger revision, backup/off-site evidence,
  free disk/RAM/swap/load, database/archive state, live-execution value, service identities,
  migrations, trade/discovery flow and heavy jobs. Do not stage the artifact unless all hard gates
  pass and transfer plus decompression preserves the 8-GiB host reserve.

## R40 production preflight passed at 2026-08-26 23:19 UTC

- Read-only resume/preflight reconciled actual server state with the human checkpoint and machine
  ledger. Ledger remains revision 24, `r38-materializer-activation=failed`, SHA-256
  `d8790ddb765601aabcda17446a0f33eb9d0c94da1d2402e85119d4eae5ac89a9`. Selectors remain exact
  ingestion R30 and operations R37; the R37 materializer is stopped exit 143/restart 0/OOM false.
  Every other Walletscaner container is restart 0/OOM false. Only the Walletscaner Compose project
  is listed; no protected co-tenant target was changed.
- Host `/` has 15,072,665,600 bytes free at 80% use, about 1.06 GB available RAM and 1.97 GB free
  swap. No dump, restore, archive writer/verifier or materializer job is active. Transfer plus
  stream-load plus the tested materializer exceeds the 8-GiB hard reserve with margin.
- Latest server recovery point `memecoin_alpha_20260826T173517Z.dump` is 1,936,729,703 bytes.
  Sidecar, server full SHA, off-site acknowledgement and local verified generation all match SHA
  `5bb6961e...`; an independent PostgreSQL 16 `pg_restore --list` passed. Multiple earlier verified
  local/off-host generations remain.
- Database is 17,656,724,503 bytes; migrations 050/051 checksums match local source, invalid indexes
  and transactions older than five minutes are zero. Inbox/dead letter are 0/0, pool age 5 seconds,
  open discovery incidents zero, and discovery remains live. Swap/wallet-trade age is 186 seconds
  and R30 reports zero configured/subscribed trade addresses: the known silent trade-lane hard gate
  remains present and is the exact R40 repair target.
- Archive state is fail-closed and progressing: chain payload 25 verified; wallet evidence 21
  verified / 11 pending / 0 dead-letter; compact shadow 6 verified / 3 retry. No canonical retirement
  or B2 deletion is part of this rollout. Live execution is false in every selected worker.
- Local/server Compose, release-checkpoint, guarded selector updater and migrations 050/051 hashes
  match exactly. Next exact mutation is revision-checked dry-run/apply of ledger phase
  `r40-artifact-staging=in_progress`, with rollback to absent R40 server paths, ingestion R30 and
  stopped materializer R37. Only then may the exact `.partial` transfer begin.

## R40 artifact staging ledger opened at 2026-08-26 23:20 UTC

- Revision 24 was dry-run checked and atomically advanced to revision 25,
  `r40-artifact-staging=in_progress`; ledger SHA-256 is
  `04e43cbf5ffd03e95b2e57e2efeec78051efa02fe9312e393812711080d863ab`. A trailing read-only
  formatting command failed because of shell quoting after the successful apply; independent
  ledger read-back confirms the exact phase, status and evidence. It was not reapplied.
- The ledger records exact artifact bytes/SHA, candidate image prefix, verified backup SHA,
  pre-staging disk and zero active trade subscriptions. Both intended R40 server paths remain
  absent. No image, selector, service, database or B2 state changed.
- Next exact action is resumable rate-limited transfer to
  `/opt/walletscaner/deploy/walletscaner-worker-storage-r40-20260826.tar.zst.partial`, followed by
  exact byte/SHA verification in a network-disabled bounded container and atomic rename. Loading
  remains a separate verified step.

## R40 server artifact checkpoint at 2026-08-26 23:28 UTC

- Initial `reput` correctly refused because no remote partial existed and created no byte. The first
  transfer then used rate-limited SFTP `put`; any future interruption can resume the resulting
  partial with `reput`.
- The remote partial reached exactly 462,733,489 bytes. A network-disabled R36 container with
  64-MiB/0.04-CPU/32-pid limits independently matched SHA-256
  `71ecf11c435d0449db2e9107f88abc25c1a9ad93ce2283bfcc8d28d490de6f07` and passed `zstd -t`.
  Only after those checks was it atomically renamed to
  `/opt/walletscaner/deploy/walletscaner-worker-storage-r40-20260826.tar.zst`; the partial is absent.
- Server free disk after staging is 14,581,055,488 bytes. Ledger remains revision 25 staging in
  progress. No image, selector, service, database or B2 object changed. Next exact step is a
  single-thread low-I/O/CPU zstd stream into `docker load`, then exact image ID/platform/hash
  verification against local `sha256:909ee993...`. Do not activate on any mismatch.

## R40 image-load checkpoint at 2026-08-26 23:30 UTC

- The verified zstd artifact was decompressed single-threaded under the R36 64-MiB/0.04-CPU,
  network-disabled boundary and streamed directly to low-I/O-priority `docker load`; no second
  uncompressed server artifact was created. The command exited 0.
- Server tag `walletscaner-worker:storage-r40-20260826` resolves exactly to Linux/amd64 image ID
  `sha256:909ee9932bb7aa394fe3e0897eb823cbc65a5cb3f3e1a5adea5f80d50b8ba474`, matching local.
  Embedded materializer/watch/scheduler/coordinator/test hashes also match local source exactly.
- Free disk is 14,607,872,000 bytes. Selectors remain ingestion R30/operations R37; ingestion ID
  `fec291346d30...` remains running and materializer ID `28e6a9099e69...` remains stopped R37.
  Live execution remains false. No service, database or B2 object changed.
- Image load briefly raised load1 to 3.33. Next exact read-only action is to wait for load and
  archive activity to settle, verify flow/resource reserve again, then close ledger revision 25 as
  staging completed. Do not open activation or mutate selectors while the load gate is elevated.

## R40 artifact staging completed at 2026-08-26 23:32 UTC

- The scheduled archive verifier completed naturally before activation: one object independently
  restored/verified in 57,234 ms, archive summary 47 verified / 10 pending / 0 retry / 0 dead-letter.
  No dump, restore, writer, verifier or materializer job remains active. Short `vmstat` samples kept
  50-61% CPU idle with no sustained I/O wait; free disk is 14,606,802,944 bytes.
- Ledger revision 25 was dry-run checked and closed atomically. Revision 26 is
  `r40-artifact-staging=completed`, SHA-256
  `5cda1db04eaae59d5e6858eb959cec6fc62c67e8cad6f87fc0aa4b32e624b545`.
- No selector/service/database/B2 state changed during staging. The next production phase is scoped
  ingestion activation only: open revision 27 before mutation, guarded-update only
  `WALLETSCANER_INGEST_IMAGE` R30 -> R40, render exact limits/live-false, recreate only
  `solana-ingestion`, then verify trade observation fills and remains bounded before touching the
  operations selector or materializer. Rollback is the inverse one-key update plus exact R30
  ingestion recreate.

## R40 ingestion activation opened at 2026-08-26 23:33 UTC

- Ledger revision 26 was dry-run checked and atomically advanced. Revision 27 is
  `r40-ingestion-activation=in_progress`, SHA-256
  `2a3edb54bec2a0183942b0e4bc4670ea354e9e6f612e40f4db3b99a8f6524c75`.
- Evidence records candidate R40, rollback R30 image/container, live false, zero active trade lane
  and disk reserve. No selector or service changed while opening the phase.
- Next exact mutation is the guarded updater dry-run/apply changing only
  `WALLETSCANER_INGEST_IMAGE` from `walletscaner-worker:pipeline-storage-r30-20260825` to
  `walletscaner-worker:storage-r40-20260826`. Then render and verify only ingestion before its
  no-dependency/no-build recreate. Operations/materializer remain R37/stopped.

## R40 ingestion selector checkpoint at 2026-08-26 23:34 UTC

- The guarded updater dry-ran and atomically changed exactly one key:
  `WALLETSCANER_INGEST_IMAGE` R30 -> exact R40. `.env.server` SHA-256 changed from
  `b1e6ce998c6217b99d16eb09d9d67afcb354cb264649703690a4f85b8246f9cd` to
  `c1e15170a71bd594f4f9d4d3e1c2e12e36e4d669ad475583cbea9b08502f1522`.
- Live execution remains false and operations remains exact R37. No container was recreated yet;
  ingestion ID `fec291346d30...` is still running exact R30. Rollback is the inverse guarded
  one-key update from exact R40 to R30.
- Next exact read-only action is secret-free Compose render/inspection for only ingestion: require
  exact R40 image, live false, existing CPU/memory/pid limits and bounded trade controls. If it
  passes, recreate only `solana-ingestion` with `--no-deps --no-build --force-recreate`.

## R40 ingestion service checkpoint at 2026-08-26 23:35 UTC

- Secret-free Compose rendering passed: exact R40, live false, RPC/standard-Helius hybrid, hard
  three-pool trade cap, six fetch attempts, 160 MiB, 0.2 CPU and 128 pids. The optional hold env is
  absent and therefore uses the tested/documented code default of 300 seconds.
- Only `solana-ingestion` was recreated with exact project/file/env plus
  `--no-deps --no-build --force-recreate`. New container `22664aab2618...` runs exact image ID
  `sha256:909ee9932bb7...`, restart 0/OOM false with the rendered resource/live controls.
- Operations remains R37 and materializer remains stopped. No migration, canonical row, B2 object
  or other service was changed. Next action is a minimum five-minute observation-lane canary:
  require 1-3 matching configured/subscribed/active pools when eligible candidates exist, fresh
  swaps/trades, zero drop/dead-letter/open-incident growth, bounded resources and all non-target
  container IDs unchanged. Roll back ingestion immediately on a hard gate.

## R40 ingestion canary in progress at 2026-08-26 23:43 UTC

- The lane passed its minimum 300-second hold and remained active. Successive exact R40 health
  samples moved active/configured/subscribed from `1/1/1` to `2/2/2`; ACK wait, dropped signatures,
  queue pressure and trade dead letters remain zero. One sample had 31/2,000 transient queued trade
  signatures, with fresh wallet trades at 20 seconds. Ingestion is restart 0/OOM false and stayed
  below its 160-MiB limit.
- Restart hydration correctly persisted three historical pool backfill truncations, then admitted a
  complete new observation instead of collapsing the lane to zero. The lane has produced roughly
  540-600 wallet trades per rolling five minutes. Strict alpha/risk admission remains unchanged;
  these counts prove collection, not alpha quality.
- Discovery live sockets have zero current slot lag/drops, but the scoped restart opened three
  fail-closed historical intervals. Durable repair is progressing: Pump/PumpSwap boundary collection
  reached 5,000 signatures and CPMM replay reached 450/638. Inbox/dead-letter remain bounded/zero.
  Operations/materializer activation stays blocked until open discovery incidents return to zero;
  do not restart or duplicate the ingestion canary.

## R40 ingestion canary hard gate failed at 2026-08-26 23:49 UTC

- The core collection repair worked: the exact-pool lane reached `3/3/3`, produced fresh wallet
  trades and kept drop/queue-pressure/dead-letter at zero. CPMM discovery repair also completed
  638/638 and closed one restart incident. This does not override the failed consistency gate.
- During each capacity rotation, successive health samples repeated
  active/configured/subscribed `2/3/3 -> 3/3/3 -> 2/3/3`, with reason
  `subscription-ack-gap`; the transient trade queue rose to 327/2,000. The provider cap remained
  three and no signature dropped, but recurring degraded state violates the exact lane-state
  acceptance criterion and would create noisy/ambiguous operational health.
- Source review identifies the race: `subscribePool` awaits bounded backfill before marking the pool
  active, while the provider address is configured and live during that await. Backfill can also
  call the durable exclusion path before the active state exists. The fix must make bootstrap state
  atomic and preserve fail-closed truncation/persist-failure behavior under tests.
- Ledger revision 27 remains activation in progress; selector/container are exact R40. Next exact
  mutation is the guarded inverse selector update R40 -> R30, render and recreate only ingestion,
  then verify exact R30/live-false/non-target identities and close revision 27 as failed. Do not
  touch operations/materializer or normalize this canary as passed.

## R40 ingestion rollback selector checkpoint at 2026-08-26 23:50 UTC

- Guarded updater dry-run/applied only `WALLETSCANER_INGEST_IMAGE` from exact R40 back to exact R30;
  `.env.server` returned byte-for-byte to SHA-256 `b1e6ce998c...`. Live false and operations R37
  remain unchanged.
- No container has been recreated yet; ingestion `22664aab2618...` still runs exact R40. Next exact
  action is secret-free R30 render followed by recreate of only `solana-ingestion` with
  `--no-deps --no-build --force-recreate`, then post-rollback identity/flow verification.

## R40 ingestion rollback service checkpoint at 2026-08-26 23:51 UTC

- Secret-free R30 rendering preserved live false and the exact 160-MiB/0.2-CPU/128-pid limits.
  Only `solana-ingestion` was recreated. New container `ee10d1074016...` runs exact R30 image ID
  `sha256:afd180aed4fb...`, restart 0/OOM false with those limits.
- No other service, selector, migration, database row or B2 object changed. Next read-only gate is
  the first R30 health/freshness sample plus every non-target container identity; then close ledger
  revision 27 as failed with R40 canary evidence. Local work must fix and test bootstrap atomicity
  before building a new immutable candidate.

## R40 ingestion rollback completed at 2026-08-26 23:53 UTC

- Post-rollback ingestion `ee10d1074016...` is exact R30, running restart 0/OOM false with live
  execution false. All 12 non-target Walletscaner container IDs match pre-canary exactly; operations
  remains R37 and materializer remains stopped. R30 trade lane returned to its known zero-address
  state. Restart repair temporarily raised the canonical working set to 160, with zero dead letter;
  no evidence was deleted.
- Ledger revision 27 was dry-run checked and closed as failed. Revision 28 is
  `r40-ingestion-activation=failed`, SHA-256
  `329c14e5ee00a5b56cb91d4cf9f597b861a47e98ffad2d2af4f2a78ff4ce0d69`. Free disk is
  14,515,924,992 bytes. R40 server artifact/image remain loaded but inactive as forensic evidence.
- Next exact action is local only: add a directly tested bootstrap coordinator/state transition so
  a provider-configured pool occupies the bounded lane during its awaited backfill, truncation
  still persists before unsubscribe, and failure restores or excludes deterministically. Run
  focused concurrency/backfill tests, type/lint, exact Linux and PostgreSQL gates, then build a new
  immutable R41; never reactivate R40.

## R41 local bootstrap-atomicity implementation opened at 2026-08-27 17:39 UTC

- Resume reconciliation confirmed commit `67b4c8e`, a clean tracked worktree and only the four
  preserved historical partial artifact remnants. The R40 rollback facts above remain current;
  production has not been mutated in this resumed phase.
- The exact failure path is now source-confirmed. `StandardSolanaEventSource.subscribeAddress`
  configures/sends the provider subscription before awaiting its bounded per-address backfill,
  whereas `watch-solana.subscribePool` marked `subscribedToBuys` only after that await. Provider
  configured/ACK counts could therefore be three while scheduler occupancy was two; the repeated
  `2/3/3 -> 3/3/3` rotations observed in R40 were real state races, not an alert threshold defect.
- The smallest intended fix is local only: reserve the scheduler slot synchronously before the
  awaited provider bootstrap, directly test that in-flight state, and retain the existing durable
  fail-closed truncation order. Provider bootstrap errors must also close/exclude the slot
  deterministically rather than leave a phantom subscription. No thresholds, alpha gates,
  migrations, production selectors or retention policy will change in this step.

## R41 bootstrap-atomicity implementation checkpoint at 2026-08-27 17:43 UTC

- `bootstrapTradeSubscription` now marks the bounded slot occupied before invoking the provider's
  async subscribe/backfill operation. Duplicate admission coalesces on that visible state. A
  truncation that durably excludes coverage during the await is not reactivated afterward.
- RPC provider bootstrap failure enters `releaseRpcTradeObservation` while the slot is still
  occupied. That preserves the existing `persist gap -> unsubscribe` ordering; if both provider
  bootstrap and durable release fail, both failures are retained in an `AggregateError` and the
  release coordinator keeps/restores the subscription instead of silently losing coverage.
- New concurrency/exclusion/failure tests pass. Focused provider/transport/scheduler/coverage gate
  is 67/67; root typecheck and lint pass; `git diff --check` passes. No production operation or
  schema change occurred. Next exact action is commit this coherent local fix, then run the full
  application and disposable PostgreSQL 16 gates before creating an immutable R41 artifact.

## R41 host gates and server preflight at 2026-08-27 17:52 UTC

- Source fix is committed as `5902ac0`. Host full tests produced 409 pass / 47 intentional DB
  skips and only the known three Windows `spawn zstd ENOENT` failures; the production workspace
  build passed. Focused Linux-independent tests, typecheck and lint remain green.
- Local Docker Desktop 4.85.0 cannot currently start because its own inference/secrets Unix-socket
  listeners fail on Windows. Model Runner was disabled using its documented setting and two stale
  zero-byte runtime sockets were reversibly renamed, not deleted; the defect recreates a fresh
  inaccessible socket. No Docker image, volume or populated PostgreSQL clone was reset/deleted.
- Read-only production preflight shows only the Walletscaner Compose project. Eleven intended
  services are running; operations/materializer remains stopped. Ingestion container
  `ee10d1074016...` is exact R30, restart 0/OOM false/live false. The complete sorted Walletscaner
  container inventory hashes to `1658ee2f574cf005d5b200344f418b11121f88ec98f8a8f0150af5b9b1feb574`.
- PostgreSQL is about 18.16 GB and disk free is 13,760,401,408 bytes. Current operational evidence
  reports about +0.80 GB/day database growth, +1.25 GB/day recent disk consumption and only 2.15
  days of conservative runway above the 8-GiB reserve. Dead letters are zero, discovery is live,
  wallet evidence archive is caught up through 24 August, but the stopped compact materializer has
  27 pending days and three mismatch rows. The latest server dump remains the verified/off-site
  acknowledged `memecoin_alpha_20260826T173517Z.dump`, 1,936,729,703 bytes, SHA-256 `5bb6961e...`.
- Because local Docker is unavailable and storage runway is now short, the next exact step is an
  isolated server test staging phase, not a production-service change. Record ledger revision 29,
  stage only a hash-verified `git archive` of commit `5902ac0`, and use the already verified R40
  Linux image as a read-only base with 0.1 CPU/bounded memory/network disabled. Do not recreate any
  Compose service or build a final image until those tests pass and load remains safe.

## R41 isolated server test staging opened at 2026-08-27 17:54 UTC

- A tracked-only `git archive` of exact source commit `5902ac0` was created outside the repository:
  855,531 bytes, SHA-256 `2019e3bc5c7081825503bba29f3f74bd49916dc7e4e09a3f53b3990e1a74e207`.
  It contains no untracked remnants, local credentials or production environment files.
- The production rollout ledger was dry-run checked from revision 28 and atomically advanced to
  revision 29, phase `r41-server-test-staging=in_progress`; read-back file SHA-256 is
  `643a0ea6c59836267c107291fd47dda0fb2a1ec3f4f09e0e82ea2526e8c6426c`. Rollback remains no Compose
  change: exact R30 ingestion, R37 materializer stopped.
- No artifact has been uploaded and no container has been started in this phase yet. Next exact
  action is upload to a new `.partial`, verify bytes/SHA, rename to the final staging name, extract
  under a new isolated directory, then run the networkless R40-base Linux test with 0.1 CPU.

## R41 focused Linux server gate at 2026-08-27 17:57 UTC

- The `.partial` upload was verified at exactly 855,531 bytes and SHA-256 `2019e3bc...` before an
  atomic rename. `git get-tar-commit-id` independently read exact commit
  `5902ac0c3cdbca48b01a2b0d26fe3c757cfef0a0` from the transferred archive. It was extracted only
  under `/opt/walletscaner/deploy/r41-source-5902ac0`; production source was not overlaid.
- An initial file-hash assertion incorrectly compared Windows CRLF worktree hashes to exported Git
  content and lacked fail-fast chaining; its apparent success is explicitly rejected. The exact
  archive SHA and embedded commit marker are the authoritative transfer checks. No service/image
  changed as a result.
- A networkless one-shot R40-base container with read-only mounts for the three changed R41 files,
  0.10 CPU, 256 MiB RAM and 128 PIDs passed provider/transport/scheduler/coverage 67/67. `--rm`
  removed it. Load1 rose transiently to 4.20 from throttled runnable work, so the full Linux gate
  must wait for load recovery rather than stack more work onto the one-CPU host.
- Next exact action is read-only load recovery sampling. Only after load1 is below 1.0, run the full
  networkless non-DB Linux suite under the same hard resource boundary, then open fresh isolated
  PostgreSQL gates one at a time; do not overlap tests or production maintenance.

## Local Docker repair checkpoint at 2026-08-27 18:02 UTC

- Production daily `pg_dump` is currently active; no further server test/build may overlap it.
- Docker Desktop's already downloaded in-place updater is version 4.88.1.237512, 180,802,992 bytes,
  and has a valid Docker Inc Authenticode signature. Installed version is the broken 4.85.0.235549.
- Next local action is the documented `update --quiet --accept-license` operation with Docker
  processes stopped. This is not uninstall/factory-reset and must preserve all images, volumes and
  the populated PostgreSQL clone. Afterward verify engine version plus the previously known image
  and clone identities before using it; if any data identity is absent, stop rather than recreate.

## Local Docker update did not apply at 2026-08-27 18:03 UTC

- The signed updater invoked the documented in-place update and exited `-5`; its own log confirms
  the inner installer did not apply. This Codex process is not elevated and the installed version
  remains exactly 4.85.0.235549. No uninstall, factory reset, WSL unregister, volume, image or clone
  mutation occurred. Docker Desktop processes are stopped.
- Do not retry blindly or request elevation inside this rollout. Resume the already ledgered server
  test path only after the daily production dump and host load finish/recover.

## R41 candidate build boundary at 2026-08-27 18:07 UTC

- Report-only project-scoped image retention identified 39 obsolete Walletscaner tags and Docker
  reports 2.111 GB reclaimable image bytes. Three verified prior transfer artifacts total about
  1.388 GB. Nothing was deleted. The 8.864-GB globally reclaimable BuildKit cache is explicitly
  out of scope and will not be pruned because ownership cannot be isolated from the protected
  co-tenant.
- Minimal overlay definition commit `d916169` copies only the three R41 files onto exact tested R40;
  its transferred Dockerfile is 784 bytes, SHA-256 `e4ae7693...`. R40 already passed the full
  Linux 302/302 and isolated PG16 45/45 gates, while the exact R41 delta passed Linux 67/67 and host
  full application code passed 409 tests apart from unchanged Windows-only zstd availability.
- A candidate-only overlay build is safe during the dump because it has no package install,
  compilation, network or large context; it must not recreate services or trigger cleanup. Final
  test/immutable tag/activation remain blocked until the dump completes and load recovers.

## R41 candidate image checkpoint at 2026-08-27 18:08 UTC

- The minimal networkless overlay build completed in 1.8 seconds with a 125.28-KB context; it did
  not install dependencies or fetch a base. Candidate
  `walletscaner-worker:storage-r41-candidate-20260827` is exact linux/amd64 image ID
  `sha256:229148f8616c695cf4b9da536c892c0ee59fe2f106ee2d852b6b763f5a39465c`, 463,434,958 bytes,
  release label `storage-r41-20260827` and source label exact `5902ac0c3cdb...`.
- A 0.02-CPU/networkless byte verifier confirmed the three R41 file SHA-256 values as
  `9c7e0239...`, `e7115001...`, `fab4d158...`; the storage materializer remains byte-identical to
  the fully PG16-tested R40/R39 implementation at `a64b479b...`.
- This is only a candidate. No immutable final tag, export, selector, service, database or cleanup
  changed. Daily `pg_dump` still gates final tests and activation.

## R41 full Linux gate resource decision at 2026-08-27 18:10 UTC

- The active dump produced only 618,157,933 bytes after about 33 minutes, so waiting for it before
  every CPU-only test would likely consume more than another hour of the short disk runway.
- Candidate probing confirmed both `/bin/nice` and `/bin/ionice`. It is therefore safe to run only
  the non-database full Linux suite concurrently with a single Vitest worker, 0.05 CPU, idle I/O,
  lowest process priority, network disabled, 512 MiB memory and 64 PIDs. PostgreSQL integration,
  image export, service activation and cleanup remain blocked on dump completion.

## R41 throttled full Linux gate result at 2026-08-27 18:28 UTC

- The one-shot `walletscaner-r41-full-linux-test` container finished with `exit=1`; it was removed
  by `--rm`. This is not recorded as a passed full gate. Most suites passed, including the exact
  R41 provider/transport/coverage path and Linux zstd archive tests, while PostgreSQL suites were
  intentionally skipped in this networkless phase.
- At the deliberately extreme 0.05-CPU ceiling, fixed-five-second performance cases and several
  subprocess-based deployment tests exceeded their time budgets. Two Compose/backup scheduler
  assertion files also failed and must not be classified as throttle artifacts without a direct
  rerun. No production service, selector, database row or B2 object changed.
- The daily dump remains active and reached 1,035,873,319 temporary bytes after about 52 minutes.
  Next exact action is a single networkless rerun of only the observed failed files at 0.20 CPU,
  512 MiB, 64 PIDs, one Vitest worker and idle I/O. This separates time-budget artifacts from real
  candidate drift while leaving PostgreSQL integration, export and activation blocked on the dump.

## R41 failed-file classification at 2026-08-27 18:31 UTC

- At 0.20 CPU the two real fixed-time application/research suites passed 24/24; their earlier
  failures were caused by the artificial 0.05-CPU ceiling, not an R41 regression.
- The two Compose/backup assertions initially proved the candidate intentionally lacks the root
  Compose file. With the exact commit-`5902ac0` Compose file mounted read-only, both passed 2/2.
  Two earlier harness attempts are rejected evidence: one lacked a writable Vitest cache and one
  overconstrained Vitest worker processes. Neither reached application assertions.
- The remaining 11 failures across seven deploy-tool test files all report child-process status
  `null`, because the Alpine worker runtime intentionally has no `python3`. The same files pass in
  the Windows host gate, but a Linux Python-enabled ephemeral harness will run them after the dump;
  they are not silently waived. The production runtime does not execute these host-side scripts.
- No service, selector, database row, B2 object or production file changed. Next exact action is to
  let the active dump finish, verify its checksum/custom-archive/off-site evidence, then run the
  seven Python-backed files in a disposable Linux harness before any PostgreSQL gate or activation.

## 27 August recovery generation checkpoint at 2026-08-27 19:15 UTC

- The bounded scheduler completed `memecoin_alpha_20260827T173517Z.dump` atomically at exactly
  2,030,534,774 bytes. PostgreSQL 16 `pg_restore --list` passed and the completed sidecar records
  SHA-256 `ae4ecfe40cc11318809032df35205a2b0194c456a56ed150eb1b94509ad7a587`.
- The hidden Windows off-site task ran successfully at 19:00 UTC, but the new server dump completed
  at 19:05 UTC. It therefore reconciled the prior 26-August generation instead of this one. The
  schedule/dump-duration race would leave the new generation unacknowledged and block the next
  server dump; do not call backup freshness operational until corrected.
- Current server free space is about 13.13 GB. The prior verified server generation remains intact.
  Next exact mutation is the reviewed `run-offsite-backup.ps1`: resumably pull only the newest dump,
  match its SHA-256, validate the byte-identical archive, atomically write the remote acknowledgement
  and then let the path-pinned reconciliation script retain the newest server generation while
  removing only the older already-verified server copy. On any failure, preserve both generations.

## 27 August off-site recovery gate completed at 2026-08-27 19:31 UTC

- The reviewed off-site wrapper completed successfully. Its first 20-Mbps SFTP connection closed
  after 1,778,227,200 bytes (87.6%); the bounded retry resumed the same `.partial` rather than
  restarting. The final local dump is exactly 2,030,534,774 bytes with SHA-256
  `ae4ecfe40cc11318809032df35205a2b0194c456a56ed150eb1b94509ad7a587` and PostgreSQL 16 archive-list
  verification `offsite-docker-postgres16`.
- Only after those checks, the script wrote the matching server `.offsite-verified` marker and the
  reviewed reconciliation retained the new generation while removing the superseded 26-August
  server dump. Older off-host generations remain local; no canonical database or B2 object changed.
- Server free space recovered to 14,855,958,528 bytes. No pg_dump/hash/SFTP/pg_restore process is
  active; the output that matches the backup scheduler shell is its sleeping container entrypoint,
  not a running dump. The schedule race remains a real automation defect and will be corrected
  after R41 activation/cleanup so future tasks do not routinely miss a dump that finishes after
  22:00 local time.
- Next exact action is wait for load1 below 1.0, then run the seven Python-backed deploy-tool files
  in an ephemeral network-detached R41 harness. PostgreSQL tests and activation remain separate,
  serial gates.

## R41 Linux deploy-tool gate completed at 2026-08-27 19:37 UTC

- An ephemeral R41 candidate container installed Python 3.14.7 under a 0.10-CPU/384-MiB/64-PID
  boundary. Before tests its Docker bridge was disconnected and the inspected network map was
  exactly empty. No package or layer was added to the candidate/release image.
- At 0.10 CPU, 18/19 Python-backed deploy-tool tests passed; the only failure was the first release
  checkpoint case exceeding Vitest's fixed five-second timeout after 8.4 seconds. The same file
  passed 3/3 at 0.20 CPU in the still-networkless container. Combined Linux result is 19/19.
- The exact ephemeral container was removed and its absence verified. No production service,
  selector, database or B2 state changed. This closes every non-PostgreSQL failure from the
  throttled full Linux suite: real application tests, Compose/backup assertions and deploy tools
  all pass in their required runtime harnesses.
- Next exact action is allow host load to recover, create one internal-only disposable PostgreSQL
  16 network/database, run `ingestion-coverage.integration.test.ts` against the R41 candidate,
  then remove both exact test resources. R40's storage/materializer bytes and prior 45/45 PG16
  evidence remain unchanged; this direct R41 gate targets the affected coverage boundary.

## R41 direct PostgreSQL 16 gate completed at 2026-08-27 19:45 UTC

- A fresh PostgreSQL 16 container ran on an internal-only Docker network with no host port, 0.10
  CPU, 256 MiB and 64 PIDs. The R41 candidate runner used 0.20 CPU/512 MiB/64 PIDs and no external
  network path.
- `packages/db/src/ingestion-coverage.integration.test.ts` applied the complete ordered migration
  set to its fresh schema and passed 8/8 in 24.34 seconds. This directly covers immutable incident
  lifecycle, oldest-first repair, exact coverage exclusion, Telegram suppression and final paper
  admission guards at the boundary affected by R41.
- The runner removed itself. The exact PostgreSQL container, its internal network and anonymous
  volume `d343c751...` were then removed and independently verified absent. Production PostgreSQL
  was never used by this test.
- R41 now has a complete change-proportional gate: host type/lint/build, focused 67/67, Linux full
  suite with every throttle/harness failure resolved, Linux deploy tools 19/19 and direct PG16 8/8.
  The byte-identical R40 storage/materializer implementation retains its earlier PG16 45/45 gate.
  Next exact mutation is close rollout revision 29 as completed, then open a separate immutable
  artifact phase before final tagging/export; no production selector changes in either transition.

## R41 immutable recovery artifact checkpoint at 2026-08-27 19:50 UTC

- Rollout test-staging was closed as completed at revision 30; revision 31 opened
  `r41-immutable-artifact=in_progress`. Both transitions were dry-run/read-back checked before any
  image mutation.
- Final tag `walletscaner-worker:storage-r41-20260827` resolves to the exact tested candidate image
  ID `sha256:229148f8616c695cf4b9da536c892c0ee59fe2f106ee2d852b6b763f5a39465c`, linux/amd64,
  463,434,958 bytes, with exact release/source labels. No layer was rebuilt.
- The server exported only that tag at low CPU/I/O priority. Its 463,110,427-byte zstd artifact
  passed `zstd -t` and has SHA-256
  `80feee488b214fdedae26d473520e3a023deb9bc3668ca1cdad79b744c4ad2ce`.
- A 20-Mbps transfer placed a byte-identical copy outside the repository at
  `~/WalletscanerBackups/_release-artifacts/walletscaner-worker-storage-r41-20260827.tar.zst`;
  local size and SHA-256 match exactly. Local Docker availability is not required for byte-level
  recovery storage. No production selector/service changed.
- Next exact action is close ledger revision 31 as completed, refresh the complete production
  preflight and only then open an ingestion-only R41 activation phase. Rollback remains the exact
  R30 tag/image/container path; operations R37 and the materializer remain unchanged/stopped.

## R41 ingestion activation opened at 2026-08-27 20:09 UTC

- The resume dashboard and fresh read-only preflight were committed as `bc68bb6`. The stale
  accidental read-only Cartesian query was terminated by exact PID and verified absent before this
  phase; no data changed.
- Local/server SHA-256 values match for both guarded release tools. The image updater dry-run proves
  a one-key transition from exact R30 to exact R41, with `.env.server` expected before/after SHA-256
  `b1e6ce998c...` / `b43baee037...`.
- Rollout ledger revision 33 is now `r41-ingestion-activation=in_progress`, read-back SHA-256
  `e8c871960944...`. Its rollback ref is exact R30 image/container plus stopped R37 materializer.
  A trailing CRLF in the remote here-document caused only the final human-readable Python print to
  exit nonzero after the ledger read-back had already printed revision 33; the atomic ledger apply
  and SHA verification completed successfully and must not be repeated.
- No selector or service has changed yet. Next exact mutation is guarded updater dry-run/apply for
  only `WALLETSCANER_INGEST_IMAGE`, followed by a secret-free Compose render. Only after the render
  proves R41, live false and unchanged resource limits may `solana-ingestion` be recreated with
  `--no-deps --no-build`.

## R41 ingestion selector checkpoint at 2026-08-27 20:11 UTC

- Guarded dry-run and apply changed only `WALLETSCANER_INGEST_IMAGE` from exact R30 to exact R41;
  `.env.server` read back at the expected SHA-256 `b43baee037ca...`.
- The first secret-free render probe used the wrong normalized-Compose field path (`deploy`) and
  failed after the selector apply. It changed nothing. A bounded key inspection showed the expected
  normalized top-level fields, and the corrected render proved image R41, live false, 0.20 CPU,
  167,772,160-byte memory, 128 PIDs and `unless-stopped` restart.
- The still-running ingestion container remains exact R30 ID `ee10d1074016...`; this proves no
  implicit dependency or service recreation occurred. Next exact mutation is recreate only
  `solana-ingestion` with exact project/file/env plus `--no-deps --no-build --force-recreate`, then
  verify its R41 identity/resources/live flag and every non-target container ID before canary time
  starts. Rollback is the guarded inverse selector update and R30-only recreate.

## R41 ingestion service checkpoint at 2026-08-27 20:13 UTC

- Exact Compose project/file/env plus `--no-deps --no-build --force-recreate` replaced only
  `solana-ingestion`. New container `696e4a4f6c61...` runs exact R41 image ID
  `sha256:229148f8616c...`, restart 0/OOM false, 0.20 CPU, 160 MiB, 128 PIDs and live false.
  The sorted non-target name/ID/image hash is exactly unchanged at `7391a3c65cd8...`.
- A final `docker compose ls --format json` observation received a CRLF-tainted format argument and
  exited nonzero after all target verification had completed; it made no state change and is not
  a failed recreate. The already captured project inventory remains the pre-state comparator.
- First health sample reports trade observation `ok/active` with
  active/configured/subscribed `1/1/1`, two admissions, zero queue and no replacement. The database
  recorded 203 wallet trades in the preceding five minutes, inbox unresolved/dead-letter is 28/0.
- Restart bootstrap opened three `backfill_truncated` discovery incidents about 46 seconds before
  the sample. Canary has not passed: all must close through the durable repair path inside the
  existing recovery gate, trade state must remain internally equal across later rotations and the
  minimum five-minute hold must complete. Any unresolved/recurrent hard-gate failure triggers the
  exact R30 rollback rather than being called degraded success.

## R41 ingestion canary failed and rolled back at 2026-08-27 20:18 UTC

- R41 fixed the targeted scheduler race in production: successive health samples were internally
  exact at `1/1/1`, then `2/2/2`; observation stayed `ok/active`, queue was at most three, the last
  five-minute sample contained 593 wallet trades and dead-letter stayed zero.
- The independent recovery gate failed. Three restart-bootstrap discovery incidents remained open
  at 324 seconds. Durable repairs were progressing (up to 4,000 collected signatures; one entered
  replay) but did not close inside the contractual five-minute limit. This is a real recovery-
  throughput defect, not permission to call R41 operational.
- Guarded dry-run/apply restored only the ingestion selector to exact R30 and returned `.env.server`
  byte-for-byte to SHA-256 `b1e6ce998c...`. Only ingestion was recreated; container
  `d4e2eb0b2b8b...` runs image `sha256:afd180aed4fb...`, restart 0/OOM false, 0.20 CPU, 160 MiB,
  128 PIDs and live false. The non-target name/ID/image hash remains exact `7391a3c65cd8...`.
- The final non-target verification command inherited a harmless CR byte after printing its exact
  hash; a separate read-only rerun printed the same exact hash and target identity. Rollout ledger
  revision 34 closes `r41-ingestion-activation=failed`, SHA-256 `0fc683541153...`.
- No canonical evidence, B2 object, migration, materializer or other service changed. Next exact
  work is source/config diagnosis of durable repair throughput and restart admission. Do not
  reactivate R41 or the materializer until a change-proportional fix proves every supported-program
  restart gap closes inside five minutes under the shared-host resource ceiling.

## R42 bounded public-RPC repair decision at 2026-08-27 20:27 UTC

- Live R30 evidence separates transport from historical repair. Exact discovery subscriptions are
  ACKed, live queues are 0–3, unresolved transaction counts are zero and current cursors for the two
  busiest programs are 2–25 seconds old. Their raw WebSocket streams prefiltered about 149,000 and
  325,000 non-matching messages while admitting only 185 and 10 exact live events in the sample.
- `getSignaturesForAddress` cannot apply that instruction-log predicate. The durable repair must
  therefore inspect all program signatures. Current policy collects 500 per 30-second cycle up to
  20,000, then replays only 50 per cycle. The observed 3,668-signature CPMM repair alone needs over
  36 minutes at the configured replay schedule; 20,000 could take hours. This is mathematically
  incompatible with the five-minute recovery SLO and consumes PostgreSQL/RPC budget without a
  credible chance of restoring high-volume public-RPC coverage.
- R42 will make the existing conservative lower bound the public-RPC default: 500 total repair
  signatures. More importantly, a persisted collecting **or replaying** repair already above the
  active cap must become terminal immediately on resume instead of bypassing a lowered bound. The
  supervisor already requires two independent healthy current-transport samples before closing
  such an incident as `alpha_excluded_unreconciled`; it must not create reconciliation proof.
- Acceptance is deliberately split. Observe-only collection may be operational when the current
  transport is fresh, trade subscription counts are internally equal, no incident remains open and
  every unrepairable interval is durably alpha-excluded. Full alpha validation still fails until an
  instruction-filtered historical/archive source proves those intervals; R42 must not relabel this
  as 99% coverage or enable paper/live delivery.
- Next exact local action: add the persisted-over-cap fail-closed guard and regression test, change
  the default/example/operations contract from 20,000 to 500, run focused and repository gates,
  then build a minimal immutable R42 overlay on exact R41. No production selector, environment,
  service, database or B2 state changes in the implementation phase.
