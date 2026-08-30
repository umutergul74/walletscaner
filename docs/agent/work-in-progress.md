---
status: active
updated_at_utc: 2026-08-30T21:44:00Z
owner: codex
task: bounded alpha producer and sustainable wallet evidence storage
last_safe_checkpoint: R46 safe/auth working but queue capacity failed; no production mutation pending, ledger6; local continuation and scorer parity522tests pass
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

## Completion conditions

Queue arrivals below useful drain, preserved trade/enrichment evidence, bounded lag and failure
recovery; retention exceeds measured ingress and retains8GiB reserve. Finite disk cannot guarantee
perpetual collection through unlimited B2/provider outage; backpressure must preserve evidence.
