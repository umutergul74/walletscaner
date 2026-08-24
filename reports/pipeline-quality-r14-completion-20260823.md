# Pipeline quality R14 completion — 2026-08-23

## Outcome

R14 is the final deployed ingestion release for this work. It retains R13's PostgreSQL NUL-payload
and exact-address queue safety fixes, while keeping normal provider payloads on a zero-copy fast
path. Finality and wallet-alpha fixes from R10-R12 remain operational. Live execution is disabled,
signals remain zero, and no alpha threshold was weakened.

## Release evidence

- Source archive: `walletscaner-pipeline-quality-r14-20260823a.tar.gz`, 2,480,512 bytes.
- Source SHA-256: `b7a54eed2dad7de5078e327e9753cd7ebeab2a37558ab159fd52e7838ca363db`.
- Image: `walletscaner-worker:pipeline-quality-r14-20260823`.
- Exact image ID: `sha256:50ec04aaa52a0d9daf38a0dea88eb2f0f1abf81e8d5cbb3446a7afdbbb94bc80`.
- Linux/amd64 labels match the release and source hashes.

## Verification

- TypeScript and ESLint: passed.
- Provider/queue regressions: 40/40.
- PostgreSQL 16 evidence integration: 24/24, including NUL string values, NUL object keys,
  occurrence count, literal escape and original-payload SHA-256.
- Exact R14 Linux image: provider/queue and zstd archive tests 43/43.
- Broad Windows suite: 329 passed, 34 skipped; its only two failures were the absent local `zstd`
  executable and those archive cases passed in the exact Linux image.
- Production Next.js/workspace build: passed.

## Rollout and canary

- Transition occurred with live trade queue/workers/configured addresses/active subscriptions all
  zero. Only the hash-guarded `WALLETSCANER_INGEST_IMAGE` key changed and only
  `solana-ingestion --no-deps` was recreated.
- Container image and labels match R14; state running, restart 0, OOM false.
- First R14 health sample processed 304 backfill events, canonical parser 331 events with zero
  failure, trade queue 0, unresolved/dropped/purged 0 and finality unresolved/error 0.
- Storage admission remained open. No PostgreSQL/Redis volume, B2 object, canonical row or unrelated
  service was manually changed or deleted.

## Remaining measured gates

- Operations status remains `degraded` for database-size warning, 7.8-hour payload-compaction lag
  and a deployment-polluted 6.65-day recent runway estimate. Archive queues and canonical backlog
  remain zero; recurring maintenance is advancing the oldest compaction boundary.
- Wallet-alpha received a fresh producer burst after ingestion catch-up. A read-only sample saw 644
  coalesced revisions; the next cycle reached its 240-second work budget after 45 admitted wallets
  and reduced pending to 265 with zero failure and 94.7 MiB RSS. The ceiling worked, but sustained
  net drain after ingestion contention subsides must still be observed; signals remain zero.
- Continuous WAL/PITR, compact wallet-evidence B2 cutover, live Token-2022 samples, approved Jupiter
  quotes and independent optional-venue coverage are still open. None blocks evidence collection,
  but each relevant gate blocks stronger execution-grade or storage-equilibrium claims.

## Rollback

Restore immutable R13 (same safety behavior) or R10 through the exact-value environment updater,
then recreate only `solana-ingestion --no-deps`. R14 introduced no migration.
