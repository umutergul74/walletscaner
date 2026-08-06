-- Canonical identity, ordering and retry state remain in chain_event_inbox.
-- Large provider payloads use daily partitions so retention can return disk
-- space to the filesystem instead of accumulating dead TOAST pages.
ALTER TABLE chain_event_inbox
  ADD COLUMN IF NOT EXISTS partition_key TEXT;

CREATE TABLE IF NOT EXISTS chain_event_payloads (
  event_idempotency_key TEXT NOT NULL
    REFERENCES chain_event_inbox(idempotency_key) ON DELETE CASCADE,
  received_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  payload_sha256 TEXT NOT NULL,
  PRIMARY KEY (received_at, event_idempotency_key)
) PARTITION BY RANGE (received_at);

CREATE INDEX IF NOT EXISTS idx_chain_event_payloads_event
  ON chain_event_payloads (event_idempotency_key);

-- A rare unresolved event must not pin a high-volume daily partition forever.
-- Maintenance moves such payloads here before retiring the old partition.
CREATE TABLE IF NOT EXISTS chain_event_payload_holds (
  event_idempotency_key TEXT PRIMARY KEY
    REFERENCES chain_event_inbox(idempotency_key) ON DELETE CASCADE,
  received_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  payload_sha256 TEXT NOT NULL,
  held_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
DECLARE
  day_offset INTEGER;
  lower_bound DATE;
  upper_bound DATE;
  partition_name TEXT;
BEGIN
  FOR day_offset IN -3..8 LOOP
    lower_bound := CURRENT_DATE + day_offset;
    upper_bound := lower_bound + 1;
    partition_name := 'chain_event_payloads_' || to_char(lower_bound, 'YYYYMMDD');
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF chain_event_payloads
         FOR VALUES FROM (%L) TO (%L)',
      partition_name,
      lower_bound::text || ' 00:00:00+00',
      upper_bound::text || ' 00:00:00+00'
    );
  END LOOP;
END
$$;

COMMENT ON TABLE chain_event_payloads IS
  'Short-lived canonical provider payloads; daily partitions are retired after bounded retention.';
COMMENT ON TABLE chain_event_payload_holds IS
  'Payloads for unresolved old canonical events moved out of retireable daily partitions.';
