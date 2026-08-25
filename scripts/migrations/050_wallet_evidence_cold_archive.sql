-- Extend the existing immutable B2 archive manifest to full-fidelity wallet
-- evidence. This migration is additive: it neither rewrites nor retires a
-- canonical wallet row.

ALTER TABLE archive_segments
  DROP CONSTRAINT IF EXISTS archive_segments_source_kind_check;

ALTER TABLE archive_segments
  ADD CONSTRAINT archive_segments_source_kind_check
  CHECK (source_kind IN ('chain-event-payloads', 'wallet-evidence'));

ALTER TABLE archive_segments
  ADD COLUMN IF NOT EXISTS record_type_counts JSONB;

UPDATE archive_segments
SET record_type_counts = jsonb_build_object('chain_event_payload', source_row_count)
WHERE source_kind = 'chain-event-payloads'
  AND source_row_count IS NOT NULL
  AND record_type_counts IS NULL;

ALTER TABLE archive_segments
  DROP CONSTRAINT IF EXISTS archive_segments_record_type_counts_check;

ALTER TABLE archive_segments
  ADD CONSTRAINT archive_segments_record_type_counts_check CHECK (
    record_type_counts IS NULL
    OR (
      jsonb_typeof(record_type_counts) = 'object'
      AND octet_length(record_type_counts::text) <= 4096
    )
  );

ALTER TABLE archive_segments
  DROP CONSTRAINT IF EXISTS archive_segments_verified_record_type_counts_check;

ALTER TABLE archive_segments
  ADD CONSTRAINT archive_segments_verified_record_type_counts_check CHECK (
    status NOT IN ('verify_pending', 'verifying', 'verified', 'retry_verify')
    OR record_type_counts IS NOT NULL
  );

-- Every independently verified revision remains discoverable after a later
-- correction invalidates the active segment. B2 object versions are never
-- deleted or overwritten by this project.
CREATE TABLE IF NOT EXISTS archive_segment_generations (
  segment_id BIGINT NOT NULL REFERENCES archive_segments(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('chain-event-payloads', 'wallet-evidence')),
  range_start TIMESTAMPTZ NOT NULL,
  range_end TIMESTAMPTZ NOT NULL,
  format_version TEXT NOT NULL,
  compression TEXT NOT NULL,
  object_key TEXT NOT NULL,
  source_row_count BIGINT NOT NULL CHECK (source_row_count >= 0),
  canonical_metadata_row_count BIGINT NOT NULL CHECK (
    canonical_metadata_row_count >= 0
    AND canonical_metadata_row_count <= source_row_count
  ),
  record_type_counts JSONB NOT NULL CHECK (
    jsonb_typeof(record_type_counts) = 'object'
    AND octet_length(record_type_counts::text) <= 4096
  ),
  source_bytes BIGINT NOT NULL CHECK (source_bytes >= 0),
  source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  archive_bytes BIGINT NOT NULL CHECK (archive_bytes > 0),
  archive_sha256 TEXT NOT NULL CHECK (archive_sha256 ~ '^[0-9a-f]{64}$'),
  content_md5_base64 TEXT NOT NULL,
  etag TEXT,
  object_version_id TEXT,
  object_lock_mode TEXT NOT NULL CHECK (object_lock_mode IN ('GOVERNANCE', 'COMPLIANCE')),
  object_lock_evidence TEXT NOT NULL CHECK (
    object_lock_evidence IN ('api-verified', 'attested-default-policy')
  ),
  retain_until TIMESTAMPTZ NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (segment_id, revision),
  UNIQUE (object_key),
  CHECK (range_end = range_start + INTERVAL '1 day'),
  CHECK (canonical_metadata_row_count = source_row_count),
  CHECK (retain_until > verified_at)
);

CREATE INDEX IF NOT EXISTS idx_archive_segment_generations_source_range
  ON archive_segment_generations (source_kind, range_start, revision DESC);

CREATE OR REPLACE FUNCTION capture_verified_archive_generation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'verified' THEN
    INSERT INTO archive_segment_generations (
      segment_id, revision, source_kind, range_start, range_end,
      format_version, compression, object_key, source_row_count,
      canonical_metadata_row_count, record_type_counts, source_bytes,
      source_sha256, archive_bytes, archive_sha256, content_md5_base64,
      etag, object_version_id, object_lock_mode, object_lock_evidence,
      retain_until, uploaded_at, verified_at
    ) VALUES (
      NEW.id, NEW.revision, NEW.source_kind, NEW.range_start, NEW.range_end,
      NEW.format_version, NEW.compression, NEW.object_key, NEW.source_row_count,
      NEW.canonical_metadata_row_count,
      COALESCE(
        NEW.record_type_counts,
        CASE NEW.source_kind
          WHEN 'chain-event-payloads' THEN
            jsonb_build_object('chain_event_payload', NEW.source_row_count)
          ELSE '{}'::jsonb
        END
      ),
      NEW.source_bytes, NEW.source_sha256, NEW.archive_bytes,
      NEW.archive_sha256, NEW.content_md5_base64, NEW.etag,
      NEW.object_version_id, NEW.object_lock_mode, NEW.object_lock_evidence,
      NEW.retain_until, NEW.uploaded_at, NEW.verified_at
    )
    ON CONFLICT (segment_id, revision) DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_capture_verified_archive_generation ON archive_segments;
CREATE TRIGGER trg_capture_verified_archive_generation
AFTER INSERT OR UPDATE OF status ON archive_segments
FOR EACH ROW
WHEN (NEW.status = 'verified')
EXECUTE FUNCTION capture_verified_archive_generation();

-- Capture the already verified raw generations before wallet evidence begins.
INSERT INTO archive_segment_generations (
  segment_id, revision, source_kind, range_start, range_end,
  format_version, compression, object_key, source_row_count,
  canonical_metadata_row_count, record_type_counts, source_bytes,
  source_sha256, archive_bytes, archive_sha256, content_md5_base64,
  etag, object_version_id, object_lock_mode, object_lock_evidence,
  retain_until, uploaded_at, verified_at
)
SELECT
  id, revision, source_kind, range_start, range_end,
  format_version, compression, object_key, source_row_count,
  canonical_metadata_row_count,
  COALESCE(
    record_type_counts,
    jsonb_build_object('chain_event_payload', source_row_count)
  ),
  source_bytes, source_sha256, archive_bytes, archive_sha256,
  content_md5_base64, etag, object_version_id, object_lock_mode,
  object_lock_evidence, retain_until, uploaded_at, verified_at
FROM archive_segments
WHERE status = 'verified'
ON CONFLICT (segment_id, revision) DO NOTHING;

CREATE OR REPLACE FUNCTION invalidate_wallet_evidence_archive_day(candidate_at TIMESTAMPTZ)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  segment_start TIMESTAMPTZ;
BEGIN
  IF candidate_at IS NULL THEN
    RETURN;
  END IF;
  segment_start := date_trunc('day', candidate_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

  UPDATE archive_segments
  SET revision = revision + 1,
      status = 'pending',
      not_before = NOW(),
      lease_owner = NULL,
      lease_expires_at = NULL,
      object_key = NULL,
      source_row_count = NULL,
      canonical_metadata_row_count = NULL,
      record_type_counts = NULL,
      source_bytes = NULL,
      source_sha256 = NULL,
      archive_bytes = NULL,
      archive_sha256 = NULL,
      content_md5_base64 = NULL,
      etag = NULL,
      object_version_id = NULL,
      object_lock_mode = NULL,
      object_lock_evidence = NULL,
      retain_until = NULL,
      uploaded_at = NULL,
      verified_at = NULL,
      last_error = 'wallet evidence changed after archive segment creation',
      updated_at = NOW()
  WHERE source_kind = 'wallet-evidence'
    AND range_start = segment_start
    AND range_end = segment_start + INTERVAL '1 day'
    AND status <> 'pending';
END
$$;

CREATE OR REPLACE FUNCTION invalidate_wallet_evidence_archive_segment()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM invalidate_wallet_evidence_archive_day(OLD.observed_at);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE')
     AND (TG_OP <> 'UPDATE' OR NEW.observed_at IS DISTINCT FROM OLD.observed_at) THEN
    PERFORM invalidate_wallet_evidence_archive_day(NEW.observed_at);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_wallet_trade_archive_invalidation ON wallet_trade_events;
CREATE TRIGGER trg_wallet_trade_archive_invalidation
AFTER INSERT OR UPDATE OR DELETE ON wallet_trade_events
FOR EACH ROW EXECUTE FUNCTION invalidate_wallet_evidence_archive_segment();

DROP TRIGGER IF EXISTS trg_wallet_entry_archive_invalidation ON wallet_entry_signals;
CREATE TRIGGER trg_wallet_entry_archive_invalidation
AFTER INSERT OR UPDATE OR DELETE ON wallet_entry_signals
FOR EACH ROW EXECUTE FUNCTION invalidate_wallet_evidence_archive_segment();

DROP TRIGGER IF EXISTS trg_wallet_outcome_archive_invalidation ON wallet_signal_outcomes;
CREATE TRIGGER trg_wallet_outcome_archive_invalidation
AFTER INSERT OR UPDATE OR DELETE ON wallet_signal_outcomes
FOR EACH ROW EXECUTE FUNCTION invalidate_wallet_evidence_archive_segment();

COMMENT ON TABLE archive_segment_generations IS
  'Immutable manifest history for every independently restored B2 object revision.';
COMMENT ON COLUMN archive_segments.record_type_counts IS
  'Exact restored row counts by archive envelope type; required for wallet-evidence coverage.';
