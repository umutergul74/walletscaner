-- migrate:no-transaction

-- Archive-gated inbox retirement must start at the first verified archive
-- range. The older processed metadata horizon can legitimately contain rows
-- from before cold transport was activated; scanning those rows on every
-- maintenance pass exhausted the shared-host statement timeout.
--
-- Keep this index partial and ordered by the archive range key so the worker
-- can seek directly into verified ranges while preserving recently processed
-- rows through its separate processed-time predicate.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chain_event_inbox_archive_retention
  ON chain_event_inbox (received_at, idempotency_key)
  INCLUDE (processed_at)
  WHERE status IN ('processed', 'rolled_back');
