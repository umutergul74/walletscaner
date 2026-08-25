---
status: active
updated_at_utc: 2026-08-25T21:02:00Z
owner: codex
task: make Walletscaner PostgreSQL/B2 storage tiering autonomous and sustainable on the fixed disk
last_safe_checkpoint: compact shadow committed as 0f12784 with exact image/tests; production unchanged
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
