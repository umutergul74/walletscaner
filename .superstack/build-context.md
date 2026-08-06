{
"pipeline": {
"canonical_flow": "program discovery -> PostgreSQL chain_event_inbox -> leased decode/normalize/enrich -> wallet trade evidence -> FIFO ledger -> wallet-alpha score -> transactional signal_outbox -> paper/alert/API",
"ingestion_method": "Free-plan hybrid: PublicNode standard logs/RPC for broad reviewed launch-program discovery and HTTP gap repair; batched DexScreener market gating; Helius standard logsSubscribe only for up to three market-eligible pools; filtered Helius HTTP/DAS token-risk fallback; transactionSubscribe remains an explicit paid-plan option",
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
"storage": "PostgreSQL system of record; Redis is hot cache/rate-limit state only",
"backfill_implemented": true,
"historical_provider": "Helius Enhanced Transactions plus Solana RPC gap repair",
"historical_backfill_method": "credit-budgeted stratified program windows plus wallet-entry pool windows, per-entry mint 20-40m horizon windows, and Helius DAS metadata batches",
"historical_backfill_persistence": "PostgreSQL evidence tables, historical market observations and 5m buckets, unique backfill-window state, ingestion_cursors, per-run atomic progress files in reports/backfills, and latest progress file reports/helius-historical-backfill-progress.json",
"historical_backfill_credit_control": "legacy Enhanced History estimated at 100 credits/request, DAS at 10 credits/request, with a persisted per-run hard budget",
"historical_data_quality": "completed versus saturated windows, SOL-denominated price/amount/volume, confidence-tagged price source, metadata coverage, unique token/wallet/day coverage",
"price_model": "same-transaction stable quote is observed-execution; same-transaction SOL quote converted by live/historical Pyth is oracle-converted; quote provenance is idempotently persisted before USD conversion is accepted; historical backlog conversion reuses persisted observations within 60 seconds and a bounded single-flight 60-second event-time cache before requesting the Pyth Benchmarks single-timestamp endpoint; requests are serialized at a minimum 1.2-second interval with bounded 429 backoff; DEX Screener is context/outcome/paper mark only",
"amount_model": "rawAmount decimal string plus decimals for accounting; numeric UI amounts are compatibility/display fields",
"risk_policy": "unknown critical token risk fails closed; direct creator is excluded; funded-by and cluster/insider gates remain rollout work",
"validation_method": "FIFO realized profitability plus bot-observed followability, 30/90d windows with decay, sample shrinkage/Wilson lower bound, two chronological holdouts, and capital-constrained paper replay",
"wallet_alpha_managed_shadow": "wallet-alpha-managed-v2 is implemented as a bounded read-only model-selection comparison over evidence-v1. It selects frozen tp15-sl20-20m outcomes, measures explicit rug/catastrophic-loss rates, lower-decile return and losing streaks, and keeps fixed-horizon-v1 unchanged as the control. The command defaults to 25 wallets, hard-caps at 100, includes a bounded low-score control, persists no score/signal/outbox state and is not authorized as a recurring shared-host service.",
"wallet_alpha_primary_report": "reports/wallet-alpha-latest.md",
"wallet_alpha_live_tracking": "revision-safe incremental wallet queue with one-wallet leases, wallet-scoped FIFO replacement, indexed latest-qualified score reads, bounded Helius standard logsSubscribe for market-eligible pools, and no circular top-wallet subscription loop",
"wallet_alpha_resource_model": "The production worker is separate from the on-demand report, invokes Node/tsx directly, disables gather parallelism only on its own PostgreSQL sessions, leases one wallet at a time, processes at most 100 work items or 240 seconds per run, and sleeps five minutes between runs. A two-stage admission probe reads at most six trades and three entries before any full ledger/scoring load; a low-evidence revision is completed without a score while durable evidence remains and later changes requeue it. Full reads hard-cap at 10,000 trades, 2,000 entries and 4,000 outcomes; an oversized wallet is isolated for a 24-hour retry while later wallets continue. Persistence concurrency is two, the Node heap is 112 MB and the container ceiling is 160 MB. Correlated admission inside the ordered claim SQL is prohibited after a production canary produced a 56+ second disk scan. The final bounded-probe canary completed 26 revisions in 245.3 seconds under concurrent backup I/O: 12 scored, 14 low-evidence skips, zero failures and 96.27 MiB RSS.",
"evidence_sampling": "DexScreener 30-token batch endpoint with concurrency 2 and deterministic pool/120-second compact observations. Evidence-sampler is the sole durable price_observations writer and runs by direct Node/tsx; removing its npm wrapper reduced measured container memory from 78.3 MiB to 45.8 MiB. Solana-ingestion may sample every five seconds for in-memory decisions, but it does not append price history and writes compact pool state at most every 300 seconds while eligibility is unchanged; first samples, market-gate transitions and rugs persist immediately. Outcome persistence is lifecycle-driven: one provisional insert, no same-state rewrites, one unresolved or mature transition, and mature immutability. Evidence sampling keeps a 500-active-token ceiling, while ingestion keeps 120 fairly prioritized due pools per cycle and a 1,000 active-pool hard ceiling",
"ingestion_runtime_memory": "standard RPC signature dedupe is capped at 25,000; completed subscription requests are released; known-pool and token-risk caches have TTL plus 25,000/5,000 entry ceilings with cache sizes emitted in health logs; expiry sweeps are amortized; public HTTP transaction fetch uses a bounded six-attempt exponential retry budget, at most 128 live transaction workers and a 2,000-signature queue with request/retry/recovery/final-unresolved/in-flight/queued/dropped telemetry. At 80% queue pressure, the hot pool subscription is removed and its persisted trade coverage is marked incomplete so it cannot enter wallet-alpha evidence silently. The August 1 canary reached a 722-signature high-water mark, drained to zero, and recorded zero drops or pressure exclusions under a 160 MiB ceiling.",
"paper_replay_implemented": true,
"paper_delivery": "qualified-pool-paper-v1 is frozen as a $100 negative-control cohort. qualified-pool-paper-v2 is a separate future-only $100 cohort selected explicitly by PAPER_STRATEGY_VERSION: five-minute exact-pool confirmation; a fresh zero-risk, warning-free assessment; at least $30,000 liquidity, $10,000 five-minute volume, 40 transactions, 58% buy share, at most 1.5 volume/liquidity turnover and 90% liquidity retention; at most two $8 positions/$16 exposure; pessimistic fees/slippage; -15%/liquidity/stagnation/45-minute exits, 80% sale at +30%, another partial at +75% and an 18% trail. Both use append-only paper events, never share cash/trades and never invent a post-rug fill.",
"api_health": "DB-backed exact unresolved/dead-letter working-set health, planner-estimated processed history, rolling 24-hour parser/price coverage, bounded recent watermarks and a 15-second process cache; stream connection diagnostics remain structured worker logs",
"operational_retention": "The bounded-storage revision in migrations 025-032 was applied to production on 2026-07-28 after a current byte-identical off-host backup and populated PostgreSQL 16 gates. Canonical metadata remains in chain_event_inbox while complete provider JSON is atomically written to daily chain_event_payloads partitions; processed payloads retain 48 hours and rare unresolved old payloads move to chain_event_payload_holds before a partition drop returns heap/TOAST/index files to the filesystem. price_observations is rebuilt into two-day daily partitions with a compact global key table. Failed-risk/excluded wallet evidence retains 3 days and admitted wallet trade/entry/outcome evidence retains 95 days for the 30/90-day scorer. Existing 3-day inbox/swap and 7-day superseded-score horizons remain.",
"operational_monitoring": "A 300-second working-set monitor writes an atomic JSON status report and structured logs for backlog, event lag, pending age, database size, host disk and CPU/load. It also reports recent price rows/hour, oldest-price retention lag and processed raw-payload compaction lag. Solana ingestion independently enforces a 90%/4 GiB disk admission close and resumes only below 85% with hysteresis, stopping source/parser writes while maintenance remains available. A dedicated low-resource Telegram notifier is the only Telegram API consumer.",
"database_maintenance": "Purpose-built partial/composite indexes cover canonical claims, retention, latest-slot/freshness probes, evidence sampling and incremental wallet-alpha reads. Daily payload and price partitions make retention a filesystem-releasing DROP operation; the one-time 027/028 bounded-table transition removes legacy price-index and inbox-TOAST bloat without VACUUM FULL. Row-oriented work remains capped at 5,000 rows/30 seconds; expired three-day swaps run before processed inbox metadata so a continuously eligible inbox cannot starve swap retirement. The maintenance PostgreSQL pool allows 15 seconds for its initial read-only inventory and then lowers the same connection to a five-second mutation timeout; a timed-out mutation increments telemetry and stops without rolling back prior committed batches. A PostgreSQL 16 smoke deleted ten expired swaps in two five-row batches. The production canary then deleted 7,694 swaps and 54 old wallet trades, bounded three heavy stages by timeout and reduced swap-retention lag from about 3.2 hours to 85 seconds. Canonical partition-head selection keeps its recursive loose-index scan and extracts new partition keys outside JSON.",
"resource_isolation": "All production services have explicit memory, CPU quota/weight and PID ceilings; Walletscaner CPU shares are lower than the host default so the protected co-tenant wins contention; UI, research, paper, operations and legacy services are opt-in Compose profiles while profile-free startup is core-only",
"backup_policy": "Daily PostgreSQL custom-format dumps with SHA-256 sidecars and pg_restore list validation; server retention is fail-safe and deletes only generations carrying a matching offsite-verified SHA acknowledgement; one unacknowledged completed generation blocks later scheduled dumps so off-host downtime cannot create unbounded server growth. Once all generations are acknowledged, the newest server recovery point is retained and older verified copies are removed before allocating the next temporary dump. The job requires free space at least equal to the newest dump plus a 2 GiB emergency margin, and interrupted temporary dumps are cleaned only after six hours. A daily 09:00 Europe/Istanbul Windows task runs the resumable, rate-limited PowerShell pull workflow, verifies SHA-256 and pg_restore readability outside the production host, records an atomic local status file and only then acknowledges the server generation; at least one server copy and two off-host generations are retained, with a full isolated PostgreSQL 16 restore required weekly and before deleting the last server copy of a recovery generation",
"finalized_reconciliation": "schema-supported but production rollback reconciliation remains pending",
"quality_gates": "The current revision passes TypeScript typecheck, ESLint, 172 non-integration tests, all 13 PostgreSQL 16 repository integration cases, clean migrations 001-032, the production-image typecheck and 26 targeted alpha/ingestion/paper tests. The latest-qualified alpha query preserves demotion semantics and its production EXPLAIN ANALYZE fell from a prior 40+ second history scan to 1.426 ms using existing indexes.",
"wallet_alpha_managed_benchmark": "The final generated 100-wallet batch with 6,000 trades, 3,000 entries and 3,000 managed outcomes completed in 300.64 ms at 28.41 MiB heap and 105.52 MiB RSS under a 112 MiB heap / 160 MiB RSS boundary. This is a local anti-regression measurement, not shared-host or provider validation.",
"canary_live_evidence": "The r13 shared-host sample completed 1,314 canonical events with zero worker failures, zero Pyth provider errors and zero rate limits. Historical SOL/USD served 477 memory hits and 318 PostgreSQL hits while issuing only 17 serialized provider requests; 27 durable historical quote observations spanning 2026-07-15 20:59 UTC through 2026-07-16 10:54 UTC were persisted. Ingestion used 98.95 MiB of its 160 MiB limit at about 11% CPU with restart count zero and OOM false; protected Robinhood services retained the same container identities and stayed healthy",
"active_shadow_evidence": "The fixed-disk profile restarted by explicit user instruction on 2026-07-28 after the stopped-stack migration reduced PostgreSQL from about 18.9 GB to 10.55 GB. On 2026-08-01 the newest completed server dump was copied off host, SHA-256/pg_restore verified and acknowledged before the older server generation was retired, temporarily recovering disk to about 83% used/12.5 GB free. The next 1.009 GB bounded dump was also verified on-host/off-host and acknowledged before replacing the Jul29 server copy, returning the host from 87% used/9.62 GB free to 85% used/11.11 GB free. Ingestion remained open with zero queue-pressure drops, alpha stayed below its memory ceiling, and Robinhoodscaner container identities remained unchanged. This proves bounded startup/canary behavior, not the required seven-day growth plateau.",
"rollout_state": "Migrations 015-032, the bounded partition/retention schema and the alpha-v2 application image are deployed and the authorized fixed-disk profile is running. PostgreSQL, Redis, ingestion, evidence sampler, bounded wallet-alpha worker, maintenance/monitoring/backup, Telegram notifier and qualified-pool-paper-v2 are active; v1 is frozen as a no-open-position negative control, while API, web and legacy research remain stopped. V2 activated a separate future-only $100 portfolio on 2026-08-01 and its startup notification was delivered exactly once; it inherited no v1 trade or cash state. ENABLE_LIVE_EXECUTION remains false. The next hard gate is a seven-day storage/resource/lag shadow plus fourteen days of the new v2 chronological paper cohort, not a profitable-strategy conclusion."
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
"security_score": 88,
"quality_score": 92,
"ready_for_mainnet": false,
"findings": {
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
"seven-day shared-host shadow acceptance evidence is not complete",
"fixed-disk retention, WAL, backup and autovacuum headroom must remain stable for the full seven-day shadow",
"older explicit lookup-failed wallet-trade prices require bounded idempotent enrichment before execution coverage can be accepted",
"funding/cluster insider exclusion is not a production score gate",
"finalized rollback reconciliation is schema-ready but not implemented"
],
"open_medium": [
"Meteora and Orca launch coverage is pending reviewed adapters and fixtures",
"repository has no baseline commit or remote history"
]
}
}
}
