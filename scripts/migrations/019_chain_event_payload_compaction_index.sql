-- migrate:no-transaction

-- Keep bounded compaction work proportional to the remaining uncompacted
-- working set without detoasting the provider JSON payload.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chain_event_inbox_payload_compaction
  ON chain_event_inbox (
    (COALESCE(processed_at, received_at)),
    idempotency_key
  )
  WHERE status = 'processed'
    AND payload_compacted_at IS NULL;
