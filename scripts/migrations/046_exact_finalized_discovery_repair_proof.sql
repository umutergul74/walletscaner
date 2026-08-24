SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- A live discovery cursor may advance while a durable gap repair replays. The
-- repair proof therefore belongs to the immutable newest signature captured
-- when collection began, never to the mutable live cursor observed later.
-- Preserve the pre-R21 completion metadata before normalizing the known safe,
-- fully replayed sessions to that immutable target.
ALTER TABLE ingestion_gap_repairs
  ADD COLUMN IF NOT EXISTS previous_covered_through_signature TEXT,
  ADD COLUMN IF NOT EXISTS previous_covered_through_slot BIGINT,
  ADD COLUMN IF NOT EXISTS completion_evidence_normalized_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS target_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS target_verified_slot BIGINT,
  ADD COLUMN IF NOT EXISTS target_confirmation_status TEXT;

UPDATE ingestion_gap_repairs repair
SET previous_covered_through_signature = repair.covered_through_signature,
    previous_covered_through_slot = repair.covered_through_slot,
    covered_through_signature = repair.target_signature,
    covered_through_slot = repair.target_slot,
    completion_evidence_normalized_at = NOW(),
    updated_at = NOW()
WHERE repair.status = 'completed'
  AND repair.boundary_source = 'truncation_cursor'
  AND repair.target_signature IS NOT NULL
  AND repair.target_slot IS NOT NULL
  AND repair.completed_signature_count = repair.fetched_signature_count
  AND NOT EXISTS (
    SELECT 1
    FROM ingestion_gap_repair_signatures staged
    WHERE staged.repair_id = repair.repair_id
      AND staged.status <> 'completed'
  )
  AND EXISTS (
    SELECT 1
    FROM ingestion_gap_repair_signatures target
    WHERE target.repair_id = repair.repair_id
      AND target.signature = repair.target_signature
      AND target.slot = repair.target_slot
      AND target.position_from_head = 0
      AND target.status = 'completed'
  )
  AND (
    repair.covered_through_signature IS DISTINCT FROM repair.target_signature
    OR repair.covered_through_slot IS DISTINCT FROM repair.target_slot
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM ingestion_gap_repairs repair
    WHERE repair.status = 'completed'
      AND repair.boundary_source = 'truncation_cursor'
      AND (
        repair.target_signature IS NULL
        OR repair.target_slot IS NULL
        OR repair.covered_through_signature IS DISTINCT FROM repair.target_signature
        OR repair.covered_through_slot IS DISTINCT FROM repair.target_slot
        OR repair.completed_signature_count <> repair.fetched_signature_count
      )
  ) THEN
    RAISE EXCEPTION 'completed safe discovery repair lacks an exact immutable target proof';
  END IF;
END;
$$;

ALTER TABLE ingestion_gap_repairs
  ADD CONSTRAINT ingestion_gap_repairs_exact_completion_target_check CHECK (
    status <> 'completed'
    OR (
      target_signature IS NOT NULL
      AND target_slot IS NOT NULL
      AND covered_through_signature = target_signature
      AND covered_through_slot = target_slot
      AND completed_signature_count = fetched_signature_count
    )
  ) NOT VALID;
ALTER TABLE ingestion_gap_repairs
  VALIDATE CONSTRAINT ingestion_gap_repairs_exact_completion_target_check;

ALTER TABLE ingestion_gap_repairs
  ADD CONSTRAINT ingestion_gap_repairs_target_verification_check CHECK (
    (
      target_verified_at IS NULL
      AND target_verified_slot IS NULL
      AND target_confirmation_status IS NULL
    )
    OR (
      status = 'completed'
      AND target_verified_at IS NOT NULL
      AND target_verified_slot = target_slot
      AND target_confirmation_status = 'finalized'
    )
  ) NOT VALID;
ALTER TABLE ingestion_gap_repairs
  VALIDATE CONSTRAINT ingestion_gap_repairs_target_verification_check;

CREATE OR REPLACE FUNCTION enforce_ingestion_coverage_repair_proof()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.coverage_reconciled_at IS NULL AND NEW.coverage_repair_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.coverage_reconciled_at IS NULL OR NEW.coverage_repair_id IS NULL THEN
    RAISE EXCEPTION 'coverage reconciliation timestamp and repair id must be paired';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM ingestion_gap_repairs repair
    WHERE repair.repair_id = NEW.coverage_repair_id
      AND repair.incident_id = NEW.idempotency_key
      AND repair.status = 'completed'
      AND repair.boundary_source = 'truncation_cursor'
      AND repair.covered_through_signature = repair.target_signature
      AND repair.covered_through_slot = repair.target_slot
      AND repair.target_verified_at IS NOT NULL
      AND repair.target_verified_slot = repair.target_slot
      AND repair.target_confirmation_status = 'finalized'
  ) THEN
    RAISE EXCEPTION 'coverage reconciliation requires an exact finalized repair target proof';
  END IF;
  RETURN NEW;
END;
$$;
