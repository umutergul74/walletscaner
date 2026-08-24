CREATE TABLE IF NOT EXISTS archive_retirement_policies (
  source_kind TEXT PRIMARY KEY
    CHECK (source_kind = 'chain-event-payloads'),
  activated_at TIMESTAMPTZ NOT NULL,
  future_canary_segment_id BIGINT REFERENCES archive_segments(id) ON DELETE RESTRICT,
  future_canary_verified_at TIMESTAMPTZ,
  retirement_enabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (future_canary_segment_id IS NULL AND future_canary_verified_at IS NULL
      AND retirement_enabled_at IS NULL)
    OR
    (future_canary_segment_id IS NOT NULL AND future_canary_verified_at IS NOT NULL)
  ),
  CHECK (retirement_enabled_at IS NULL OR future_canary_segment_id IS NOT NULL)
);

INSERT INTO archive_retirement_policies (source_kind, activated_at)
VALUES ('chain-event-payloads', NOW())
ON CONFLICT (source_kind) DO NOTHING;

CREATE OR REPLACE FUNCTION approve_chain_event_payload_retirement(
  candidate_range_start TIMESTAMPTZ,
  minimum_remaining_days INTEGER
) RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  policy archive_retirement_policies%ROWTYPE;
  candidate archive_segments%ROWTYPE;
BEGIN
  IF candidate_range_start IS NULL
     OR candidate_range_start <> date_trunc('day', candidate_range_start AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' THEN
    RAISE EXCEPTION 'Future canary range start must be a UTC day boundary';
  END IF;
  IF minimum_remaining_days IS NULL OR minimum_remaining_days < 1 THEN
    RAISE EXCEPTION 'Minimum remaining retention days must be positive';
  END IF;

  SELECT * INTO policy
  FROM archive_retirement_policies
  WHERE source_kind = 'chain-event-payloads'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Archive retirement policy is missing';
  END IF;
  IF candidate_range_start <
       (date_trunc('day', policy.activated_at AT TIME ZONE 'UTC') + INTERVAL '1 day') AT TIME ZONE 'UTC' THEN
    RAISE EXCEPTION 'Archive canary is not wholly future-only relative to policy activation';
  END IF;

  SELECT * INTO candidate
  FROM archive_segments
  WHERE source_kind = 'chain-event-payloads'
    AND range_start = candidate_range_start
    AND range_end = candidate_range_start + INTERVAL '1 day'
    AND status = 'verified'
    AND object_lock_evidence IN ('api-verified', 'attested-default-policy')
    AND retain_until > NOW() + make_interval(days => minimum_remaining_days)
    AND source_row_count IS NOT NULL
    AND source_row_count > 0
    AND canonical_metadata_row_count = source_row_count
    AND source_sha256 ~ '^[a-f0-9]{64}$'
    AND archive_sha256 ~ '^[a-f0-9]{64}$'
    AND verified_at IS NOT NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Future canary is not fully verified or lacks remaining retention';
  END IF;

  UPDATE archive_retirement_policies
  SET future_canary_segment_id = candidate.id,
      future_canary_verified_at = candidate.verified_at,
      retirement_enabled_at = NOW(),
      updated_at = NOW()
  WHERE source_kind = 'chain-event-payloads';

  RETURN candidate.id;
END;
$$;

CREATE OR REPLACE FUNCTION archive_retirement_policy_ready(
  minimum_remaining_days INTEGER DEFAULT 1
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM archive_retirement_policies AS policy
    JOIN archive_segments AS segment
      ON segment.id = policy.future_canary_segment_id
    WHERE policy.source_kind = 'chain-event-payloads'
      AND policy.retirement_enabled_at IS NOT NULL
      AND policy.future_canary_verified_at = segment.verified_at
      AND segment.range_start >=
          (date_trunc('day', policy.activated_at AT TIME ZONE 'UTC') + INTERVAL '1 day')
            AT TIME ZONE 'UTC'
      AND segment.status = 'verified'
      AND segment.object_lock_evidence IN ('api-verified', 'attested-default-policy')
      AND minimum_remaining_days >= 1
      AND segment.retain_until > NOW() + make_interval(days => minimum_remaining_days)
      AND segment.source_row_count > 0
      AND segment.canonical_metadata_row_count = segment.source_row_count
  )
$$;
