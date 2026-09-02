-- migrate:no-transaction

-- Canonical claiming needs only the oldest unresolved row from each durable partition. Keeping
-- the direct partition column in the key lets PostgreSQL perform an index-only recursive seek;
-- the legacy expression index remains available as an immediate rollback path.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chain_event_inbox_direct_partition_head
  ON chain_event_inbox (
    chain,
    partition_key,
    slot ASC NULLS LAST,
    transaction_index ASC NULLS LAST,
    instruction_index ASC NULLS LAST,
    received_at,
    idempotency_key
  )
  INCLUDE (status, attempt_count, next_attempt_at, lock_expires_at)
  WHERE status NOT IN ('processed', 'rolled_back');

