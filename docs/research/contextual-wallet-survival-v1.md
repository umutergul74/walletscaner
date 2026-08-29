# Contextual Wallet Survival Research

## Status

`contextual-wallet-survival-v1-20260829` is an immutable, local-only falsification run. It is not a
production strategy and cannot emit Telegram, paper or live orders. The restored PostgreSQL 16
snapshot is model-development evidence through 27 August 2026; none of it is an untouched future
holdout.

The verdict is **reject**. Do not loosen the policy on the same history.

## Question and causal contract

The tested question was whether a token's decision-time market context plus the completed histories
of wallets entering its exact pool could identify a survivable, followable launch better than market
features alone.

The implementation deliberately separates:

1. terminal rug/unsellable hazard;
2. conditional return when the market survives;
3. wallet contribution after partial pooling;
4. raw evaluation after conservative 7.1% round-trip friction.

There is one decision per exact pool. Outcomes become learnable only after `frozen_at` is strictly
earlier than the next decision. A 100-completed-market burn-in precedes an online top-decile rule.
The survival head uses a one-sided uncertainty bound and blocks selection above 12%. Model targets
are winsorized at -100/+100, while evaluation keeps the raw positive tail and terminal loss. Every
policy uses the same chronological windows and 40-minute embargo.

The fixed controls are broad risk-passed flow, market-only scoring and a deterministic shuffled
wallet-identity negative control. Promotion required every all/train/validation/holdout window to
meet sample/day, median, average-ex-best, hit-rate, profit-factor, rug/catastrophic-loss and winner
concentration gates, and to beat both controls in all later windows.

## Result

The read-only audit evaluated 1,370 exact-pool decisions from 12 July through 27 August. It selected
49 contextual-wallet decisions:

- average return: -1.87%;
- median return: +13.63%;
- average excluding the best winner: -2.94%;
- hit rate: 71.43%;
- profit factor: 0.87;
- catastrophic-loss rate: 10.20%;
- worst modeled return: -104.85% including the conservative missing-cost adjustment.

The first chronological window failed tail and profit-factor gates. Validation selected nine
markets and also failed. Holdout 1 selected none; holdout 2 selected only one, far below the minimum.
Market-only selected none under the survival and uncertainty contract. The wallet-shuffle control
selected two. No future shadow, paper or delivery path is authorized.

The important lesson is that win rate and median were misleading. Five losses below -50% erased 38
wins. Four appeared within approximately nine hours on 20 July, demonstrating launch-regime drift
and correlated tail risk rather than independent Bernoulli trades.

## Why the available features cannot solve it

All 49 selected markets were from the same launch-program/context bucket. Winners and catastrophic
losses materially overlapped on every persisted decision feature:

- winner/catastrophic median liquidity: about $21.5k / $22.2k;
- median five-minute volume: about $10.4k / $10.1k;
- median transactions: 283 / 275;
- median buy share: 53.18% / 52.73%;
- median volume/liquidity: 0.49 / 0.47;
- median pool age: 5.62 / 5.55 minutes;
- median top-10 concentration: 12.70% / 12.70%.

Therefore another liquidity, volume, buy-share, age or top-10 threshold search on this cohort would
be data mining, not a credible strategy. Address-level wallet repetition is also not independent
support: dozens of addresses may share a funder, bundle, creator or automation cluster. Selecting
the best address histories without cluster proof creates a multiple-comparison advantage that is
not safely tradable.

## Next strategy — survival and execution before wallet alpha

The next defensible strategy family is not another static threshold grid. It is a future-only,
multi-stage decision system whose missing evidence fails closed:

1. **Coverage and finality:** admit only controlled, gap-free, finalized exact-pool evidence.
2. **Program and sellability:** block retained authorities, behavior-changing Token-2022 extensions,
   mutable transfer controls, unknown program ownership and any failed two-way sellability probe.
3. **Economic exit surface:** record direct exact-pool executable buy and sell quotes for $6, $25
   and $100, including price impact, route identity, platform/priority fees, response latency,
   quote age and failure reason. A market snapshot is never a fill.
4. **Identity graph:** resolve creator, first funder, shared funder, bundle/co-slot participation,
   common transaction authority and repeated coordinated entry. Pool, vault, program and creator
   identities are excluded. Address count is never treated as independent support.
5. **Early path and flow:** retain bounded 15s/30s/60s/2m/5m price, liquidity and quote-depth deltas;
   unique funded buyer/seller counts; cluster-adjusted net flow; concentration change; max adverse
   excursion; failed-sell and liquidity-removal events.
6. **Calibrated survival head:** estimate terminal hazard with time decay and launch-program/regime
   context. Use a conservative upper confidence bound, calibration error and drift detector; an
   unhealthy or out-of-distribution regime produces no signal.
7. **Conditional followability head:** only after survival passes, estimate size-specific net return
   from causally completed wallet and market histories with partial pooling. Compare against
   market-only, shuffled-identity and delayed-entry controls.
8. **Portfolio guard:** paper-only starting balance $100, at most two concurrent positions, no
   averaging down, and loss bounded primarily by small notional rather than an imaginary stop.
   One terminal hazard or a predeclared daily expected-shortfall breach pauses new entry until a
   fresh calibrated regime window passes. Exit decisions use executable sell quotes; absence of a
   sell route is a terminal loss, never a credited stop fill.

This design deliberately makes a low signal rate acceptable. The objective is positive expected
value after tail loss and execution, not a busy Telegram feed.

## Required future acceptance

Before a paper candidate exists, the new decision tape needs at least seven stable future-only days,
30 mature distinct markets overall and enough samples in each chronological window. It must pass the
repository's standard coverage/latency/replay gates and show positive median and average excluding
the best winner, profit factor at least 1.30, catastrophic and rug rates no greater than 3%, best
winner share no greater than 30%, stable calibration, and superiority to market-only,
wallet-shuffle and realistic delayed-fill controls. Fourteen additional paper-only days with
size-aware exact-pool quote/fill evidence are required before any discussion of real capital.

The immediate engineering priority is the bounded decision tape for stages 2–5. Training a more
complex model before those fields exist would only fit the same insufficient evidence more tightly.
