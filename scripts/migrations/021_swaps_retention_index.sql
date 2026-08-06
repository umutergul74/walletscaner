-- migrate:no-transaction

-- Live swaps are a bounded first-entry bridge; global time retention must not
-- scan the multi-column wallet/token indexes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_swaps_retention
  ON swaps (observed_at, idempotency_key);
