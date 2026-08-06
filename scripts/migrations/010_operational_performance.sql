-- Keep the canonical claim loop on the tiny unresolved working set instead of
-- repeatedly scanning processed JSON payloads.
CREATE INDEX IF NOT EXISTS idx_chain_event_inbox_unresolved_partition
  ON chain_event_inbox (
    chain,
    (COALESCE(NULLIF(payload->>'address', ''), source)),
    slot ASC NULLS LAST,
    transaction_index ASC NULLS LAST,
    instruction_index ASC NULLS LAST,
    received_at,
    idempotency_key
  )
  INCLUDE (status, attempt_count, next_attempt_at, lock_expires_at)
  WHERE status NOT IN ('processed', 'rolled_back');

-- Health summaries should use a compact index-only scan rather than reading
-- the large canonical payload heap.
CREATE INDEX IF NOT EXISTS idx_chain_event_inbox_health_summary
  ON chain_event_inbox (status)
  INCLUDE (slot, received_at, occurred_at, event_type, processed_at);

CREATE INDEX IF NOT EXISTS idx_pools_created_at_desc
  ON pools (created_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_tokens_first_seen_at_desc
  ON tokens (first_seen_at DESC);

-- Evidence sampling filters by token, strategy and a short event-time window.
CREATE INDEX IF NOT EXISTS idx_price_observations_sampler
  ON price_observations (token_address, strategy_version, observed_at);

CREATE INDEX IF NOT EXISTS idx_wallet_entry_signals_recent_strategy
  ON wallet_entry_signals (strategy_version, observed_at);

CREATE INDEX IF NOT EXISTS idx_wallet_signal_outcomes_recent_strategy
  ON wallet_signal_outcomes (strategy_version, observed_at);

CREATE INDEX IF NOT EXISTS idx_wallet_alpha_scores_latest_per_wallet
  ON wallet_alpha_scores (
    chain,
    wallet_address,
    strategy_version,
    calculated_at DESC
  );

CREATE INDEX IF NOT EXISTS idx_wallet_trade_events_health_quality
  ON wallet_trade_events (data_quality)
  INCLUDE (execution_price_usd, observed_at);

-- High-churn tables need vacuum/analyze to react to fixed-size inbox updates
-- and evidence upserts before dead tuples become a CPU and I/O problem.
ALTER TABLE chain_event_inbox SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_threshold = 1000,
  autovacuum_analyze_threshold = 500
);

ALTER TABLE price_observations SET (
  autovacuum_vacuum_scale_factor = 0.03,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 2000,
  autovacuum_analyze_threshold = 1000
);

ALTER TABLE wallet_signal_outcomes SET (
  autovacuum_vacuum_scale_factor = 0.03,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_vacuum_threshold = 1000,
  autovacuum_analyze_threshold = 500
);
