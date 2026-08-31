# Wallet-alpha FIFO R51 production rollout

Generated from the 2026-08-31 22:37–23:03 UTC bounded production operation.

## Outcome

**No-go; verified rollback.** R51 passed schema, identity, correctness and resource gates but failed
the useful queue-drain and no-failure-growth gates. Only `wallet-alpha` was returned to exact R43.
Live execution remained disabled throughout.

## Recovery and immutable inputs

- Pre-change dump: `memecoin_alpha_20260831T173517Z.dump`, 2,804,194,002 bytes,
  SHA-256 `112599cf58e915dd57993fa780b84cfc7e5c2fed22368d7e6b211fd80aa3e4ad`.
- R51 image: `sha256:11040e46acec558b3b37fec3103e4367efe0ade8b1ee62c3234dcd22079e0a49`.
- R43 rollback image: `sha256:e87020e75036e6f0f376a516228c6546959cd3c6479840e4547d62f5f928bf3b`.
- R51 release ledger revision 9: SHA-256
  `d5482cebbf9d1fd9bc77c057dbb44dfcfe5871032275ca991d96e5b0ffa69408`.

## Migration evidence

Migrations 052–055 were applied through the exact R51 image with 5-second lock and 60-second
statement limits. Their recorded SHA-256 values match the repository. The 6.2 GB
`wallet_trade_events` relation retained relfilenode 60487, all expected triggers/functions exist,
and invalid index count remained zero. Legacy ingestion produced known-order revision rows after
the migration, proving producer-independent invalidation at the table boundary.

## Canary

| Cycle | Elapsed | Useful | Low evidence | Failed | End pending |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 242.495 s | 76 | 2 | 2 | 39,500 |
| 2 | 246.910 s | 40 | 9 | 0 | 39,738 |
| 3 | 242.305 s | 72 | 1 | 2 | 39,803 |

Pending started at 39,496. Observed alpha RSS stayed at or below 127.81 MiB under the unchanged
160 MiB limit; restart/OOM stayed `0/false`. The failures were fail-closed: two inventory limits,
one page deadline and one concurrent-revision CAS retry. No unsafe checkpoint was accepted.

The bottleneck is now precise: the historical 39k cohort has no continuation yet. Each selected
wallet therefore repeats a complete first seed, and seed progress commits only after the wallet is
fully evaluated. The live producer can add elevated work faster than this one-CPU worker completes
first seeds. The continuation optimization is correct, but it cannot repair this initial-state
capacity problem by itself.

## Final state and next gate

Active alpha is exact R43, live execution is false, and every non-alpha Walletscaner identity
matches pre-state. Migrations 052–055 and about 107 MiB of derived R51 canary state remain; no
canonical data was deleted. Final database size was 25,248,013,335 bytes with 12,888,768,512 bytes
free on the root filesystem.

Do not retry R51 unchanged. A new design must persist bounded initial-seed progress across
pages/cycles, keep incomplete seeds ineligible for scoring, isolate historical background work from
the live elevated lane, and pass a one-hour negative useful-queue slope with no recurring failure
growth before a new alpha-only canary.
