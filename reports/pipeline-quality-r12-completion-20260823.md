# Pipeline quality R12 completion — 2026-08-23

## Outcome

The interrupted R9 rollout was recovered, completed and advanced through two bounded hot-path
fixes. Finality reconciliation and the two dominant wallet-alpha query defects are operational on
production. Live execution remains disabled and no profitable-alpha claim is made.

## Production releases

| Service | Release | Image ID | Source SHA-256 |
|---|---|---|---|
| `solana-ingestion` | `pipeline-quality-r10-20260823` | `sha256:ae3feac43d0e...` | `8255d7c4594e0380fc955bb7fe6a4441d60fb1f3a083a908eec550c328521d55` |
| `wallet-alpha` | `wallet-alpha-query-r12-20260823` | `sha256:23f5fea40751...` | `0d38b2d65e372fc165688f60e54264b1994ce313bace45dd60b19167ca496620` |

Only the named service was stopped/recreated at each rollout. PostgreSQL/Redis volumes were not
changed. The protected co-tenant was not inspected or touched.

## Root causes and measured fixes

1. A transaction signature could be finalized by discovery before a late backfill/trade event with
   the same signature arrived. The finality row was terminal, so the pending-only RPC worker never
   revisited the new event and partition ordering correctly blocked everything behind it. R10 adds a
   256-row, lease-safe terminal-state reconciliation sweep. Live mismatches changed `3 -> 0`; inbox
   backlog changed `803 -> 5`, then the monitor reported `0`.
2. Wallet-alpha claim SQL ordered by `updated_at`, while its partial index orders by
   `not_before, updated_at`. PostgreSQL scanned a 301,582-row historical queue for each one-wallet
   lease. R11 aligns fairness/retry order with the existing index. Live claim mean changed
   `628.57 ms -> 4.99 ms` without adding an index.
3. Outcome loading filtered only `outcome.strategy_version`, so PostgreSQL could not use the
   strategy-first wallet-entry index. R12 filters `entry.strategy_version` too, preventing
   cross-strategy joins and changing the live mean `1,224.68 ms -> 25.50 ms`.

The first R12 100-item cycle finished in 26.31 seconds versus the prior 200-242 second range. It
processed 55 admitted and 45 low-evidence wallets with zero processing failure; pending work fell
from 475 to 375. CPU, heap and container limits were not raised.

## Recovery and safety evidence

- Verified dump: `memecoin_alpha_20260823T150923Z.dump`, 1,505,940,747 bytes.
- Dump SHA-256: `2f8831a3a9bde0e6e19c89099444b2404bc950f30ae9c7f20865e38c0f43fdba`.
- Server/off-host byte equality, SHA, PostgreSQL 16 archive-list, sidecar and acknowledgement passed.
- Clean PostgreSQL 16 final integration: 23/23.
- Exact R10 image: critical zstd/finality/migration tests 19/19; finality integration 21/21.
- Exact R12 image: query-order and strategy-boundary integration 2/2.
- Final containers: running, restart `0`, OOM `false`; host about 23 GB free and 1.1 GB available RAM.

## Remaining work — do not overstate

- Zero wallet-alpha signals exist; alpha is not validated.
- 10,962 verified payloads were still eligible for compaction at the last check. The latest worker
  compacted 4,000 per run and is catching up; verify zero lag before calling storage healthy.
- Detailed 95-day wallet evidence still needs the documented B2 artifact, compact deterministic
  ledger, dual-read parity, isolated restore and stopped cutover before any canonical retirement.
- Daily dumps are operational; continuous WAL/PITR is not.
- Token-2022 fail-closed support is implemented but has not encountered a live extension sample.
- Jupiter size-aware quote evidence needs an approved API key and future-only shadow validation.
- Optional Raydium/Meteora/Orca venues remain disabled pending per-venue coverage/resource gates.

## Rollback

- Ingestion: restore `WALLETSCANER_INGEST_IMAGE` to immutable R9 and recreate only
  `solana-ingestion` with `--no-deps`.
- Research: restore `WALLETSCANER_RESEARCH_IMAGE` to immutable R11 (query-order retained) or R4,
  then recreate only `wallet-alpha` with `--no-deps`.
- Database: no R10-R12 schema mutation was added; migrations 040-042 have the verified current dump
  and populated PostgreSQL 16 restore proof.
