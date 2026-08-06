-- migrate:no-transaction

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_signal_outcomes_retention
  ON wallet_signal_outcomes (observed_at, idempotency_key);
