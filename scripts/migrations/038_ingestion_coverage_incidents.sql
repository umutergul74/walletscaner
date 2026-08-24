SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Discovery backfill coverage must use the chain time of the last durably
-- admitted event, not parser completion or cursor-write wall time.
ALTER TABLE ingestion_cursors
  ADD COLUMN IF NOT EXISTS last_event_occurred_at TIMESTAMPTZ;

-- Existing cursors predate the chain-time column. The inbox slot index keeps
-- this to a small exact-slot lookup per cursor; metadata outside the retained
-- horizon remains NULL and must fail the production preflight rather than use
-- cursor write time as chain evidence.
UPDATE ingestion_cursors AS cursor
SET last_event_occurred_at = (
  SELECT MIN(event.occurred_at)
  FROM chain_event_inbox AS event
  WHERE event.chain = cursor.chain
    AND event.slot = cursor.last_slot
    AND event.signature = cursor.last_signature
)
WHERE cursor.last_event_occurred_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM chain_event_inbox AS event
    WHERE event.chain = cursor.chain
      AND event.slot = cursor.last_slot
      AND event.signature = cursor.last_signature
  );

-- A transport recovery closes the operational incident, but it never asserts
-- that transactions from the observed gap were reconstructed. The original
-- evidence columns are immutable and every incident row is retained.
CREATE TABLE IF NOT EXISTS ingestion_coverage_incidents (
  idempotency_key TEXT PRIMARY KEY CHECK (BTRIM(idempotency_key) <> ''),
  chain TEXT NOT NULL CHECK (chain = 'solana'),
  provider TEXT NOT NULL CHECK (BTRIM(provider) <> ''),
  program_address TEXT NOT NULL CHECK (BTRIM(program_address) <> ''),
  reason TEXT NOT NULL CHECK (
    reason IN (
      'head_slot_lag',
      'raw_websocket_silence',
      'subscription_ack_timeout',
      'stale_live_notification',
      'backfill_truncated',
      'source_start_failed',
      'combined'
    )
  ),
  gap_started_at TIMESTAMPTZ NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL,
  cluster_slot BIGINT,
  source_slot BIGINT,
  slot_lag BIGINT CHECK (slot_lag IS NULL OR slot_lag >= 0),
  last_websocket_message_at TIMESTAMPTZ,
  silence_ms BIGINT CHECK (silence_ms IS NULL OR silence_ms >= 0),
  subscription_ack_timeout_count BIGINT NOT NULL DEFAULT 0
    CHECK (subscription_ack_timeout_count >= 0),
  successful_subscription_ack_count BIGINT NOT NULL DEFAULT 0
    CHECK (successful_subscription_ack_count >= 0),
  open_metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(open_metadata) = 'object'),
  restart_attempted_at TIMESTAMPTZ,
  restart_completed_at TIMESTAMPTZ,
  restart_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (restart_attempt_count >= 0),
  last_restart_attempted_at TIMESTAMPTZ,
  last_restart_completed_at TIMESTAMPTZ,
  last_restart_error TEXT,
  closed_at TIMESTAMPTZ,
  close_cluster_slot BIGINT,
  close_source_slot BIGINT,
  resolution TEXT CHECK (
    resolution IS NULL OR resolution = 'transport_recovered_gap_unreconciled'
  ),
  close_metadata JSONB CHECK (
    close_metadata IS NULL OR jsonb_typeof(close_metadata) = 'object'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (gap_started_at <= opened_at),
  CHECK (restart_attempt_count = 0 OR restart_attempted_at IS NOT NULL),
  CHECK (
    restart_completed_at IS NULL
    OR (restart_attempted_at IS NOT NULL AND restart_completed_at >= restart_attempted_at)
  ),
  CHECK (closed_at IS NULL OR closed_at >= opened_at),
  CHECK (
    (closed_at IS NULL AND resolution IS NULL AND close_metadata IS NULL)
    OR
    (closed_at IS NOT NULL
      AND resolution = 'transport_recovered_gap_unreconciled'
      AND close_metadata IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ingestion_coverage_incidents_one_open
  ON ingestion_coverage_incidents (provider, program_address)
  WHERE closed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ingestion_coverage_incidents_program_time
  ON ingestion_coverage_incidents (program_address, opened_at DESC);

CREATE INDEX IF NOT EXISTS idx_ingestion_coverage_incidents_program_gap
  ON ingestion_coverage_incidents (program_address, gap_started_at, closed_at);

-- A strict candidate queued before an incident becomes known must be retained
-- as audit evidence but never retried forever or delivered. Suppression is a
-- terminal, non-deleting outbox state.
ALTER TABLE telegram_notification_outbox
  DROP CONSTRAINT IF EXISTS telegram_notification_outbox_status_check;
ALTER TABLE telegram_notification_outbox
  ADD CONSTRAINT telegram_notification_outbox_status_check CHECK (
    status IN ('pending', 'processing', 'retry', 'delivered', 'dead_letter', 'suppressed')
  ) NOT VALID;
ALTER TABLE telegram_notification_outbox
  VALIDATE CONSTRAINT telegram_notification_outbox_status_check;

CREATE OR REPLACE FUNCTION preserve_ingestion_coverage_incident_history()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ingestion coverage incident history is append-only';
  END IF;
  IF ROW(
       NEW.idempotency_key,
       NEW.chain,
       NEW.provider,
       NEW.program_address,
       NEW.reason,
       NEW.gap_started_at,
       NEW.opened_at,
       NEW.cluster_slot,
       NEW.source_slot,
       NEW.slot_lag,
       NEW.last_websocket_message_at,
       NEW.silence_ms,
       NEW.subscription_ack_timeout_count,
       NEW.successful_subscription_ack_count,
       NEW.open_metadata,
       NEW.created_at
     ) IS DISTINCT FROM ROW(
       OLD.idempotency_key,
       OLD.chain,
       OLD.provider,
       OLD.program_address,
       OLD.reason,
       OLD.gap_started_at,
       OLD.opened_at,
       OLD.cluster_slot,
       OLD.source_slot,
       OLD.slot_lag,
       OLD.last_websocket_message_at,
       OLD.silence_ms,
       OLD.subscription_ack_timeout_count,
       OLD.successful_subscription_ack_count,
       OLD.open_metadata,
       OLD.created_at
     ) THEN
    RAISE EXCEPTION 'ingestion coverage incident opening evidence is immutable';
  END IF;
  IF OLD.closed_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'closed ingestion coverage incident evidence is immutable';
  END IF;
  IF NEW.restart_attempt_count < OLD.restart_attempt_count THEN
    RAISE EXCEPTION 'ingestion coverage restart count cannot decrease';
  END IF;
  IF OLD.restart_attempted_at IS NOT NULL
     AND NEW.restart_attempted_at IS DISTINCT FROM OLD.restart_attempted_at THEN
    RAISE EXCEPTION 'first ingestion coverage restart attempt is immutable';
  END IF;
  IF OLD.restart_completed_at IS NOT NULL
     AND NEW.restart_completed_at IS DISTINCT FROM OLD.restart_completed_at THEN
    RAISE EXCEPTION 'first ingestion coverage restart completion is immutable';
  END IF;
  IF OLD.last_restart_attempted_at IS NOT NULL
     AND (NEW.last_restart_attempted_at IS NULL
          OR NEW.last_restart_attempted_at < OLD.last_restart_attempted_at) THEN
    RAISE EXCEPTION 'last ingestion coverage restart attempt cannot move backward';
  END IF;
  IF OLD.last_restart_completed_at IS NOT NULL
     AND (NEW.last_restart_completed_at IS NULL
          OR NEW.last_restart_completed_at < OLD.last_restart_completed_at) THEN
    RAISE EXCEPTION 'last ingestion coverage restart completion cannot move backward';
  END IF;
  IF NEW.closed_at IS NOT NULL AND NEW.closed_at < NEW.opened_at THEN
    RAISE EXCEPTION 'ingestion coverage incident cannot close before it opened';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_preserve_ingestion_coverage_incident_history
  ON ingestion_coverage_incidents;
CREATE TRIGGER trg_preserve_ingestion_coverage_incident_history
BEFORE UPDATE OR DELETE ON ingestion_coverage_incidents
FOR EACH ROW EXECUTE FUNCTION preserve_ingestion_coverage_incident_history();
