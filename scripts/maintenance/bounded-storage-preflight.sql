\set ON_ERROR_STOP on

SELECT 'database_bytes' AS metric, pg_database_size(current_database())::text AS value
UNION ALL
SELECT 'inbox_total', COUNT(*)::text FROM chain_event_inbox
UNION ALL
SELECT 'inbox_keep', COUNT(*)::text
FROM chain_event_inbox
WHERE status NOT IN ('processed', 'rolled_back')
   OR COALESCE(processed_at, received_at) >= NOW() - INTERVAL '3 days'
UNION ALL
SELECT 'inbox_unresolved', COUNT(*)::text
FROM chain_event_inbox
WHERE status NOT IN ('processed', 'rolled_back')
UNION ALL
SELECT 'price_total', COUNT(*)::text FROM price_observations
UNION ALL
SELECT 'price_keep', COUNT(*)::text
FROM price_observations
WHERE observed_at >= NOW() - INTERVAL '2 days'
UNION ALL
SELECT 'price_inbound_foreign_keys', COUNT(*)::text
FROM pg_constraint
WHERE contype = 'f' AND confrelid = 'price_observations'::regclass
UNION ALL
SELECT 'price_dependent_views', COUNT(*)::text
FROM information_schema.view_table_usage
WHERE table_schema = 'public' AND table_name = 'price_observations';

SELECT
  c.relname AS relation,
  pg_total_relation_size(c.oid) AS total_bytes
FROM pg_class AS c
WHERE c.oid IN (
  'chain_event_inbox'::regclass,
  'price_observations'::regclass,
  'wallet_trade_events'::regclass,
  'wallet_entry_signals'::regclass,
  'wallet_signal_outcomes'::regclass,
  'wallet_position_episodes'::regclass,
  'wallet_position_lots'::regclass
)
ORDER BY total_bytes DESC;
