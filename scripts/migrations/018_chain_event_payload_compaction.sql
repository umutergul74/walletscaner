-- Processed rows keep their canonical identity/timing columns for seven days,
-- but only the first 48 hours need the full provider payload on the fixed disk.
ALTER TABLE chain_event_inbox
  ADD COLUMN IF NOT EXISTS payload_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS payload_compacted_at TIMESTAMPTZ;
