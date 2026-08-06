CREATE INDEX IF NOT EXISTS idx_pools_base_token_created
  ON pools (chain, base_token_address, created_at)
  WHERE created_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wallet_trade_events_strategy_wallet_time
  ON wallet_trade_events (strategy_version, wallet_address, observed_at);

CREATE INDEX IF NOT EXISTS idx_wallet_entry_signals_strategy_wallet_time
  ON wallet_entry_signals (strategy_version, wallet_address, observed_at);

CREATE INDEX IF NOT EXISTS idx_wallet_signal_outcomes_strategy_entry_status
  ON wallet_signal_outcomes (
    strategy_version,
    entry_idempotency_key,
    status,
    exit_strategy,
    observed_at
  );
