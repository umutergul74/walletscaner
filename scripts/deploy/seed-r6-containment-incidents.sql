\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

BEGIN;

-- Serialize signal admission for both affected programs while the durable
-- coverage evidence and the exact-pool correction become visible together.
SELECT pg_advisory_xact_lock(
  hashtextextended(
    'walletscaner:discovery-coverage:' ||
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    0
  )
);
SELECT pg_advisory_xact_lock(
  hashtextextended(
    'walletscaner:discovery-coverage:' ||
      'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
    0
  )
);

DO $preflight$
DECLARE
  unexpected_open_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO unexpected_open_count
  FROM ingestion_coverage_incidents
  WHERE provider = 'solana-rpc-discovery'
    AND program_address IN (
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
    )
    AND closed_at IS NULL
    AND idempotency_key NOT IN (
      'r6-containment-pump-live-queue-20260822',
      'r6-containment-pumpswap-cursorless-20260821'
    );
  IF unexpected_open_count <> 0 THEN
    RAISE EXCEPTION 'unexpected open coverage incident exists for an R6 containment program';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pools
    WHERE chain = 'solana'
      AND pool_address = 'CcweuytkDiHRjHAfJ9y8Xt7ATVj7vxB8yPAvmz5UxYow'
      AND dex = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
      AND created_at = '2026-08-21T10:02:55Z'::timestamptz
  ) THEN
    RAISE EXCEPTION 'reviewed cursorless PumpSwap pool identity changed or is missing';
  END IF;
END
$preflight$;

INSERT INTO ingestion_coverage_incidents (
  idempotency_key,
  chain,
  provider,
  program_address,
  reason,
  gap_started_at,
  opened_at,
  open_metadata
) VALUES (
  'r6-containment-pump-live-queue-20260822',
  'solana',
  'solana-rpc-discovery',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  'combined',
  '2026-08-22T00:04:46.556351Z'::timestamptz,
  '2026-08-22T18:03:00Z'::timestamptz,
  jsonb_build_object(
    'evidenceVersion', 'pipeline-stability-r6-20260822',
    'classification', 'historical-reviewed-live-queue-pressure',
    'coverageTrigger', 'live_queue_pressure',
    'r5ContainerStartedAt', '2026-08-22T00:04:46.556351Z',
    'finalR5HealthObservedAt', '2026-08-22T18:01:52.517Z',
    'finalR5LastWebsocketMessageAt', '2026-08-22T18:02:52.153Z',
    'finalR5LastWebsocketContextSlot', 440976629,
    'observedDroppedSignatureCount', 1631,
    'observedQueuePressureCount', 2,
    'observedQueueHighWatermark', 500,
    'observedMaxQueuedSignatures', 500,
    'historicalReconstructionProven', false,
    'coverageDisposition', 'alpha_excluded_unreconciled'
  )
), (
  'r6-containment-pumpswap-cursorless-20260821',
  'solana',
  'solana-rpc-discovery',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  'backfill_truncated',
  '2026-08-21T10:02:55Z'::timestamptz,
  '2026-08-22T18:03:00Z'::timestamptz,
  jsonb_build_object(
    'evidenceVersion', 'pipeline-stability-r6-20260822',
    'classification', 'historical-reviewed-cursorless-initial-saturation',
    'coverageTrigger', 'cursorless-initial-limit',
    'affectedPoolAddress', 'CcweuytkDiHRjHAfJ9y8Xt7ATVj7vxB8yPAvmz5UxYow',
    'affectedTokenAddress', 'TSvMmWjCBRghBocKRMHexPFRA49j2i1YfW5pYGKL5rD',
    'initialBackfillLimit', 5,
    'firstRetainedTradeAt', '2026-08-21T10:03:59Z',
    'unprovenPrefixSeconds', 64,
    'historicalReconstructionProven', false,
    'coverageDisposition', 'alpha_excluded_unreconciled'
  )
)
ON CONFLICT (idempotency_key) DO NOTHING;

UPDATE pools
SET raw = jsonb_set(
  raw,
  '{tradeCoverage}',
  COALESCE(raw->'tradeCoverage', '{}'::jsonb) || jsonb_build_object(
    'complete', false,
    'reason', 'cursorless-initial-limit',
    'gapStartedAt', '2026-08-21T10:02:55.000Z',
    'excludedAt', '2026-08-22T18:03:00.000Z',
    'evidenceVersion', 'pipeline-stability-r6-20260822'
  ),
  true
)
WHERE chain = 'solana'
  AND pool_address = 'CcweuytkDiHRjHAfJ9y8Xt7ATVj7vxB8yPAvmz5UxYow'
  AND dex = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
  AND COALESCE((raw#>>'{tradeCoverage,complete}')::boolean, false);

DO $verify$
DECLARE
  exact_incident_count INTEGER;
  corrected_pool_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO exact_incident_count
  FROM ingestion_coverage_incidents
  WHERE closed_at IS NULL
    AND (
      (
        idempotency_key = 'r6-containment-pump-live-queue-20260822'
        AND program_address = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
        AND reason = 'combined'
        AND gap_started_at = '2026-08-22T00:04:46.556351Z'::timestamptz
        AND open_metadata->>'coverageTrigger' = 'live_queue_pressure'
      )
      OR
      (
        idempotency_key = 'r6-containment-pumpswap-cursorless-20260821'
        AND program_address = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
        AND reason = 'backfill_truncated'
        AND gap_started_at = '2026-08-21T10:02:55Z'::timestamptz
        AND open_metadata->>'coverageTrigger' = 'cursorless-initial-limit'
      )
    );
  IF exact_incident_count <> 2 THEN
    RAISE EXCEPTION 'R6 containment incidents are missing or conflict with reviewed evidence';
  END IF;

  SELECT COUNT(*) INTO corrected_pool_count
  FROM pools
  WHERE chain = 'solana'
    AND pool_address = 'CcweuytkDiHRjHAfJ9y8Xt7ATVj7vxB8yPAvmz5UxYow'
    AND raw#>>'{tradeCoverage,complete}' = 'false'
    AND raw#>>'{tradeCoverage,reason}' = 'cursorless-initial-limit'
    AND raw#>>'{tradeCoverage,evidenceVersion}' = 'pipeline-stability-r6-20260822';
  IF corrected_pool_count <> 1 THEN
    RAISE EXCEPTION 'reviewed cursorless pool was not fail-closed exactly once';
  END IF;
END
$verify$;

COMMIT;

SELECT jsonb_build_object(
  'type', 'r6-containment-evidence',
  'openIncidentCount', (
    SELECT COUNT(*)
    FROM ingestion_coverage_incidents
    WHERE idempotency_key IN (
      'r6-containment-pump-live-queue-20260822',
      'r6-containment-pumpswap-cursorless-20260821'
    )
      AND closed_at IS NULL
  ),
  'correctedPoolCoverage', (
    SELECT raw->'tradeCoverage'
    FROM pools
    WHERE chain = 'solana'
      AND pool_address = 'CcweuytkDiHRjHAfJ9y8Xt7ATVj7vxB8yPAvmz5UxYow'
  )
);
