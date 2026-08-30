---
status: active
updated_at_utc: 2026-08-30T21:22:00Z
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
  is completing. No source/scorer thresholds, provider routes or production timeouts changed.
- Local disposable PG16.15 is running only127.0.0.1:54329 with32MiBshared buffers. Initial launch
  accidentally used default5432; it was stopped immediately and relaunched correctly. No user DB
  or production PostgreSQL was touched. Stop this exact local cluster when tests finish.

## Completion conditions

Queue arrivals below useful drain, preserved trade/enrichment evidence, bounded lag and failure
recovery; retention exceeds measured ingress and retains8GiB reserve. Finite disk cannot guarantee
perpetual collection through unlimited B2/provider outage; backpressure must preserve evidence.
