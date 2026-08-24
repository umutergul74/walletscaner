# Pipeline Stability R5 Resume Checkpoint

Last updated: 2026-08-22T18:43:15Z
Status: R6/R7 ACTIVE; SCOPED CANARY PASSED; 24-HOUR TREND REMAINS OPEN

## Safety boundary

- Work is limited to the `walletscaner` project and explicitly targeted Walletscaner services.
- `ENABLE_LIVE_EXECUTION=false` must remain enforced.
- No PostgreSQL row/table/volume deletion, host-wide prune, reboot, shared-network change or
  co-tenant mutation is authorized by this rollout.
- The protected Robinhoodscaner and scalp2 projects are out of scope.
- Every production mutation requires a fresh pre-state snapshot, a verified off-host PostgreSQL
  generation, the full local release gate and a scoped post-state/canary check.

## Verified resume state

- Local branch: `main`; the working tree contains the accumulated Walletscaner changes and has no
  clean baseline commit. It must not be reset or broadly reformatted.
- Production host is reachable through SSH port 22.
- Host snapshot at `2026-08-21T07:37:32Z`: root filesystem 68G total, 39G used, 29G available
  (58%); 1,025 MiB memory available; 120 MiB of 2,047 MiB swap used.
- Pre-R5 rollback boundary captured before mutation:
  - `solana-ingestion`: `pipeline-stability-r3-20260820`
  - `wallet-alpha` and `data-maintenance`: `pipeline-stability-r4-20260820`
  - `telegram-notifier`: `pipeline-stability-r2-20260820`
  - other approved observe-only services remain on their previously verified images.
- Current target-service release boundary (supersedes the pre-R5 target rows above):
  - `solana-ingestion`: container
    `c9ead3cd772c1fe3b30e3f5444b8b6a2d23501a3ea5d2b4ef0e8f69115daa58d`, exact R5 image
    `sha256:0516c2b11e4b9adda66b1af59aebf935e5d420cc639e39fb2648d331ef9af0b0`;
  - `telegram-notifier`: container
    `23ac39b4868d05046cba177e1d7a0b29835c2e519f80fc6913e79478016581b8`, same exact R5 image;
  - `paper-alert`: container
    `3259da86ae53cea8efaadc732aa6522321b4b03912f850c35629932ab2ac6877`, same exact R5 image;
  - `.env.server` exact current SHA-256 is
    `c2ead1cfc3fc3df034f5eecd693a2a815c7b6ebbf593ba0de05d6f4998dcc6c2`; server Compose exact
    post-CPU-fix SHA-256 is
    `bb1a4ff1feb0e2e90a892cf08ea80b71eb2175922b7d38e80ff15072f00999f1`.
- The interrupted pre-R5 dump finished on the host:
  `memecoin_alpha_20260820T214946Z.dump` = 1,001,754,781 bytes. Its local and server SHA-256 are
  exactly `474d1cc34e472fcbd36ddc71fb5c8c95038d864bf36c7af84f27ea00ffd1660e`.
  The resumable pull completed at `2026-08-21T08:28:16Z`; the manifest records
  `archiveListVerified=true` using offsite Docker PostgreSQL 16, a second independent local
  `postgres:16 pg_restore --list` invocation exited zero, and the read-back server acknowledgement
  contains the same SHA and timestamp. This is now the release backup gate.
- The prior acknowledged server generation
  `memecoin_alpha_20260820T150923Z.dump` = 1,109,508,628 bytes remains present.
- No production service, database object, backup or image was changed during resume inventory.
- The current R5 unit boundary is green: discovery supervisor, Standard/Helius event-source and
  Telegram-store coverage tests passed `3 files / 45 tests`; repository-wide TypeScript typecheck
  also passed. This is a local source boundary only, not permission or evidence of deployment.
- The expanded source/database static boundary is green: TypeScript passed and the focused R5 run
  passed `5 files / 57 tests`; the new PostgreSQL integration file registered four additional tests
  but correctly skipped because `TEST_DATABASE_URL` is not yet available locally. No PG claim is
  made until those four cases run on PostgreSQL 16.
- R5 now keeps per-program live admission ordered, retries a fetched event in memory while durable
  admission is closed, fences obsolete Standard and Helius sockets, tracks truncation per address,
  rejects JSON-RPC probe errors, distinguishes same-slot signatures, stores cursor chain time, and
  records an isolated initial source-start failure as a durable fail-closed incident.
- Strict Telegram claim/suppression and paper admission use canonical exact-pool provenance; more
  than 20 tainted rows cannot leak past the bounded cleanup batch, malformed/legacy provenance is
  fail-closed, and a per-program PostgreSQL advisory transaction lock closes the known-incident to
  paper-open race. The PostgreSQL 16 evidence for these claims is recorded below.
- That pending database gate is now complete. A resource-bounded local PostgreSQL 16 container
  passed the four R5 concurrency/lifecycle/admission cases, then the combined existing evidence,
  cold-archive and R5 coverage run passed `3 files / 26 tests`. The first archive attempt failed
  only because Windows lacked the `zstd` executable; the rerun passed with the official Zstandard
  v1.5.7 Windows binary. Its release ZIP SHA-256 is
  `acb4e8111511749dc7a3ebedca9b04190e37a17afeb73f55d4425dbf0b90fad9`.
- Repository-wide ESLint passed after the R5 changes. The disposable local PostgreSQL container is
  `walletscaner-r5-pg16` on loopback port 55438 and must be stopped after the full release gate.
- The normal `walletscaner-postgres-backup-1` scheduler remains active. After the new dump gate was
  independently proved, duplicate one-shot container `603bb0f0f397`
  (`walletscaner-postgres-backup-pre-r5`) was observed sleeping, stopped cleanly and removed without
  `-v`; no dump, sidecar, acknowledgement, bind path or volume was removed.
- A read-only production cursor inventory found all four configured discovery cursors. Pump.fun,
  CPMM and PumpSwap matched exact retained `(chain, slot, signature)` inbox metadata at slots
  440650212, 440641537 and 440648403. LaunchLab slot 440574495 was a deliberately non-persisted
  filtered cursor; exact public Solana `getBlockTime` returned `2026-08-21T00:12:04Z`. The current
  rollout therefore has no cursorless-bootstrap case, but cursor-time verification remains a
  mandatory fail-closed deployment gate.
- Post-review R5 tests now include a populated PostgreSQL 16 upgrade. Migrations 001-037 are applied,
  exact and near-match inbox evidence plus two legacy cursors are inserted, then migration 038 proves
  exact `(chain, slot, signature)` backfill while missing metadata remains NULL and fails preflight.
- The final dependency/source gate passed: the earlier `npm ci` installed 434 packages with zero
  reported vulnerabilities; TypeScript, repository-wide ESLint, `git diff --check`, the production
  Next.js build and the complete PostgreSQL 16 plus zstd suite passed. The final suite result is
  `57 files / 305 tests`. A first run against a newly created 0.5-CPU disposable database hit only
  two parallel 10-second migration-hook timeouts; the unchanged suite passed after giving that local
  test database two CPUs/512 MiB. No production resource limit was changed. The disposable database
  was then stopped and auto-removed without a volume.
- Migration 038 is 7,702 bytes with final SHA-256
  `a253c15e242370c6c8186bf0fe2a255d20070839a43b6f9c7c9998db9ea09725`.
- `scripts/deploy/update-release-image-env.py` is the only approved R5 image-key updater. It is
  dry-run by default, accepts only the ingestion/signal image keys, requires their exact prior values,
  writes through an fsynced same-directory temporary file and atomically replaces/read-backs the
  result. Its normal, stale-prestate and forbidden-key paths passed two tests. The host companion is
  5,304 bytes with SHA-256
  `fb26b3794f84862120d4c742bf050e565c9a1ddb23be0d61e3b3f6d62cad8dcf`; it must be uploaded through a
  `.partial` path and hash-verified because loading the worker image cannot update host-side scripts.
- Local immutable image `walletscaner-worker:pipeline-stability-r5-20260821` built successfully from
  `docker/worker.Dockerfile`. Its exact image ID is
  `sha256:0516c2b11e4b9adda66b1af59aebf935e5d420cc639e39fb2648d331ef9af0b0`, config label is
  `pipeline-stability-r5-20260821`, architecture is amd64 and reported image size is 463,262,527
  bytes. An isolated smoke check found Node 24.18.0, npm 11.16.0, both deployment helpers and the
  exact migration-038 SHA above inside the image.
- The raw Docker artifact is
  `C:\Users\Umut\AppData\Local\walletscaner-artifacts\pipeline-stability-r5-20260821\walletscaner-worker-pipeline-stability-r5-20260821.tar`:
  463,295,488 bytes, SHA-256
  `633e19389d719e87f3de9bed4f21421cdedf1f6e218f0a89bf382f8a10bbc368`. An independently tested zstd
  copy exists but saved less than 0.2%; use the raw tar for the simpler exact `docker load` path.
- Fresh read-only production pre-state at `2026-08-21T09:12:27Z` passed the release boundary:
  - root disk is 58% used with 31,026,802,688 bytes available; memory available is 1,064,509,440
    bytes and swap usage is 139,255,808 bytes;
  - PostgreSQL is healthy at 12,014,238,743 bytes; latest migration is 037 with checksum
    `c9e2c78d...f6889dc`; inbox has 132,904 processed rows and no other status; 20 archive manifests
    are verified with zero pending/dead-letter state;
  - every running Walletscaner container is non-OOM. Ingestion remains exact R3 image
    `sha256:c15823fd...62c1c` with restart baseline one; Telegram remains exact R2
    `sha256:56519115...c5ab`; paper remains exact R1 `sha256:95339a5a...8f0e`; normal backup is running;
  - env keys are ingest R3, signal R2, research/operations R4, v3 paper, archive enabled/non-dry-run,
    retirement enabled and `ENABLE_LIVE_EXECUTION=false`;
  - newest backup dump/sidecar/read-back acknowledgement are still present with the exact recorded
    1,001,754,781-byte generation;
  - Docker has no non-Walletscaner container. `scalp2.service` is masked/failed with no matching
    process, and no Robinhoodscaner service/process/container is present. This state is observation
    only and must remain untouched;
  - current ingestion has zero discovery drop/pressure/unresolved state and 11,778/11,778 decoded
    candidates with zero unmatched; the monitor's only degraded reason is no wallet trade for about
    25 minutes while pool freshness, archive, backlog, compaction and disk health remain normal.
- The image tar was uploaded over SSH 22 to a `.partial` path. The completed server partial matched
  463,295,488 bytes and SHA-256 `633e1938...c368`; only then was it atomically renamed to
  `/opt/walletscaner/deploy/pipeline-stability-r5-20260821/walletscaner-worker-pipeline-stability-r5-20260821.tar`.
  The final path was read back with the same bytes and SHA. The updater companion was separately
  uploaded as `.partial`, matched 5,304 bytes and SHA `fb26b379...d8dcf`, atomically renamed to
  `/opt/walletscaner/scripts/deploy/update-release-image-env.py`, set mode 0750 and passed host
  Python 3 bytecode compilation. No service/database/image state changed during upload.
- `docker load` consumed only the exact verified tar. The server tag resolves to the required image
  ID `sha256:0516c2b11e4b9adda66b1af59aebf935e5d420cc639e39fb2648d331ef9af0b0`, size 463,262,527
  bytes, amd64 and label `pipeline-stability-r5-20260821`; an isolated container read migration SHA
  `a253c15e...09725`. Disk after load is 60% used with 29,144,399,872 bytes available. No long-lived
  container was recreated and migration remains 037.
- The second pre-mutation check re-proved exact ingestion/Telegram/paper container IDs, migration
  037, backup triplet sizes, image env keys and live-execution false with 29,144,207,360 bytes free.
  Only Telegram R2 and paper R1 were then stopped through scoped Compose. Both exited code zero with
  restart zero/OOM false; ingestion R3, wallet-alpha R4, maintenance R4 and PostgreSQL retained their
  exact container identities and running states. Durable outboxes were not changed.
- Migration 038 applied once through the exact R5 ingestion image and the temporary Compose container
  was removed. `schema_migrations` records exact checksum `a253c15e...09725`; the cursor column,
  append-only incident table, three indexes, one-open unique partial index and immutable-history
  trigger are present; invalid index count is zero and incident count is zero. Migration backfilled
  chain time for 149 of 7,411 all-source cursor rows. The remaining global NULL rows are expected
  legacy/non-discovery cursors; the next fail-closed gate is specifically all four configured pool
  program cursors.
- The explicit Compose `run -e CURSOR_CHAIN_TIME_APPLY=false` dry-run found exactly one unresolved
  configured cursor: LaunchLab slot 440574495 at `2026-08-21T00:12:04Z`, matching the independent
  preflight. The explicit true run repaired exactly one guarded row and then reported
  `status=verified`, `configuredProgramCount=4`, `unresolvedCount=0`, `repairedCount=1`, `rounds=2`.
  Both one-shot containers were removed. Old ingestion R3 continued during this initial phase, so a
  final apply/read-only verification is still mandatory after stopping it.
- Exact old ingestion container `91dc61bd...348e` on R3 image `sha256:c15823fd...62c1c` was stopped
  through scoped Compose. It exited code zero, OOM false and retained restart baseline one. Checked
  wallet-alpha, maintenance and PostgreSQL container IDs remained unchanged and running; both signal
  services remain intentionally stopped.
- With ingestion stopped, the explicit R5 apply one-shot reported four configured cursors,
  `unresolvedCount=0`, `repairedCount=0`, then the explicit false one-shot independently reported the
  same verified boundary. Both temporary containers were removed. No cursor can now move before R5
  startup.
- Retained metadata independently re-proved the known Pump interval: slot 440548309 at
  `2026-08-20T21:10:45Z` through next retained slot 440551012 at `2026-08-20T21:29:31Z`, exactly
  1,126 seconds. The idempotent, advisory-locked, insert-only companion
  `scripts/deploy/seed-r5-historical-pump-gap.sql` passed two static mutation-contract tests plus
  typecheck/ESLint/diff check. It is 5,625 bytes with SHA-256
  `e5f99b272287c07a8a53e4921e3819290175bb84eebcd7316d69579e20a81d54`; upload/hash it separately
  because it was created after the immutable runtime image and must not trigger an image rebuild.
- The Pump SQL companion was uploaded through `.partial`, matched exact bytes/SHA and was atomically
  finalized before execution. First execution reported two canonical pools, zero qualified messages
  and zero paper trades in the interval, inserted one exact closed incident and verified
  `historicalReconstructionProven=false`. Immediate replay reported `INSERT 0 0` and verified the same
  exact row. It modified or deleted no pre-existing row; ingestion and both signal services remained
  stopped.
- The hash-verified updater dry-run read env SHA `9c7e4453...f09ae` and predicted SHA
  `0f1a88c9...31e3`, listing exactly ingest R3→R5 and signal R2→R5. The exact apply produced the same
  two-key list and predicted hash; server `sha256sum` and key read-back matched. Live execution is
  still false, paper strategy is exact v3, and all three target services remained stopped.
- Telegram alone was recreated as container `23ac39b4...581b8` on exact R5 image
  `sha256:0516...f0b0`. It runs with live false, 40 MB Node heap, restart zero and OOM false. Its first
  logged cycle completed in 9,298 ms, enqueued the two expected historical incident transition audit
  messages and delivered one under the intentional one-message claim limit; the next poll drained
  the other. The durable outbox now has only delivered qualified-pool/paper/status rows and no
  pending/retry/dead-letter. Observed RSS settled at 48.77 MiB/80 MiB and CPU at 0.06%.
- Paper alone was recreated as container `3259da86...6877` on exact R5 image with live false, exact
  `qualified-pool-paper-v3-strict-flow`, 40 MB Node heap, restart zero and OOM false. Its first health
  cycle completed in 301 ms with required qualification `strict-flow-v2-20260817`, unchanged
  $85.83766180986538 cash, zero open positions, zero opened/managed actions. RSS settled at 46.84
  MiB/80 MiB and CPU at 0.06%; ingestion remained stopped throughout.
- Ingestion alone was recreated at `2026-08-21T09:41:03.407838555Z` as container
  `e87283a3bc1e9f8b21f669f04780888e415dba65981629fd3272221b9a7316c9` on exact R5 image
  `sha256:0516...f0b0`. Its first inspection proved running, restart zero, OOM false, 160 MiB memory
  and live execution false. The inspection also caught configuration drift before acceptance:
  production Compose still imposed 0.15 CPU although the reviewed profile requires 0.20. Runtime
  was changed only for this exact container with `docker update --cpus 0.20`, then the scoped
  host-only updater changed only the exact `solana-ingestion` Compose CPU line from 0.15 to 0.20.
  The updater is 3,926 bytes with SHA-256
  `b8ed0a31bcd87a7dd8d1c7c73067a9535bab03bb951d291c0321a1f50974ac7a`; server Compose SHA moved
  from `eb7645d0...19698` to `bb1a4ff1...999f1`, and both runtime and durable read-back now equal
  200,000,000 NanoCPUs. No other service block was changed.
- The first compact R5 ingestion heartbeat at `2026-08-21T09:45:13Z` decoded 83/83 emitted discovery
  candidates, including six inner-CPI pools, with zero unmatched, parser failure, unresolved
  transaction, dropped signature, queue pressure or canonical failure. Pump.fun, PumpSwap and CPMM
  were current and healthy. LaunchLab had a successful subscription acknowledgement but no fresh raw
  notification while the bounded activity probe found a later chain signature; the supervisor
  therefore opened incident `6b391f2a...59c5`, restarted only that source once and kept it
  `alpha_excluded_unreconciled`. This is the intended fail-closed response, but the canary remains
  open until the condition is classified as recovered or persistent. At that sample ingestion used
  65.85 MiB/160 MiB and 14.13% CPU, PostgreSQL used 18.66% CPU, disk had 29,150,916,608 bytes free,
  and all three R5 containers still had restart zero/OOM false.
- By the compact sample taken at `2026-08-21T09:51:02Z`, LaunchLab had supplied 63 raw WebSocket
  notifications and one decoded live event. The supervisor had closed its open incident only after
  that fresh evidence and returned the program to `current_transport_healthy`. Aggregate discovery
  was 166/166 with zero unmatched and canonical completion was 542 with zero failure. The transient
  RPC-trade startup queue had peaked at 418, then fallen from 339 to 218; the latest queue delay fell
  from about 145 seconds to 13.92 seconds, while drops and pressure remained zero. The historical
  maximum delay is not an acceptance signal; queue depth and fresh delay must continue toward zero.
- The full `57 files / 305 tests` gate predates the host-only CPU updater and its two focused tests.
  Those focused tests passed, but the final repository gate must be rerun and recorded before this
  rollout is declared complete. This does not invalidate the immutable runtime image because the
  helper is not copied into it and changed no runtime source.
- The first R5 trade stream exposed a correctness-preserving but unacceptable latency bottleneck:
  per-pool ordering intentionally allowed one active worker per address, while the existing
  `SOLANA_TRANSACTION_FETCH_DELAY_MS=1000` forced one second before every confirmed transaction
  fetch. With two active pools the queue peaked at 418 and a processed old item reached 449,278 ms
  queue delay; subscriptions then naturally fell to zero and the queue began draining with zero
  drop/pressure. CPU/concurrency must not be raised for this serial-delay defect.
- The scoped host-only repair `scripts/deploy/update-ingestion-trade-latency.py` is 3,922 bytes with
  SHA-256 `c6a6100869f904c59f61aa9b579740a78ddcb93324eab7bf95280221f4a03044`. Its focused suite passed
  together with the three other R5 deployment companions: `4 files / 9 tests`; TypeScript, targeted
  ESLint, Python compilation and `git diff --check` passed. The helper was uploaded through
  `.partial`, byte/hash verified, atomically finalized at
  `/opt/walletscaner/scripts/deploy/update-ingestion-trade-latency.py` at `09:55:00Z`, set mode 0750
  and compiled on host. Its dry run made no mutation and predicted exact env SHA
  `c2ead1cfc3fc3df034f5eecd693a2a815c7b6ebbf593ba0de05d6f4998dcc6c2`, changing only fetch delay
  1000→0, trade backfill page limit 5→500 and maximum pages 1→4. The 500×4 recovery budget exactly
  matches the existing 2,000-signature queue ceiling; confirmed-notification visibility remains
  guarded by the unchanged six-attempt bounded retry policy.
- A fresh pre-apply read-back proved exact old env SHA, target container ID/image, runtime 0.20 CPU,
  160 MiB, restart zero/OOM false, live false, exact paper v3 and 29,138,386,944 free bytes. The
  helper then atomically applied exactly its reviewed three-key diff and read back exact env SHA
  `c2ead1cfc3fc3df034f5eecd693a2a815c7b6ebbf593ba0de05d6f4998dcc6c2`; image/live/paper keys were
  unchanged. The current container intentionally still has the old environment until recreate and
  must not be mistaken for the repaired runtime. At 09:56:13Z its queue was 155 and falling, with
  one active subscription, 6.601-second latest delay and zero drops/pressure/failure.
- Rendered Compose was independently parsed after the env apply without printing secrets. It resolves
  ingestion to exact R5 tag, 0.20 CPU, 167,772,160-byte memory, fetch delay 0, backfill page limit
  500, maximum pages 4 and `ENABLE_LIVE_EXECUTION=false`. The old-config process remained healthy
  but the workload confirmed the bottleneck was sustained rather than a single startup sample:
  queue depth oscillated 125→237→223→270 as active subscriptions changed, and old items reached
  449 seconds while drop/pressure stayed zero. This justifies the latency-profile recreate; it does
  not justify more CPU or concurrency.
- At the exact transition heartbeat (`2026-08-21T10:02:43Z` sentinel sample, read at 10:03:28Z),
  the old process had queue zero, active workers zero, active subscriptions zero, 1,673 completed
  live trade events, zero drop/pressure and 2,108 canonical completions with zero failure. An
  independent read-only DB replay of `restoreRecentPools` found zero current controlled-flow restore
  candidates, so no in-memory or restorable pool work remained. Only then was ingestion force-
  recreated through scoped Compose; no other service was targeted.
- The repaired ingestion container is
  `c9ead3cd772c1fe3b30e3f5444b8b6a2d23501a3ea5d2b4ef0e8f69115daa58d`, created at
  `2026-08-21T10:03:41.084526651Z` and started at `2026-08-21T10:03:51.688262821Z`. Immediate Docker
  state is running, restart zero, OOM false, exact R5 image
  `sha256:0516c2b11e4b9adda66b1af59aebf935e5d420cc639e39fb2648d331ef9af0b0`, 200,000,000 NanoCPUs
  and 167,772,160-byte memory. The new acceptance clock cannot complete before
  `2026-08-21T10:18:52Z`.
- The actual container environment read-back contains fetch delay 0, trade backfill 500×4, queue
  limit 2,000, concurrency limit 128 and live false. Its first repaired-runtime heartbeat at
  `2026-08-21T10:05:29Z` processed 138 live trade events with one active subscription while queue
  depth and current queue delay stayed zero; process maximum queue delay was 4,883 ms. Fifteen
  early-visibility cases retried and all 15 recovered, with final unresolved, request error/timeout,
  drop and pressure all zero. This is the intended latency improvement without higher CPU or
  concurrency. Discovery decoded 27/27, canonical completed 183 with zero failure. Pump.fun,
  PumpSwap and CPMM were current; LaunchLab had only one raw notification and no qualifying live
  event, so new incident `dc3f3b73...aa57` correctly kept only that program
  `alpha_excluded_unreconciled`. Green acceptance remains pending fresh LaunchLab evidence.
- At the 10:06:29Z sentinel sample, LaunchLab had supplied the required fresh evidence and its new
  incident was closed; all four programs had no open incident. By the compact 10:07:45Z read,
  discovery was 37/37, canonical failures zero, trade queue/current delay zero, process maximum
  delay still 4,883 ms, 17/17 retry recoveries, final unresolved/drop/pressure zero. This is an
  interim healthy sample; the not-before time remains authoritative.
- The next sample exposed another conservative LaunchLab transition: a supervised source restart
  encountered the deliberately tiny discovery backfill budget and opened incident
  `01202fff...fd34b` for `backfill_truncated`. Pump.fun, PumpSwap and CPMM remained current; LaunchLab
  was again the only excluded program. Trade stayed queue/delay zero with 17/17 recovered retries and
  discovery reached 53/53. This is safe-degraded, not green. The incident may close only after a new
  post-restart raw notification and two healthy samples; do not edit it or enlarge provider budgets
  during the canary merely to force a green label.
- The final current-HEAD gate is complete. A fresh disposable PostgreSQL `16.14` container with two
  CPUs/512 MiB and the exact official Zstandard v1.5.7 ZIP (1,747,181 bytes, SHA-256
  `acb4e8111511749dc7a3ebedca9b04190e37a17afeb73f55d4425dbf0b90fad9`) ran the complete suite:
  `60 files / 312 tests` passed. Repository typecheck, full ESLint, `git diff --check` and the
  `apps/web` Next.js production build passed. The disposable PostgreSQL container was stopped and
  auto-removed; no test volume remains.
- A post-recreate provenance audit found a release blocker that the aggregate heartbeat did not
  expose. Restored PumpSwap pool `CcweuytkDiHRjHAfJ9y8Xt7ATVj7vxB8yPAvmz5UxYow` had no durable
  trade cursor. The source fetched exactly the configured five-item initial page and then treated
  it as complete, even though the pool was created at `2026-08-21T10:02:55Z` and the first retained
  trade is at `10:03:59Z`. That 64-second interval has no completeness proof. The later 500-by-4
  budget applies only when a cursor exists, so it did not protect this path. The pool currently
  reports `tradeCoverage.complete=true` incorrectly. Its 81 retained wallet-trade events begin at
  `10:03:59Z`; there are zero entry signals, zero qualified Telegram rows and zero paper rows, so
  the defect was caught before downstream alpha leakage.
- At `2026-08-21T10:14Z`, only `telegram-notifier` and `paper-alert` were stopped as containment.
  They exited zero with restart count zero and OOM false; their exact stopped container IDs remain
  `23ac39b...581b8` and `3259da8...6877`. Ingestion remains running as exact container
  `c9ead3c...aa58d` on exact R5 image, and PostgreSQL remains running as exact container
  `d9e1987...1760`. No row, volume, image, co-tenant or collected payload was removed. Signal
  consumers must remain stopped until cursorless saturation fails closed, the affected interval is
  durably excluded and the corrected immutable ingestion image passes its canary.

## Durable phase ledger

| Phase                                             | State       | Finished (UTC)       | Exact evidence                                                                                       | Safe retry / next action                                         |
| ------------------------------------------------- | ----------- | -------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Resume inventory                                  | completed   | 2026-08-21T07:37:32Z | SSH 22; disk 58%; exact running image boundary recorded above                                        | Re-read server state before every mutation                       |
| R5 focused source/static gate                     | completed   | 2026-08-21T08:05:00Z | TypeScript; ESLint; focused `5 files / 57 tests`                                                     | Rerun focused tests after any source edit                        |
| PostgreSQL 16 integration gate                    | completed   | 2026-08-21T08:18:00Z | local `walletscaner-r5-pg16`; R5 4/4; combined `3 files / 26 tests`; zstd 1.5.7                      | Keep PG container until full suite passes                        |
| Newest dump offsite gate                          | completed   | 2026-08-21T08:28:16Z | 1,001,754,781 bytes; SHA `474d...1660e`; two PG16 archive-list checks; remote marker read back       | Never recreate marker manually; exact pull command is idempotent |
| Duplicate backup scheduler cleanup                | completed   | 2026-08-21T08:34:00Z | exact one-off ID `603bb0f0f397`; stopped then removed without volumes                                | Normal scheduler must remain running                             |
| R5 architecture/provider/data/operations contract | completed   | 2026-08-21T08:35:34Z | four contracts describe ordered admission, incidents, strict consumers and interruption-safe rollout | Run docs diff/check after full gate                              |
| Full local release gate                           | completed   | 2026-08-21T09:03:27Z | `npm ci`; typecheck; ESLint; `57 files / 305 tests`; production build; diff check; migration SHA     | Rerun whole gate after any release-source change                 |
| Immutable image artifact                          | completed   | 2026-08-21T09:09:50Z | image `sha256:0516...f0b0`; tar 463,295,488 bytes; SHA `633e...c368`                                 | Recheck all three identities before upload                       |
| Production pre-state                              | completed   | 2026-08-21T09:12:27Z | disk 58%; DB 12.014 GB; migration 037; exact containers/gates/backup/co-tenant boundary recorded       | Refresh again before first DB/service mutation                   |
| Artifact upload/hash/rename                       | completed   | 2026-08-21T09:21:40Z | server tar exact bytes/SHA `633e...c368`; updater exact bytes/SHA `fb26...d8dcf`; both finalized         | Recheck final hashes before load/use                             |
| Image load/digest                                 | completed   | 2026-08-21T09:22:51Z | server ID/size/arch/label/migration SHA exact; disk 60%/29.14 GB free                                 | Do not retag or rebuild                                          |
| Signal-service stop                               | completed   | 2026-08-21T09:24:24Z | exact Telegram R2/paper R1 containers stopped, exit 0; every checked non-target ID remained running   | Keep stopped until migration/cursor/env gates pass               |
| Migration 038                                     | completed   | 2026-08-21T09:25:55Z | exact checksum/schema/index/trigger; invalid indexes 0; one-shot removed                              | Never edit/reapply migration; proceed to configured cursor gate  |
| Initial cursor dry-run/apply                      | completed   | 2026-08-21T09:27:10Z | dry-run exact LaunchLab plan; apply repaired 1; four configured/unresolved 0                           | Repeat after old ingestion is stopped                            |
| Old-ingestion stop/final cursor apply             | completed   | 2026-08-21T09:33:12Z | exact R3 stopped; stable apply 0 repairs; false verification four/unresolved 0                        | Keep ingestion stopped through env gate                          |
| Historical Pump gap evidence seed                 | completed   | 2026-08-21T09:34:14Z | exact SQL SHA; 2 pools/0 messages/0 trades; insert 1 then replay 0; exact closed row verified          | Keep append-only; never claim reconstruction                    |
| Image-env dry-run/apply                           | completed   | 2026-08-21T09:35:19Z | exact two-key diff; before/after hashes matched; live false/v3 unchanged                               | Start and verify one target service at a time                    |
| Telegram R5                                      | completed   | 2026-08-21T09:38:16Z | exact ID/image; health cycle; coverage audit drained; restart/OOM 0; 48.77 MiB                         | Keep running; do not roll back after incident history exists     |
| Paper R5                                         | completed   | 2026-08-21T09:40:28Z | exact image/v3/strict qualification; 301 ms cycle; 46.84 MiB; restart/OOM 0                            | Keep running; observe through full canary                        |
| Ingestion R5 recreate                            | completed   | 2026-08-21T09:41:03Z | exact ID/image/live false/restart-OOM 0; 160 MiB                                                      | R3 remains the ingestion-only rollback image                     |
| Ingestion CPU drift repair                       | completed   | 2026-08-21T09:43:53Z | helper exact SHA; runtime and Compose both exact 0.20; Compose SHA `bb1a...999f1`                      | Reset canary clock after resource correction                     |
| RPC-trade latency profile dry run                | completed   | 2026-08-21T09:55:00Z | helper `c6a6...3044`; 4 files/9 tests; exact 3-key diff; predicted env SHA `c2ea...c6c2`                | Wait for current in-memory trade queue to drain before apply     |
| RPC-trade latency env apply                       | completed   | 2026-08-21T09:56:45Z | exact 3-key apply/read-back; env SHA `c2ead1cf...dcc6c2`; live/paper/images unchanged                  | Existing container remains old config until recreate             |
| RPC-trade latency ingestion recreate             | completed   | 2026-08-21T10:03:51Z | queue/workers/subscriptions 0 first; new exact container/image/resource profile                       | Verify actual env and fresh health                               |
| Final current-HEAD local gate                     | completed   | 2026-08-21T10:05:51Z | PG16.14+zstd; 60 files/312 tests; typecheck; full ESLint; diff; web production build                   | Rerun only after source/helper changes                           |
| Fifteen-minute production canary                  | blocked     | -                    | cursorless PumpSwap initial page saturated at 5; 64-second completeness gap; no downstream leakage     | Replace runtime with fail-closed cursorless recovery             |
| Signal-consumer containment                       | completed   | 2026-08-21T10:14:00Z | Telegram/paper exact R5 containers exited 0; restart/OOM 0; ingestion and PostgreSQL kept running       | Keep stopped through fix, exclusion and corrected canary         |

## R5 objective

Close fail-open discovery gaps without increasing shared-host concurrency or provider load:

1. distinguish a legitimately quiet program from a missed WebSocket stream with a bounded,
   on-breach per-program latest-signature probe;
2. require fresh post-restart WebSocket evidence before closing a coverage incident;
3. retain subscription-ACK timeout evidence even if the ACK arrives late;
4. retry failed source restarts after a bounded cooldown;
5. prevent storage-gate pauses from acknowledging or cursor-advancing an unpersisted event;
6. detect bounded-backfill truncation and fail closed instead of skipping unseen signatures;
7. exclude unreconciled incident intervals from strict Telegram and paper admission;
8. fence stale health samples with a lifecycle generation;
9. make concurrent incident creation return the conflict winner reliably;
10. prove migration/repository trigger and restart-field parity on PostgreSQL 16.

## Exact next work

1. Keep Telegram and paper stopped. Re-read their exact stopped state plus the running ingestion and
   PostgreSQL identities before any mutation.
2. Change the Standard source so a cursorless initial page that exactly saturates its bounded limit
   emits nothing, advances no cursor and invokes an awaited per-address truncation callback. Wire
   the trade source callback to mark the exact pool's coverage incomplete durably, unsubscribe it and
   prevent `subscribedToBuys=true`.
3. Raise only the bounded cursorless trade initial-page limit from 5 to 500; exact saturation must
   still fail closed. Do not change CPU, concurrency, queue limit or discovery backfill policy.
4. Append an idempotent, advisory-lock-protected PumpSwap coverage incident for the conservative
   affected interval with `historicalReconstructionProven=false`. Never update/delete prior incident
   history. Recheck that the interval has zero qualified Telegram and paper rows.
5. Run focused regressions, the full PostgreSQL 16 plus zstd suite, typecheck, ESLint, tracked diff
   check, untracked checkpoint whitespace check and the production web build. Build and hash a new
   immutable ingestion-only image. Keep R5 signal images stopped and unchanged.
6. At a zero-queue/zero-worker boundary, stop only ingestion, apply the hash-locked one-key env
   change and append-only incident, recreate only ingestion, then prove actual env/image/resources,
   no cursorless false-complete state, fresh program flow, queue/retry/error/timeout health and exact
   incident/outbox/paper exclusions before restarting the existing R5 Telegram/paper containers.

Next safe command (read-only; containment verification):

```powershell
$line = ssh bot 'docker logs --since 20m walletscaner-solana-ingestion-1 2>&1 | grep solana-ingestion-health | tail -n 1'
$health = $line | ConvertFrom-Json
[pscustomobject]@{
  sampledAt = (Get-Date).ToUniversalTime().ToString('o')
  queue = $health.trade.queuedSignatureCount
  freshDelayMs = $health.trade.lastTransactionQueueDelayMs
  subscriptions = $health.activePoolSubscriptions
  drops = $health.trade.droppedSignatureCount
  pressure = $health.trade.queuePressureCount
  activeWorkers = $health.trade.activeWorkerCount
  unresolved = $health.trade.finalUnresolvedTransactionCount
  requestErrors = $health.trade.transactionRequestErrorCount
  requestTimeouts = $health.trade.transactionRequestTimeoutCount
  canonicalFailures = $health.canonicalParser.failedEventCount
}
```

Then inspect exact target container image/restart/OOM/resource state, the affected pool's provenance,
incident/outbox/paper/inbox rows, disk and the unchanged co-tenant boundary before changing anything.
Do not restart the stopped signal consumers, tune concurrency or claim the R5 canary passed.

## Interruption recovery rule

On resume, read `AGENTS.md`, `skills.md`, then this checkpoint. Verify every fact that can change
(containers, disk, backup acknowledgement, migrations) before executing the first pending step.
Never infer that a command completed merely because it was the next planned command.

## 2026-08-22 resume audit

- The prior task stopped after the provider source was partially edited. The local
  `StandardSolanaEventSource` now detects a saturated cursorless initial page and exposes an awaited
  `onBackfillTruncated` callback, but no focused cursorless/callback regression was added and
  `watch-solana.ts` does not pass or consume that callback. Therefore the source edit is not a
  finished or deployable fix. No R6 image or artifact exists and the server still runs exact R5.
- Telegram silence is intentional containment, not a Telegram API failure. Exact R5 containers
  `23ac39b...581b8` and `3259da8...6877` remain stopped since 2026-08-21T10:12Z with exit zero,
  restart zero and OOM false. Their last durable outbox creation/delivery is
  `2026-08-21T10:11:37Z`/`10:11:38Z`. The outbox has 2,074 delivered rows and no pending/retry or
  dead-letter row. Paper v3 remains an isolated active portfolio in PostgreSQL, but its worker is
  stopped; no live execution is enabled.
- Exact ingestion container `c9ead3c...aa58d` remains on R5 image `sha256:0516...f0b0`, 0.20 CPU and
  160 MiB. Docker restarted it once after an unlogged exit-code-1 termination at
  `2026-08-22T00:04:46Z`; OOM is false. The current process has then stayed up for about 17 hours.
- The affected cursorless PumpSwap pool still incorrectly persists
  `tradeCoverage={"complete":true}`. It still has zero wallet-entry, Telegram and paper leakage.
  The conservative program interval has not yet been seeded; do not restart signal consumers.
- Current collection is not acceptable as complete evidence. At the resume sample the aggregate
  discovery source was degraded with a 500-item queue, 867+ dropped signatures and two pressure
  events on Pump.fun. LaunchLab had produced 184 incident rows and repeated shallow-backfill/source
  restart churn; one current incident remained open. Strict consumers are stopped and incident
  history excludes known intervals, but process liveness/12,060 decoded events does not prove
  complete network coverage. The corrected release must treat discovery queue pressure as a
  program coverage breach or otherwise prove no dropped candidate can be admitted as complete.
- PostgreSQL is healthy with migration 038 exact, 21 verified archive segments, zero archive
  pending/dead-letter state and only processed inbox rows. Database size is 13,116,840,983 bytes.
  Root disk has 26,937,610,240 bytes free (63% used), memory has about 1.14 GiB available, and swap
  usage is about 115 MiB. No co-tenant container exists; `scalp2.service` remains masked/failed and
  untouched.

### Resume-safe implementation order

1. Add focused provider tests for cursorless saturation, below-limit success and both awaited
   truncation callback reasons. Wire the trade source callback to durable exact-pool exclusion and
   re-check coverage after `subscribeAddress` before setting subscription flags.
2. Add an exact hash-locked one-key env updater for `RPC_TRADE_INITIAL_BACKFILL_LIMIT=5 -> 500` and
   update the documented/default profile. Saturation at 500 must still fail closed.
3. Reproduce the discovery queue-pressure leak in tests and make the per-program supervisor open a
   durable coverage incident before dropped discovery signatures can be treated as current healthy.
   Do not raise CPU, concurrency or queue limits as the fix.
4. Run focused tests, then the full PostgreSQL 16 plus zstd gate, typecheck, ESLint, workspace builds
   and diff/JSON/whitespace checks. Build a new immutable ingestion-only image and exact tar/hash.
5. Re-read backup/headroom/container state. At a bounded queue transition stop only ingestion,
   apply the one-key env update, seed an append-only PumpSwap incident through the corrected runtime
   activation time, load/recreate only ingestion and run a bounded canary. Restart the existing R5
   Telegram/paper containers only after exact pool coverage, incident, outbox and paper gates pass.

### 2026-08-22 local completion ledger

- The provider now fails closed on a saturated cursorless initial page, awaits an exact truncation
  callback and preserves the below-limit oldest-to-newest success path. Focused provider regressions
  cover both truncation reasons and both cursorless boundary outcomes.
- `watch-solana.ts` now persists an exact-pool incomplete trade-coverage snapshot from that callback,
  unsubscribes the affected pool, and refuses to reactivate a subscription whose coverage was
  concurrently excluded. The helper is idempotent and preserves the first observed gap.
- The per-program discovery supervisor now opens a durable `combined` incident immediately when
  queue-pressure or dropped-signature counters advance. Exact counters and
  `coverageTrigger=live_queue_pressure` are retained in metadata; this evidence-loss boundary does
  not trigger a misleading source restart and remains alpha-excluded after live recovery.
- Added `scripts/deploy/update-ingestion-backfill-env.py`, a dry-run-default, whole-file-SHA and
  exact-value guarded atomic updater limited to `RPC_TRADE_INITIAL_BACKFILL_LIMIT`. Defaults now
  document the reviewed `500/500/4` initial/page/page-count profile; exact saturation still fails
  closed.
- `npm run typecheck` passed. The focused provider, trade-coverage, supervisor and deployment-helper
  suite passed 4 files / 63 tests. No production mutation or signal restart has occurred in this
  local phase.
- The complete gate passed with a resource-bounded PostgreSQL 16.14 container and official zstd
  1.5.7: 62 files / 321 tests, repository TypeScript, full ESLint, `git diff --check` and the
  production Next.js build. The first unconstrained Vitest pass hit only the known parallel
  10-second migration-hook ceiling; the unchanged full suite passed with four test workers. The
  disposable database was then stopped and auto-removed without a volume.
- Immutable image `walletscaner-worker:pipeline-stability-r6-20260822` is amd64, 463,275,473 bytes,
  label `walletscaner.release=pipeline-stability-r6-20260822`, exact image ID
  `sha256:2456672e58c55f4a105903ad8ff74cb00865b7aebd7c10d2eec8a2b981c0f49f`.
  Its isolated smoke check proved Node 24.18.0, npm 11.16.0, PostgreSQL client 16.14, zstd 1.5.7,
  both R6 fail-closed source markers and exact updater SHA-256
  `49ce0a2bea606fdfa3527e654867ecbc2df1422008a16d574280ed4f2e59a592`.
- Raw artifact
  `C:\Users\Umut\AppData\Local\walletscaner-artifacts\pipeline-stability-r6-20260822\walletscaner-worker-pipeline-stability-r6-20260822.tar`
  is 463,308,288 bytes with SHA-256
  `8cf39bd710c7f0ca873d87195a44edb3a49cbe053975b809e8c848098a969eff`.

Next safe action: re-read production backup/headroom/container/config state, upload both R6
artifacts through `.partial` paths with exact hash/size verification, and load without recreating a
service. Do not stop ingestion until server image and append-only incident inputs are independently
ready.

### 2026-08-22 production R6 cutover ledger

- Production pre-state at `2026-08-22T17:41:29Z`: disk 63% with 26,900,582,400 bytes available,
  1,198,706,688 bytes memory available, live execution false, exact env/Compose hashes unchanged,
  PostgreSQL healthy, migration 038 latest, 21 verified archive segments, zero archive/outbox
  pending or dead-letter state, one already excluded LaunchLab incident open. Signal containers
  remained exact stopped R5 identities with exit zero/restart zero/OOM false.
- The newest 1,207,388,330-byte dump `20260821T150923Z` was resumably downloaded off host, matched
  SHA-256 `32790fb825a0481a2222df93c45bee4912e4a6d7e10f326e5dec8af507e408e8` and passed an
  independent Docker PostgreSQL 16 archive-list check. Its remote acknowledgement was read back
  byte-exact. The scoped reconcile helper lacked execute permission; its local/server SHA matched,
  then explicit `bash` dry-run/apply kept the newest generation and retired only the older already
  acknowledged `20260820T214946Z` server generation.
- R6 tar and helper uploads passed `.partial` byte/SHA gates and atomic rename. Server load produced
  exact image ID `sha256:2456672e58c55f4a105903ad8ff74cb00865b7aebd7c10d2eec8a2b981c0f49f`,
  amd64, 463,275,473 bytes and the exact release label/source smoke checks. Disk remained 63% with
  27,391,254,528 bytes available.
- Final R5 health at `2026-08-22T18:01:52.517Z` showed Pump.fun queue 500, dropped signatures 1,631,
  pressure count two and no open Pump incident. The final containment SQL is 6,150 bytes, SHA-256
  `24076761eb99f83daf68de6a6e4d45117d63e3534905e12613afbfa1e0c31d4b`.
- At `2026-08-22T18:04:43Z` only exact old ingestion container `c9ead3c...aa58d` was stopped. It
  exited zero, OOM false; no other service changed.
- Exact containment SQL committed atomically: two open append-only incidents were inserted, and the
  one reviewed PumpSwap pool changed from `tradeCoverage.complete=true` to false with reason
  `cursorless-initial-limit`. Qualified-message and paper-trade leakage remained zero; outbox
  pending remained zero. No row was deleted.
- The image updater changed only `WALLETSCANER_INGEST_IMAGE` from exact R5 to exact R6; intermediate
  env SHA-256 was `2d904ce6...51c192b`. The backfill helper dry-run and apply then changed only
  `RPC_TRADE_INITIAL_BACKFILL_LIMIT=5 -> 500`; final env SHA-256 is
  `7386d34f723c02acc751ad8a050c1464c87d6f4dc1c5e056f115b79a58ee81d9`. Rendered Compose proves
  exact R6 image, 0.20 CPU, 160 MiB, `500/500/4` and live execution false. Signal image remains R5.
- Only ingestion was recreated at `2026-08-22T18:06:19Z` as container `a4dd8c5...dcdc`, exact R6
  image ID, restart zero/OOM false, 0.20 CPU/160 MiB and actual runtime `500/500/4`/live false.
  First heartbeat completed nine canonical events with zero failure, queue, drop or pressure and
  decoded 9/9 Pump discoveries. All four program reconnect windows correctly recorded their bounded
  backfill truncation instead of declaring completeness; seeded Pump/PumpSwap incidents remained
  alpha-excluded while fresh recovery evidence accumulated. LaunchLab also retained its pre-existing
  excluded incident and one startup ACK timeout. This is an initial fail-closed sample, not yet a
  promotion gate.
- The next heartbeat completed 31/31 discovery events with zero unmatched/failure, aggregate and
  per-program queue/drop/pressure zero. Pump.fun, PumpSwap and CPMM had two healthy samples and
  closed their operational incidents without reconciling the historical gaps. LaunchLab remained
  safely excluded by its existing incident.
- Exact stopped R5 Telegram container was started for a delivery canary. Telegram API delivery
  succeeded once, but the notifier began materializing every open/recovered coverage transition
  accumulated while it was stopped: 19 pending rows remained after one delivery. It was immediately
  stopped cleanly at `2026-08-22T18:11:27Z`, same container ID, exit zero/restart zero/OOM false.
  Paper was never started. Pending rows remain as audit evidence; none were deleted.
- Local R7 correction now selects only the latest durable transition per program. This preserves
  real-time open/recovery changes while coalescing stopped-worker churn instead of replaying every
  historical cycle. A PostgreSQL regression is being added before any signal restart.
- Exact replay cohort cleanup updated 19 pending, zero-attempt coverage status rows to terminal
  `suppressed` with audit reason `historical_coverage_transition_replay_coalesced_r7`; it deleted
  nothing. Final counts were pending/processing/retry zero, dead-letter zero, delivered 2,075 and
  suppressed replay 19. One transition message had already been delivered before containment.
- The R7 coalescing release passed focused PostgreSQL 16 (19/19), full PostgreSQL 16 plus zstd
  (62 files / 322 tests), TypeScript, full ESLint, diff check and production build. Disposable PG16
  was stopped and auto-removed without a volume.
- Immutable signal image `walletscaner-worker:signal-replay-r7-20260822` is amd64,
  463,277,223 bytes, label `signal-replay-r7-20260822`, exact ID
  `sha256:f93f0c7d7ddbf9eb30f3b3e60f4382c7e2a5b5a101cbe845a4e1e763b596a8d5`.
  Raw tar is 463,310,336 bytes, SHA-256
  `bebe482885e70693c1fb4d0cc8ac88817983164f4067b06a5f6e3ed16b8cfeaa`.

Next safe action: resumably upload/hash/load exact R7 signal artifact, change only the guarded signal
image key, render Compose, recreate Telegram only and verify at most one latest transition per
program plus a draining outbox. Keep paper stopped until Telegram drains cleanly.

### 2026-08-22 production R7 Telegram canary ledger

- The interrupted SFTP `reput` session resumed rather than restarting. Its `.partial` upload
  completed at exact 463,310,336 bytes and SHA-256
  `bebe482885e70693c1fb4d0cc8ac88817983164f4067b06a5f6e3ed16b8cfeaa`; the destination was absent
  before atomic rename. Server load produced exact image ID
  `sha256:f93f0c7d7ddbf9eb30f3b3e60f4382c7e2a5b5a101cbe845a4e1e763b596a8d5`, amd64,
  463,277,223 bytes, release label `signal-replay-r7-20260822` and the expected
  `latest_by_program` source marker. Disk was 63% used with 26,930,245,632 bytes available.
- The guarded image helper dry-run and apply changed only `WALLETSCANER_SIGNAL_IMAGE` from exact R5
  to exact R7. `.env.server` SHA-256 is now
  `1847f9f6067d2516af5ebb01dff3e043ee37835b7b4dfea34d22832ebd1306bf`; live execution remains false,
  ingestion remains exact R6 and the trade profile remains `500/500/4`.
- Only `telegram-notifier` was recreated. Container
  `b349bab6a158394b75ce3cfb9625912683123f1ce508b16970895160c6610cc8` runs exact R7 with the direct
  Node/tsx command, 0.02 CPU, 80 MiB, restart zero, OOM false and live execution false. Paper remains
  stopped on its prior container boundary.
- The first R7 notifier scan selected four latest program states instead of replaying every
  historical incident transition. It delivered one in that cycle; subsequent one-message claims
  began draining the remaining current-state summaries. No qualified-pool candidate was enqueued,
  and the historical 19-row suppressed audit cohort remains unchanged.

Next safe action: prove the four current-state messages drain to zero with no second-wave enqueue,
then recreate only `paper-alert` onto exact R7 and run the combined bounded canary. Do not recreate
ingestion.

- The four current-state rows all reached `delivered`; pending/processing/retry and dead-letter were
  zero. The latest coverage source-key creation remained at `2026-08-22T18:28:05.045275Z`; later
  poll cycles inserted zero second-wave coverage rows.
- Only `paper-alert` was then recreated as container
  `6b39e372166d18ad88749498447b6181f3cd7ecc9edc7d4c5c55bc486211a387` on exact R7. Its actual
  runtime is the direct Node/tsx command, 0.02 CPU, 80 MiB/40 MiB heap, exact
  `qualified-pool-paper-v3-strict-flow`, live execution false, restart zero and OOM false. Its first
  health cycle took 308 ms, opened/managed zero positions and retained 85.83766180986538 USD cash,
  -14.16233819013462 USD realized PnL, zero open positions and six immutable events.

Next safe action: finish the combined resource/data-integrity canary, remove only the two verified
server-side release tar transport copies if all gates remain green, then write the final durable
handoff. Keep the loaded R5 rollback image and do not run a global image/cache prune.

### 2026-08-22 final canary and handoff boundary

- The final R6 health sample had 957 canonical completions, 506/506 emitted discovery candidates
  decoded, zero unmatched/canonical failure/unresolved/queue/drop/pressure, 130 materialized entries
  and one active exact-pool trade subscription. Pump.fun, PumpSwap and CPMM were current healthy.
  LaunchLab alone retained its durable open incident and remained
  `alpha_excluded_unreconciled`; this makes aggregate discovery health intentionally degraded rather
  than admitting uncertain coverage.
- The first post-R6 sampler cohort consumed 66 entries for one exact market, saved one compact price
  observation and 132 outcome transitions in 1.423 seconds with zero provider error, exact-pool miss
  or invalid market. It transactionally requeued the affected wallet revisions.
- The following wallet-alpha cycle prefetched 89 candidates/81 admitted revisions and stopped at its
  configured 240-second boundary after processing 39 wallets. It skipped three low-evidence rows and
  recorded zero cycle failure or oversized wallet, with about 95.5 MiB logged RSS under 160 MiB.
  Seventy-nine changing revisions remain for normal future cycles; one separate pre-existing
  over-10,000-trade wallet is isolated until its configured 24-hour retry. Persisted alpha signals
  remain zero; no threshold was lowered.
- Telegram pending/processing/retry/dead-letter, signal pending/processing/retry/dead-letter and
  archive non-verified counts were all zero. All 21 archive segments were verified, the reviewed
  PumpSwap pool remained `tradeCoverage.complete=false`, migration 038 was latest and zero indexes
  were invalid/unready. Paper remained at 85.83766180986538 USD cash, -14.16233819013462 USD realized
  PnL, zero open positions and six events.
- Every running Walletscaner container reported restart zero and OOM false. A post-cycle resource
  snapshot showed ingestion 75.79/160 MiB at 8.31% CPU, Telegram 49.95/80 MiB at 0.04%, paper
  39.18/80 MiB at 0.12%, PostgreSQL 186.8/256 MiB at 9.46% and host load 0.62 on one CPU. These are
  point samples; the 24-hour trend remains an explicit open gate.
- The next five-minute operations sample removed the transient load warning: load per CPU was 0.37,
  latest pool age 23.23 seconds, latest swap/wallet trade age 48.23 seconds, price observations/hour
  36, pipeline backlog/dead letters zero and archive backlog/dead letters zero. Overall status remains
  deliberately `degraded` only because the 13,132,020,759-byte database exceeds the conservative
  12-GiB warning threshold; this is not an ingestion queue failure, and it must not be hidden by
  raising the threshold.
- The two server-side R6/R7 tar transport copies exactly matched their verified local artifacts and
  loaded images before targeted removal. No image, BuildKit/cache, database row/table/volume,
  archive payload or co-tenant object was removed. Root disk ended at 62% used with 27,812,982,784
  bytes available; memory available was 1,124,810,752 bytes and swap use 122,667,008 bytes.

Resume rule: leave R6/R7 active and inspect the 24-hour queue/drop/pressure, resource and strict
cohort trend. Do not restart or tune merely because LaunchLab remains fail-closed, wallet-alpha has
bounded carry-over work, or no profitable signal exists. Any new change starts from this exact
checkpoint and re-verifies live state first.
