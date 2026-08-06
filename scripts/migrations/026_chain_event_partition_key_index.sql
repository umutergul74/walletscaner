-- migrate:no-transaction

-- New rows keep the queue partition key outside JSON. The payload fallback
-- covers only pre-025 unresolved rows until they finish or age out.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chain_event_inbox_partition_key_v2
  ON chain_event_inbox (
    chain,
    (
      COALESCE(
        NULLIF(partition_key, ''),
        NULLIF(payload->>'address', ''),
        source
      )
    ),
    slot ASC NULLS LAST,
    transaction_index ASC NULLS LAST,
    instruction_index ASC NULLS LAST,
    received_at,
    idempotency_key
  )
  INCLUDE (status, attempt_count, next_attempt_at, lock_expires_at)
  WHERE status NOT IN ('processed', 'rolled_back');
