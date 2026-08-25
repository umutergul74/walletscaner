# Pipeline/storage R30 rollout ledger

- Release: `pipeline-storage-r30-20260825`
- Source revision: `039f1c5`
- Ingestion image ID: `sha256:afd180aed4fbdddd5e6b1bd537dd0c01d602ef4ea69a16f9d81f99c5c9252da9`
- Export bytes: `463396864`
- Export SHA-256: `ea2d04df2813cf5b845b38b792e7d5369c0fe19e56b77d711402d4db735ee0d0`
- Supporting R29 source/image: `b3ab4c8` /
  `sha256:ecfc196020573f29a76d052fc386a519d57650662f4c7731b543a05b8eb38c55`
- Migrations: through `048_wallet_alpha_qualified_signal_lane.sql`
- Live execution: `false`

## Recovery and pre-state

- The 2026-08-25 server dump is `memecoin_alpha_20260825T150924Z.dump`, 2,053,352,363 bytes,
  SHA-256 `ba26a3c89fdb8dc671d92976659ae177a6d8f76be40a45b8b8f774bb54238160`.
  Its sidecar and independent PostgreSQL 16 `pg_restore --list` check pass. This generation is not
  yet off-site acknowledged; the prior verified off-host generation remains the off-site recovery
  point and the new server dump was not deleted.
- Host headroom before R30 transfer was about 16.1 GB. PostgreSQL invalid-index count was zero and
  migration 048 was present exactly once.
- R29 and R23 immutable images remain rollback points. The exact pre-R30 `.env.server` SHA-256 was
  `c53d8d75b6360ca0a3e9292eddc6d3123f2f2100423137029ef52735620bb762`.
- Only the Walletscaner Compose project was listed. No unrelated project, volume, B2 object, host
  package, Docker daemon setting or network/firewall setting was changed.

## Verification gates

- Targeted discovery-supervisor tests: 26/26 passed.
- TypeScript, ESLint and production workspace build passed.
- Exact Node 24/Linux image plus disposable PostgreSQL 16 passed 88/88 files and 426/426 tests.
  Deploy-time Python and the reviewed root Compose file were mounted only into the disposable test
  container; they were not added to the worker runtime image.
- Local and remote tar bytes/SHA-256 matched before `docker load`; loaded image labels identify
  release R30 and source revision `039f1c5`.

## Scoped rollout

R29 was first applied only to evidence sampler, wallet alpha, data maintenance and operations
monitor. The PostgreSQL backup scheduler was recreated separately on PostgreSQL 16 with
`--compress=zstd:1 --no-owner --no-acl`. Ingestion was then moved R23 -> R29 to activate the
qualified P2 producer. After the repair-boundary bug was proven, only ingestion moved R29 -> R30.
Telegram, PostgreSQL and Redis container identities remained unchanged across both ingestion
rollouts. Every recreated service retained its reviewed CPU/RAM/PID limit, restart count zero and
OOM false. `ENABLE_LIVE_EXECUTION=false` was verified inside R30.

The guarded R30 environment update changed only `WALLETSCANER_INGEST_IMAGE`; before/after file
SHA-256 was `c53d8d75... -> 5a98db05...`. No Compose `down`, dependency-following create, build on
the host, global prune, volume command, destructive DDL, `VACUUM FULL` or B2 mutation was used.

## Live evidence

- The first normal R29 maintenance cycle used 250-row compaction batches, compacted 6,750 verified
  raw payloads in 43.726 seconds and reported zero query timeout. The measured one-hour inbox ingress
  was 6,082 rows versus about 13,500 rows/hour maintenance capacity. The 48-hour compaction boundary
  remained 11.05 hours late, so storage equilibrium is waiting.
- R29 wallet-alpha cycles processed 72/92/90 wallets with zero current-cycle failure; the fastest
  completed in 36.577 seconds. The former combined bound-probe statement timeouts did not recur.
- The R23 producer had left 207 pending `risk-passed-source-entry` P2 rows. R29 consumed some while
  a bounded transaction reclassified the remaining 134 using migration 048 semantics. Legacy P2
  is zero and R29 writes unqualified risk-passed wallets to P1. No evidence revision was deleted.
- R30 accepted a finalized failed transaction as an immutable ordering boundary only after all
  11,657 staged Pump signatures had replayed oldest-first and exact signature/slot/finality was
  independently confirmed by both official Solana RPC and PublicNode. It persisted an append-only
  finalized proof, recorded `targetTransactionSucceeded=false`, and closed the incident as
  reconciled. A failed transaction still produces no discovery event.
- R30 ingestion samples showed live trade transport OK, canonical parser/finality errors zero,
  dropped signatures zero, queue-pressure zero and storage admission open.

## Waiting and residual risk

- Restart-created PumpSwap and CPMM repair sessions remain bounded by the reviewed 20,000-signature
  ceiling. Their exact intervals stay alpha-excluded until exact proof commits; cap exhaustion must
  close only current transport as unreconciled and must never relabel the gap complete.
- Background wallet-alpha P0/P1 was about 8.5k rows with the oldest pending revision about 40 hours.
  P2 was zero. Cgroup counters proved alpha and PostgreSQL were quota-throttled while the host was
  about 71% idle, so a restart-free canary raised only PostgreSQL 0.18->0.21 CPU and alpha
  0.07->0.10. The first two complete cycles moved queue 8,531->8,495; a comparable light cycle
  improved 201.5->132.5 seconds and a heavy cycle completed 54 rather than 46 wallets inside the
  same 245-second ceiling. The Compose limits now match the accepted live canary, but a negative
  one-hour slope is still required or both limits must be reverted.
- The newest dump still needs byte-identical off-site acknowledgement. The scheduler intentionally
  blocks another multi-gigabyte generation until that happens.
- No watch-or-better wallet signal or profitable chronological paper cohort is validated. Observe
  only remains mandatory.
