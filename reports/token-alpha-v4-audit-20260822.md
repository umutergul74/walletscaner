# Token Alpha V4 Causal Audit

Generated: 2026-08-22T19:32:14.896Z

## Decision

- Verdict: **no-promotable-v4**
- Exact strict-flow markets: 177
- Candidate grid: 5760
- Locked candidate: none
- Live execution: prohibited; this report cannot authorize capital deployment.

## Current V3 Paper Incidents

- DgjFaXGgnMjYR71z8LGrA2XpAPjUDmdQUdB5wVV6tyxE: -6.0000 USD (pool_liquidity_zero)
- 5Ex8oQPNTadDPJ2yjAjoixDSF8aoDufPpJy7WX58Xs1d: -2.1623 USD (hard_stop_loss)
- 2DY7uGZ4sKXwUtRPdGGEMWgDsFf3mnAPupPpJ7FksRiD: 0.0000 USD (entry_liquidity_not_persistent)
- AEXVCbhtp5NhXNYy1jHHpmXCJM7TsxvRusAQV5NyhNx8: -6.0000 USD (pool_liquidity_zero)

## Frozen Strict-V2 Baseline

| Window | N | Median | Avg ex-best | Hit | PF | Rug | Catastrophic | Worst | Pass |
|---|---:|---:|---:|---:|---:|---:|---:|---:|:---:|
| train | 67 | 11.41% | 5.85% | 88.06% | 23.68 | 4.48% | 5.97% | -100.00% | no |
| validation | 30 | 12.87% | 9.28% | 86.67% | 3.88 | 0.00% | 3.33% | -73.53% | no |
| holdout1 | 34 | 12.18% | 245.98% | 73.53% | 35.99 | 0.00% | 14.71% | -104.85% | no |
| holdout2 | 35 | 9.73% | -1.52% | 71.43% | 1.00 | 0.00% | 11.43% | -107.09% | no |

## Locked Causal-Wallet Candidate

No candidate passed both train and validation.

## Exact-Pool Delay Sensitivity

| Delay | Entries | Coverage | Median | Avg ex-best | Hit | Rug | Catastrophic | Worst |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0m | 177 | 100.00% | 11.07% | 108.11% | 80.79% | 1.69% | 9.04% | -107.09% |
| 2m | 102 | 57.63% | 12.27% | 5.34% | 81.37% | 0.00% | 4.90% | -107.09% |
| 5m | 69 | 38.98% | 11.22% | -1.17% | 73.91% | 0.00% | 10.14% | -98.23% |
| 10m | 62 | 35.03% | 11.31% | 7.53% | 82.26% | 0.00% | 3.23% | -74.51% |

Delay rows use the next source-linked exact-pool wallet entry within 90 seconds. Missing fills are excluded, so these figures are diagnostic rather than executable backtest proof.

## Required Next Gate

A new version may run only as an isolated future shadow. Paper entry requires at least 30 future distinct markets, seven complete UTC days, exact-pool fill replay, creator/funder independence, median and ex-best average above zero, hit rate at least 60%, profit factor at least 1.2, catastrophic/rug rate at most 5%, worst outcome at least -35%, and best-winner share at most 40%.