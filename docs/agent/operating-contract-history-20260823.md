# Walletscaner Agent Operating Contract — Historical Snapshot

This file preserves the complete pre-2026-08-23 operating ledger. It is historical evidence, not
the always-on agent contract. Use the root `AGENTS.md` for current authority and invariants, and
`docs/agent/current-state.md` for the latest compact handoff. Verify live state before operations.

## Scope and precedence

This file governs the entire repository. Read it before inspecting, changing, testing, or
operating the project. Then use `skills.md` to select the task-specific playbook.

Apply instructions in this order:

1. The user's current request and explicit scope boundaries.
2. This file.
3. The task route in `skills.md`.
4. Architecture and operations documents.
5. Existing implementation and tests.

If two sources conflict, do not silently choose one. Verify current code and runtime state,
identify the conflict, and use the higher-precedence instruction. Never broaden a task from
diagnosis into implementation or from local development into production mutation without
authorization.

## Project contract

Walletscaner is a Solana evidence, wallet-intelligence, and paper-trading research system. It
discovers newly tradable tokens, derives verified wallet trades, materializes deterministic FIFO
ledgers, measures both wallet profitability and post-detection followability, applies token-risk
gates, and produces explainable research or paper signals.

The system is not:

- a live execution bot;
- a blind copy-trading bot;
- a price-momentum-only signal generator;
- an EVM indexer;
- a production writer based on the legacy `market-watch` or `live-alpha` file-state paths.

Keep `ENABLE_LIVE_EXECUTION=false`. Do not add private-key handling, transaction signing, or live
order execution unless the user creates a separately authorized phase with an explicit security
design and acceptance process.

## Current operational mode

On 2026-07-24 the user explicitly stopped every Walletscaner service because the shared-host disk
was nearly full. The bounded-storage upgrade passed its PostgreSQL 16 populated-upgrade,
repository-integration and partition-retirement gates; a current byte-identical off-host backup was
verified; and migrations 025-032 were applied to production on 2026-07-28. The stopped migration
reduced the database from about 18.9 GB to 10.55 GB and moved the host from 96% used/2.8 GB free to
85% used/11.2 GB free without `VACUUM FULL`. On 2026-07-28 the user explicitly authorized restart;
the intended profile below passed its staged data/ingestion/research/paper canary. The user later
explicitly stopped every Walletscaner service; all Walletscaner containers were still stopped at the
2026-08-13 archive validation boundary. Do not infer restart authority from the older canary.
The matching bounded-storage image, migration 032, off-host-acknowledged backup, disk gate and
`ENABLE_LIVE_EXECUTION=false` were verified immediately before startup. The protected
Robinhoodscaner state remained unchanged throughout.

On 2026-08-13 a stopped-state custom-format dump (`20260813T134756Z`, 1,477,469,735 bytes) passed
`pg_restore --list` on-host, was copied off host, matched byte-for-byte by SHA-256 and passed an
independent PostgreSQL 16 archive-list check before its off-host acknowledgement was written. Only
then were the acknowledged Aug1 and Aug2 server copies retired, recovering 2,465,013,760 bytes.
Keep the Aug13 server generation and at least two verified local generations; the normal next dump
must still pass the newest-size-plus-2-GiB gate.

On 2026-08-13 the cold-archive release was deployed behind the opt-in archive profile after its
populated PostgreSQL 16, repository and image gates passed. Migration 033 applied once in production
with zero invalid indexes. The production dry run made no manifest or provider writes. An empty-day
transport canary and a real 2026-08-01 segment then passed writer upload plus independent-reader
full restore: 85,039 source rows equalled 85,039 canonical metadata rows, 1,726,640,952 restored
source bytes compressed to 121,728,534 bytes, and both source/archive SHA-256 values were exact.
The real verifier completed in 771.3 seconds under its 128 MB/4% CPU ceiling; observed RSS peaked
below 90 MB before completion. The source partition remains intact with 85,039 rows and
721,960,960 relation bytes. No production payload was retired. `ARCHIVE_ENABLED=false`,
`ARCHIVE_DRY_RUN=true`, `ENABLE_LIVE_EXECUTION=false` and every Walletscaner service were restored
to the stopped boundary after validation; Robinhoodscaner container identities were unchanged.

The fixed-profile verifier key still lacks `readFileRetentions` and the writer remains broader than
required. The user explicitly accepted that residual permission risk. The code must never import or
send B2 delete, bucket-management, lifecycle or bypass-governance commands. Production records
`attested-default-policy` for the user-configured Governance/30-day bucket default and must never
report it as API-verified retention. Do not retire production payload data until the documented
future-only canary passes after a separately authorized ingestion restart.

On 2026-08-14 the remaining settled raw-payload backlog completed: all 12 daily manifests are
`verified`, with zero pending/retry/dead-letter state. The three non-empty days contain 267,381
source/canonical rows and 5,384,805,390 restored bytes compressed to 389,157,080 bytes, plus nine
13-byte empty-day frames. Every PostgreSQL source partition remains intact. A fresh
1,477,487,617-byte dump (`20260814T052837Z`) passed on-host and off-host SHA-256 plus PostgreSQL 16
archive-list verification and was acknowledged before the older Aug13 server copy was retired.
Migration 034 then applied once with zero invalid indexes. Its durable retirement policy is not
ready: the activation is recorded, the future-canary and retirement timestamps are null, and
`ARCHIVE_RETIREMENT_ENABLED=false`. Historical transport evidence cannot authorize deletion.

The rollout consolidated all stopped Walletscaner worker containers onto the new release image and
used only the scoped Walletscaner image-prune script. The new release and one archive rollback are
kept; host-wide BuildKit cache was not touched. Disk moved from the temporary backup/image-load peak
of 93% used/4.8 GiB free to 88% used/8.4 GiB free. A one-shot maintenance canary exposed Compose
`env_file` precedence: the attempted shell-prefix dry run executed one previously approved normal
retention cycle, deleting 86,570 expired hot swaps, 5,000 expired rejected entries and 11 expired
price partitions. It deleted zero durable wallet trades and zero raw payload partitions; migration
034 blocked 11 payload partitions. The corrected `docker compose run -e` canary made zero mutations.
Use explicit `run -e` overrides for future one-shot safety checks.

Later on 2026-08-14 the user explicitly authorized the fastest backup-gated disk recovery, normal
observe-only profile restart and continued B2 transport. The exact 1,477,487,617-byte dump was
uploaded to B2 and independently downloaded in full; SHA-256
`8870b05fade98784e9280087b6392b159f3191ae240b2a5ee479beac5336bd9b`, PostgreSQL 16
`pg_restore --list` and the attested Governance/30-day receipt matched. A serial isolated
PostgreSQL 16 restore of those bytes completed at 10.774 GB with all archive manifests. Do not use
parallel `pg_restore -j` for current dumps: the clone reproduced a migration-033 trigger/table load
ordering failure, while serial restore succeeded.

Only after that recovery proof, production truncated the zero-row `swaps` allocation and the
deterministic FIFO ledger cache. Canonical `wallet_trade_events` remained 1,817,798 rows and stored
scores remained 224,397 rows; 508,852 episodes and 836,308 lots were removed, and 10,146 latest
`observed` wallets were requeued for bounded lazy reconstruction. PostgreSQL fell from 13.534 GB to
11.537 GB. The stopped stateless containers were rebound to the new image, then the scoped
Walletscaner image-prune script removed exactly one unreferenced obsolete image. No global image,
volume or BuildKit prune ran. The host reached about 84.85% used with about 11.0 GB free.

The intended data, ingestion, research, paper, notification and operations services then passed
staged startup. Scheduled archive writer/verifier transport is also active with
`ARCHIVE_ENABLED=true` and `ARCHIVE_DRY_RUN=false`; `ARCHIVE_RETIREMENT_ENABLED=false` and
`ENABLE_LIVE_EXECUTION=false` remain enforced. API, web and legacy-research services remain stopped.
The first scheduled pass uploaded and independently restored the next settled empty day in 4.3
seconds, leaving 13 verified manifests and zero pending/retry/dead-letter rows.
The first restarted alpha cycle processed 97 wallets with zero failures/oversized rows in 96.9
seconds at 88.5 MB RSS. Ingestion had zero queue drops/pressure exclusions/parser failures and stayed
below its resource ceilings. Within about 20 minutes, 685 canonical events completed, two pools had
passed risk and opened bounded trade subscriptions, 74 entries materialized, and wallet-trade
freshness recovered to eight seconds. Every long-lived Walletscaner container still had zero
restart/OOM; disk remained about 84.87% used/10.99 GB free. The one-time rebuild/retention queue was
about 36.5k revisions and drains through the normal bounded 100-item worker cycles; do not raise the
heap or concurrency merely to clear it sooner. The earliest eligible non-empty future canary is the UTC day beginning
2026-08-15 and cannot authorize retirement until the full day closes, settles, uploads and passes
independent restore. Every source payload partition remains intact until that gate passes. The
protected Robinhoodscaner container identities and stopped states are unchanged.

On 2026-08-16 the non-empty post-activation UTC day 2026-08-15 passed the complete future-only
gate: writer and independent verifier matched 56,180 source/canonical rows, 1,207,394,029 restored
bytes, an 86,201,706-byte zstd object and both SHA-256 values under the attested Governance/30-day
policy. Migration 034 then recorded segment 55 as the durable canary and
`archive_retirement_policy_ready(7)` became true. An explicit dry run made zero mutations; the
approved bounded maintenance run retired 12 verified old payload partitions, preserved every
canonical wallet trade and copied zero unresolved payloads because none required a hold. The latest
1,871,502,891-byte PostgreSQL dump was first downloaded off host, matched SHA-256
`9666cc2ded03cac6a290af036d3c2e5db5b37e279d959eea72e8d9fbf0a11e6b`, passed PostgreSQL 16
archive-list validation and received its offsite acknowledgement before the older server dump was
removed. A second unreferenced image was removed only after its exact
`walletscaner.release=diskfix-prehash-r2-20260717` label and zero container references were proved.
Disk recovered from 92%/about 5.9 GiB free to 84.42%/about 10.54 GiB free, and the unchanged
ingestion container automatically reopened its disk gate and resumed canonical writes. The
maintenance container now persistently runs with `ARCHIVE_RETIREMENT_ENABLED=true`; the database
policy, exact verified-manifest/remaining-lock test and transactional unresolved-payload hold remain
mandatory on every partition. The offsite pull uses ten resumable attempts and immediately invokes
the report-first, SHA/ack-gated server reconciliation while always retaining the newest server
generation. The PostgreSQL scheduler now uses a start-to-start 24-hour interval instead of drifting
by dump duration; the local task runs hidden at 22:00 Europe/Istanbul. `ENABLE_LIVE_EXECUTION=false`
remains enforced. This paragraph supersedes the earlier future-canary/retirement-off boundary.

Later on 2026-08-16 an alpha-quality baseline proved that storage was no longer the immediate
research bottleneck: `wallet_alpha_signals` remained empty and no latest wallet was watch-or-better,
although the top observed wallets had hundreds of realized and followability samples. The bounded
managed-exit shadow rejected all 25 sampled wallets because catastrophic-loss rates remained about
9%-14%; do not lower those tail-risk gates to manufacture signals. Source-buy to bot-entry delay was
p50 19.84s, p90 56.42s and p95 148.20s. The first all-at-once shadow read reported 176.56 MiB RSS;
the replacement reads five-wallet batches, excludes missing/negative/over-60-second entry timing,
and completed the same 25-wallet read-only sample at 139.01 MiB RSS with 5,204/5,771 entries timing
eligible. Outcome construction now accepts only the entry's exact pool; same-mint fallback pricing
is prohibited. Only `evidence-sampler` was recreated onto image
`walletscaner-worker:local` (`44329fea541f...`) for that fail-closed change. Its first cycle processed
131 entries/four exact pools with zero provider errors or exact-pool misses at 48.51 MiB, zero
restart and no OOM. Other long-lived workers stayed on their previous images; live execution stayed
false and Robinhoodscaner identities/states were unchanged. The image build temporarily reduced
free disk to about 9.77 GB/87% used; do not spend more disk or increase sampling frequency until the
24-hour runway and lower-frequency outcome-write design are measured.

The next alpha-quality release superseded that sampler boundary without changing its 120-second
cadence. `evidence-sampler` now runs immutable image
`alpha-outcome-r3-20260816` (`e8d3eeb7228e...`): provider calls remain 30-token batches, entries
are grouped by exact `(token,pool)`, outcome persistence uses bounded 200-row upserts, unchanged
lifecycle states are not written, and a wallet is requeued at most once per changed batch. Its warm
production cycles completed in 1.885-3.008 seconds with one provider request, zero provider errors,
zero exact-pool misses, zero invalid markets, zero restart and no OOM. Keep the two-minute cadence:
moving to 60 seconds improves only outcome/exit resolution, not token discovery, while PostgreSQL
already approaches its 18% shared-host CPU quota.

`wallet-alpha` now runs immutable image `alpha-admission-r4-20260816`
(`cc5b8688d3ec...`). It peeks at no more than 100 unlocked revisions, performs one five-second
timeout admission prefetch whose per-wallet lateral index probes stop at six trades and three
entries, and keys every cached result to the exact queue revision. Claiming remains one wallet at a
time; a revision change forces the old one-wallet probe. The first two production cycles prefetched
100 candidates in 1.499/1.964 seconds and completed 100 revisions in 43.017/57.118 seconds: 28/23
wallets were fully scored, 72/77 low-evidence revisions were completed, and failures, oversized
rows, restarts and OOMs were zero. Logged RSS peaked at 92.24 MiB under the unchanged 160 MiB
ceiling. The pending queue moved from 6,317 to 6,260 across the second cycle while live evidence
continued to requeue changed wallets. Do not move evidence predicates into ordered claim SQL,
claim a batch, raise concurrency or weaken admission thresholds.

A seven-day, exact-pool, one-market-per-token/pool diagnostic found 139 mature managed outcomes.
The baseline catastrophic-loss rate was about 15%. A discovered entry-time profile requiring
top-10 holder concentration below 20%, five-minute buy share from 50% to below 60%, and
volume/liquidity below 0.50 selected 19 markets; its earlier 14 and later five diagnostic slices
were all positive. This is model-selection evidence, not an untouched holdout: no signal, Telegram
message or paper strategy was enabled. Freeze the profile and require at least seven future days,
30 distinct markets, robust return/tail gates, exact-pool fill realism and funder/cluster
independence before a separately versioned paper cohort. The audit is
`reports/token-alpha-feature-audit-20260816.md`.

At `2026-08-16T20:51:05.137545Z`, the exact strict profile and acceptance gates were frozen in the
append-only `hypothesis_runs` row `token-alpha-strict-v1-future-freeze`. Its strategy version is
`token-alpha-strict-v1`, verdict is `watch`, and paper, Telegram and live execution are all false.
Only post-activation evidence may count toward its seven-complete-UTC-day/30-distinct-market gate.
Changing a threshold requires a new version and future activation boundary; never rewrite or
backfill this cohort.

On 2026-08-17 Europe/Istanbul (`2026-08-16T21:49:19.139Z`), the broad qualified-pool Telegram
cohort was frozen after a read-only 72-hour audit of 137 at-least-30-minute-old alerts found a
-59.92% median current mark, 53.3% at or below -50%, and severe winner concentration. The displayed
`riskScore=0`/`riskConfidence=90` was not a profit forecast: zero meant no configured token-risk
warning, while 90 was the hard-coded completeness value for known evidence. The notifier now labels
these fields as lower-is-better token risk and evidence coverage, not expected return.

The separate append-only run `qualified-pool-strict-v2-future-freeze` activates
`strict-flow-v2-20260817` only from that timestamp. It requires an exact pool at least five minutes
old, 20 or more five-minute transactions, buy share from 50% up to but excluding 60%,
volume/liquidity below 0.50, top-10 concentration below 20%, risk score zero with at least 90
evidence coverage and no warnings, plus complete trade coverage. One best pool per token is selected
and every decision-time feature is frozen in the outbox payload. The Telegram title says research
candidate, not proven alpha. No strict candidate existed at the rollout boundary.

`qualified-pool-paper-v3-strict-flow` is a new isolated future-only $100 paper cohort activated at
the same boundary. It consumes only strict-v2 payloads, rechecks the exact pool two minutes later,
reapplies the buy-share/turnover/activity rules and 90% liquidity retention, and models 30 bps fees
plus 250/400 bps base entry/exit slippage. Exposure is at most two $6 positions/$12 total. V1 and V2
remain immutable negative/comparison cohorts at $3.0392 and $96.1322 cash with no open positions at
the boundary. This early paper experiment does not alter the separate paper/Telegram-disabled
`token-alpha-strict-v1` gate and is not live-capital evidence. Promotion still requires seven
complete UTC days, 30 strict markets, the frozen robust/tail gates and at least 14 paper days.

The signal rollout uses immutable image `walletscaner-worker:signal-quality-r1-20260817`
(`sha256:95339a5a9799...`) only for `paper-alert` and `telegram-notifier`. The release passed
TypeScript, ESLint, production builds and 49 files/229 tests with PostgreSQL 16 plus zstd. Canary
RSS was 42.22/39.2 MiB at 0.05%/0.07% CPU, with zero restart/OOM/dead-letter; the first notifier
scan completed in 288 ms. No migration, data deletion, ingest restart or co-tenant change occurred.

On 2026-08-22 the v3 paper review found three opened positions had lost $14.1623381901: two exact
pools reached zero liquidity and one hit the modeled hard stop. A read-only PostgreSQL 16 clone
produced 177 historical strict-flow exact markets. Strict-v2 failed all four chronological windows;
the final holdout had -1.52% average return excluding its best winner, 1.00 profit factor, 11.43%
catastrophic-loss rate and a -107.09% worst outcome after 7.1% modeled round-trip cost. Causal wallet
quality was rebuilt only from outcomes frozen before each decision. Twenty-six markets had a
safe-3 supporter and seven had a safe-6 supporter, but none of 5,760 candidate combinations passed
both train and validation. Do not claim that a profitable v4 was discovered or tune v3 in place.

Migration 039 froze `strict-flow-v4-causal-shadow-20260822` at
`2026-08-22T20:00:10.081341Z`, paused `qualified-pool-paper-v3-strict-flow` with zero open positions,
and records paper, Telegram and live execution as false. `telegram-notifier` runs immutable image
`signal-causal-shadow-r8-20260822` (`sha256:4fffea6a9436...`) with qualified-pool delivery mode
`shadow`; those decision snapshots are durable but non-deliverable and cannot feed v3. The
`paper-alert` container is rebound to R8 but remains stopped. Existing ingestion/research and
operations images are unchanged.

During the stopped paper-container rebind, dependency-following `docker compose create` unexpectedly
recreated PostgreSQL and a subsequent scoped recovery recreated Redis. Named volumes were never
removed and database state remained intact. Ingestion restarted twice, opened four fail-closed
`backfill_truncated` incidents, then closed them after two fresh healthy samples as
`transport_recovered_gap_unreconciled`; the affected intervals remain alpha-excluded. Never use
dependency-following `docker compose create` for a stopped worker on this host. The post-recovery
sample had zero open incidents or dead letters, 227/227 discovery candidates decoded, 459 canonical
completions, 72 entries, one active exact-pool trade subscription and three-second wallet-trade
freshness, with zero unmatched events, parser failures, queue pressure, drops or sampling errors.
The audit and rollout records are
`reports/token-alpha-v4-audit-20260822.md` and
`reports/token-alpha-v4-shadow-rollout-20260822.md`.

The same 2026-08-16 review disproved an apparent multi-venue decoder regression. The ingestion
health window reported 749 decoded events out of 774, but retained payload inspection showed that
all 25 unmatched rows were arbitrary program transactions from the unfiltered five-item
initial/reconnect backfill: one Pump.fun, ten CPMM, nine LaunchLab and five PumpSwap. Live filtered
candidates decoded 749/749. `StandardSolanaEventSource` now reapplies the exact configured
instruction-log predicate after every fetched transaction. A resolved non-match advances the
cursor, increments `postfetchFilteredTransactionCount`, and is not emitted, persisted or counted in
pool decoder coverage. This fixes the false denominator and needless writes; it does not by itself
prove that a deep reconnect gap can be scanned within five minutes.

That filter shipped only to `solana-ingestion` as immutable image
`alpha-discovery-r5-20260816` (`4ac6ef023a55...`). The first startup heartbeat separated 12
resolved non-matching backfill transactions, persisted none of them, and decoded 12/12 emitted
candidates. The second heartbeat reached 25/25 with zero unmatched event, parser failure, queue
drop/pressure, reconnect, retry, restart or OOM. Ingestion used about 94.75 MiB of its 160 MiB
ceiling at a 2.92% CPU snapshot; PostgreSQL was 5.84% at the same boundary. Live execution remained
false and the protected Robinhoodscaner container identities/states did not change.

Later on 2026-08-16 a current server inventory proved that the raw archive fix alone is not the
95-day steady state: trade, entry and outcome evidence spans only about 37-41 calendar days, and
the settled Aug14/Aug15 rates project those three relations to about 15.6 GB at 95 days. A serial
restore of the verified Aug15 dump benchmarked a compact hot target at 406,200,320 bytes versus
5,502,296,064 source bytes with exact episode, non-realized-lot and mature-outcome counts plus
matching retained-field digests. This does not authorize canonical deletion. The separate
wallet-evidence B2 artifact, incremental FIFO, dual-read scorer parity and stopped cutover gates in
`docs/storage_lifecycle.md` remain mandatory.

The final 2026-08-16 inventory found 15 verified archive manifests with zero pending, retry or
dead-letter state and only the Aug14-Aug16 hot payload partitions remaining. The operations monitor
still reported degraded health because more than 100,000 archive-covered, expired
`chain_event_inbox` metadata rows remained; its oldest row was 2026-08-01. The bounded maintenance
worker was advancing that cohort by roughly 3,000-3,500 deletions per 30-minute cycle while also
compacting 500-1,000 newer rows, but two five-second statements timed out per cycle. This is a
retirement-throughput backlog, not a failed B2 transport or a reason to weaken archive gates. The
inbox relation was about 656 MB. Do not raise shared-host CPU/heap or hide the alert; the next
storage work, when justified against the alpha roadmap, is an indexed/set-based throughput fix and
separate compaction-versus-expired-metadata telemetry.

The storage-flow releases passed 49 files/219 tests including PostgreSQL 16 and zstd. The staged
ingestion worker uses `storage-flow-r1-20260816`; in its first 25-minute sample it prefiltered
140,179 of 140,231 standard-RPC WebSocket messages before JSON parsing, completed 53/53 canonical
events and recorded zero parser failures, drops, reconnects or queue pressure. Pump.fun discovery
decoded 37/37 observed source events, including two inner-instruction pools; the smaller CPMM,
LaunchLab and PumpSwap samples are not yet a 99% acceptance proof and require reviewed denominator
fixtures. `data-maintenance` and `operations-monitor` use the operations-only
`storage-flow-r3-20260816` overlay. Whole raw-payload eligibility uses the configured 48-hour
horizon, while migration 035 and the exact-day `LATERAL` plan prevent pre-archive metadata from
starving verified inbox retirement. The production canary retired 2,000 eligible inbox rows, and
the first normal scheduled pass retired another 3,500 plus compacted 500 newer rows in bounded
500-row batches. They advanced the oldest cohort and deleted zero wallet trades, entries, outcomes,
scores or raw partitions. The monitor persists at most one sample/hour
for 30 days and reports runway above an 8-GiB reserve only after 24 hours; the series remains
immature. Disk was about 84.84% used with about 11.0 GB free after the index rollout. The compact
canonical-evidence lifecycle still has not passed its cutover gates. Robinhoodscaner identities and
stopped states were unchanged.

On 2026-08-21 Europe/Istanbul (2026-08-20 UTC), the pipeline-stability release closed the remaining
correctness and maintenance bottlenecks without changing live-capital policy. `solana-ingestion`
runs immutable `pipeline-stability-r3-20260820`
(`sha256:c15823fd404e769e04e510069fd64ff856c179c873a4060e5a22f4516cd62c1c`).
Its ten-minute production canary decoded 297/297 emitted discovery candidates, post-fetch filtered
26 irrelevant transactions and proved target-program invoke plus successful completion in 331/331
retained payloads. Nine inner-CPI discoveries decoded; canonical failures, retry, unresolved, drop,
queue pressure, restart and OOM were zero. RSS ranged from 59.42-63.21 MiB. The program-log filter
records proof when the matched target frame completes successfully, so a later unrelated truncated
suffix cannot erase it; a missing, failed or malformed target completion still fails closed.

`wallet-alpha` and `data-maintenance` run immutable `pipeline-stability-r4-20260820`
(`sha256:ddbfc59a9fb8f2f555bc5b57b18afa2bd673db99aa6c3bda802d27eb5816f83e`).
The release passed TypeScript, ESLint, 51 files/248 tests against a fresh PostgreSQL 16 plus zstd,
and every workspace production build. Migration 036 adds the exact concurrent partial index for
three-day rejected evidence. Rejected batches now lock at most 500 entries and delete dependent
outcomes plus those exact entries in one transaction; timeout/error rolls back the whole batch.
Migration 037 adds the narrow `wallet_alpha_score_supersessions` table with full score PK/FK,
`ON DELETE CASCADE` and a leading retention index. Its stopped-writer backfill produced 15,396 rows,
exactly matching total score rows minus one latest row per wallet/strategy. Only a genuinely inserted
changed score records supersession; identical replay records nothing and out-of-order insertion
queues the older side. Do not restore the cross-row `EXISTS newer` retention scan.

The backup-gated r4 dry run made zero mutations. The first new wallet-alpha cycle processed nine
wallets with zero failure/oversized row and wrote exactly nine new scores plus nine supersession
records; reported RSS peaked at 101.32 MiB under the unchanged 160 MiB ceiling. The bounded
maintenance canary retired all 10,612 eligible superseded scores and 2,500 rejected entries,
compacted 4,677 payloads, reduced payload-compaction lag to zero and reported zero stage timeout or
advisory-lock warning. It deleted zero admitted wallet trades, wallet outcomes, wallet episodes or
payload partitions. Score hard expiry remains 95 days and superseded history remains seven days.
The advisory lock is acquired and released on one pinned PostgreSQL session. Keep the five-second
statement timeout, 500-row evidence batches, current CPU/heap ceilings and 30-minute maintenance
cadence; do not trade this bounded design for a timeout, heap or concurrency increase.

The release also makes quote insertion safe across both primary and natural unique keys, rejects
immutable price/provenance disagreement, scopes Telegram alpha backlog health to the active trimmed
strategy version and uses direct Node/tsx for ingestion. `telegram-notifier` remains on the r2 image;
paper-alert, evidence-sampler, operations-monitor, PostgreSQL, Redis, archive and backup services
were not recreated. `ENABLE_LIVE_EXECUTION=false`, archive transport/retirement gates and existing
alpha admission thresholds remain enforced. No volume operation, payload-partition retirement,
global prune or co-tenant action occurred. A natural r3 trade/quote did not occur during the ten-minute
canary, so retain the earlier r2 22-quote production proof and inspect the first future natural r3
quote; also keep the 24-hour resource trend and future-only alpha/paper gates open.

On 2026-08-22 the interrupted R5 rollout was recovered through the durable checkpoint
`reports/pipeline-stability-r5-resume-checkpoint-20260821.md`. R5 had exposed two correctness
boundaries: a cursorless five-signature exact-pool bootstrap could silently omit an older trade
prefix, and Pump.fun discovery had accumulated a saturated 500-item queue with 1,631 dropped
signatures while reporting no coverage incident. Telegram and paper were intentionally stopped;
their one-day silence was containment, not a Telegram API outage. Migration 038's append-only
coverage incidents and exact-pool provenance were used to exclude the reviewed gaps. No historical
gap was claimed reconstructed and no risk/admission threshold was weakened.

Only `solana-ingestion` now runs immutable `pipeline-stability-r6-20260822`
(`sha256:2456672e58c55f4a105903ad8ff74cb00865b7aebd7c10d2eec8a2b981c0f49f`). A cursorless initial
page that saturates the 500-signature limit emits nothing, persists exact-pool incomplete coverage
and unsubscribes; discovery queue-pressure/drop growth opens an immediate per-program fail-closed
incident. The production profile remains 500/500/four pages at 0.20 CPU/160 MiB. Its first roughly
29 minutes processed 553 inbox rows and materialized 365 pools, 367 swaps, 178 wallet trades and 66
entries; the measured health sample decoded 289/289 emitted candidates with zero canonical failure,
unresolved event, queue, drop or pressure. Pump.fun, PumpSwap and CPMM were current healthy;
LaunchLab remained deliberately alpha-excluded behind one unreconciled ACK/backfill incident.

Only `telegram-notifier` and `paper-alert` now run immutable `signal-replay-r7-20260822`
(`sha256:f93f0c7d7ddbf9eb30f3b3e60f4382c7e2a5b5a101cbe845a4e1e763b596a8d5`). A notifier restart
selects at most the latest durable coverage transition per configured program, so it cannot replay
every open/recovered cycle accumulated while stopped. The R7 canary coalesced to four latest states,
drained the outbox to zero and produced no second wave. Paper retained 85.8377 USD cash, -14.1623 USD
realized PnL, zero open positions and six immutable events. The next evidence cycle consumed all 66
new exact-pool entries and persisted one compact observation plus 132 outcome transitions with zero
provider or exact-pool error. Keep `ENABLE_LIVE_EXECUTION=false`; zero wallet-alpha signals and no
latest watch-or-better wallet still mean there is no proven alpha. Keep the 24-hour resource/ingress
trend and future chronological acceptance gates open.

Both releases passed 62 files/322 tests with PostgreSQL 16 plus zstd, TypeScript, ESLint, diff and
production builds. The newest database dump was independently pulled, byte/SHA matched and passed a
PostgreSQL 16 archive-list check before cutover. The two server release tar transport copies were
removed only after exact local copies and loaded image identities were proved; no image/cache/global
prune, database/volume operation or co-tenant action occurred. Root disk ended near 62% used with
about 27.85 GB free; all 21 archive segments were verified with no archive backlog/dead letter.

On 2026-07-15 the user explicitly cleared the earlier operational hold and authorized the
fixed-disk, observe-only shared-host profile. After the separate 2026-08-14 authorization, the
active intended services are:

- data: `postgres`, `redis`;
- ingest/research: `solana-ingestion`, `evidence-sampler`, `wallet-alpha`;
- operations: `data-maintenance`, `operations-monitor`, `postgres-backup`.
- cold transport: `archive-writer-scheduler`, `archive-verifier-scheduler`; verified partition
  retirement is active behind both the durable policy and runtime gate.
- notifications: `telegram-notifier`.
- paper: `paper-alert` running only `qualified-pool-paper-v3-strict-flow`; v1 and v2 are frozen as
  immutable negative/comparison cohorts.

Keep `api`, `web` and every legacy-research service stopped. Live execution remains disabled. The
user authorized Telegram research/status notifications and the isolated $100 qualified-pool paper
phase on 2026-07-16; this is not permission to trade real capital, activate every Compose profile,
consume private keys, or relax a risk gate.

`telegram-notifier` is the only approved Telegram API consumer in the active profile. It consumes
the `alert` signal destination plus durable qualified-pool, paper-trade and status outbox messages;
it never consumes the `paper` signal destination. New-token messages require the configured
liquidity/five-minute volume floors plus the frozen strict-flow-v2 age, transaction, buy-share,
turnover, top-10, known-risk and complete-coverage gates. Do not replace this with raw pool-created
spam, silently tune the current version or expose Telegram credentials.

`paper-alert` is authorized only for `qualified-pool-paper-v3-strict-flow`: the separately
activated future-only $100 portfolio described above. V1 and v2 remain unchanged with no open
positions at the v3 activation boundary. V3 must not consume legacy/unversioned notifications, the
alert destination, or messages before its own activation; pretend a post-rug stop filled; inherit
older cash/trades; or contact Telegram directly. Keep its direct Node/tsx command, 40 MB heap,
80 MB container ceiling and 2% CPU quota unless measured evidence justifies a smaller bound.

The notifier was activated on 2026-07-16 after a fresh custom-format backup was SHA-256 and
`pg_restore --list` verified both on-host and off-host. Migrations 015-032 are applied and the pool
candidate index is valid/ready. Production uses a 30-second poll, one-message claim batches, a 40 MB
Node heap, an 80 MB container ceiling and a 2% CPU quota. The direct Node/tsx command is intentional:
adding an npm wrapper previously raised measured container memory from roughly 41 MB to 78 MB. The
first qualified-pool notification and startup status were delivered exactly once in the durable
outbox; wallet-alpha signal count was still zero at activation.

The migrations 025-032 fixed-disk policy is deployed and its intended services are currently active.
Canonical metadata and
its immutable payload SHA-256 remain in `chain_event_inbox`; full provider JSON is atomically stored
in daily `chain_event_payloads` partitions. Processed payloads retain 48 hours, rare unresolved old
payloads move to `chain_event_payload_holds`, and whole expired partitions are dropped so heap,
TOAST and index files return to the filesystem. `price_observations` uses daily partitions with a
two-day horizon and a compact global idempotency-key table. Processed or rolled-back inbox metadata
and buy-only first-entry bridge swaps retain three days; failed-risk/excluded wallet evidence
retains three days; admitted wallet trade/entry/outcome evidence retains 95 days; superseded
wallet-alpha scores retain seven days. Row-oriented pruning remains bounded to 5,000-row batches
and a 30-second mutation-scheduling budget. The three-day `swaps` horizon runs before processed
inbox-row pruning inside that shared budget; otherwise a continuously eligible inbox can starve
swap retirement. The
maintenance PostgreSQL pool allows at most 15 seconds for the initial read-only eligibility
inventory, then lowers the same single connection to a five-second server-side statement timeout for
mutations. Mutation SQLSTATE `57014` is a bounded stage stop; prior completed batches remain
committed and the run still emits its health summary. This is required because checking a JavaScript
deadline before a query does not stop an individual PostgreSQL statement from exceeding the
30-second run ceiling. The
durable buy/sell ledger remains `wallet_trade_events`; `swaps` is not a second permanent ledger.
Maintenance and monitoring run through direct Node/tsx commands with 32 MB heaps and 64 MB
container ceilings.
At least one verified server dump and two verified off-host generations must remain. An
unacknowledged generation blocks the next dump; after acknowledgement, old verified server copies
are removed before allocating a new dump, and newest-dump-size plus 2 GiB headroom is mandatory.
Do not disable retention, weaken offsite acknowledgement, run `VACUUM FULL`, or accumulate extra
server dumps without a capacity review.

On the 2026-07-28 restart canary, the evidence sampler's npm wrapper consumed about 78.3 MiB of its
80 MiB ceiling; direct Node/tsx reduced it to about 45.8 MiB. Wallet-alpha now has a dedicated
production worker separate from the on-demand report. It invokes Node/tsx directly, disables
PostgreSQL gather parallelism only on its own connections, leases one wallet at a time, processes at
most 100 work items or 240 seconds per run, and sleeps five minutes between runs. Reads hard-cap at
10,000 trades, 2,000 entries and 4,000 outcomes per wallet; an oversized wallet is isolated for a
24-hour retry while later wallets continue. Before a full ledger/score load, a two-stage bounded
admission probe reads at most six trades and three entries. A wallet below both thresholds has its
current revision completed without a score; its durable evidence remains and any later evidence
requeues it automatically. Never push these correlated checks into the ordered claim SQL: the
2026-08-01 canary proved that formulation can become a 56+ second disk scan. Keep two-way
persistence concurrency, 112 MB heap, 160 MB container ceiling and 7% CPU quota. Do not restore npm
wrappers, multi-wallet evidence loads, periodic full reports or per-query PostgreSQL parallelism
without new shared-host evidence.

Solana RPC transaction ingestion has an explicit 80% signature-queue pressure gate. Crossing it
removes the affected hot-pool subscription and durably marks its trade coverage incomplete; that
pool is excluded from wallet evidence rather than silently dropping signatures and claiming full
coverage. Health logs expose queue pressure, address count, high-water mark and coverage exclusions.
Do not turn a queue overflow into a best-effort drop path or re-admit an incomplete pool without a
separately verified repair.

On 2026-07-16 the canonical backlog hot path was replaced with a recursive partition-head
skip-scan, eight-row claims, four-way cross-partition processing and 90-second leases. Delayed swaps
now hydrate immutable pool context from PostgreSQL instead of depending on the two-hour sampling
map. Historical SOL/USD lookup reuses durable observations and bounded caches, serializes external
requests at a minimum 1.2-second interval and backs off on HTTP 429. The Pyth Benchmarks client uses
the single-timestamp endpoint; the interval endpoint returns an array and must not be parsed as one
price response. The r13 shared-host sample completed 1,314 canonical events with zero worker
failures, zero Pyth errors and zero rate limits while ingestion stayed below 100 MiB. This resolves
the immediate throughput/provider storm, but the seven-day shadow gate and bounded repair of older
explicit `lookup-failed` price evidence remain open acceptance work.

Never assume this note is the sole source of truth. Before an operational change, verify exact
container state, live-execution state, disk, memory/swap, database size, backup validity and both
Compose projects. Preserve the active profile unless the user's request requires a scoped change.

## Protected co-tenant: Robinhoodscaner

The production host is shared. `robinhoodscaner-intel` is outside this project's scope and must
not be changed, restarted, stopped, rebuilt, inspected for secrets, or otherwise disturbed.

Known boundaries:

| System          | Compose project         | Working directory           |
| --------------- | ----------------------- | --------------------------- |
| Walletscaner    | `walletscaner`          | `/opt/walletscaner`         |
| Robinhoodscaner | `robinhoodscaner-intel` | `/root/RobinhoodScaner_new` |

For every server operation:

- Target the exact Compose project, service, container, directory, and file.
- Capture Walletscaner and Robinhoodscaner container status before and after the operation.
- Prefer `docker compose -p walletscaner -f docker-compose.server.yml ...` from
  `/opt/walletscaner`.
- Use exact label filters such as `com.docker.compose.project=walletscaner` when enumerating
  containers.
- Treat host CPU, RAM, swap, disk, Docker daemon settings, networking, firewall, package updates,
  reboots, and provider quotas as shared resources.

Unless the user explicitly authorizes a host-wide action after seeing its impact, never:

- run an unscoped `docker compose down`, `docker stop`, or `docker restart`;
- run `docker system prune`, delete Docker volumes, or delete database directories;
- modify `/root/RobinhoodScaner_new` or a `robinhoodscaner-intel-*` container;
- change shared firewall rules, Docker daemon configuration, ports, swap, kernel settings, or host
  packages;
- reboot, resize, or migrate the shared host;
- use a wildcard or generated container list without first verifying every resolved target.

For obsolete Walletscaner worker images, use
`scripts/deploy/prune-walletscaner-images.sh` with explicit release/rollback tags. Its default is
report-only and it protects every container-referenced image ID. Do not replace it with a host-wide
image or BuildKit-cache prune.

`scripts/deploy.sh` is not a safe default deployment entrypoint. It performs remote setup,
`rsync --delete`, environment transfer, stack shutdown, and rebuild. Review it line by line and
obtain explicit deployment authority before using it. Treat old `market-watch` status commands as
legacy unless the task explicitly concerns offline research.

## Mandatory first pass

Before substantial work:

1. Read `README.md` and `.superstack/build-context.md`.
2. Read `docs/architecture.md`, `docs/operations.md`, and the task-specific documents routed by
   `skills.md`.
3. Inspect `git status --short --branch`; preserve unrelated user changes.
4. Locate applicable `AGENTS.md` files before editing nested paths.
5. Map the request to current source files, schema, tests, and runtime ownership.
6. Separate verified facts, hypotheses, and recommendations.
7. For server work, begin with read-only inventory and health checks.

Do not read or print `.env`, `.env.server`, private keys, tokens, webhook URLs, passwords, or full
container environments. Inspect variable names or explicitly selected non-secret operational
values only. Redact secrets from logs and reports.

## Source-of-truth map

- `README.md`: product boundary, supported venues, commands, public acceptance gates.
- `.superstack/build-context.md`: compact architecture handoff and current implementation state.
- `docs/architecture.md`: canonical event flow and service ownership.
- `docs/data_model.md`: persistence semantics and relationships.
- `docs/providers.md`: provider roles and constraints.
- `docs/wallet_intelligence.md`: wallet evidence and alpha definitions.
- `docs/scoring.md` and `docs/risk.md`: deterministic scoring and fail-closed risk policy.
- `docs/backtesting.md`: historical and paper validation rules.
- `docs/operations.md`: production configuration, monitoring, retention, backup, and rollout gates.
- `scripts/migrations/*.sql`: ordered database contract. Never rewrite an applied migration.
- `docker-compose.server.yml`: intended server service topology.
- `reports/`: generated evidence, never a substitute for canonical PostgreSQL state.

When architecture changes, update code, tests, relevant docs, and
`.superstack/build-context.md` together. Do not allow these sources to describe different systems.

## Architectural invariants

Preserve these unless the user explicitly authorizes an architecture change:

1. PostgreSQL is the production system of record. Redis is hot/cache/rate-limit state only.
2. Every chain event is durably and idempotently written to `chain_event_inbox` before parsing
   side effects.
3. Inbox and outbox work uses unique keys, leases, retries, attempts, and dead-letter states.
4. Store Solana `slot` and chain event time. Keep `occurred_at`, `received_at`, `processed_at`,
   and `finalized_at` semantically distinct.
5. Do not advance a partition cursor past an unresolved older event.
6. Exact token quantities use decimal-string raw amounts plus decimals. JavaScript `number` is for
   display compatibility, not accounting.
7. Execution prices require explicit provenance. DEX Screener is market context and outcome
   evidence, not canonical execution price.
8. Wallet identity must be a verified signer, fee payer, or venue authority. Pool, vault, program,
   and infrastructure addresses are not traders.
9. FIFO ledger output must be deterministic under duplicate delivery and input reordering.
10. Wallet profitability and bot-observed followability remain separate measurements.
11. Unknown or failed critical risk evidence blocks downstream paper signals.
12. Direct creators are excluded. Missing funder/cluster/insider coverage must be reported, not
    treated as passed.
13. Live execution remains disabled.

Raw provider payloads may be retained only alongside parsed canonical fields and an explicit cost,
retention, and reprocessing purpose. Do not create unbounded raw-JSON stores.

## Engineering workflow

### Diagnose

- Reproduce or observe the issue before editing.
- Follow data from source to durable record to transformation to consumer.
- Check logs, metrics, database state, and relevant code together.
- Find the root cause; do not stop at a cosmetic symptom.
- A healthy process or zero backlog is not proof of complete coverage or correct output.

### Plan

- State the desired outcome and measurable acceptance criteria.
- Identify data migrations, rollback strategy, provider cost, operational load, and co-tenant risk.
- Prefer the smallest coherent change that fixes the invariant violation.
- Distinguish immediate containment from the durable design.

### Implement

- Preserve module boundaries and existing user changes.
- Keep provider I/O behind adapters and business logic deterministic.
- Add idempotency and bounded retries to external or durable work.
- Use pagination, streaming, incremental materialization, or bounded batches for growing datasets.
- Never load an unbounded production table into memory.
- Avoid full-table rewrites in periodic jobs; process changed partitions or wallets.
- Make retention capacity greater than peak ingestion capacity.
- Add migrations for schema changes and make them safe to apply on populated tables.

### Verify

- Run targeted tests first, then the full required gate.
- Validate behavior, resource use, idempotency, and failure recovery—not only compilation.
- For data changes, compare counts, hashes, or deterministic outputs before and after replay.
- For provider changes, use fixtures plus bounded live/devnet checks when authorized.
- For operations, verify both Compose projects after the change.

### Handoff

Report:

- the outcome;
- files and behavior changed;
- tests and checks run, including skipped checks;
- migrations or operational actions;
- current server state;
- residual risks and the next hard gate.

Do not describe an implementation as production-ready when only unit tests have passed.

## Database and migration rules

- Add a new numbered migration; never modify an applied migration to change production state.
- Make writes idempotent and define the conflict key intentionally.
- Use `NUMERIC` or exact raw strings for token accounting.
- Design indexes from actual query predicates and ordering.
- Consider lock duration, table size, WAL, temporary disk, replication/backup impact, and rollback.
- Use concurrent index creation or a staged migration when a populated production table requires it.
- Test migrations against PostgreSQL 16 with representative volume before server execution.
- Do not run destructive DDL, mass deletes, `VACUUM FULL`, restore, or reindex operations on the
  shared production host without an external verified backup, disk-headroom proof, a rollback
  plan, and explicit approval.
- Deleting rows does not guarantee filesystem space is returned. Prefer time partitioning and
  partition retirement for high-volume time-series data.

## Performance and reliability rules

- Every recurring job needs bounded memory, bounded concurrency, timeout, retry/backoff, and
  progress/heartbeat reporting.
- Every queue or polling loop needs lag, throughput, error, retry, dead-letter, and staleness
  metrics.
- Every long-lived in-process `Map`/`Set` that grows from chain activity needs an explicit TTL or
  capacity, bounded cleanup cost and an exposed size/limit metric. Persisted idempotency remains the
  correctness boundary; process memory is only a bounded optimization.
- Measure rates and percentiles; a latest-value snapshot is not sufficient for an acceptance gate.
- Forecast disk exhaustion from growth rate and include backup/WAL headroom.
- Alert before a shared host reaches emergency thresholds.
- A crash loop must back off or trip a circuit breaker; it must not repeatedly rewrite large data.
- Raising a heap or container limit is not a substitute for incremental processing, especially on
  the shared host.

## Validation matrix

Use Node.js 22 or newer; CI currently uses Node.js 24. Keep `package-lock.json` authoritative.

For implementation changes, the default final gate is:

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build --workspaces --if-present
```

Database integration tests require a disposable PostgreSQL 16 instance and
`TEST_DATABASE_URL`. A green suite with the integration file skipped is not the full gate.

Additional requirements:

- Provider/parser change: fixture tests, duplicate replay, malformed input, reconnect/gap path.
- Ledger/scoring change: ordering and duplicate invariance, partial sells, reopened positions,
  holdout and risk-gate tests.
- Migration change: clean install plus upgrade from representative populated state.
- Worker/performance change: production-scale fixture or generated load with memory/runtime bounds.
- API change: typed contract, error path, pagination, and envelope tests.
- UI change: production build and empty/loading/error/large-data states.
- Operations change: pre/post inventory, health, persistent mounts, backup state, and co-tenant
  verification.

If a required check cannot run, say exactly why and do not silently downgrade the result.

## Production acceptance gates

Do not enable user-facing alerts or advance the research phase until relevant gates are proven:

- supported mainnet instruction parse coverage at least 99%;
- ingest lag p95 below 3 seconds and p99 below 10 seconds;
- reconnect gaps closed within 5 minutes;
- no growing backlog, dead-letter accumulation, or stale report;
- high-quality execution coverage at least 90% for candidate wallets;
- duplicate replay leaves ledger and score hashes unchanged;
- seven-day stable shadow run;
- at least fourteen days of paper-only evidence with chronological holdouts;
- finalized reconciliation/rollback behavior verified;
- alert latency and single-delivery guarantees verified;
- storage, backup, and retention proven sustainable at measured peak rates.

Passing a time gate requires mature data and successful measurements, not merely elapsed calendar
time.

## Known priorities that must not be hidden

Keep resolved incidents separate from open acceptance work:

- The production wallet-alpha process previously exhausted a roughly 970 MB Node heap because it
  loaded the full evidence history and rebuilt every ledger. The replacement revisioned dirty-wallet
  queue, one-wallet leases, capped evidence reads and bounded scorer pass PostgreSQL 16 tests. A
  generated 99-normal-plus-one-oversized workload completed under the 112 MB heap/160 MB container
  boundaries and proved that the oversized wallet does not block later work. Production ranking
  refresh now filters qualified rows before an indexed anti-join; its measured plan fell from a
  40+ second score-history scan to 1.426 ms. Periodic status-count history scans were removed from
  the worker and remain on-demand only. Under a concurrent bounded backup, the final two-stage
  admission canary completed 26 queue revisions in 245.3 seconds: 12 wallets scored, 14 low-evidence
  revisions completed without scoring, zero failures/oversized rows, 96.27 MiB process RSS, zero
  restarts and no OOM. Treat this as code-complete but not production-accepted until the seven-day
  shared-host shadow gate passes. Never regress to a full-history periodic job, a multi-wallet
  evidence load, a claim-time correlated evidence scan or a larger heap as a substitute.
- The previous price sampler stored repeated full provider payloads at a rate that dominated database
  growth. In production, ownership was reduced to `evidence-sampler`, lowering durable price ingress
  from roughly 16,000 rows/hour to 168 rows/hour; a bounded cycle deleted 50,000 old rows in 30
  seconds. Pool-state writes are five-minute/transition/rug gated and outcome writes are
  lifecycle-driven. Treat the writer amplification as resolved, but keep the seven-day
  relation/filesystem/WAL shadow open until autovacuum reuse and retention lag are stable.
- Canonical inbox growth previously depended on rehashing multi-kilobyte JSON after 48 hours, which
  could not catch live ingress. Insertion now computes the immutable JSONB hash once; migration 020
  selects only prehashed 48-72 hour work and three-day processed retention lets transitional legacy
  rows age out. The bounded production canary deleted 5,000 eligible processed rows and the planner
  used the new valid/ready partial index. Do not lengthen the hot horizon or reintroduce database-side
  payload hashing without a measured capacity proof.
- Live `swaps` previously duplicated both sides of every durable wallet trade even though its only
  production consumer materializes first-buy entries. It is now buy-only with a three-day indexed
  hot horizon; the full buy/sell FIFO evidence remains in `wallet_trade_events`. Entry rows copy the
  immutable source id and flow evidence, so the hot-row FK was removed and the id remains an archival
  reference after expiry. Two legacy indexes with zero production scans were removed concurrently.
  Do not extend swap retention or restore sell duplication merely for generic history; use the
  canonical inbox/backups or an explicit historical backfill workflow. On 2026-08-01 the monitor
  exposed about 3.2 hours of swap-retention lag because inbox pruning exhausted the shared deadline;
  the maintenance order now gives expired swaps the first row-oriented budget. A PostgreSQL 16
  smoke deleted ten expired rows in two five-row batches. Keep the production lag shadow open until
  it returns below one hour under concurrent backup/ingestion load.
- The standard RPC diagnostic `unresolvedTransactionCount` is cumulative and combines several failure
  classes. Use deltas plus backlog/coverage/freshness evidence for decisions until fetch-null,
  block-time and handler failures are exposed separately.
- Historical price acquisition is now bounded and the Pyth single-timestamp response is parsed
  correctly. Rows written before r13 with explicit `priceEvidence.rejected='lookup-failed'` remain
  truthful but incomplete. Repair them only through a bounded, idempotent enrichment design that
  preserves quote provenance and requeues affected wallet-alpha revisions; do not fabricate prices
  or run an unindexed full-table periodic update.
- `wallet-alpha-managed-v2` is implemented only as a bounded read-only model-selection shadow over
  `evidence-v1`. It uses the frozen managed-exit outcomes plus explicit rug/catastrophic-loss rates
  instead of relaxing the fixed-horizon v1 gate. It does not persist scores, emit signals, claim the
  work queue or contact Telegram. Do not schedule or promote it until threshold-crossing fill
  realism, query/RSS bounds, a future-only shadow cohort and the normal chronological acceptance
  gates pass.
- Creator/funder/cluster coverage, finalized reconciliation and Meteora/Orca launch coverage remain
  rollout work. They block live-capital readiness even if the shadow canary is stable.
- Migrations 025-032 and the associated repository/maintenance changes implement the
  fixed-disk architecture: daily chain-payload and price partitions, filesystem-releasing
  retention, fail-closed risk admission, a 95-day admitted-evidence cap and ingestion disk
  hysteresis. The disposable PostgreSQL 16 populated upgrade, repository integration and partition
  retirement gates passed on 2026-07-28; the production migrations were then backup-gated and
  completed with all new indexes valid. The matching application image was installed into stopped
  containers and passed its image-level type/admission gate. The fixed-disk profile has been
  explicitly restarted; the seven-day fixed-disk shadow remains an open acceptance gate.
  Do not run migration 027 or 028 casually: both intentionally rebuild/drop legacy storage.
- The repository currently has no established commit history or remote. Preserve immutable source and
  database rollback artifacts before deployment; establish a reviewed baseline commit before the
  next risky refactor.

Update this section only when reproducible evidence proves a priority resolved or changes its state.

## Definition of done

Work is done only when:

- the requested behavior is implemented within scope;
- relevant invariants are preserved;
- tests and required integration/performance checks pass;
- failure and recovery paths are covered;
- schema/config/docs are synchronized;
- no secret or unrelated user change is exposed or overwritten;
- operational impact and rollback are understood;
- production state is changed only when authorized and verified;
- the handoff states remaining limitations honestly.

Never present placeholders, mocks, stale reports, process liveness, or waiting-state artifacts as a
completed real-world result.
