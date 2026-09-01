SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Expensive FIFO/scoring work is useful only after a wallet has enough *possible* evidence to
-- reach the immutable fixed-horizon watch gate. Canonical evidence is still stored for every
-- wallet. This state records whether the current queue revision is ready or has been durably
-- deferred until later evidence makes it eligible.
ALTER TABLE wallet_alpha_work_queue
  ADD COLUMN IF NOT EXISTS admission_status TEXT NOT NULL DEFAULT 'unchecked',
  ADD COLUMN IF NOT EXISTS admission_reason TEXT,
  ADD COLUMN IF NOT EXISTS admission_checked_at TIMESTAMPTZ;

ALTER TABLE wallet_alpha_work_queue
  DROP CONSTRAINT IF EXISTS wallet_alpha_work_queue_admission_status_check;
ALTER TABLE wallet_alpha_work_queue
  ADD CONSTRAINT wallet_alpha_work_queue_admission_status_check
  CHECK (admission_status IN ('unchecked', 'ready', 'deferred'));

ALTER TABLE wallet_alpha_work_queue
  DROP CONSTRAINT IF EXISTS wallet_alpha_work_queue_admission_reason_check;
ALTER TABLE wallet_alpha_work_queue
  ADD CONSTRAINT wallet_alpha_work_queue_admission_reason_check
  CHECK (admission_reason IS NULL OR length(admission_reason) BETWEEN 1 AND 160);

-- This is deliberately an upper-bound gate, not an alpha-quality verdict. Eight recent sells are
-- necessary for eight recent profitability samples; eight distinct recent source-linked tokens
-- with mature fixed-horizon outcomes are necessary for eight followability samples. Risk, return,
-- quality and tail-loss gates remain in the scorer. Existing FIFO state and already-qualified
-- scores bypass admission so their derived state stays current.
CREATE OR REPLACE FUNCTION wallet_alpha_admission_ready(
  requested_chain TEXT,
  requested_wallet_address TEXT,
  requested_strategy_version TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
BEGIN
  -- Other research namespaces retain the pre-migration contract. A future strategy must add an
  -- explicit policy before it can opt into evidence-v1 admission semantics.
  IF requested_strategy_version <> 'evidence-v1' THEN
    RETURN TRUE;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM wallet_fifo_continuations continuation
    WHERE continuation.chain = requested_chain
      AND continuation.wallet_address = requested_wallet_address
      AND continuation.strategy_version = requested_strategy_version
  ) THEN
    RETURN TRUE;
  END IF;

  IF COALESCE((
    SELECT score.status IN ('watch', 'candidate', 'validated-paper')
    FROM wallet_alpha_scores score
    WHERE score.chain = requested_chain
      AND score.wallet_address = requested_wallet_address
      AND score.strategy_version = requested_strategy_version
    ORDER BY score.calculated_at DESC
    LIMIT 1
  ), FALSE) THEN
    RETURN TRUE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM wallet_trade_events trade
    WHERE trade.chain = requested_chain
      AND trade.wallet_address = requested_wallet_address
      AND trade.strategy_version = requested_strategy_version
      AND trade.side = 'sell'
      AND trade.observed_at >= NOW() - INTERVAL '90 days'
    OFFSET 7 LIMIT 1
  ) THEN
    RETURN FALSE;
  END IF;

  -- Check the cheaper entry prerequisite before joining outcomes. This short-circuits the common
  -- case and keeps admission cost bounded for the high-cardinality trader population.
  IF NOT EXISTS (
    SELECT 1
    FROM (
      SELECT entry.token_address
      FROM wallet_entry_signals entry
      WHERE entry.chain = requested_chain
        AND entry.wallet_address = requested_wallet_address
        AND entry.strategy_version = requested_strategy_version
        AND entry.observed_at >= NOW() - INTERVAL '90 days'
        AND NULLIF(BTRIM(entry.source_swap_idempotency_key), '') IS NOT NULL
        AND entry.cohort <> 'excluded-uncontrolled-flow'
      GROUP BY entry.token_address
      LIMIT 8
    ) distinct_entries
    OFFSET 7 LIMIT 1
  ) THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM (
      SELECT entry.token_address
      FROM wallet_entry_signals entry
      JOIN wallet_signal_outcomes outcome
        ON outcome.entry_idempotency_key = entry.idempotency_key
       AND outcome.strategy_version = entry.strategy_version
      WHERE entry.chain = requested_chain
        AND entry.wallet_address = requested_wallet_address
        AND entry.strategy_version = requested_strategy_version
        AND entry.observed_at >= NOW() - INTERVAL '90 days'
        AND NULLIF(BTRIM(entry.source_swap_idempotency_key), '') IS NOT NULL
        AND entry.cohort <> 'excluded-uncontrolled-flow'
        AND outcome.status = 'mature'
        AND outcome.exit_strategy = 'fixed-horizon'
        AND outcome.observed_at >= NOW() - INTERVAL '90 days'
      GROUP BY entry.token_address
      LIMIT 8
    ) mature_tokens
    OFFSET 7 LIMIT 1
  );
END;
$$;

CREATE OR REPLACE FUNCTION enqueue_wallet_alpha_work(
  requested_chain TEXT,
  requested_wallet_address TEXT,
  requested_strategy_version TEXT,
  requested_priority SMALLINT,
  requested_priority_reason TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  admission_ready BOOLEAN;
BEGIN
  IF requested_priority < 0 OR requested_priority > 2 THEN
    RAISE EXCEPTION 'wallet-alpha priority must be between 0 and 2';
  END IF;
  IF requested_priority_reason IS NULL
     OR length(requested_priority_reason) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'wallet-alpha priority reason must contain 1-100 characters';
  END IF;

  admission_ready := wallet_alpha_admission_ready(
    requested_chain,
    requested_wallet_address,
    requested_strategy_version
  );

  IF NOT admission_ready THEN
    INSERT INTO wallet_alpha_work_queue (
      chain, wallet_address, strategy_version, revision, completed_revision,
      updated_at, not_before, priority, priority_reason, pending_since,
      admission_status, admission_reason, admission_checked_at
    ) VALUES (
      requested_chain, requested_wallet_address, requested_strategy_version, 1, 1,
      NOW(), NOW(), 0, NULL, NULL,
      'deferred', 'insufficient-watch-upper-bound', NOW()
    )
    ON CONFLICT (chain, wallet_address, strategy_version) DO UPDATE SET
      revision = wallet_alpha_work_queue.revision + 1,
      completed_revision = wallet_alpha_work_queue.revision + 1,
      updated_at = NOW(),
      not_before = NOW(),
      priority = 0,
      priority_reason = NULL,
      pending_since = NULL,
      locked_by = NULL,
      locked_at = NULL,
      lock_expires_at = NULL,
      attempt_count = 0,
      last_error = NULL,
      quarantine_reason = NULL,
      admission_status = 'deferred',
      admission_reason = 'insufficient-watch-upper-bound',
      admission_checked_at = NOW();
    RETURN FALSE;
  END IF;

  INSERT INTO wallet_alpha_work_queue (
    chain, wallet_address, strategy_version, revision, updated_at, not_before,
    priority, priority_reason, pending_since,
    admission_status, admission_reason, admission_checked_at
  ) VALUES (
    requested_chain, requested_wallet_address, requested_strategy_version, 1, NOW(), NOW(),
    requested_priority, requested_priority_reason, NOW(),
    'ready', 'watch-upper-bound-or-existing-state', NOW()
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
    END,
    admission_status = 'ready',
    admission_reason = 'watch-upper-bound-or-existing-state',
    admission_checked_at = NOW();

  RETURN TRUE;
END;
$$;

-- Reconcile only a bounded, unlocked cohort. Each row is revision-checked by its row lock and each
-- call is independently restart-safe. Ready rows are marked once so they cannot starve later
-- unchecked rows; deferred rows retain all canonical evidence and can be promoted by any producer.
CREATE OR REPLACE FUNCTION reconcile_wallet_alpha_admission_batch(
  requested_strategy_version TEXT,
  requested_limit INTEGER
) RETURNS TABLE(examined INTEGER, deferred INTEGER, retained_ready INTEGER)
LANGUAGE plpgsql
AS $$
BEGIN
  IF requested_limit < 1 OR requested_limit > 5000 THEN
    RAISE EXCEPTION 'wallet-alpha admission reconciliation limit must be between 1 and 5000';
  END IF;

  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT queue.chain, queue.wallet_address, queue.strategy_version
    FROM wallet_alpha_work_queue queue
    WHERE queue.strategy_version = requested_strategy_version
      AND queue.revision > queue.completed_revision
      AND queue.admission_status = 'unchecked'
      AND (queue.lock_expires_at IS NULL OR queue.lock_expires_at <= NOW())
    ORDER BY queue.priority DESC, queue.not_before, queue.updated_at, queue.wallet_address
    LIMIT requested_limit
    FOR UPDATE SKIP LOCKED
  ), decisions AS MATERIALIZED (
    SELECT candidates.*,
           wallet_alpha_admission_ready(
             candidates.chain,
             candidates.wallet_address,
             candidates.strategy_version
           ) AS ready
    FROM candidates
  ), marked_ready AS (
    UPDATE wallet_alpha_work_queue queue
    SET admission_status = 'ready',
        admission_reason = 'watch-upper-bound-or-existing-state',
        admission_checked_at = NOW()
    FROM decisions
    WHERE decisions.ready
      AND queue.chain = decisions.chain
      AND queue.wallet_address = decisions.wallet_address
      AND queue.strategy_version = decisions.strategy_version
    RETURNING 1
  ), marked_deferred AS (
    UPDATE wallet_alpha_work_queue queue
    SET completed_revision = queue.revision,
        priority = 0,
        priority_reason = NULL,
        pending_since = NULL,
        locked_by = NULL,
        locked_at = NULL,
        lock_expires_at = NULL,
        attempt_count = 0,
        last_error = NULL,
        quarantine_reason = NULL,
        admission_status = 'deferred',
        admission_reason = 'insufficient-watch-upper-bound',
        admission_checked_at = NOW()
    FROM decisions
    WHERE NOT decisions.ready
      AND queue.chain = decisions.chain
      AND queue.wallet_address = decisions.wallet_address
      AND queue.strategy_version = decisions.strategy_version
    RETURNING 1
  )
  SELECT
    (SELECT COUNT(*)::INTEGER FROM candidates),
    (SELECT COUNT(*)::INTEGER FROM marked_deferred),
    (SELECT COUNT(*)::INTEGER FROM marked_ready);
END;
$$;

COMMENT ON COLUMN wallet_alpha_work_queue.admission_status IS
  'Durable expensive-work admission checkpoint; deferred is not evidence deletion or alpha rejection.';
COMMENT ON FUNCTION wallet_alpha_admission_ready(TEXT, TEXT, TEXT) IS
  'Upper-bound prerequisite for expensive evidence-v1 scoring; true is not an alpha-quality verdict.';
COMMENT ON FUNCTION reconcile_wallet_alpha_admission_batch(TEXT, INTEGER) IS
  'Bounded restart-safe reconciliation of legacy pending revisions into ready or deferred state.';
COMMENT ON FUNCTION enqueue_wallet_alpha_work(TEXT, TEXT, TEXT, SMALLINT, TEXT) IS
  'Revision-safe producer gate: canonical evidence persists while unready expensive work is deferred.';
