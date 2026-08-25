SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- New evidence must coalesce into the pending revision without defeating an
-- active retry delay. Migration 047 protected only evidence-limit quarantine;
-- a frequently updated wallet with a transient database timeout could
-- otherwise become immediately claimable after every new trade and starve the
-- rest of its priority lane.
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
      WHEN wallet_alpha_work_queue.last_error IS NOT NULL
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

-- Preserve the same invariant while an older release performs a direct
-- revision upsert during a rolling deployment. Completing the claimed
-- revision still clears retry/quarantine state through the repository path.
CREATE OR REPLACE FUNCTION normalize_wallet_alpha_work() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.last_error IS NOT NULL
     AND OLD.not_before > NOW()
     AND NEW.revision > OLD.revision
     AND NEW.not_before < OLD.not_before THEN
    NEW.not_before := OLD.not_before;
    NEW.last_error := OLD.last_error;
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
BEFORE INSERT OR UPDATE OF revision, completed_revision, pending_since, not_before,
  last_error, quarantine_reason
ON wallet_alpha_work_queue
FOR EACH ROW EXECUTE FUNCTION normalize_wallet_alpha_work();

COMMENT ON FUNCTION enqueue_wallet_alpha_work(TEXT, TEXT, TEXT, SMALLINT, TEXT) IS
  'Revision-safe enqueue that preserves active transient retry and evidence-limit quarantine boundaries.';
