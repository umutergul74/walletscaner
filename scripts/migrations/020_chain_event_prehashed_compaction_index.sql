-- migrate:no-transaction

-- New canonical inbox rows persist the immutable payload hash at insert time.
-- This index lets retention compact that bounded 48-72 hour working set
-- without scanning or detoasting the transitional legacy backlog.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chain_event_inbox_prehashed_compaction
  ON chain_event_inbox (
    (COALESCE(processed_at, received_at)),
    idempotency_key
  )
  WHERE status = 'processed'
    AND payload_compacted_at IS NULL
    AND payload_sha256 IS NOT NULL;
