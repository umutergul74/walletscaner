---
status: active
updated_at_utc: 2026-08-28T21:35:00Z
owner: codex
task: close the current off-site backup gap, preserve the 48-hour raw-payload safety window, and determine the smallest safe capacity fix before storage reserve is threatened
last_safe_checkpoint: read-only preflight complete; no production mutation has occurred in this task
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
- Let the already recovered R42 compact materializer finish its remaining four verified wallet days;
  do not raise CPU/RAM or bypass parity.
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
- Production ledger revision 45 remains `r42-storage-shadow-observation=in_progress`; no current
  phase has yet been opened for this task.

## Phases and acceptance gates

1. **Off-site recovery generation**: open a revision-checked ledger phase, run the reviewed bounded
   pull wrapper, require exact SHA-256 and PostgreSQL 16 archive-list success, atomically upload the
   acknowledgement, then verify the newest server dump remains and only the older acknowledged
   server generation is removed. Recheck disk, containers and flow.
2. **Current autonomous work**: confirm all remaining compact days reach verified with zero
   mismatch/retry and without reserve breach. Do not confuse shadow facts with source retirement.
3. **Payload capacity diagnosis/fix**: use observed query plans/rates and a populated PostgreSQL 16
   rehearsal. Any code/schema change must keep one connection, bounded statements and deletion
   capacity above measured ingress. Deploy only as a new immutable artifact with rollback.
4. **Raw partition gate**: after 2026-08-29 00:00 UTC, allow only the existing manifest/Object Lock/
   policy guarded maintenance path to retire the 26-August partition. Verify exact filesystem gain
   and no held/unresolved loss.
5. **Validation**: require a clean post-catch-up 24-hour slope above the 8 GiB reserve before calling
   storage operationally sustainable. Canonical wallet retirement remains a separate future gate.

## Rollback and next exact action

- No production mutation has occurred, so the current rollback is the unchanged R42/R36 topology
  plus both server dump generations.
- Next exact action: create ledger revision 46 as planned for the off-site backup reconciliation,
  then invoke `scripts/backup/run-offsite-backup.ps1`. If checksum/archive-list/acknowledgement or
  reconciliation fails, stop; keep both server generations and record the failure rather than
  deleting anything manually.
