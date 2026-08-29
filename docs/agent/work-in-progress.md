---
status: active
updated_at_utc: 2026-08-29T06:06:00Z
owner: codex
task: bound the exact-pool trade observation latency incident without weakening ordered admission, increasing shared-host resources, consuming unbounded Helius credits, or losing the pending storage-equilibrium gate
last_safe_checkpoint: R44 source 1252b2b and immutable Linux image 44e6beae implement a trade-only 15000ms queue-age breaker; targeted 51/51, typecheck/lint/build and validation-Linux 416/416 passed, with database integration unchanged from R43; next action is production preflight and a revision-ledgered ingestion-only canary, not an unrecorded deploy
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
