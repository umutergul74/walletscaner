# Contextual Wallet Survival V1 Audit

Generated: 2026-08-29T20:52:01.243Z
Decision hash: `e674a3a854411b59d52d5fc9cf4225d6608fdb9fb12c51e5d7bfb5c5b4d37fde`

## Decision

- Verdict: **reject**
- Eligible exact-pool markets: 1370
- Decision range: 2026-07-12T15:39:59.537Z -> 2026-08-27T17:13:55.754Z
- This result can never authorize live execution. A pass permits only a future-only isolated shadow cohort.

## Policy comparison

| Policy | Window | N | Days | Avg | Median | Avg ex-best | Hit | PF | Rug | Catastrophic | Best share | Pass |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| broad | all | 1270 | 26 | -1.86% | 8.26% | -9.98% | 53.31% | 0.92 | 0.08% | 14.41% | 40.59% | average-ex-best<=2, hit-rate<60%, profit-factor<1.3, catastrophic-rate>3%, best-winner-share>30% |
| broad | train | 446 | 5 | 16.69% | 9.67% | -6.44% | 59.42% | 1.88 | 0.00% | 12.56% | 64.91% | average-ex-best<=2, hit-rate<60%, catastrophic-rate>3%, best-winner-share>30% |
| broad | validation | 270 | 8 | -14.17% | 2.61% | -14.55% | 50.74% | 0.44 | 0.00% | 16.67% | 2.94% | average-ex-best<=2, hit-rate<60%, profit-factor<1.3, catastrophic-rate>3% |
| broad | holdout1 | 267 | 9 | -9.61% | 2.50% | -10.05% | 51.31% | 0.55 | 0.00% | 13.11% | 3.43% | average-ex-best<=2, hit-rate<60%, profit-factor<1.3, catastrophic-rate>3% |
| broad | holdout2 | 273 | 7 | -11.81% | -4.53% | -12.55% | 47.99% | 0.51 | 0.37% | 16.85% | 5.67% | median<=0, average-ex-best<=2, hit-rate<60%, profit-factor<1.3, catastrophic-rate>3% |
| marketOnly | all | 0 | 0 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00 | 0.00% | 0.00% | 0.00% | count<30, active-days<7, median<=0, average-ex-best<=2, hit-rate<60%, profit-factor<1.3 |
| marketOnly | train | 0 | 0 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00 | 0.00% | 0.00% | 0.00% | count<12, active-days<2, median<=0, average-ex-best<=2, hit-rate<60%, profit-factor<1.3 |
| marketOnly | validation | 0 | 0 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00 | 0.00% | 0.00% | 0.00% | count<8, active-days<1, median<=0, average-ex-best<=2, hit-rate<60%, profit-factor<1.3 |
| marketOnly | holdout1 | 0 | 0 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00 | 0.00% | 0.00% | 0.00% | count<8, active-days<1, median<=0, average-ex-best<=2, hit-rate<60%, profit-factor<1.3 |
| marketOnly | holdout2 | 0 | 0 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00 | 0.00% | 0.00% | 0.00% | count<8, active-days<1, median<=0, average-ex-best<=2, hit-rate<60%, profit-factor<1.3 |
| shuffledWallet | all | 2 | 2 | -13.48% | -13.48% | -35.37% | 50.00% | 0.24 | 0.00% | 0.00% | 100.00% | count<30, active-days<7, median<=0, average-ex-best<=2, hit-rate<60%, profit-factor<1.3, best-winner-share>30% |
| shuffledWallet | train | 1 | 1 | 8.41% | 8.41% | 0.00% | 100.00% | 999.00 | 0.00% | 0.00% | 100.00% | count<12, active-days<2, average-ex-best<=2, best-winner-share>30% |
| shuffledWallet | validation | 1 | 1 | -35.37% | -35.37% | 0.00% | 0.00% | 0.00 | 0.00% | 0.00% | 0.00% | count<8, median<=0, average-ex-best<=2, hit-rate<60%, profit-factor<1.3 |
| shuffledWallet | holdout1 | 0 | 0 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00 | 0.00% | 0.00% | 0.00% | count<8, active-days<1, median<=0, average-ex-best<=2, hit-rate<60%, profit-factor<1.3 |
| shuffledWallet | holdout2 | 0 | 0 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00 | 0.00% | 0.00% | 0.00% | count<8, active-days<1, median<=0, average-ex-best<=2, hit-rate<60%, profit-factor<1.3 |
| contextualWallet | all | 49 | 7 | -1.87% | 13.63% | -2.94% | 71.43% | 0.87 | 0.00% | 10.20% | 7.80% | average-ex-best<=2, profit-factor<1.3, catastrophic-rate>3% |
| contextualWallet | train | 40 | 3 | -2.22% | 13.62% | -3.54% | 75.00% | 0.85 | 0.00% | 12.50% | 9.93% | average-ex-best<=2, profit-factor<1.3, catastrophic-rate>3% |
| contextualWallet | validation | 8 | 3 | -3.18% | 1.56% | -10.20% | 50.00% | 0.82 | 0.00% | 0.00% | 40.36% | average-ex-best<=2, hit-rate<60%, profit-factor<1.3, best-winner-share>30% |
| contextualWallet | holdout1 | 0 | 0 | 0.00% | 0.00% | 0.00% | 0.00% | 0.00 | 0.00% | 0.00% | 0.00% | count<8, active-days<1, median<=0, average-ex-best<=2, hit-rate<60%, profit-factor<1.3 |
| contextualWallet | holdout2 | 1 | 1 | 22.69% | 22.69% | 0.00% | 100.00% | 999.00 | 0.00% | 0.00% | 100.00% | count<8, average-ex-best<=2, best-winner-share>30% |

## Fixed acceptance contract

Every all/train/validation/holdout window needs enough distinct markets and days, positive median, average excluding the best winner above 2%, hit rate >=60%, profit factor >=1.30, rug and catastrophic-loss rates <=3%, and best-winner share <=30%. The contextual policy must also beat market-only and wallet-identity-shuffle controls in every later window.

## Limitations

- Historical prices are exact-pool market observations, not executable Jupiter fills.
- Distinct wallet addresses are not yet proven independent funder/bundle clusters.
- Token-2022 behavior-changing extensions and mutable program controls are not complete historical features.
- Portfolio concurrency, capital contention and failed transaction probability are not modeled by this market-quality audit.
- All currently available history is model-development evidence and cannot be an untouched future holdout.
- A passing audit can authorize only an isolated future shadow; Telegram, paper and live execution remain disabled.
