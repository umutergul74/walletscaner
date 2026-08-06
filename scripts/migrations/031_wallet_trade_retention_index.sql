-- migrate:no-transaction

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_trade_events_retention
  ON wallet_trade_events (observed_at, idempotency_key)
  INCLUDE (chain, wallet_address, strategy_version);
