-- Cold-archive state is additive and fail-closed. No source row or partition is
-- deleted by this migration. Maintenance may retire canonical payloads only
-- after an independently read-back object reaches verified status.
CREATE TABLE IF NOT EXISTS archive_segments (
  id BIGSERIAL PRIMARY KEY,
  source_kind TEXT NOT NULL
    CHECK (source_kind IN ('chain-event-payloads')),
  range_start TIMESTAMPTZ NOT NULL,
  range_end TIMESTAMPTZ NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  format_version TEXT NOT NULL DEFAULT 'raw-solana-v1',
  compression TEXT NOT NULL DEFAULT 'zstd-3',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'exporting', 'verify_pending', 'verifying', 'verified',
      'retry_export', 'retry_verify', 'dead_letter'
    )),
  not_before TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  export_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (export_attempt_count >= 0),
  verify_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (verify_attempt_count >= 0),
  object_key TEXT,
  source_row_count BIGINT CHECK (source_row_count IS NULL OR source_row_count >= 0),
  canonical_metadata_row_count BIGINT
    CHECK (
      canonical_metadata_row_count IS NULL
      OR (
        canonical_metadata_row_count >= 0
        AND canonical_metadata_row_count <= source_row_count
      )
    ),
  source_bytes BIGINT CHECK (source_bytes IS NULL OR source_bytes >= 0),
  source_sha256 TEXT CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
  archive_bytes BIGINT CHECK (archive_bytes IS NULL OR archive_bytes > 0),
  archive_sha256 TEXT CHECK (archive_sha256 IS NULL OR archive_sha256 ~ '^[0-9a-f]{64}$'),
  content_md5_base64 TEXT,
  etag TEXT,
  object_version_id TEXT,
  object_lock_mode TEXT,
  object_lock_evidence TEXT
    CHECK (
      object_lock_evidence IS NULL
      OR object_lock_evidence IN ('api-verified', 'attested-default-policy')
    ),
  retain_until TIMESTAMPTZ,
  uploaded_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_kind, range_start, range_end),
  CHECK (range_end > range_start),
  CHECK (range_start = date_trunc('day', range_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'),
  CHECK (range_end = range_start + INTERVAL '1 day'),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CHECK (
    status NOT IN ('verify_pending', 'verifying', 'verified', 'retry_verify')
    OR (
      object_key IS NOT NULL
      AND source_row_count IS NOT NULL
      AND canonical_metadata_row_count IS NOT NULL
      AND source_bytes IS NOT NULL
      AND source_sha256 IS NOT NULL
      AND archive_bytes IS NOT NULL
      AND archive_sha256 IS NOT NULL
      AND content_md5_base64 IS NOT NULL
    )
  ),
  CHECK (
    status <> 'verified'
    OR (
      verified_at IS NOT NULL
      AND uploaded_at IS NOT NULL
      AND canonical_metadata_row_count = source_row_count
      AND object_lock_mode IN ('GOVERNANCE', 'COMPLIANCE')
      AND object_lock_evidence IN ('api-verified', 'attested-default-policy')
      AND retain_until IS NOT NULL
      AND retain_until > verified_at
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_archive_segments_writer_claim
  ON archive_segments (not_before, range_start, id)
  WHERE status IN ('pending', 'retry_export', 'exporting');

CREATE INDEX IF NOT EXISTS idx_archive_segments_verifier_claim
  ON archive_segments (not_before, range_start, id)
  WHERE status IN ('verify_pending', 'retry_verify', 'verifying');

CREATE INDEX IF NOT EXISTS idx_archive_segments_verified_range
  ON archive_segments (source_kind, range_start, range_end)
  WHERE status = 'verified';

CREATE TABLE IF NOT EXISTS archive_attempts (
  id BIGSERIAL PRIMARY KEY,
  segment_id BIGINT NOT NULL REFERENCES archive_segments(id) ON DELETE CASCADE,
  segment_revision INTEGER NOT NULL CHECK (segment_revision > 0),
  stage TEXT NOT NULL CHECK (stage IN ('export', 'upload', 'verify', 'restore')),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  worker_id TEXT NOT NULL,
  outcome TEXT NOT NULL
    CHECK (outcome IN ('claimed', 'success', 'retry', 'dead_letter', 'stale_revision')),
  error TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (octet_length(COALESCE(error, '')) <= 4096),
  CHECK (octet_length(details::text) <= 16384)
);

CREATE INDEX IF NOT EXISTS idx_archive_attempts_segment
  ON archive_attempts (segment_id, segment_revision, occurred_at DESC, id DESC);

CREATE OR REPLACE FUNCTION invalidate_chain_event_archive_segment()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  segment_start TIMESTAMPTZ;
BEGIN
  segment_start := date_trunc('day', NEW.received_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';

  IF EXISTS (
    SELECT 1
    FROM archive_segments
    WHERE source_kind = 'chain-event-payloads'
      AND range_start = segment_start
      AND range_end = segment_start + INTERVAL '1 day'
      AND status = 'verified'
  ) THEN
    RAISE EXCEPTION
      'received_at window % is immutable after verified cold archive', segment_start
      USING ERRCODE = '23514';
  END IF;

  UPDATE archive_segments
  SET revision = revision + 1,
      status = 'pending',
      not_before = NOW(),
      lease_owner = NULL,
      lease_expires_at = NULL,
      object_key = NULL,
      source_row_count = NULL,
      canonical_metadata_row_count = NULL,
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
      last_error = 'source changed after archive segment creation',
      updated_at = NOW()
  WHERE source_kind = 'chain-event-payloads'
    AND range_start = segment_start
    AND range_end = segment_start + INTERVAL '1 day'
    AND status <> 'pending';

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_chain_event_payload_archive_invalidation ON chain_event_payloads;
CREATE TRIGGER trg_chain_event_payload_archive_invalidation
AFTER INSERT ON chain_event_payloads
FOR EACH ROW
EXECUTE FUNCTION invalidate_chain_event_archive_segment();

COMMENT ON TABLE archive_segments IS
  'Idempotent daily cold-archive manifest. Verified requires independent read-back and visible Object Lock retention.';
COMMENT ON TABLE archive_attempts IS
  'Bounded append-only audit for archive export, upload, verification and restore stages.';
