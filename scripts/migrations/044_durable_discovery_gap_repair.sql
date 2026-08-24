SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Discovery repair is deliberately separate from the live signature queue. A
-- reconnect page is collected newest-first, but no cursor may move until the
-- old durable boundary is found and the staged signatures can be replayed
-- oldest-first. The session survives worker and host restarts.
CREATE TABLE IF NOT EXISTS ingestion_gap_repairs (
  repair_id TEXT PRIMARY KEY CHECK (BTRIM(repair_id) <> ''),
  incident_id TEXT NOT NULL REFERENCES ingestion_coverage_incidents(idempotency_key),
  provider TEXT NOT NULL CHECK (BTRIM(provider) <> ''),
  program_address TEXT NOT NULL CHECK (BTRIM(program_address) <> ''),
  cursor_signature TEXT NOT NULL CHECK (BTRIM(cursor_signature) <> ''),
  cursor_slot BIGINT NOT NULL CHECK (cursor_slot >= 0),
  cursor_occurred_at TIMESTAMPTZ,
  target_signature TEXT CHECK (target_signature IS NULL OR BTRIM(target_signature) <> ''),
  target_slot BIGINT CHECK (target_slot IS NULL OR target_slot >= 0),
  before_signature TEXT CHECK (before_signature IS NULL OR BTRIM(before_signature) <> ''),
  status TEXT NOT NULL DEFAULT 'collecting'
    CHECK (status IN ('collecting', 'replaying', 'completed', 'failed')),
  boundary_reached BOOLEAN NOT NULL DEFAULT FALSE,
  fetched_signature_count INTEGER NOT NULL DEFAULT 0
    CHECK (fetched_signature_count >= 0),
  completed_signature_count INTEGER NOT NULL DEFAULT 0
    CHECK (completed_signature_count >= 0),
  collection_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (collection_attempt_count >= 0),
  replay_attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (replay_attempt_count >= 0),
  last_error TEXT,
  covered_through_signature TEXT
    CHECK (covered_through_signature IS NULL OR BTRIM(covered_through_signature) <> ''),
  covered_through_slot BIGINT CHECK (covered_through_slot IS NULL OR covered_through_slot >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CHECK (completed_signature_count <= fetched_signature_count),
  CHECK ((target_signature IS NULL) = (target_slot IS NULL)),
  CHECK (
    (status = 'collecting' AND NOT boundary_reached AND completed_at IS NULL)
    OR (status = 'replaying' AND boundary_reached AND completed_at IS NULL)
    OR (status = 'failed' AND completed_at IS NULL)
    OR (
      status = 'completed'
      AND boundary_reached
      AND completed_at IS NOT NULL
      AND covered_through_signature IS NOT NULL
      AND covered_through_slot IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ingestion_gap_repairs_one_active
  ON ingestion_gap_repairs (incident_id)
  WHERE status IN ('collecting', 'replaying');

CREATE INDEX IF NOT EXISTS idx_ingestion_gap_repairs_incident_time
  ON ingestion_gap_repairs (incident_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ingestion_gap_repair_signatures (
  repair_id TEXT NOT NULL REFERENCES ingestion_gap_repairs(repair_id) ON DELETE RESTRICT,
  signature TEXT NOT NULL CHECK (BTRIM(signature) <> ''),
  slot BIGINT NOT NULL CHECK (slot >= 0),
  position_from_head INTEGER NOT NULL CHECK (position_from_head >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (repair_id, signature),
  UNIQUE (repair_id, position_from_head),
  CHECK (
    (status = 'pending' AND completed_at IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_ingestion_gap_repair_signatures_pending
  ON ingestion_gap_repair_signatures (repair_id, position_from_head DESC)
  WHERE status = 'pending';

-- Existing incident rows remain append-only. These columns are set only while
-- closing an open incident and are the explicit proof that strict consumers
-- may stop excluding that interval.
ALTER TABLE ingestion_coverage_incidents
  ADD COLUMN IF NOT EXISTS coverage_reconciled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS coverage_repair_id TEXT
    REFERENCES ingestion_gap_repairs(repair_id);

ALTER TABLE ingestion_coverage_incidents
  ADD CONSTRAINT ingestion_coverage_incidents_repair_proof_check CHECK (
    (coverage_reconciled_at IS NULL AND coverage_repair_id IS NULL)
    OR (
      coverage_reconciled_at IS NOT NULL
      AND coverage_repair_id IS NOT NULL
      AND closed_at IS NOT NULL
      AND coverage_reconciled_at <= closed_at
    )
  ) NOT VALID;
ALTER TABLE ingestion_coverage_incidents
  VALIDATE CONSTRAINT ingestion_coverage_incidents_repair_proof_check;
