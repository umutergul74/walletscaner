SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Migration 025 made partition_key durable, and every current repository writer derives a
-- non-empty value from the event address or source. Repair only the bounded unresolved working
-- set left by an older release; processed history is deliberately not rewritten.
UPDATE chain_event_inbox
SET partition_key = COALESCE(
  NULLIF(partition_key, ''),
  NULLIF(payload->>'address', ''),
  source
)
WHERE status NOT IN ('processed', 'rolled_back')
  AND NULLIF(partition_key, '') IS NULL;

-- NOT VALID avoids a table-wide validation scan on the large historical inbox while still
-- enforcing the invariant for every new or subsequently updated row. The bounded UPDATE above
-- makes the current unresolved working set safe for the direct claim path.
ALTER TABLE chain_event_inbox
  DROP CONSTRAINT IF EXISTS chain_event_inbox_unresolved_partition_key_check;
ALTER TABLE chain_event_inbox
  ADD CONSTRAINT chain_event_inbox_unresolved_partition_key_check
  CHECK (
    status IN ('processed', 'rolled_back')
    OR NULLIF(partition_key, '') IS NOT NULL
  ) NOT VALID;

