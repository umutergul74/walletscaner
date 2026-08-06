-- migrate:no-transaction

-- Fixed-disk retention must walk oldest evidence without scanning the JSON
-- heaps or sorting the full durable history.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_entry_signals_retention
  ON wallet_entry_signals (observed_at, idempotency_key);
