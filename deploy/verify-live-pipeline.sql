\pset pager off

SELECT NOW() AS server_time;

SELECT filename, applied_at
FROM schema_migrations
WHERE filename IN (
  '010_operational_performance.sql',
  '012_wallet_alpha_incremental.sql',
  '013_legacy_schema_reconciliation.sql',
  '014_wallet_alpha_report_performance.sql'
)
ORDER BY filename;

SELECT c.relname,
       GREATEST(c.reltuples, 0)::bigint AS planner_estimated_rows,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size
FROM pg_class c
WHERE c.oid IN (
  'chain_event_inbox'::regclass,
  'price_observations'::regclass,
  'wallet_trade_events'::regclass,
  'wallet_entry_signals'::regclass,
  'wallet_signal_outcomes'::regclass
)
ORDER BY pg_total_relation_size(c.oid) DESC;

SELECT status, COUNT(*)
FROM chain_event_inbox
WHERE status NOT IN ('processed', 'rolled_back')
GROUP BY status
ORDER BY status;

SELECT event_type, source, COUNT(*) AS events, MAX(received_at) AS latest_received
FROM chain_event_inbox
WHERE status NOT IN ('processed', 'rolled_back')
GROUP BY event_type, source
ORDER BY event_type, source;

SELECT COUNT(*) AS prices_10m, MAX(observed_at) AS latest_price
FROM price_observations
WHERE observed_at >= NOW() - INTERVAL '10 minutes';

SELECT COUNT(*) AS wallet_trades_10m, MAX(observed_at) AS latest_wallet_trade
FROM wallet_trade_events
WHERE observed_at >= NOW() - INTERVAL '10 minutes';

SELECT COUNT(*) FILTER (WHERE revision > completed_revision) AS alpha_pending,
       COUNT(*) FILTER (
         WHERE locked_by IS NOT NULL AND lock_expires_at > NOW()
       ) AS alpha_leased
FROM wallet_alpha_work_queue;

SELECT pipeline, partition_key, last_contiguous_slot, status, updated_at
FROM pipeline_watermarks
ORDER BY updated_at DESC
LIMIT 25;

SELECT pg_size_pretty(pg_database_size(current_database())) AS database_size;
