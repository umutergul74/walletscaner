\pset pager off

SELECT
  index_class.relname,
  index_state.indisvalid,
  index_state.indisready,
  pg_size_pretty(pg_relation_size(index_class.oid)) AS size
FROM pg_index AS index_state
JOIN pg_class AS index_class ON index_class.oid = index_state.indexrelid
WHERE index_class.relname IN (
  'idx_chain_event_inbox_unresolved_partition',
  'idx_chain_event_inbox_health_summary',
  'idx_pools_created_at_desc',
  'idx_tokens_first_seen_at_desc',
  'idx_price_observations_sampler',
  'idx_wallet_entry_signals_recent_strategy',
  'idx_wallet_signal_outcomes_recent_strategy',
  'idx_wallet_alpha_scores_latest_per_wallet',
  'idx_wallet_alpha_scores_strategy_wallet_latest',
  'idx_wallet_trade_events_health_quality',
  'idx_wallet_alpha_work_claim',
  'idx_price_observations_retention',
  'idx_chain_event_inbox_retention',
  'idx_wallet_alpha_scores_retention',
  'idx_wallet_signal_outcomes_entry_time',
  'idx_wallet_trade_events_latest',
  'idx_chain_event_inbox_processed_slot',
  'idx_outcome_resolution_idempotency',
  'idx_outcome_resolution_due',
  'idx_pipeline_health_service_time'
)
ORDER BY index_class.relname;

EXPLAIN (ANALYZE, BUFFERS)
SELECT
  chain,
  COALESCE(NULLIF(payload->>'address', ''), source),
  slot,
  transaction_index,
  instruction_index,
  received_at,
  idempotency_key
FROM chain_event_inbox
WHERE status NOT IN ('processed', 'rolled_back')
ORDER BY
  chain,
  COALESCE(NULLIF(payload->>'address', ''), source),
  slot ASC NULLS LAST,
  transaction_index ASC NULLS LAST,
  instruction_index ASC NULLS LAST,
  received_at,
  idempotency_key
LIMIT 100;
