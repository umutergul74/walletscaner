# Walletscaner live data and alpha audit — 30 August 2026

Observation: 20:12–20:29 UTC (23:12–23:29 Europe/Istanbul). Read-only production investigation;
source baseline `9a72447`. No service, image, schema, provider configuration, canonical data, B2
object, Telegram delivery or paper state was changed. Only this report and agent handoff documents
were written locally.

## Verdict

Collection is operational but incomplete for alpha validation. There is no validated profitable
strategy and no current qualified wallet-alpha signal. Waiting unchanged is not the correct next
step: price authentication is not loaded in the active process, the alpha queue is growing, the
new exact-pool decision tape is not deployed, and storage has not reached equilibrium.

## Signals, research candidates and paper performance

- Exact database queries returned zero rows in both `wallet_alpha_signals` and `signals`.
- An indexed latest-score query returned zero current `watch`, `candidate` or `validated-paper`
  wallets. It does not imply that no profitable wallet exists anywhere on Solana.
- V4 has **65** durable, non-deliverable `qualified-pool` shadow candidates, including **15 in the
  last 24 hours** and 60 in seven days. These are decision snapshots, not admitted alpha signals.
- The last 24h's 15 candidates were all older than 22 minutes. Only **5/15** had any retained
  exact-token/exact-pool observation between decision and +22m; the same five had a +20m to +22m
  mark. Two of those five marks were flagged rugged. This is a missing-evidence/risk diagnostic,
  not a complete cohort return estimate. The older 50 have no retained mark in this window;
  two-day price retention prevents interpreting older missing marks as never collected.
- V4 snapshots do not freeze executable buy/sell quotes, so their existence and elapsed days do
  not establish realistic fills or a successful future holdout. No thresholds were fitted here.

Each paper version began with its own $100. Event cash accounting (not rounded position sums):

| Frozen paper version | Closed positions | Realized PnL | Remaining cash | Terminal rug events |
| --- | ---: | ---: | ---: | ---: |
| qualified-pool-paper-v1 | 91 | -$96.9608 | $3.0392 | 40 |
| qualified-pool-paper-v2 | 3 | -$3.8678 | $96.1322 | 0 |
| qualified-pool-paper-v3-strict-flow | 3 | -$14.1623 | $85.8377 | 2 |

No open positions exist. Paper worker is stopped, V3 is paused; old V1/V2 `active` portfolio labels
are metadata, not evidence that a worker is trading. Last paper event was 21-Aug 02:33 UTC.

The latest completed contextual-survival audit is **29 August**, using a restored snapshot through
27 August, not a fresh live backtest: 1,370 eligible markets, 49 model selections, -1.87% average,
-2.94% excluding the best winner, profit factor 0.87 and 10.20% catastrophic losses. Its 71.43% hit
rate did not produce positive expected returns. Verdict remains reject. The historical report
cannot be relabeled as new future validation.

## Wallet quality

The top three current observed rankings remain below promotion. For example `GmZJbDov…ZF271s` has
727 realized episodes, 347 tokens and 28 active days; reported realized median +3.87% and hit rate
62.45% look attractive. But high-quality execution evidence is only 85.42%, below the 90% gate.
Its fixed-horizon followability has 523 observations, 77 rug outcomes (14.72%) and 128 catastrophic
losses (24.47%). The other two leaders show roughly 21.75–24.05% catastrophic followability losses.
All three fail chronological holdouts. Their scores are research rankings, not copy-trading advice.

The generic stored reason that these wallets lack enough completed/followable trades is misleading
when hundreds exist; tail-risk/holdout/price quality are the actionable failures. This explanation
defect was observed, not changed. Address/funder/bundle independence is still unproven.

## Data quality and bottlenecks

Latest operational report at 20:28:40 UTC:

- 12 services running; PostgreSQL and Redis healthy; running container restart/OOM counts zero.
  Ingestion R45, alpha R43, sampler R29, notifier R23, maintenance/archive R36 and materializer R42
  remain separate deployed artifacts. Paper/API/web/legacy research are not running. Live execution
  is false. The protected co-tenant inventory remains empty and untouched.
- Inbox7, dead-letter0, oldest pending14.1s; last pool3.3s, last wallet trade15.3s.
  Finality pending22, oldest9.5s, unresolved-last24h0. These show progress, not full source coverage.
- 719 sampler cycles across approximately24h saved1,259 exact-market observations and28,676
  outcome transitions, with one provider error and one exact-pool miss. Median-independent mean
  cycle time was2.28s; maximum39.04s. Many wallet outcomes can share one market observation, so
  those counts are not independent samples.
- The 870 alpha-cycle sample spans approximately24h: pending10,788 ->18,265 despite42,150 wallet
  revision evaluations and25,223 low-evidence skips. Current queue is dominated by price enrichment
  (15,594 in a nearby snapshot), with1,548 elevated and no signal-lane items. One evidence-limit
  quarantine is distinct from transient errors. Background readiness reached approximately15.8h;
  the oldest total item includes the multi-day quarantine. R46's producer-admission correction is
  locally tested but **not deployed**.
- Pyth/Jupiter keys were saved earlier but neither exists in the running ingestion environment.
  The deployed Pyth adapter does support bearer authentication. Historical SOL/USD counters are
  requests3,435/errors3,435. The latest stored SOL/USD oracle publication is26-Aug16:16:03 UTC.
  A bounded recent one-hour sample has5,419 `price-proxy` trades and186 unpriced `observed-balance`
  trades: **zero observed-execution/oracle-converted rows in that sample**. Raw evidence persists,
  but market-proxy USD values cannot establish canonical realized returns.
- Since R45 start, creator enrichment succeeded8/357 attempts (2.24%). Direct creator, funder and
  cluster independence therefore cannot be assumed. Token-risk RPC fallback was used1,916/1,916
  times in the cumulative telemetry; primary availability and provider cost need separate attention.
- Discovery watches four programs, but detailed live trades have an explicit **one active pool**
  resource cap. Cumulative1,157 pool-coverage exclusions and585 queue-pressure events are visible.
  Purged work is excluded, not secretly counted as complete. Zero parser failures is not proof of
  independent 99% network coverage.
- There are zero currently open transport incidents, but569 closed historical intervals remain
  unreconciled/alpha-excluded. Only one new discovery incident opened in the last24h; its transport
  recovered in90s, without complete backfill proof. These569 records are not569 current outages.

Bounded latency sample of2,000 recently processed events, approximately20:16–20:29 UTC:

| Event | N | Chain -> durable receive p50 / p95 / p99 | Receive -> processed p95 |
| --- | ---: | --- | ---: |
| Pool discovery | 463 | 1.56 / 2.25 / 2.89 seconds | 15.67 seconds |
| Swap | 1,537 | 50.41 / 121.95 / 134.59 seconds | 36.94 seconds |

The deployed durable rows do not retain `providerTiming.origin`, so the swap sample cannot be
split into live versus backfill. Do not call122s the live-only latency or add percentiles together.
Conversely, fast websocket transport counters do not prove fast durable trade availability.

## Storage and recovery

- Latest DB24,136,621,079 bytes (22.48GiB); free14,728,196,096 bytes (13.72GiB), disk79.73% used.
- Measured24h DB growth+1.245GB/day; seven-day+1.528GB/day. Conservative runway above the8GiB
  reserve is4.02days, **not a prediction of total disk exhaustion in four days**. Cleanup jumps and
  dump allocation cause variation; this is not a stable long-term operating point.
- Largest relation: wallet trades5.86GB; inbox2.04GB; raw28/29/30-Aug partitions approximately
  2.01/1.82/1.32GB; entries1.55GB; outcomes1.50GB; scores1.04GB. Row counts from catalog estimates
  are approximately2.73m wallet trades and780k pools, not exact chain-wide counts.
- B2 manifests are healthy:29 raw-payload and36 wallet-evidence segments verified; pending,
  verify-pending, retry/dead-letter0. They represent39.60GB raw envelopes +5.37GB wallet evidence,
  compressed to3.18GB +0.558GB respectively. This is restored serialized source size, not physical
  PostgreSQL allocation freed. Raw through30-Aug00:00 UTC; settled wallet evidence through27-Aug.
- All36 compact days are verified with zero mismatch. **The compact reader/retirement cutover is
  not implemented or enabled**: old canonical wallet rows plus shadow compact facts coexist.
  Uploading them to B2 alone does not bound production wallet storage. No deletion is authorized.
- Newest dump2,770,884,949 bytes is now offsite acknowledged. Local scheduled task succeeded
  30-Aug19:21 UTC with SHA256 matching server
  `566487ea4fdbc074ed81bd83853a1147dbdcb962bddb3d9f96b3112ae9f06478` and archive-list verification.
  The11:01 UTC missing-ack blocker is therefore superseded. This newest generation has
  `fullRestoreVerified=false`; it is not a new full restore drill. The next daily dump had earlier
  skipped while acknowledgement was missing; backup freshness must be checked at the next cycle.

## Smallest credible next sequence (not executed)

1. Authorize a named ingestion rollout combining the existing tested R46 admission fix and saved
   credentials, after fresh backup/headroom/identity gates. Verify new oracle observations, rising
   high-quality price coverage, no canonical evidence loss, and a negative producer-adjusted queue
   slope. Repair historical USD pricing only in bounded, separately validated batches.
2. Finish the compact-reader dual-run and guarded canonical wallet retirement; preserve full B2
   evidence and open FIFO state. Exit criterion is a measured sustainable storage slope and reserve,
   not simply a successful upload or one-time cleanup. Avoid further general storage redesign.
3. Deploy the already implemented052/053 future decision tape after its Linux artifact/resource
   gates. Tie every frozen decision to exact-pool short-horizon marks and size-aware two-way quote
   evidence; keep failed/missing samples in the denominator. Quotes remain not fills. Add the
   missing identity proof before promotion; do not increase sampling frequency blindly.
4. Only after valid data exists, freeze and evaluate a survival-first policy against market-only,
   shuffled-wallet and delayed-entry controls with untouched chronological windows. Require at
   least7 stable future days/30 mature markets plus enough samples in every window; only then a
   separate14-day paper phase. A failed hypothesis is rejected, not tuned until it looks profitable.

## Limitations and work boundary

No fresh full backtest, full restore, independent chain denominator audit, B2 re-download, load test
or code test suite was run in this read-only review. Three broad latest-score ranking/aggregate
queries exceeded their15–30s bounds; they were not made unbounded. Narrow indexed latest-qualified
and top-observed queries succeeded. A schema probe and a legacy-signal probe initially named absent
columns; transactions were read-only and were corrected. The displayed live results above come
from successful queries. No report age, process uptime, score, quote or time gate was substituted
for actual validation.
