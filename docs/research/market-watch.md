# Market Watch

Run:

```bash
npm run research:market-watch
```

This command runs the live Solana alpha scan, updates cumulative token and wallet state, refreshes recent tracked token prices from DEX Screener, and compares methods:

- `high-traction`
- `cross-token-wallet`
- `active-degen-history`

The report separates a raw leader from a validated method:

- `bestMethod: none` means no method currently clears the evidence and risk filters.
- `leadingMethod` is only the best-ranked raw cohort; it is not a trade signal.
- `decisionStatus.recommendedMode: observe-only` means keep collecting data and do not treat the report as actionable.
- `decisionStatus.recommendedMode: paper-watch` means a weak paper-only pattern exists, but no validated method exists.
- `decisionStatus.watchRule` and `decisionStatus.watchPaperExit` name weak hypotheses that need more evidence.
- `decisionStatus.rawCandidateMethod`, `rawCandidateRule`, and `rawCandidatePaperExit` can look promising in the current snapshot, but do not change the mode by themselves.
- `rawWatch*` fields are also snapshot-only until the time persistence gate promotes them to `watch*`.
- A method, rule, or paper exit must retain candidate quality for at least three recorded runs over 120 minutes and add at least two new signals before it can become validated.
- Those new signals are evaluated as a post-discovery holdout. Validation also requires holdout average return of at least 2%, non-negative median, at least 50% hit rate, and no result below -35%.
- A method, rule, or paper exit needs at least two qualifying runs over 30 minutes before it can become watch-only.
- `decisionStatus.leadingWallet` is only the strongest current wallet evidence; it can still be rejected.
- `decisionStatus.watchWallet` requires at least three tracked-token outcomes and watch-quality evidence in two consecutive runs.
- `decisionStatus.validatedWallet` requires at least four tracked-token outcomes, high confidence, controlled downside, and candidate-quality evidence in three consecutive runs.
- `decisionHistory` keeps the latest decision modes, rule outcomes, paper-exit outcomes, and per-wallet evidence so changes can be judged across runs.
- `methodSignals` measures each method from the first observation where that method appeared for a token, not merely from the token's first tracked price.
- `ruleCandidates` tests stricter filters using only signal-time features such as liquidity, buy pressure, and wallet-event count.
- Rule and method statistics include median return, average return without the single best sample, and best-winner share so one extreme winner cannot validate a weak cohort.
- Rule and exit cohorts deduplicate by token address so one token cannot count as several independent samples through multiple method tags.
- Controlled-momentum cohorts record signal-time five-minute and one-hour price change, pair age, and volume-to-liquidity ratio to test anti-chasing hypotheses on future samples.
- `paperExitCandidates` simulates simple paper-only take-profit, stop-loss, and timeout exits over observed samples.
- Paper-exit verdicts use net returns after a conservative 3% estimated round-trip cost; reports keep gross and net averages separate.
- `topWallets[].walletConfidence` stays `early` until a wallet has repeated outcome evidence across multiple tracked tokens.
- `topWallets[].walletVerdict` remains `reject` until the stricter outcome and risk thresholds are met; a high raw score alone is insufficient.
- Wallet returns start from the token price observed when that wallet first appears in a live buy scan. Earlier token gains are not credited to a wallet discovered later.
- Legacy wallet labels and buy counts remain visible for context, but only `walletSignals` with an observed entry price can contribute to wallet outcomes, confidence, or validation.
- Wallets with no observed-entry outcomes are capped at a low research score and rank below wallets with measured outcomes.
- Wallet validation uses a fixed 20-minute outcome. The first price observation between 20 and 40 minutes after detection freezes the result; younger entries remain provisional and cannot raise confidence or validation.

Outputs:

- `reports/market-watch-latest.md`
- `reports/market-watch-latest.json`
- `reports/market-watch-state.json`

Useful controls:

- `MARKET_WATCH_CYCLES`: number of scan/evaluate cycles.
- `MARKET_WATCH_INTERVAL_SECONDS`: wait time between cycles.
- `MARKET_WATCH_RUN_SCAN=false`: evaluate existing live report without running a fresh scan.
- `MARKET_WATCH_REFRESH_TOKENS`: number of previously tracked tokens to refresh.
- `MARKET_WATCH_PAPER_ROUND_TRIP_COST_PCT`: estimated paper entry/exit cost, default `3`.
- `MARKET_WATCH_WALLET_OUTCOME_HORIZON_MINUTES`: fixed wallet outcome horizon, default `20`.
- `MARKET_WATCH_WALLET_OUTCOME_MAX_DELAY_MINUTES`: allowed delay for the first post-horizon price observation, default `20`.

The evidence is only as strong as the number of elapsed cycles. Do not treat early results as a trading instruction.
