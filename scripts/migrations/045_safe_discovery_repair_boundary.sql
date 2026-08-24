SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Migration 044 originally allowed a repair session to snapshot the current
-- live cursor after an incident opened. Live admission may already have moved
-- that cursor across the uncertain interval, so such a session cannot be a
-- coverage proof. Preserve those rows, fail them closed, and require every new
-- proof to name the exact cursor captured by the truncating backfill.
ALTER TABLE ingestion_gap_repairs
  ADD COLUMN IF NOT EXISTS boundary_source TEXT NOT NULL
    DEFAULT 'unsafe_legacy_current_cursor';

ALTER TABLE ingestion_gap_repairs
  ADD CONSTRAINT ingestion_gap_repairs_boundary_source_check CHECK (
    boundary_source IN ('unsafe_legacy_current_cursor', 'truncation_cursor')
  ) NOT VALID;
ALTER TABLE ingestion_gap_repairs
  VALIDATE CONSTRAINT ingestion_gap_repairs_boundary_source_check;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM ingestion_gap_repairs
    WHERE boundary_source = 'unsafe_legacy_current_cursor'
      AND status = 'completed'
  ) THEN
    RAISE EXCEPTION 'unsafe migration-044 repair already completed; manual containment required';
  END IF;
END;
$$;

UPDATE ingestion_gap_repairs
SET status = 'failed',
    last_error = 'unsafe-live-cursor-boundary-r16',
    updated_at = NOW()
WHERE boundary_source = 'unsafe_legacy_current_cursor'
  AND status IN ('collecting', 'replaying');

-- Close only the contained R16 incidents as transport-recovered but explicitly
-- unreconciled. Their intervals remain excluded forever; no row is deleted or
-- relabelled as complete. A new R17 startup truncation opens a fresh incident
-- carrying the exact safe cursor signature.
UPDATE ingestion_coverage_incidents incident
SET closed_at = NOW(),
    resolution = 'transport_recovered_gap_unreconciled',
    close_metadata = jsonb_build_object(
      'proof', 'operator-containment',
      'coverageDisposition', 'alpha_excluded_unreconciled',
      'reason', 'unsafe-live-cursor-boundary-r16',
      'note', 'Repair evidence preserved as failed; no historical coverage proof was claimed.'
    )
WHERE incident.closed_at IS NULL
  AND EXISTS (
    SELECT 1
    FROM ingestion_gap_repairs repair
    WHERE repair.incident_id = incident.idempotency_key
      AND repair.boundary_source = 'unsafe_legacy_current_cursor'
      AND repair.status = 'failed'
  );

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
  ) THEN
    RAISE EXCEPTION 'coverage reconciliation requires a completed safe-boundary repair';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_ingestion_coverage_repair_proof
  ON ingestion_coverage_incidents;
CREATE TRIGGER trg_ingestion_coverage_repair_proof
BEFORE UPDATE OF coverage_reconciled_at, coverage_repair_id
ON ingestion_coverage_incidents
FOR EACH ROW
EXECUTE FUNCTION enforce_ingestion_coverage_repair_proof();
