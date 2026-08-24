{
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
"discovery_gap_repair": "Operational in R20 with migrations 044-045. A truncation captures its exact cursor before live admission advances, stages signature pages durably without moving that cursor, and replays oldest-first in bounded 50-item cycles. Only a completed truncation_cursor repair plus independent head match and post-incident WebSocket evidence can set coverage_reconciled_at. The unsafe R16 live-cursor sessions are preserved failed and never became proof. CPMM reached its exact 11,143-signature boundary and is converging; Pump.fun/PumpSwap each hit the reviewed 20,000-signature cap, remain failed and permanently alpha-excluded while their currently healthy transports were closed only as unreconciled.",
"next_release_discovery_prefilter": "Deployed in storage-flow-r1-20260816: when every subscription on a StandardSolanaEventSource has non-empty exact log filters, nonmatching raw logsNotification strings are rejected before JSON.parse and counted by message/byte diagnostics; any unfiltered address disables the fast path. The first 25-minute production sample prefiltered 140,179 of 140,231 messages and completed 53/53 canonical events without parser failures, drops, reconnects or queue pressure. This reduces JSON allocation/GC load without pretending to reduce inbound network traffic.",
"price_model": "same-transaction stable quote is observed-execution; same-transaction SOL quote converted by live/historical Pyth is oracle-converted; quote provenance is idempotently persisted before USD conversion is accepted; historical backlog conversion reuses persisted observations within 60 seconds and a bounded single-flight 60-second event-time cache before requesting the Pyth Benchmarks single-timestamp endpoint; requests are serialized at a minimum 1.2-second interval with bounded 429 backoff; DEX Screener is context/outcome/paper mark only",
"amount_model": "rawAmount decimal string plus decimals for accounting; numeric UI amounts are compatibility/display fields",
"risk_policy": "unknown critical token risk fails closed; direct creator is excluded; funded-by and cluster/insider gates remain rollout work",
"validation_method": "FIFO realized profitability plus bot-observed followability, 30/90d windows with decay, sample shrinkage/Wilson lower bound, two chronological holdouts, and capital-constrained paper replay",
"wallet_alpha_managed_shadow": "wallet-alpha-managed-v2 is implemented as a bounded read-only model-selection comparison over evidence-v1. It selects frozen tp15-sl20-20m outcomes, measures explicit rug/catastrophic-loss rates, lower-decile return and losing streaks, and keeps fixed-horizon-v1 unchanged as the control. The command defaults to 25 wallets, hard-caps at 100, loads evidence in five-wallet batches with a hard batch ceiling of ten, excludes missing/negative/over-60-second buy-to-entry timing, includes a bounded low-score control, persists no score/signal/outbox state and is not authorized as a recurring shared-host service.",
"wallet_alpha_primary_report": "reports/wallet-alpha-latest.md",
"wallet_alpha_live_tracking": "revision-safe incremental wallet queue with one-wallet leases, wallet-scoped FIFO replacement, indexed latest-qualified score reads, bounded Helius standard logsSubscribe for market-eligible pools, and no circular top-wallet subscription loop",
"wallet_alpha_resource_model": "The production worker is separate from the on-demand report, invokes Node/tsx directly, disables gather parallelism only on its own PostgreSQL sessions, leases one wallet at a time and processes at most 100 work items or 240 seconds per bounded cycle. It remains long-lived: PostgreSQL LISTEN/NOTIFY wakes elevated work, a non-empty backlog falls back to 30-second polls and idle state to 300-second polls. A read-only prefetch covers at most 100 unlocked queue candidates; each lateral index probe stops at six trades and three entries under a five-second statement timeout. Claims use `(strategy_version, priority DESC, not_before, updated_at, wallet_address)` and preserve revision safety. Full reads hard-cap at 10,000 trades, 2,000 entries and 4,000 outcomes; an oversized wallet is isolated for a 24-hour retry while later wallets continue. Persistence concurrency is two, the Node heap is 112 MB and the container ceiling is 160 MB. The first R13 production cycle ran 243.117 seconds at 121.04 MiB RSS and immediately refreshed one P2 wallet without increasing CPU/RAM limits.",
"wallet_alpha_priority_queue": "Operational in wallet-alpha-priority-r13-20260824: migration 043 keeps one revision-safe wallet row and adds priorities 0 background, 1 score-changing and 2 fail-closed risk-passed source entry. Producers coalesce with max priority; completing an old leased revision cannot erase a newer revision or its priority. Commit-bound PostgreSQL NOTIFY is only a wake hint and durable polling remains the recovery path. The accepted one-CPU rollout stabilized ingestion alone, then sampler, then alpha. Pre-alpha production lanes were P2/P1/P0 31/224/3,079; 30 P2 rows drained in the first bounded cycle and one signal-relevant completion caused immediate refresh with zero refresh failure. The remaining P2 row is the known over-10,000-trade wallet and is deferred for about 24 hours, not ready work. Final ingestion had four current programs, at least 20 consecutive clean samples and zero queue/drop/reject/unresolved/incident/breach/parser/finality error. Local commit-to-refresh was 181 ms, but production future-event p95/p99 remains waiting.",
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
"database_maintenance": "Purpose-built partial/composite indexes cover canonical claims, retention, latest-slot/freshness probes, evidence sampling and incremental wallet-alpha reads. Daily payload and price partitions make retention a filesystem-releasing DROP operation without VACUUM FULL. Compaction selects one verified archive UTC day and deletes payload/hold rows by `(received_at,event_idempotency_key)`, allowing runtime partition pruning; the exact segment must retain the Object Lock reserve. Migration 036 adds the exact rejected-entry partial index, and each 500-entry rejected batch locks entries, deletes dependent outcomes and deletes those entries in one transaction so timeout/error rolls back the whole batch. Migration 037 tracks genuine supersessions so seven-day cleanup avoids probing the large score JSON history. At the 2026-08-23 boundary, 22 verified payload segments held 765,680 rows; the latest maintenance run compacted 4,000 with zero timeout and 10,962 eligible rows remained. The 30-minute worker is making net progress, but storage is not called healthy until compaction lag returns to zero and a clean post-deploy runway window matures. The independent 95-day detailed-evidence horizon remains the larger cutover problem.",
"resource_isolation": "All production services have explicit memory, CPU quota/weight and PID ceilings; Walletscaner CPU shares are lower than the host default so the protected co-tenant wins contention; UI, research, paper, operations and legacy services are opt-in Compose profiles while profile-free startup is core-only. The next local Compose revision also caps each Walletscaner json-file log at three 10 MiB files; it is not active until a scoped post-canary container recreation and does not alter the shared Docker daemon or Robinhoodscaner.",
"backup_policy": "Daily PostgreSQL custom-format dumps have SHA-256 sidecars and PostgreSQL 16 archive-list validation. Server retention fails closed: one unacknowledged generation blocks the next dump; after off-host verification, the report-first reconciliation validates every dump/sidecar/marker tuple, retains the newest server copy and removes only older acknowledged copies. Generation requires newest-size plus 2 GiB headroom. The server scheduler now measures 24 hours start-to-start, eliminating dump-duration drift. A hidden 22:00 Europe/Istanbul Windows task uses ten resumable attempts, records an atomic status file, acknowledges only byte-identical verified output and immediately runs server reconciliation. At least one server and two off-host generations remain. Current restores are serial because the 2026-08-14 clone proved pg_restore -j can race migration-033 dependencies.",
"cold_archive_validation": "P0-P7 and the historical backlog completed before retirement. On 2026-08-16 the non-empty post-activation 2026-08-15 UTC segment became the future-only canary: 56,180 source/canonical rows, 1,207,394,029 restored bytes and the 86,201,706-byte object matched exact source/archive hashes under the attested Governance/30-day policy. All 15 then-known manifests were verified with zero retry/dead-letter state. The fixed Backblaze profiles still lack readFileRetentions and the writer is broader than ideal; the accepted attested-default-policy limitation remains explicit, and application code contains no B2 delete, lifecycle, bucket-management or governance-bypass command path.",
"finalized_reconciliation": "Operational in pipeline-quality-r10-20260823. Future-only confirmed events are blocked until their signature reaches a terminal finalized/rooted decision; failed/unresolved evidence rolls back fail-closed. A bounded 256-row terminal-state sweep also repairs an event that arrives after its signature was already finalized. The production late-terminal mismatch count fell from three to zero and the blocked inbox drained from 803 to zero without restart/OOM. This is pipeline correctness evidence, not the independent 99% source-denominator proof.",
"quality_gates": "R20 passes TypeScript, ESLint, 79/79 exact Linux image discovery/provider/supervisor/route/migration tests locally and on the production host, plus the earlier disposable PostgreSQL 16 populated migration-045 integration. The broader Windows suite previously passed 350 tests with 38 skips except two archive-artifact cases requiring an external zstd executable; exact Linux archive tests pass. Production canaries do not replace future chronological shadow, exact-fill, independent 99% denominator or live-capital gates.",
"pipeline_stability_canary": "On 2026-08-22 UTC, immutable ingestion image pipeline-stability-r6-20260822 (sha256:2456672e58c...) replaced only solana-ingestion after an independently verified PostgreSQL 16 off-host backup. Its first approximately 29 minutes processed 553 inbox rows and materialized 365 pools, 367 swaps, 178 wallet trades and 66 entries; the observed health sample decoded 289/289 discovery candidates with zero canonical failure, unresolved event, queue, drop or pressure. Pump.fun, PumpSwap and CPMM transport were current healthy; LaunchLab remained fail-closed behind one durable unreconciled ACK/backfill incident. Immutable signal image signal-replay-r7-20260822 (sha256:f93f0c7d7ddb...) then recreated only Telegram and paper. A stopped-worker backlog coalesced to four latest program summaries, drained to zero and created no second wave; paper retained 85.8377 USD cash, -14.1623 USD realized PnL and zero open positions. The next sampler cycle consumed 66 exact-pool entries, wrote one observation and 132 outcome transitions with zero provider error/exact-pool miss. Restart/OOM remained zero for all three recreated workers.",
"wallet_alpha_managed_benchmark": "The final generated 100-wallet batch with 6,000 trades, 3,000 entries and 3,000 managed outcomes completed in 300.64 ms at 28.41 MiB heap and 105.52 MiB RSS under a 112 MiB heap / 160 MiB RSS boundary. This is a local anti-regression measurement, not shared-host or provider validation.",
"canary_live_evidence": "R20 production canary split four independent sockets across two standard providers after proving that the host PublicNode path acknowledged all four but delivered only two. Pump.fun/PumpSwap are current on PublicNode; LaunchLab/CPMM are current on api.mainnet-beta.solana.com without Helius discovery credits. The 07:46 UTC sample had zero reconnect, ACK timeout, heartbeat timeout, discovery queue, drop or handler rejection. LaunchLab had fresh notifications and no incident; CPMM had zero slot lag. Two capacity-exhausted historical repairs closed only as unreconciled and stayed alpha-excluded; one exact CPMM replay remains the only open incident. Telegram delivered the two recovery transitions once with no pending/retry/dead-letter state.",
"active_shadow_evidence": "At the R8 boundary, Wallet-alpha still had zero persisted signals and no latest watch-or-better wallet; no gate was weakened. Paper-v3 is frozen at $85.8377 cash, -$14.1623 realized PnL and zero open positions. Future strict-flow candidates are retained as non-deliverable shadow decisions for causal wallet support and exact-fill evaluation. The post-recovery ingestion canary decoded 227/227 discovery candidates, completed 459 canonical events and materialized 72 entries with one active exact-pool trade subscription and three-second wallet-trade freshness. Open incidents, unmatched/parser failures, queue/drop/pressure and sampling errors were zero. This is evidence collection, not profitable-alpha proof.",
"rollout_state": "Migrations 015-045 are deployed. PostgreSQL/Redis plus R20 ingestion, R18 Telegram/maintenance, R13 evidence sampler/wallet-alpha and R9 operations are active; scheduled backup and archive writer/verifier remain active; paper-alert, API, web and legacy research are stopped. R20 production image is sha256:ec85cedd23f3... with source SHA-256 417578088d87.... The host has about 21 GB free at 70% used and the verified 1,505,940,747-byte server/off-site dump remains available. R19/R18/R13 images, exact env backups and the dump are rollback points. Aggregate discovery remains temporarily degraded only while the exact CPMM repair converges; current live transport is healthy. ENABLE_LIVE_EXECUTION=false remains enforced; no alpha gate was weakened."
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
