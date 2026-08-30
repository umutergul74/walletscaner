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
`WALLET_ALPHA_MANAGED_SHADOW_SCORE_READ_LIMIT`. The report reads evidence in bounded wallet batches
(`WALLET_ALPHA_MANAGED_SHADOW_BATCH_SIZE`, default 5, maximum 10) and admits followability entries
only when the durable source-buy timestamp proves detection within
`WALLET_ALPHA_MANAGED_SHADOW_MAX_ENTRY_DELAY_SECONDS` (default 60 seconds). Unknown, negative or
slower timing is reported and excluded. Outcome construction is exact-pool: a same-mint quote from
another pool is missing evidence, never a substitute fill. Do not schedule the query on the shared
host until its PostgreSQL plan, runtime, RSS and co-tenant impact are measured. Promotion requires a
frozen policy, realistic threshold-crossing fills, a future-only shadow cohort and the normal
seven-day / fourteen-day acceptance gates.

The production sampler also treats `(token, pool)` as the market work key. A batched token response
may satisfy several exact pools, but every selected pair gets its own deterministic observation.
Only a new outcome or a monotonic `provisional -> unresolved/mature -> mature` transition reaches
PostgreSQL; repeated same-state calculations remain telemetry, not write amplification.

`npm run benchmark:wallet-alpha-managed` exercises one production-sized 100-wallet scoring batch
with 6,000 trades, 3,000 entries and 3,000 managed outcomes under a 112 MiB Node heap. It fails when
runtime exceeds ten seconds, heap exceeds 100 MiB, RSS exceeds 160 MiB, or deterministic watch
counts differ. This generated benchmark is an anti-regression gate, not live-provider validation.

## Future survival/execution decision tape

The current local collection version is `survival-execution-tape-v2-20260830` (migration 053).
It preserves v1 outcomes and risk gates but freezes a four-per-hour sample, one-at-a-time collection
and a 10-second maximum measurement lateness. Initial entry must become terminal before a later
sell checkpoint can be claimed. Late/missing evidence remains in the denominator; it is not
retrospectively quoted or silently dropped. `timing_status=on-time` is necessary, not sufficient:
provider/risk/coverage/identity evidence must also pass. The hourly cap is not random sampling or
independent chain coverage, and the sample must not be presented as the full Solana market.

`survival-execution-tape-v1-20260830` is an evidence-collection contract, not a strategy or a
positive alpha claim. It freezes one exact-pool decision before any later outcome and records fixed
short-horizon path, liquidity and two-way executable quote evidence. The entry quantity for every
later sell check is the minimum output from the decision-time buy quote, so later price knowledge
cannot resize a historical entry. Missing, stale, wrong-pool, provider-error and no-route outcomes
stay in the denominator.

Do not optimize a selector while this cohort matures. After at least seven stable future days and
30 distinct mature markets, run a chronological survival-first analysis with the predeclared
market-only and shuffled-identity controls. A promotable hypothesis must have positive median and
average return excluding its best winner, profit factor at least 1.30, catastrophic-loss and rug
rates at most 3%, best-winner contribution at most 30%, exact-pool two-way quote coverage and
independently verified identity evidence. Failure rejects the hypothesis; it does not authorize
weaker gates. Any later paper version is new and future-only and still requires at least 14 days.

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

`qualified-pool-paper-v3-strict-flow` is another isolated, future-only $100 experiment. Its input
must carry `strict-flow-v2-20260817`; legacy broad alerts are ineligible. The decision-time payload
freezes pool age, exact-pool 5-minute buys/sells, buy share, volume/liquidity, top-10 concentration,
risk evidence time and coverage. Two minutes later the paper worker re-fetches the exact pool and
reapplies 20-transaction, 50%-60% buy-share, sub-0.50 turnover and 90% liquidity-retention gates.
At most two $6 positions/$12 aggregate exposure are allowed. V3 must be reported independently and
cannot be used to rewrite or pool v1/v2 performance.
