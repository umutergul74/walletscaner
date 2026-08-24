SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- A live discovery cursor may advance while a durable gap repair replays. Keep
-- the separately verified immutable target in an append-only proof relation so
-- deployment does not require an ACCESS EXCLUSIVE rewrite of the active repair
-- table. The proof insert and correction of pre-R21 mutable-cursor completion
-- metadata commit in one repository transaction.
CREATE TABLE IF NOT EXISTS ingestion_gap_repair_target_proofs (
  repair_id TEXT PRIMARY KEY REFERENCES ingestion_gap_repairs(repair_id) ON DELETE RESTRICT,
  incident_id TEXT NOT NULL REFERENCES ingestion_coverage_incidents(idempotency_key) ON DELETE RESTRICT,
  target_signature TEXT NOT NULL CHECK (BTRIM(target_signature) <> ''),
  target_slot BIGINT NOT NULL CHECK (target_slot >= 0),
  confirmation_status TEXT NOT NULL CHECK (confirmation_status = 'finalized'),
  verified_at TIMESTAMPTZ NOT NULL,
  previous_covered_through_signature TEXT,
  previous_covered_through_slot BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (incident_id),
  CHECK (
    (previous_covered_through_signature IS NULL) =
    (previous_covered_through_slot IS NULL)
  )
);

CREATE OR REPLACE FUNCTION enforce_ingestion_gap_repair_target_proof()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'discovery repair target proof is append-only';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM ingestion_gap_repairs repair
    WHERE repair.repair_id = NEW.repair_id
      AND repair.incident_id = NEW.incident_id
      AND repair.status = 'completed'
      AND repair.boundary_source = 'truncation_cursor'
      AND repair.target_signature = NEW.target_signature
      AND repair.target_slot = NEW.target_slot
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
  ) THEN
    RAISE EXCEPTION 'finalized target proof does not match a complete immutable repair target';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ingestion_gap_repair_target_proof
  ON ingestion_gap_repair_target_proofs;
CREATE TRIGGER trg_ingestion_gap_repair_target_proof
BEFORE INSERT OR UPDATE OR DELETE
ON ingestion_gap_repair_target_proofs
FOR EACH ROW
EXECUTE FUNCTION enforce_ingestion_gap_repair_target_proof();

CREATE OR REPLACE FUNCTION enforce_ingestion_gap_repair_exact_completion()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'completed' AND (
    NEW.target_signature IS NULL
    OR NEW.target_slot IS NULL
    OR NEW.covered_through_signature IS DISTINCT FROM NEW.target_signature
    OR NEW.covered_through_slot IS DISTINCT FROM NEW.target_slot
    OR NEW.completed_signature_count <> NEW.fetched_signature_count
    OR EXISTS (
      SELECT 1
      FROM ingestion_gap_repair_signatures staged
      WHERE staged.repair_id = NEW.repair_id
        AND staged.status <> 'completed'
    )
  ) THEN
    RAISE EXCEPTION 'completed discovery repair must equal its fully replayed immutable target';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ingestion_gap_repair_exact_completion
  ON ingestion_gap_repairs;
CREATE TRIGGER trg_ingestion_gap_repair_exact_completion
BEFORE UPDATE OF status, covered_through_signature, covered_through_slot
ON ingestion_gap_repairs
FOR EACH ROW
EXECUTE FUNCTION enforce_ingestion_gap_repair_exact_completion();

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
    JOIN ingestion_gap_repair_target_proofs proof
      ON proof.repair_id = repair.repair_id
    WHERE repair.repair_id = NEW.coverage_repair_id
      AND repair.incident_id = NEW.idempotency_key
      AND proof.incident_id = NEW.idempotency_key
      AND repair.status = 'completed'
      AND repair.boundary_source = 'truncation_cursor'
      AND repair.covered_through_signature = repair.target_signature
      AND repair.covered_through_slot = repair.target_slot
      AND proof.target_signature = repair.target_signature
      AND proof.target_slot = repair.target_slot
      AND proof.confirmation_status = 'finalized'
  ) THEN
    RAISE EXCEPTION 'coverage reconciliation requires an exact finalized repair target proof';
  END IF;
  RETURN NEW;
END;
$$;
