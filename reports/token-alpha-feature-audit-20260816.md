# Token Alpha Feature Audit — 2026-08-16

## Decision

The current wallet-alpha gates must not be weakened. High-ranked observed wallets have strong
central returns but still encounter terminal-like losses. The next alpha phase should therefore
test whether entry-time token/flow evidence can exclude catastrophic tokens before a wallet signal
is eligible.

This document records model-discovery evidence only. It enables no signal, Telegram alert, paper
entry or live execution.

## Prospective freeze

At `2026-08-16T20:51:05.137545Z`, production appended the immutable/idempotent hypothesis run
`token-alpha-strict-v1-future-freeze`. It records the exact strict profile and acceptance gates
below with `paperEnabled=false`, `telegramEnabled=false` and `liveExecutionEnabled=false`.
Only evidence observed after this timestamp belongs to the future-only cohort. The declaration is
append-only (`ON CONFLICT DO NOTHING`); changing a threshold requires a new version and a new
activation boundary, never an edit or backfill into v1.

## Wallet baseline

The latest top 100 `observed` wallets averaged:

- 302.44 completed positions and 159.25 unique tokens across 14.86 active days;
- realized median return 3.09%, hit rate 61.09% and profit factor 6.45;
- managed-followability median return 52.01%, hit rate 70.24% and profit factor 9.42;
- managed-followability worst return -103.00% on average.

There were zero latest `watch`, `candidate` or `validated-paper` wallets and zero persisted
wallet-alpha signals at this boundary. The catastrophic tail, not the central return, is the binding
problem.

## Entry-feature discovery sample

Method:

- UTC window: the seven days ending 2026-08-16;
- one earliest source-linked, risk-passed entry per exact `(token, pool)`;
- managed `tp15-sl20-20m` mature outcome;
- only fields already known at entry time;
- 40-minute embargo between chronological windows in the reusable walk-forward design;
- no wallet address or raw payload exported.

The deduplicated baseline contained 139 markets. Its chronological 70/30 diagnostic split was:

| Period | Markets | Average | Median | Hit rate | PF | Catastrophic <= -50% | Worst |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Earlier 70% | 98 | 7.43% | 16.77% | 64.29% | 1.42 | 15.31% | -102.66% |
| Later 30% | 41 | 8.96% | 13.70% | 65.85% | 1.60 | 14.63% | -83.06% |

The strongest simple pre-entry profile discovered was:

- top-10 holder concentration below 20%;
- five-minute buy share from 50% up to, but not including, 60%;
- five-minute volume/liquidity ratio below 0.50;
- existing fail-closed authority, holder, exact-pool and controlled-flow gates still required.

Its diagnostic split was:

| Period | Markets | Average | Median | Hit rate | Catastrophic <= -50% | Worst |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Earlier 70% | 14 | 40.21% | 25.61% | 100% | 0% | 7.42% |
| Later 30% | 5 | 23.68% | 28.16% | 100% | 0% | 9.55% |

The broader profile (`top10 < 40%` with the same flow bounds) selected 25 markets. Its earlier
19-market slice had 34.06% average, 26.02% median, 94.74% hit rate, PF 33.46 and no catastrophic
loss; its later six markets were all positive.

## Bias and limits

These are not untouched holdouts: the thresholds and implementation direction were chosen after
inspecting this historical window. The sample is also small, DEX Screener marks are not executable
fills, pool liquidity may change between polls, and shared-funder/insider independence is not yet
available in canonical evidence. No profitability claim should be made from these numbers alone.

## Future-only gate

Freeze the strict profile above before collecting the next sample. It may advance to a separately
versioned paper cohort only after all of the following hold on post-activation data:

- at least seven complete UTC days and 30 distinct exact `(token, pool)` markets;
- median net return >= 0 and average excluding the best winner > 0;
- hit rate >= 60%, profit factor >= 1.2 and best-winner share <= 40%;
- catastrophic-loss rate <= 5% and worst executable outcome >= -35%;
- exact-pool entry/exit evidence with measured signal-to-fill latency and liquidity-aware slippage;
- no shared-funder, creator or strong synchronized-wallet cluster counted as independent alpha;
- resource, single-delivery and storage gates remain healthy.

After that, require at least fourteen further days in a new isolated $100 paper portfolio before
considering any separately authorized live-capital phase.

## Funder/cluster next step

Current standard-WebSocket wallet-trade rows prove signer/venue authority but do not retain original
wallet funding source. Funder enrichment therefore requires a bounded external lookup and immutable
cache. It must run only for shortlisted wallets, never for the entire observed population. Unknown
or failed funding evidence remains non-independent and cannot help a token pass.
