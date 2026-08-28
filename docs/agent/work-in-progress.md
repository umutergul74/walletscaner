---
status: waiting
updated_at_utc: 2026-08-28T21:53:00Z
owner: codex
task: close the current off-site backup gap, preserve the 48-hour raw-payload safety window, and determine the smallest safe capacity fix before storage reserve is threatened
last_safe_checkpoint: ledger revision 49 completed the off-site backup reconciliation; the newest dump is independently verified, the old acknowledged server generation was removed by the reviewed guard, all 12 services remain running, and the next destructive-eligibility boundary is 2026-08-29 00:00 UTC
---

# Walletscaner Work In Progress

This is the durable resume point for the current storage incident. It contains no credentials and
does not grant authority beyond the user's current request. On resume, compare this record with Git,
the production ledger, backup files, archive manifests, containers and database state before
repeating any step.

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

## Rollback and next exact action

- Rollback/recovery evidence is the independently verified local 28-August dump plus the same newest
  acknowledged server generation; R42/R36 service topology is unchanged.
- Next exact action is read-only: after the first normal maintenance cycle following
  2026-08-29 00:00 UTC, verify the 26-August partition retirement, disk gain, held/unresolved counts,
  service identities, queues and archive parity. Then measure a clean 24-hour post-catch-up storage
  slope. Do not manually drop the partition or rerun the backup reconciliation.
