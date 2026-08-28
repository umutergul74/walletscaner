---
status: active
updated_at_utc: 2026-08-28T22:29:00Z
owner: codex
task: diagnose and repair recurrent Solana discovery disconnects and alpha-queue failures without losing the pending storage-retirement and 24-hour equilibrium gates
last_safe_checkpoint: local reconnect/backfill-coalescing and ledger natural-key fixes pass targeted, PostgreSQL 16, typecheck, lint and build gates; production has not changed and the immutable Linux artifact/preflight/ledger gates remain next
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

## Rollback and next exact action

- Rollback/recovery evidence is the independently verified local 28-August dump plus the same newest
  acknowledged server generation; R42/R36 service topology is unchanged.
- Next exact action: run typecheck, lint and the full applicable unit gate; then checkpoint and
  build an immutable Linux artifact. Do not deploy until the backup/headroom and revision-checked
  production-ledger gates pass. Independently, after the
  first normal maintenance cycle following 2026-08-29 00:00 UTC, verify the 26-August partition
  retirement and disk gain; do not manually drop it or rerun backup reconciliation.
