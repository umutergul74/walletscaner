-- A pathological wallet must not escape its bounded quarantine merely because
-- another trade/outcome revision arrives. Preserve the evidence; delay only
-- the derived rebuild until the configured retry boundary.
ALTER TABLE wallet_alpha_work_queue
  ADD COLUMN IF NOT EXISTS quarantine_reason TEXT;

ALTER TABLE wallet_alpha_work_queue
  DROP CONSTRAINT IF EXISTS wallet_alpha_work_queue_quarantine_reason_check;
ALTER TABLE wallet_alpha_work_queue
  ADD CONSTRAINT wallet_alpha_work_queue_quarantine_reason_check
  CHECK (quarantine_reason IS NULL OR quarantine_reason = 'evidence_limit');

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
    not_before = CASE
      WHEN wallet_alpha_work_queue.quarantine_reason IS NOT NULL
           AND wallet_alpha_work_queue.not_before > NOW()
        THEN wallet_alpha_work_queue.not_before
      ELSE LEAST(wallet_alpha_work_queue.not_before, NOW())
    END,
    quarantine_reason = CASE
      WHEN wallet_alpha_work_queue.quarantine_reason IS NOT NULL
           AND wallet_alpha_work_queue.not_before > NOW()
        THEN wallet_alpha_work_queue.quarantine_reason
      ELSE NULL
    END,
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

-- Keep the additive migration safe while older and newer release containers
-- are recreated one at a time. A legacy direct upsert cannot shorten an active
-- quarantine, while completing the current revision always clears it.
CREATE OR REPLACE FUNCTION normalize_wallet_alpha_work() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.quarantine_reason IS NOT NULL
     AND OLD.not_before > NOW()
     AND NEW.revision > OLD.revision
     AND NEW.not_before < OLD.not_before THEN
    NEW.not_before := OLD.not_before;
    NEW.quarantine_reason := OLD.quarantine_reason;
  END IF;

  IF NEW.revision > NEW.completed_revision AND NEW.pending_since IS NULL THEN
    NEW.pending_since := NOW();
  ELSIF NEW.revision <= NEW.completed_revision THEN
    NEW.pending_since := NULL;
    NEW.quarantine_reason := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_wallet_alpha_work_normalize ON wallet_alpha_work_queue;
CREATE TRIGGER trg_wallet_alpha_work_normalize
BEFORE INSERT OR UPDATE OF revision, completed_revision, pending_since, not_before, quarantine_reason
ON wallet_alpha_work_queue
FOR EACH ROW EXECUTE FUNCTION normalize_wallet_alpha_work();

COMMENT ON COLUMN wallet_alpha_work_queue.quarantine_reason IS
  'Fail-closed derived-work quarantine. Canonical evidence remains intact and new revisions coalesce.';
COMMENT ON FUNCTION enqueue_wallet_alpha_work(TEXT, TEXT, TEXT, SMALLINT, TEXT) IS
  'Revision-safe enqueue that preserves an active pathological-wallet quarantine.';
