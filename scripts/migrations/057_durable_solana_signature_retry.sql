SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- A provider can permanently stop serving an older transaction. Persist retry
-- ownership and backoff so one unavailable signature cannot pin every live
-- fetch worker in an in-process retry loop. Dead letters remain immutable
-- operational evidence and are never treated as successfully covered.
ALTER TABLE solana_signature_queue
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;

ALTER TABLE solana_signature_queue
  DROP CONSTRAINT IF EXISTS solana_signature_queue_status_check,
  DROP CONSTRAINT IF EXISTS solana_signature_queue_check;

ALTER TABLE solana_signature_queue
  ADD CONSTRAINT solana_signature_queue_status_v2_check CHECK (
    status IN ('pending', 'completed', 'dead_letter')
  ) NOT VALID,
  ADD CONSTRAINT solana_signature_queue_terminal_v2_check CHECK (
    (status = 'pending' AND completed_at IS NULL AND dead_lettered_at IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL AND dead_lettered_at IS NULL)
    OR (status = 'dead_letter' AND completed_at IS NULL AND dead_lettered_at IS NOT NULL)
  ) NOT VALID;

ALTER TABLE solana_signature_queue
  VALIDATE CONSTRAINT solana_signature_queue_status_v2_check;
ALTER TABLE solana_signature_queue
  VALIDATE CONSTRAINT solana_signature_queue_terminal_v2_check;

DROP INDEX IF EXISTS idx_solana_signature_queue_pending;
CREATE INDEX idx_solana_signature_queue_pending_due
  ON solana_signature_queue (
    provider, address, next_attempt_at, slot, notified_at, signature
  )
  WHERE status = 'pending';

CREATE INDEX idx_solana_signature_queue_dead_letter
  ON solana_signature_queue (dead_lettered_at, provider, address, signature)
  WHERE status = 'dead_letter';

-- A terminally unavailable transaction creates an explicit fail-closed
-- coverage reason rather than being normalized as transport health.
ALTER TABLE ingestion_coverage_incidents
  DROP CONSTRAINT IF EXISTS ingestion_coverage_incidents_reason_check;
ALTER TABLE ingestion_coverage_incidents
  ADD CONSTRAINT ingestion_coverage_incidents_reason_v2_check CHECK (
    reason IN (
      'head_slot_lag',
      'raw_websocket_silence',
      'subscription_ack_timeout',
      'stale_live_notification',
      'backfill_truncated',
      'source_start_failed',
      'unresolved_transaction',
      'combined'
    )
  ) NOT VALID;
ALTER TABLE ingestion_coverage_incidents
  VALIDATE CONSTRAINT ingestion_coverage_incidents_reason_v2_check;
