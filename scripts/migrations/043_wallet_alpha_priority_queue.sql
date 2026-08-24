-- Keep one revision-safe queue while allowing signal-relevant evidence to bypass
-- historical catch-up. PostgreSQL remains the durable source of truth; NOTIFY is
-- only a lossy wake-up hint for the long-lived worker.
ALTER TABLE wallet_alpha_work_queue
  ADD COLUMN IF NOT EXISTS priority SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS priority_reason TEXT,
  ADD COLUMN IF NOT EXISTS pending_since TIMESTAMPTZ;

UPDATE wallet_alpha_work_queue
SET pending_since = updated_at
WHERE revision > completed_revision
  AND pending_since IS NULL;

ALTER TABLE wallet_alpha_work_queue
  ALTER COLUMN pending_since SET DEFAULT NOW();

ALTER TABLE wallet_alpha_work_queue
  DROP CONSTRAINT IF EXISTS wallet_alpha_work_queue_priority_check;
ALTER TABLE wallet_alpha_work_queue
  ADD CONSTRAINT wallet_alpha_work_queue_priority_check
  CHECK (priority BETWEEN 0 AND 2);

ALTER TABLE wallet_alpha_work_queue
  DROP CONSTRAINT IF EXISTS wallet_alpha_work_queue_priority_reason_check;
ALTER TABLE wallet_alpha_work_queue
  ADD CONSTRAINT wallet_alpha_work_queue_priority_reason_check
  CHECK (priority_reason IS NULL OR length(priority_reason) BETWEEN 1 AND 100);

CREATE INDEX IF NOT EXISTS idx_wallet_alpha_work_priority_claim
  ON wallet_alpha_work_queue (
    strategy_version,
    priority DESC,
    not_before,
    updated_at,
    wallet_address
  )
  INCLUDE (revision, completed_revision, lock_expires_at, pending_since, attempt_count)
  WHERE revision > completed_revision;

CREATE OR REPLACE FUNCTION enqueue_wallet_alpha_work(
  requested_chain TEXT,
  requested_wallet_address TEXT,
  requested_strategy_version TEXT,
  requested_priority SMALLINT,
  requested_priority_reason TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  IF requested_priority < 0 OR requested_priority > 2 THEN
    RAISE EXCEPTION 'wallet-alpha priority must be between 0 and 2';
  END IF;
  IF requested_priority_reason IS NULL
     OR length(requested_priority_reason) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'wallet-alpha priority reason must contain 1-100 characters';
  END IF;

  INSERT INTO wallet_alpha_work_queue (
    chain,
    wallet_address,
    strategy_version,
    revision,
    updated_at,
    not_before,
    priority,
    priority_reason,
    pending_since
  ) VALUES (
    requested_chain,
    requested_wallet_address,
    requested_strategy_version,
    1,
    NOW(),
    NOW(),
    requested_priority,
    requested_priority_reason,
    NOW()
  )
  ON CONFLICT (chain, wallet_address, strategy_version) DO UPDATE SET
    revision = wallet_alpha_work_queue.revision + 1,
    updated_at = NOW(),
    not_before = LEAST(wallet_alpha_work_queue.not_before, NOW()),
    priority = CASE
      WHEN wallet_alpha_work_queue.revision > wallet_alpha_work_queue.completed_revision
        THEN GREATEST(wallet_alpha_work_queue.priority, EXCLUDED.priority)
      ELSE EXCLUDED.priority
    END,
    priority_reason = CASE
      WHEN wallet_alpha_work_queue.revision > wallet_alpha_work_queue.completed_revision
           AND EXCLUDED.priority < wallet_alpha_work_queue.priority
        THEN wallet_alpha_work_queue.priority_reason
      ELSE EXCLUDED.priority_reason
    END,
    pending_since = CASE
      WHEN wallet_alpha_work_queue.revision > wallet_alpha_work_queue.completed_revision
        THEN COALESCE(wallet_alpha_work_queue.pending_since, wallet_alpha_work_queue.updated_at)
      ELSE NOW()
    END;

  RETURN TRUE;
END;
$$;

-- Keep the migration compatible with the previous release while containers
-- are recreated: its direct queue upsert did not know about pending_since.
CREATE OR REPLACE FUNCTION normalize_wallet_alpha_work() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.revision > NEW.completed_revision AND NEW.pending_since IS NULL THEN
    NEW.pending_since := NOW();
  ELSIF NEW.revision <= NEW.completed_revision THEN
    NEW.pending_since := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wallet_alpha_work_normalize ON wallet_alpha_work_queue;
CREATE TRIGGER trg_wallet_alpha_work_normalize
BEFORE INSERT OR UPDATE OF revision, completed_revision, pending_since
ON wallet_alpha_work_queue
FOR EACH ROW EXECUTE FUNCTION normalize_wallet_alpha_work();

CREATE OR REPLACE FUNCTION notify_wallet_alpha_work() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.revision > NEW.completed_revision
     AND (TG_OP = 'INSERT' OR NEW.revision > OLD.revision) THEN
    PERFORM pg_notify(
      'wallet_alpha_work',
      json_build_object(
        'strategyVersion', NEW.strategy_version,
        'priority', NEW.priority
      )::TEXT
    );
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_wallet_alpha_work_notify ON wallet_alpha_work_queue;
CREATE TRIGGER trg_wallet_alpha_work_notify
AFTER INSERT OR UPDATE OF revision ON wallet_alpha_work_queue
FOR EACH ROW EXECUTE FUNCTION notify_wallet_alpha_work();

COMMENT ON COLUMN wallet_alpha_work_queue.priority IS
  '0=historical/background, 1=score-changing sell/outcome, 2=signal-relevant safe entry.';
COMMENT ON COLUMN wallet_alpha_work_queue.pending_since IS
  'Start of the current uncompleted revision run; preserved while revisions coalesce.';
COMMENT ON FUNCTION enqueue_wallet_alpha_work(TEXT, TEXT, TEXT, SMALLINT, TEXT) IS
  'Revision-safe coalescing enqueue used by every wallet evidence producer.';
