---
status: active
updated_at_utc: 2026-08-30T20:54:00Z
owner: codex
task: bounded alpha producer and sustainable wallet evidence storage
last_safe_checkpoint: fresh preflight complete; no production mutation; exact R46 artifact hash reconciled
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

## Phase2: storage implementation (not started)

Map compact materializer -> FIFO/scorer consumer -> source retirement. Add reader continuation,
parity/replay and invalidation gates before retirement. Rehearse on populatedPG16 and prove bounded
work/WAL/temp and preserved open lots. Keep B2 full evidence and fail closed on unavailable
archive/restore/parity. No emergency DELETE/TRUNCATE/VACUUM FULL is authorized by this plan.

## Completion conditions

Queue arrivals below useful drain, preserved trade/enrichment evidence, bounded lag and failure
recovery; retention exceeds measured ingress and retains8GiB reserve. Finite disk cannot guarantee
perpetual collection through unlimited B2/provider outage; backpressure must preserve evidence.
