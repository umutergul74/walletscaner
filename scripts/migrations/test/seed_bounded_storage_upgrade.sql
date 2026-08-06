\set ON_ERROR_STOP on

INSERT INTO chain_event_inbox (
  idempotency_key, chain, signature, slot, event_type, occurred_at, received_at,
  processed_at, commitment, source, decoder_version, status, payload,
  payload_sha256, payload_compacted_at
) VALUES
  (
    'storage-old-processed', 'solana', 'storage-old-processed', 1, 'swap',
    NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days',
    'confirmed', 'storage-smoke', 'smoke-v1', 'processed',
    jsonb_build_object('address', 'OldPool', 'blob', repeat('x', 100000)),
    encode(digest(jsonb_build_object('address', 'OldPool')::text, 'sha256'), 'hex'),
    NULL
  ),
  (
    'storage-recent-processed', 'solana', 'storage-recent-processed', 2, 'swap',
    NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day',
    'confirmed', 'storage-smoke', 'smoke-v1', 'processed',
    jsonb_build_object('address', 'RecentPool', 'blob', repeat('x', 100000)),
    encode(digest(jsonb_build_object('address', 'RecentPool')::text, 'sha256'), 'hex'),
    NULL
  ),
  (
    'storage-old-retry', 'solana', 'storage-old-retry', 3, 'swap',
    NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days', NULL,
    'confirmed', 'storage-smoke', 'smoke-v1', 'retry',
    jsonb_build_object('address', 'RetryPool', 'blob', repeat('x', 100000)),
    encode(digest(jsonb_build_object('address', 'RetryPool')::text, 'sha256'), 'hex'),
    NULL
  );

INSERT INTO event_processing_attempts (
  event_idempotency_key, attempt_number, worker_id, status, started_at, finished_at, error
) VALUES (
  'storage-old-retry', 1, 'storage-smoke', 'retry',
  NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days', 'fixture retry'
);

INSERT INTO price_observations (
  idempotency_key, chain, token_address, price_usd, liquidity_usd, rugged,
  signature, slot, provider, observed_at, strategy_version, raw
) VALUES
  (
    'storage-old-price', 'solana', 'OldMint', 1, 1000, FALSE,
    'storage-old-price', 1, 'storage-smoke', NOW() - INTERVAL '5 days',
    'evidence-v1', '{}'::jsonb
  ),
  (
    'storage-recent-price', 'solana', 'RecentMint', 1, 1000, FALSE,
    'storage-recent-price', 2, 'storage-smoke', NOW() - INTERVAL '1 day',
    'evidence-v1', '{}'::jsonb
  );
