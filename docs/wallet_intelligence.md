# Wallet Intelligence

Wallet-alpha v2 answers three different questions and does not collapse them into one raw ROI score:

1. **Realized profitability:** did the wallet actually sell enough inventory to realize after-cost profit?
2. **Followability:** after the bot first observed the wallet, was a comparable return still available?
3. **Reliability/risk:** is the evidence large, diverse, recent and safe enough to trust?

A rising token price is not wallet profit. An early wallet is not automatically copyable. A high historical return from one winner is not alpha.

## Eligible trade evidence

Wallet trade evidence must have:

- chain `blockTime` for deterministic ordering;
- a wallet verified as message signer/fee payer or venue user authority;
- a base-token balance change for the active pool;
- a matching quote leg for priced accounting;
- exact `rawAmount` and decimals when available;
- a deterministic key containing signature, transaction/instruction coordinates, wallet, mint, side and decoder version.

Pool vaults, token/quote mints and supplied router/program infrastructure are rejected as wallets. Token transfers without a quote leg do not generate priced realized PnL. Airdrops and wallet-to-wallet transfers therefore do not qualify as buys/sells merely because a token balance changed.

## FIFO accounting

For each `(wallet, token)` pair:

1. Buys create FIFO lots with after-cost basis.
2. A sell consumes the oldest open lots up to the sold raw amount.
3. Every matched partial sell produces a realized episode with allocated basis, proceeds, net PnL and remaining inventory.
4. Unsold inventory remains an open moonbag; it is not assumed to be realized profit.
5. When inventory reaches zero, the round trip ends. A later buy starts the next episode.
6. Duplicate and out-of-order inputs are sorted/deduplicated before accounting.

The default research round-trip cost is 3%, split across buy and sell sides. Exact paper fills have their own fee/slippage model.

## Profitability metrics

The scorer calculates, over rolling 30- and 90-day windows:

- sample count, unique tokens and active days;
- average and median return;
- average return with the best winner removed;
- hit rate and 95% Wilson lower bound;
- Beta-prior shrunk hit rate and sample reliability;
- profit factor;
- best-winner share of positive returns;
- worst return and maximum drawdown;
- high-quality execution coverage;
- open-inventory count and cost.

Scoring blends 30-day (65%) and 90-day (35%) quality when recent data exists, then applies a 30-day half-life recency factor. Small samples are shrunk toward neutral rather than promoted by a few large outcomes.

## Followability

Followability starts at a source-linked bot observation, never at the wallet's earlier execution. A mature fixed-horizon outcome contributes only when it belongs to the same strategy version and entry evidence.

Profitability and followability must independently pass their gates. A wallet cannot become a candidate from market outcomes alone when no realized sell ledger exists.

### Managed-exit v2 shadow policy

`wallet-alpha-managed-v2` is a read-only model-selection shadow over canonical `evidence-v1`; it is
not a new evidence writer and does not create wallet-alpha signals. It evaluates the already-frozen
`tp15-sl20-20m` outcome for followability while retaining realized FIFO profitability as an
independent axis. The evidence namespace, score namespace and scoring policy remain explicit so the
fixed-horizon and managed-exit models cannot be silently mixed.

The initial managed watch gate is predeclared rather than fitted wallet by wallet:

- at least 15 realized positions and 30 managed followability outcomes;
- at least four active realized-trade days;
- realized median non-negative, average excluding best positive, hit rate at least 50% and PF at
  least 1.1;
- managed median non-negative, average excluding best positive, hit rate at least 55% and PF at
  least 1.2;
- terminal-rug rate at most 5% and return-at-or-below -50% rate at most 5%.

Candidate keeps the 90% execution-quality and 40% winner-concentration gates, requires at least
30/30 samples and seven active days, and tightens terminal-rug frequency to 2.5%. Validation still
requires 14 active days plus two separate chronological ten-sample holdouts. A managed holdout may
not exceed 10% terminal-rug or catastrophic-loss frequency. The fixed-horizon v1 gates remain
unchanged and provide the stress/control series.

Managed metrics include explicit rug count/rate, catastrophic-loss count/rate, worst-decile mean
and longest chronological losing streak. A single tail event still reduces the score, but only a
measured tail frequency blocks the watch gate. This avoids both zero-tolerance false negatives and
unsafe blanket relaxation.

The current TP/SL evidence uses provider observations plus a flat 3% round-trip cost. It is not yet
proof of an executable fill at the threshold. Detection/exit latency, liquidity-sensitive
slippage, gap-through-stop behavior and zero proceeds after a terminal rug remain mandatory before
any managed score can feed Telegram or paper entry.

## Status gates

All sample counts below use the current 90-day window.

| Status            | Gate                                                                                                                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observed`        | At least 3 realized episodes **or** 3 mature followability results                                                                                                                                                                      |
| `watch`           | At least 8 realized and 8 followability results, 4 active days; median non-negative, average excluding best winner positive, hit rate at least 50%, PF at least 1.1; followability worst return at least -35%                           |
| `candidate`       | At least 15/15 results, 7 active days, at least 90% high-quality realized-price coverage, hit rate at least 55%, PF at least 1.2, winner share at most 40%; both axes pass robust gates and followability worst return is at least -35% |
| `validated-paper` | Candidate plus at least 30/30 results, 14 active days, and two consecutive chronological 10-sample holdouts passing for both profitability and followability                                                                            |
| `excluded`        | Direct creator wallet in the observed token set                                                                                                                                                                                         |

Each holdout requires non-negative median, positive average excluding the best winner, hit rate at least 50%, PF at least 1.2 and worst return at least -35%.

Those rows describe the production-compatible `fixed-horizon-v1` policy. The managed-exit shadow
uses the separately documented rate-based tail gates and never changes these v1 classifications.

`observed-execution` and `oracle-converted` are the only high-quality v2 price classes. Market proxies and historical estimates remain visible but cannot help satisfy the 90% candidate coverage gate.

## Signal risk gates

A wallet score and a token-entry signal are separate decisions. Even a qualified wallet cannot produce a paper signal unless the entry contains:

- `tokenRiskKnown=true`;
- `tokenRiskPassed=true`;
- sufficient observed liquidity;
- a recent source-linked observation.

Risk assessment fails closed when mint/freeze authority or holder concentration cannot be established. Direct creators are excluded at score time.

The approved design also calls for creator/funder links, strong insider/bundler clusters and critical unknown security evidence to block candidacy. Only the direct-creator and token-risk gates are currently connected end-to-end; funded-by and cluster exclusions remain a production-readiness gap.

## Ranking and explanation

The overall score weights profitability at 55% and followability at 45%. Reliability is retained separately from headline returns and includes lower-bound/sample-reliability information. Status rank is sorted before overall score so a small high raw score cannot outrank a wallet that passed stronger gates.

Every snapshot stores metrics, gate booleans and human-readable reasons. The API returns the latest profile, score history, recent trades and materialized episodes at `/api/wallets/:address/alpha`.

## Legacy labels

The earlier generic wallet scorer still exposes labels such as `alpha_wallet`, `copyable_smart_wallet`, `insider_dev_linked`, `sniper_bot`, `bundler_cluster`, `market_maker`, `noise_wallet` and `high_risk_wallet`. These are not wallet-alpha v2 promotion states and must not be used as substitutes for the evidence gates above.

## Remaining validation

Before alert enablement, validate on real fixtures and shadow data that:

- vault/PDA/router addresses never enter rankings;
- partial sells and multiple round trips match hand-computed FIFO results;
- Token-2022, ATA creation, inner instructions and multi-swap transactions retain exact raw amounts;
- duplicate/out-of-order replay produces identical ledger and score hashes;
- creator/funder/cluster enrichment blocks the required cases;
- candidate wallets sustain at least 90% high-quality execution coverage;
- two chronological holdout pairs pass on genuinely future data, not a re-fit sample.
