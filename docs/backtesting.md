# Backtesting

The replay engine processes events in event time, applies provider latency, fees, slippage, failed-fill assumptions, liquidity constraints, max position sizing, stop-loss, take-profit, and time-based exits.

Reports are exported as JSON, CSV, Markdown, and chart-ready series. Required metrics include total PnL, win rate, profit factor, max drawdown, median return, tail losses, average hold time, signal precision by confidence bucket, rug exposure, liquidity failure rate, and performance by liquidity/token-age/wallet cohort.

The engine must avoid lookahead bias and survivorship bias. Historical provider payloads should be stored when available so features are computed from only what was known at the replay timestamp.

## Wallet-alpha managed-exit model selection

Run `npm run research:wallet-alpha-managed-shadow` only as a bounded read-only comparison. It reads
the current source-score ranking, evaluates at most 25 wallets by default (hard ceiling 100), adds a
small bounded low-score control cohort, and writes
`reports/wallet-alpha-managed-shadow-latest.{json,md}`. It neither saves managed scores nor emits
signals. The selection is explicitly biased model-development evidence; it is not the untouched
chronological validation set.

Environment bounds are `WALLET_ALPHA_MANAGED_SHADOW_MAX_WALLETS` and
`WALLET_ALPHA_MANAGED_SHADOW_SCORE_READ_LIMIT`. Do not schedule the query on the shared host until
its PostgreSQL plan, runtime, RSS and co-tenant impact are measured. Promotion requires a frozen
policy, realistic threshold-crossing fills, a future-only shadow cohort and the normal seven-day /
fourteen-day acceptance gates.

`npm run benchmark:wallet-alpha-managed` exercises one production-sized 100-wallet scoring batch
with 6,000 trades, 3,000 entries and 3,000 managed outcomes under a 112 MiB Node heap. It fails when
runtime exceeds ten seconds, heap exceeds 100 MiB, RSS exceeds 160 MiB, or deterministic watch
counts differ. This generated benchmark is an anti-regression gate, not live-provider validation.

## Qualified-pool paper strategy

`qualified-pool-paper-v1` is deliberately isolated from wallet-alpha scoring so its results cannot
be mistaken for wallet followability evidence. The initial $100 live paper cohort uses future-only
qualified-pool notifications, exact-pool confirmation, $12 liquidity-capped positions and at most
three simultaneous positions. It models fees and adverse slippage, recovers capital after a +75%
move, retains a trailed runner, and records zero proceeds when a pool becomes demonstrably
unsellable.

Do not optimize thresholds on the same cohort used to report performance. Freeze this version for
the first chronological holdout and report every rejected candidate. After at least 14 days, compare
it with predeclared alternatives using final balance, profit factor, max drawdown, rug exposure,
liquidity-failure rate, median return and tail loss. A higher gross return does not win if it depends
on impossible post-rug fills or materially worse tail risk.

The v1 cohort is frozen as a negative control. `qualified-pool-paper-v2` is a separately activated,
future-only conservative cohort: five-minute exact-pool confirmation, stricter liquidity/volume/buy
share/turnover admission, two $8 positions at most, pessimistic costs, earlier capital recovery and
shorter risk/time exits. Never copy candidates, trades or cash between versions. Compare only after
both have enough chronological observations; a new $100 v2 portfolio is a new experiment, not a
reset of v1 losses.
