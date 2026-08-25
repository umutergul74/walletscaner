{
"current_release_hardening": {
"state": "r29-r30-operational-canary-storage-validation-waiting",
"date": "2026-08-25",
"scope": "R29 bounded alpha probes, qualified P2 classification, 250-row/45-second raw-payload compaction and zstd:1 backups; R30 finalized failed-transaction repair-boundary correctness",
"migration": "049_wallet_alpha_transient_retry_backoff.sql (additive; preserves active retry time while new evidence revisions coalesce; 048 reclassified legacy P2 without deleting evidence)",
"verification": "TypeScript, ESLint and workspace build pass; the post-migration-049 exact Node24/Linux/PostgreSQL16 gate passed 89 files and 428 tests, running the two migration-heavy DB suites sequentially; its rolled-back production canary preserved revision plus retry time",
"recovery_point": "memecoin_alpha_20260825T150924Z.dump; 2053352363 bytes; SHA-256 ba26a3c89fdb8dc671d92976659ae177a6d8f76be40a45b8b8f774bb54238160; sidecar and PostgreSQL16 archive-list verified; new generation off-site acknowledgement waiting; prior verified off-host generation retained",
"invariants": "no live execution, no source-evidence deletion, no B2 delete/lifecycle action, no shared-host/global Docker mutation"
},
"pipeline": {
"canonical_flow": "program discovery -> PostgreSQL chain_event_inbox -> leased decode/normalize/enrich -> wallet trade evidence -> FIFO ledger -> wallet-alpha score -> transactional signal_outbox -> paper/alert/API",
"ingestion_method": "websocket",
"ingestion_detail": "Free-plan hybrid: Pump.fun/PumpSwap standard logs on PublicNode and LaunchLab/CPMM standard logs on the official Solana endpoint, with PublicNode HTTP transaction fetch and durable exact-boundary gap repair; batched DexScreener market gating; Helius standard logsSubscribe only for up to three market-eligible pools; filtered Helius HTTP/DAS token-risk fallback; transactionSubscribe remains an explicit paid-plan option",
"durability": "PostgreSQL inbox/outbox with idempotency keys, processing attempts, leases, retry/dead-letter states and per-address partition-head claiming from processed watermarks; canonical claims use an index skip-scan and bounded cross-partition concurrency while preserving one in-flight head per partition; delayed swap replay lazily hydrates immutable pool context from PostgreSQL instead of depending on the two-hour active sampling map",
"event_time": "chain blockTime is occurredAt/observedAt; receivedAt, processedAt and finalizedAt are distinct",
"data_types": [
"canonical-chain-events",
"pipeline-watermarks",
"token-profiles",
"pools",
"swaps",
"liquidity-events",
"quote-price-observations",
"wallet-entry-signals",
"wallet-trade-events",
"wallet-position-lots",
"wallet-position-episodes",
"wallet-alpha-scores",
"wallet-alpha-signals",
"signal-outbox",
"paper-trades",
"risk-assessments"
],
"storage": "postgresql",
"storage_detail": "PostgreSQL is the hot system of record; Redis holds bounded cache/rate-limit state only; independently restored daily raw segments and verified database generations are retained off-host in Backblaze B2",
"backfill_implemented": true,
"historical_provider": "Helius Enhanced Transactions plus Solana RPC gap repair",
"historical_backfill_method": "credit-budgeted stratified program windows plus wallet-entry pool windows, per-entry mint 20-40m horizon windows, and Helius DAS metadata batches",
"historical_backfill_persistence": "PostgreSQL evidence tables, historical market observations and 5m buckets, unique backfill-window state, ingestion_cursors, per-run atomic progress files in reports/backfills, and latest progress file reports/helius-historical-backfill-progress.json",
"historical_backfill_credit_control": "legacy Enhanced History estimated at 100 credits/request, DAS at 10 credits/request, with a persisted per-run hard budget",
"historical_data_quality": "completed versus saturated windows, SOL-denominated price/amount/volume, confidence-tagged price source, metadata coverage, unique token/wallet/day coverage",
"next_release_discovery": "Deployed in storage-flow-r1-20260816: walletscaner-v3-inner-cpi decodes reviewed pool creation from both top-level and CPI/inner instructions, resolves v0 loaded-address indices, isolates malformed base58 instructions, persists instruction coordinates, and emits program-level decoded/unmatched plus inner/top-level coverage without new provider calls or durable metric rows.",
"next_release_discovery_validation": "A read-only 24-hour production payload replay at 2026-08-14 22:00 UTC recovered 328/432 events that the former top-level-only decoder had classified as generic solana_transaction; every recovery was an inner instruction. The 2026-08-16 production diagnosis then proved that a reported 749/774 ratio was metric contamination: all 25 unmatched rows were unfiltered initial/reconnect backfill transactions (one Pump.fun, ten CPMM, nine LaunchLab and five PumpSwap), while live filtered candidates decoded 749/749. The next release reapplies the exact instruction-log predicate after fetched transactions and reports intentional drops as postfetchFilteredTransactionCount. This corrects persistence and the denominator; deep reconnect-gap closure still requires a separate bounded provider/replay proof.",
"discovery_gap_repair": "Migrations 044-046 plus R30 capture an exact truncation cursor, stage durably, replay oldest-first and require complete immutable-target replay, exact slot, finalized signature status, append-only proof and post-incident WebSocket evidence. Transaction success is audit metadata rather than a boundary gate: a finalized failed transaction is ordered evidence and replay classifies it as no discovery event. The moving cursor/head is never proof; capped or unresolved intervals remain alpha-excluded.",
"next_release_discovery_prefilter": "Deployed in storage-flow-r1-20260816: when every subscription on a StandardSolanaEventSource has non-empty exact log filters, nonmatching raw logsNotification strings are rejected before JSON.parse and counted by message/byte diagnostics; any unfiltered address disables the fast path. The first 25-minute production sample prefiltered 140,179 of 140,231 messages and completed 53/53 canonical events without parser failures, drops, reconnects or queue pressure. This reduces JSON allocation/GC load without pretending to reduce inbound network traffic.",
"price_model": "same-transaction stable quote is observed-execution; same-transaction SOL quote converted by live/historical Pyth is oracle-converted; quote provenance is idempotently persisted before USD conversion is accepted; historical backlog conversion reuses persisted observations within 60 seconds and a bounded single-flight 60-second event-time cache before requesting the Pyth Benchmarks single-timestamp endpoint; requests are serialized at a minimum 1.2-second interval with bounded 429 backoff; DEX Screener is context/outcome/paper mark only",
"amount_model": "rawAmount decimal string plus decimals for accounting; numeric UI amounts are compatibility/display fields",
"risk_policy": "unknown critical token risk fails closed; direct creator is excluded; funded-by and cluster/insider gates remain rollout work",
"validation_method": "FIFO realized profitability plus bot-observed followability, 30/90d windows with decay, sample shrinkage/Wilson lower bound, two chronological holdouts, and capital-constrained paper replay",
"wallet_alpha_managed_shadow": "wallet-alpha-managed-v2 is implemented as a bounded read-only model-selection comparison over evidence-v1. It selects frozen tp15-sl20-20m outcomes, measures explicit rug/catastrophic-loss rates, lower-decile return and losing streaks, and keeps fixed-horizon-v1 unchanged as the control. The command defaults to 25 wallets, hard-caps at 100, loads evidence in five-wallet batches with a hard batch ceiling of ten, excludes missing/negative/over-60-second buy-to-entry timing, includes a bounded low-score control, persists no score/signal/outbox state and is not authorized as a recurring shared-host service.",
"wallet_alpha_primary_report": "reports/wallet-alpha-latest.md",
"wallet_alpha_live_tracking": "revision-safe incremental wallet queue with one-wallet leases, wallet-scoped FIFO replacement, indexed latest-qualified score reads, bounded Helius standard logsSubscribe for market-eligible pools, and no circular top-wallet subscription loop",
"wallet_alpha_resource_model": "The production worker is separate from the on-demand report, invokes Node/tsx directly, disables gather parallelism only on its own PostgreSQL sessions, leases one wallet at a time and processes at most 100 work items or 240 seconds per bounded cycle. PostgreSQL LISTEN/NOTIFY is a wake hint with bounded polling fallback. Prefetch covers at most 100 candidates; trades, entries and outcomes use three separate index-backed five-second upper-bound probes so one relation cannot consume the others' timeout. Full reads hard-cap at 10,000 trades, 2,000 entries and 4,000 outcomes; oversized evidence is quarantined. Migration 049 preserves transient retry backoff across coalesced evidence revisions. Persistence concurrency is two, heap 112 MB and container 160 MB. R29 live cycles processed 72/92/90 wallets with zero current-cycle failure; the last completed in 36.577 seconds.",
"wallet_alpha_priority_queue": "Migrations 043/047/048/049 keep one revision-safe row. P2 is restricted to a controlled-flow, critical-risk-passed entry whose latest persisted wallet status is watch/candidate/validated-paper; other risk-passed entries are P1, and buys/price enrichment are P0. R29 producer semantics and a one-time evidence-preserving reclassification reduced legacy risk-passed-source-entry P2 from 207 to zero. Active transient retry and evidence-limit quarantine times survive new revision coalescing, completion remains revision-safe and NOTIFY remains only a wake hint. Production future-event p95/p99 and one-hour net backlog equilibrium remain waiting.",
"alpha_quality_baseline": "The 2026-08-16 read-only baseline found zero persisted wallet-alpha signals and zero latest watch-or-better wallets. The top observed wallets have hundreds of high-quality-price realized episodes, but managed followability still has roughly 9%-14% catastrophic-loss rates. Source-buy to entry timing was p50 19.84s/p90 56.42s/p95 148.20s; a 60-second shadow gate retained 5,204 of 5,771 entries and excluded 567 stale/unknown rows. The original 25-wallet all-at-once shadow reported 176.56 MiB RSS; five-wallet batching completed at 139.01 MiB RSS. The next research priority is exact-pool, latency- and liquidity-aware chronological followability plus wallet cluster/funder independence, not weaker score gates or more storage features.",
"token_alpha_v4_causal_audit": "The 2026-08-22 read-only PostgreSQL 16 clone audit evaluated 177 distinct strict-flow exact markets with a 7.1% modeled round-trip cost. Strict-v2 failed every chronological window; holdout2 had -1.52% average return excluding the best winner, PF 1.00, 11.43% catastrophic-loss rate and -107.09% worst return. Wallet quality was causally reconstructed only from outcomes frozen before each market: 26 markets had a safe-3 supporter and seven had a safe-6 supporter, but none of 5,760 parameter combinations passed train plus validation. The result is no-promotable-v4. Migration 039 therefore froze only a future shadow universe; it did not authorize a v4 paper strategy.",
"evidence_sampling": "DexScreener 30-token batch endpoint with concurrency 2 and deterministic pool/120-second compact observations. Evidence-sampler is the sole durable price_observations writer and runs by direct Node/tsx; removing its npm wrapper reduced measured container memory from 78.3 MiB to 45.8 MiB. Provider requests remain token-batched, but active evidence is grouped by exact `(token,pool)` so a same-mint first pool cannot starve other execution pools. Outcome paths never fall back to another pool. Calculations are compared with the loaded lifecycle state; only new or monotonic status changes enter bounded 200-row repository upserts, with one wallet work-queue revision per changed wallet/batch. Heartbeats expose provider, database read/write and total cycle durations plus market and transition counts. Solana-ingestion may sample every five seconds for in-memory decisions, but it does not append price history and writes compact pool state at most every 300 seconds while eligibility is unchanged; first samples, market-gate transitions and rugs persist immediately. Evidence sampling keeps a 500-active-token ceiling, while ingestion keeps 120 fairly prioritized due pools per cycle and a 1,000 active-pool hard ceiling",
"ingestion_runtime_memory": "standard RPC signature dedupe is capped at 25,000; completed subscription requests are released; known-pool and token-risk caches have TTL plus 25,000/5,000 entry ceilings with cache sizes emitted in health logs; expiry sweeps are amortized; public HTTP transaction fetch uses a bounded six-attempt exponential retry budget, at most 128 live transaction workers and a 2,000-signature queue with request/retry/recovery/final-unresolved/in-flight/queued/dropped telemetry. At 80% queue pressure, the hot pool subscription is removed and its persisted trade coverage is marked incomplete so it cannot enter wallet-alpha evidence silently. Unsubscribing now purges only that address's not-yet-admitted RAM signatures and reports the count. PostgreSQL-incompatible NUL code points are represented by a literal Unicode-escape marker together with occurrence count and original-payload SHA-256, preventing one malformed provider string from blocking an ordered pool indefinitely. Discovery queue-pressure or dropped-signature counter growth opens an immediate durable per-program fail-closed coverage incident without increasing concurrency. Discovery initial/reconnect repair uses a validated 100/100/5 profile: it scans at most 500 signatures, has a product hard cap of 2,000 and exposes the active bounds in health telemetry without raising live queue, worker, CPU or RAM limits. Exact-pool trade bootstrap separately uses a 500/500/4 bounded page profile; a cursorless initial page that saturates 500 emits nothing and marks that exact pool incomplete instead of pretending the unknown prefix was recovered.",
"paper_replay_implemented": true,
"paper_delivery": "The broad qualified-pool cohort and paper-v1/v2 remain immutable controls. Paper-v3 opened three positions and lost $14.1623381901: two exact pools reached zero liquidity and one hit the hard stop. Migration 039 paused v3 at $85.837661809865 cash with zero open positions. strict-flow-v4-causal-shadow-20260822 is future-only and records strict-flow decisions with status shadow; Telegram, paper and live execution are false. Shadow rows cannot be claimed by Telegram or consumed by v3. A paper v4 remains prohibited until the frozen seven-day/30-market exact-fill, robust-return, tail-risk and independence gates pass.",
"api_health": "DB-backed exact unresolved/dead-letter working-set health, planner-estimated processed history, rolling 24-hour parser/price coverage, bounded recent watermarks and a 15-second process cache; stream connection diagnostics remain structured worker logs",
"operational_retention": "The bounded-storage revision in migrations 025-032 was applied to production on 2026-07-28. Migration 033 added the cold-archive manifest; migration 034 was backup-gated and applied on 2026-08-14 with zero invalid indexes. Canonical payload partition retirement requires four simultaneous facts: the exact independently restored manifest is verified, Object Lock has at least the configured seven-day reserve, a non-empty post-activation future-only canary has durably approved the policy, and ARCHIVE_RETIREMENT_ENABLED=true is set for that maintenance process. The 2026-08-15 canary satisfied the durable policy on 2026-08-16; the recurring maintenance runtime gate is now true. The first approved bounded run retired 12 verified old partitions with zero unresolved holds and zero durable wallet-evidence deletion. Unresolved old payloads move to chain_event_payload_holds transactionally before any future partition drop. price_observations uses two-day partitions; failed-risk evidence retains 3 days, admitted wallet evidence 95 days, processed inbox/swaps 3 days and superseded scores 7 days.",
"operational_monitoring": "A 300-second working-set monitor writes an atomic JSON status report and structured logs for backlog, event lag, pending age, database size, host disk and CPU/load. It also reports recent price rows/hour, oldest-price retention lag, processed raw-payload compaction lag, archive pending/verify/dead-letter counts, oldest unverified age, latest verification and durable retirement-policy readiness. The storage-flow revision persists at most one small filesystem/database sample per hour for 30 days, reports a conservative runway above an 8 GiB reserve only after a 24-hour maturity span, and degrades below 14 days. Solana ingestion independently enforces a 90%/4 GiB disk admission close and resumes only below 85% with hysteresis, stopping source/parser writes while maintenance remains available. A dedicated low-resource Telegram notifier is the only Telegram API consumer.",
"storage_sustainability": "The raw archive is operational but the 95-day wallet-evidence set is not at equilibrium: production evidence currently spans roughly 37-41 calendar days. The settled Aug14/Aug15 rates project trade, entry and outcome relations alone to about 15.6 GB at 95 days, so the current layout would hit the ingestion safety gate before maturity. A serial restore of the verified Aug15 dump benchmarked a compact target of scalar profitability/followability facts, open FIFO lots, dimensions and three-day detailed trade staging at 406,200,320 bytes versus 5,502,296,064 source bytes, a 92.62% reduction. All 235,707 episodes, 215,769 non-realized lots and 300,555 mature outcomes matched counts and deterministic retained-field digests. This is design evidence only; the separate wallet-evidence B2 archive, dual-write, scorer parity and stopped cutover gates remain open and no canonical evidence was deleted.",
"database_maintenance": "Purpose-built indexes cover canonical claims, retention, sampling and incremental alpha reads. R29 compacts verified raw payloads in 250-row statements within a 45-second run while retaining Object Lock reserve and unresolved evidence. Its first normal populated-host cycle compacted 6,750 rows in 43.726 seconds with zero timeout; recent ingress was 6,082 rows/hour versus approximately 13,500 rows/hour compaction capacity. The 48-hour boundary remained 11.05 hours late, so storage is waiting for zero lag and a clean 24-hour post-catch-up runway slope. The independent 95-day detailed-evidence horizon remains a larger cutover problem.",
"resource_isolation": "All production services have explicit memory, CPU quota/weight and PID ceilings; Walletscaner CPU shares remain below the host default. Cgroup evidence found alpha and PostgreSQL heavily quota-throttled while the host was about 71% idle, so a restart-free canary moved only alpha 0.07->0.10 CPU and PostgreSQL 0.18->0.21. Two cycles changed queue 8531->8495 and improved comparable cycle throughput without identity/restart/OOM or memory-limit changes. The aggregate hard ceiling remains below one CPU; revert if the one-hour queue slope is not negative. UI/research/paper/operations/legacy profiles remain opt-in and json logs are bounded at three 10 MiB files.",
"backup_policy": "Daily PostgreSQL16 custom-format dumps use zstd level 1 with no owner/ACL, SHA-256 sidecars and archive-list validation. One unacknowledged generation blocks the next; verified rotation retains a server recovery point and at least two off-host generations. Generation requires newest-size plus 2 GiB headroom and the interval is measured start-to-start. The 2026-08-25 2053352363-byte dump is locally verified but off-site acknowledgement is waiting; the prior off-host generation remains. Restores remain serial because parallel restore can race migration dependencies.",
"cold_archive_validation": "P0-P7 and the historical backlog completed before retirement. On 2026-08-16 the non-empty post-activation 2026-08-15 UTC segment became the future-only canary: 56,180 source/canonical rows, 1,207,394,029 restored bytes and the 86,201,706-byte object matched exact source/archive hashes under the attested Governance/30-day policy. All 15 then-known manifests were verified with zero retry/dead-letter state. The fixed Backblaze profiles still lack readFileRetentions and the writer is broader than ideal; the accepted attested-default-policy limitation remains explicit, and application code contains no B2 delete, lifecycle, bucket-management or governance-bypass command path.",
"finalized_reconciliation": "Operational in pipeline-quality-r10-20260823. Future-only confirmed events are blocked until their signature reaches a terminal finalized/rooted decision; failed/unresolved evidence rolls back fail-closed. A bounded 256-row terminal-state sweep also repairs an event that arrives after its signature was already finalized. The production late-terminal mismatch count fell from three to zero and the blocked inbox drained from 803 to zero without restart/OOM. This is pipeline correctness evidence, not the independent 99% source-denominator proof.",
"quality_gates": "The post-migration-049 source passes TypeScript, ESLint, workspace production build and 428/428 tests across 89 files in the exact Node24/Linux image with disposable PostgreSQL16, zstd, deploy-time Python and the reviewed Compose contract. The two migration-heavy DB suites passed sequentially after the all-parallel run exceeded only its 10-second schema-install hook. Production canaries do not replace future chronological shadow, exact-fill, independent 99% denominator or live-capital gates.",
"pipeline_stability_canary": "On 2026-08-22 UTC, immutable ingestion image pipeline-stability-r6-20260822 (sha256:2456672e58c...) replaced only solana-ingestion after an independently verified PostgreSQL 16 off-host backup. Its first approximately 29 minutes processed 553 inbox rows and materialized 365 pools, 367 swaps, 178 wallet trades and 66 entries; the observed health sample decoded 289/289 discovery candidates with zero canonical failure, unresolved event, queue, drop or pressure. Pump.fun, PumpSwap and CPMM transport were current healthy; LaunchLab remained fail-closed behind one durable unreconciled ACK/backfill incident. Immutable signal image signal-replay-r7-20260822 (sha256:f93f0c7d7ddb...) then recreated only Telegram and paper. A stopped-worker backlog coalesced to four latest program summaries, drained to zero and created no second wave; paper retained 85.8377 USD cash, -14.1623 USD realized PnL and zero open positions. The next sampler cycle consumed 66 exact-pool entries, wrote one observation and 132 outcome transitions with zero provider error/exact-pool miss. Restart/OOM remained zero for all three recreated workers.",
"wallet_alpha_managed_benchmark": "The final generated 100-wallet batch with 6,000 trades, 3,000 entries and 3,000 managed outcomes completed in 300.64 ms at 28.41 MiB heap and 105.52 MiB RSS under a 112 MiB heap / 160 MiB RSS boundary. This is a local anti-regression measurement, not shared-host or provider validation.",
"canary_live_evidence": "R20 production canary split four independent sockets across two standard providers after proving that the host PublicNode path acknowledged all four but delivered only two. Pump.fun/PumpSwap are current on PublicNode; LaunchLab/CPMM are current on api.mainnet-beta.solana.com without Helius discovery credits. The 07:46 UTC sample had zero reconnect, ACK timeout, heartbeat timeout, discovery queue, drop or handler rejection. LaunchLab had fresh notifications and no incident; CPMM had zero slot lag. Two capacity-exhausted historical repairs closed only as unreconciled and stayed alpha-excluded; one exact CPMM replay remains the only open incident. Telegram delivered the two recovery transitions once with no pending/retry/dead-letter state.",
"active_shadow_evidence": "At the R8 boundary, Wallet-alpha still had zero persisted signals and no latest watch-or-better wallet; no gate was weakened. Paper-v3 is frozen at $85.8377 cash, -$14.1623 realized PnL and zero open positions. Future strict-flow candidates are retained as non-deliverable shadow decisions for causal wallet support and exact-fill evaluation. The post-recovery ingestion canary decoded 227/227 discovery candidates, completed 459 canonical events and materialized 72 entries with one active exact-pool trade subscription and three-second wallet-trade freshness. Open incidents, unmatched/parser failures, queue/drop/pressure and sampling errors were zero. This is evidence collection, not profitable-alpha proof.",
"rollout_state": "Migrations through 049 are deployed. Ingestion runs R30 sha256:afd180aed4fb... from 039f1c5; sampler/alpha/maintenance/operations run R29 sha256:ecfc19602057... from b3ab4c8; Telegram remains compatible R23. PostgreSQL/Redis, archive schedulers and bounded backup scheduler are active; paper-alert/API/web/legacy research remain stopped. Host headroom is about 17.2 GB. Pump exact repair is reconciled; PumpSwap closed unreconciled at its cap and CPMM is the only open bounded replay, so both affected intervals remain alpha-excluded. ENABLE_LIVE_EXECUTION=false; no score/risk gate was weakened."
},
"stack": {
"language": "typescript",
"api": "express with PostgreSQL-only production startup",
"frontend": "nextjs production build",
"queue": "PostgreSQL canonical inbox/outbox; Redis hot state",
"database": "postgresql",
"production_services": [
"migrate",
"solana-ingestion",
"evidence-sampler",
"wallet-alpha",
"paper-alert",
"telegram-notifier",
"data-maintenance",
"operations-monitor",
"postgres-backup",
"api",
"web"
],
"legacy_research": "market-watch is isolated behind the legacy-research Compose profile"
},
"scope": {
"included": [
"Pump.fun",
"PumpSwap",
"Raydium LaunchLab",
"Raydium CPMM"
],
"pending": [
"Orca",
"Meteora"
],
"excluded": [
"EVM",
"live execution"
]
},
"review": {
"security_score": "B",
"quality_score": "A",
"ready_for_mainnet": false,
"findings": [
{
"severity": "high",
"status": "open",
"finding": "Observe-only research and paper infrastructure is production-stable, but chronological alpha and tail-risk evidence is below the live-capital gate.",
"fix": "Keep ENABLE_LIVE_EXECUTION=false until the frozen cohort has at least seven complete UTC days, 30 independent strict markets, 14 paper days, exact-pool realistic fills and accepted return/tail metrics."
},
{
"severity": "high",
"status": "open",
"finding": "Funding, creator-cluster and coordinated-insider independence are not yet enforced as production alpha gates.",
"fix": "Persist bounded funder/cluster features, freeze a new version and validate it on future-only markets before paper promotion."
},
{
"severity": "high",
"status": "open",
"finding": "The 95-day canonical wallet-evidence layout is not yet at measured steady state on the fixed disk.",
"fix": "Complete the separately designed B2 wallet-evidence artifact, incremental FIFO dual-read parity and backup-gated stopped cutover before retiring canonical detail."
},
{
"severity": "medium",
"status": "open",
"finding": "Bounded finalized-chain reconciliation is operational, but independent reconnect denominator and deliberate fork/rollback recovery drills have not passed the execution-grade gate.",
"fix": "Run deterministic duplicate/out-of-order replay plus forced reconnect and rollback fixtures against a documented source denominator before any execution-grade claim."
},
{
"severity": "medium",
"status": "open",
"finding": "Orca and Meteora launch coverage is absent, and smaller CPMM/LaunchLab/PumpSwap live samples are not yet a 99% decoder proof.",
"fix": "Add only reviewed program discriminators and denominator fixtures, then require per-program future live coverage before enabling each adapter."
},
{
"severity": "medium",
"status": "open",
"finding": "A Telegram credential was shared through an operator conversation and should be treated as exposed even though it is not tracked in the repository.",
"fix": "Rotate it in Telegram, update only the server secret file without logging the value, recreate only telegram-notifier and verify exactly-once delivery."
},
{
"severity": "low",
"status": "open",
"finding": "The repository still lacks a clean baseline commit/remote history for release provenance.",
"fix": "After reviewing the accumulated workspace changes, create a signed baseline and tag the immutable production release digest."
}
],
"finding_groups": {
"resolved_critical": [
"wallet-alpha unbounded full-history load and duplicate ledger rebuild",
"wallet-alpha report CTE rescans and non-strategy-first latest-score access",
"price evidence row/payload explosion with retention below ingress",
"public HTTP transaction visibility lag causing final unresolved trade fetches",
"unbounded per-cycle ingestion pool sampling and launch-storm active-pool growth",
"unbounded concurrent live transaction retry promises on a hot pool",
"unbounded Walletscaner container access to shared-host CPU and memory",
"standard RPC and risk/pool runtime cache memory growth plus per-pool full-map pruning",
"accidental all-profile shared-host startup",
"canonical inbox full-backlog window ranking and sequential event processing",
"delayed swap decoding coupled to the expiring active-pool sampling map",
"Pyth historical interval responses parsed as a single price plus unbounded request bursts"
],
"open_high": [
"future-only alpha and paper acceptance evidence is not complete",
"fixed-disk wallet-evidence lifecycle has not passed dual-read/cutover gates",
"older explicit lookup-failed wallet-trade prices require bounded idempotent enrichment before execution coverage can be accepted",
"funding/cluster insider exclusion is not a production score gate",
"forced fork/rollback and independent reconnect-denominator validation remain open"
],
"open_medium": [
"Meteora and Orca launch coverage is pending reviewed adapters and fixtures",
"repository has no baseline commit or remote history"
]
}
}
}
