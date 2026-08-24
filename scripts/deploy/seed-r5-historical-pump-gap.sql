\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on

SELECT jsonb_build_object(
  'type', 'historical-pump-gap-impact-before',
  'poolCount', (
    SELECT COUNT(*)
    FROM pools
    WHERE chain = 'solana'
      AND dex = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
      AND created_at >= '2026-08-20T21:10:45.000Z'::timestamptz
      AND created_at <= '2026-08-20T21:29:31.000Z'::timestamptz
  ),
  'qualifiedMessageCount', (
    SELECT COUNT(*)
    FROM telegram_notification_outbox AS message
    JOIN pools AS pool
      ON pool.chain = 'solana'
     AND pool.pool_address = message.payload->>'poolAddress'
     AND pool.base_token_address = message.payload->>'tokenAddress'
    WHERE message.event_type = 'qualified-pool'
      AND pool.dex = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
      AND pool.created_at >= '2026-08-20T21:10:45.000Z'::timestamptz
      AND pool.created_at <= '2026-08-20T21:29:31.000Z'::timestamptz
  ),
  'paperTradeCount', (
    SELECT COUNT(*)
    FROM paper_trades AS trade
    JOIN telegram_notification_outbox AS message
      ON message.id = trade.signal_id
    JOIN pools AS pool
      ON pool.chain = 'solana'
     AND pool.pool_address = message.payload->>'poolAddress'
     AND pool.base_token_address = message.payload->>'tokenAddress'
    WHERE trade.strategy_version = 'qualified-pool-paper-v3-strict-flow'
      AND pool.dex = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
      AND pool.created_at >= '2026-08-20T21:10:45.000Z'::timestamptz
      AND pool.created_at <= '2026-08-20T21:29:31.000Z'::timestamptz
  )
);

BEGIN;

SELECT pg_advisory_xact_lock(
  hashtextextended(
    'walletscaner:discovery-coverage:' ||
      '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    0
  )
);

INSERT INTO ingestion_coverage_incidents (
  idempotency_key,
  chain,
  provider,
  program_address,
  reason,
  gap_started_at,
  opened_at,
  cluster_slot,
  source_slot,
  slot_lag,
  last_websocket_message_at,
  silence_ms,
  subscription_ack_timeout_count,
  successful_subscription_ack_count,
  open_metadata,
  closed_at,
  close_cluster_slot,
  close_source_slot,
  resolution,
  close_metadata
) VALUES (
  'r5-historical-pump-gap-440548309-440551012',
  'solana',
  'solana-rpc-discovery',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  'raw_websocket_silence',
  '2026-08-20T21:10:45.000Z'::timestamptz,
  '2026-08-20T21:10:45.000Z'::timestamptz,
  440551012,
  440548309,
  2703,
  '2026-08-20T21:10:45.000Z'::timestamptz,
  1126000,
  0,
  0,
  jsonb_build_object(
    'evidenceVersion', 'pipeline-stability-r5-20260821',
    'classification', 'historical-reviewed-gap',
    'previousEventSlot', 440548309,
    'previousEventOccurredAt', '2026-08-20T21:10:45.000Z',
    'previousEventReceivedAt', '2026-08-20T21:13:06.484Z',
    'nextEventSlot', 440551012,
    'nextEventOccurredAt', '2026-08-20T21:29:31.000Z',
    'nextEventReceivedAt', '2026-08-20T21:29:35.935Z',
    'observedGapSeconds', 1126,
    'historicalReconstructionProven', false
  ),
  '2026-08-20T21:29:31.000Z'::timestamptz,
  440551012,
  440551012,
  'transport_recovered_gap_unreconciled',
  jsonb_build_object(
    'evidenceVersion', 'pipeline-stability-r5-20260821',
    'transportRecoveredAtNextRetainedEvent', true,
    'historicalGapReconstructed', false,
    'seededAtRollout', true
  )
)
ON CONFLICT (idempotency_key) DO NOTHING;

DO $verify$
DECLARE
  exact_match_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO exact_match_count
  FROM ingestion_coverage_incidents
  WHERE idempotency_key = 'r5-historical-pump-gap-440548309-440551012'
    AND chain = 'solana'
    AND provider = 'solana-rpc-discovery'
    AND program_address = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
    AND reason = 'raw_websocket_silence'
    AND gap_started_at = '2026-08-20T21:10:45.000Z'::timestamptz
    AND opened_at = '2026-08-20T21:10:45.000Z'::timestamptz
    AND cluster_slot = 440551012
    AND source_slot = 440548309
    AND slot_lag = 2703
    AND last_websocket_message_at = '2026-08-20T21:10:45.000Z'::timestamptz
    AND silence_ms = 1126000
    AND closed_at = '2026-08-20T21:29:31.000Z'::timestamptz
    AND close_cluster_slot = 440551012
    AND close_source_slot = 440551012
    AND resolution = 'transport_recovered_gap_unreconciled'
    AND open_metadata = jsonb_build_object(
      'evidenceVersion', 'pipeline-stability-r5-20260821',
      'classification', 'historical-reviewed-gap',
      'previousEventSlot', 440548309,
      'previousEventOccurredAt', '2026-08-20T21:10:45.000Z',
      'previousEventReceivedAt', '2026-08-20T21:13:06.484Z',
      'nextEventSlot', 440551012,
      'nextEventOccurredAt', '2026-08-20T21:29:31.000Z',
      'nextEventReceivedAt', '2026-08-20T21:29:35.935Z',
      'observedGapSeconds', 1126,
      'historicalReconstructionProven', false
    )
    AND close_metadata = jsonb_build_object(
      'evidenceVersion', 'pipeline-stability-r5-20260821',
      'transportRecoveredAtNextRetainedEvent', true,
      'historicalGapReconstructed', false,
      'seededAtRollout', true
    );

  IF exact_match_count <> 1 THEN
    RAISE EXCEPTION 'historical Pump gap row is missing or conflicts with reviewed evidence';
  END IF;
END
$verify$;

COMMIT;

SELECT jsonb_build_object(
  'type', 'historical-pump-gap-seed',
  'status', 'verified',
  'idempotencyKey', idempotency_key,
  'gapStartedAt', gap_started_at,
  'closedAt', closed_at,
  'resolution', resolution,
  'historicalReconstructionProven', open_metadata->'historicalReconstructionProven'
)
FROM ingestion_coverage_incidents
WHERE idempotency_key = 'r5-historical-pump-gap-440548309-440551012';
