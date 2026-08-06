\set ON_ERROR_STOP on

DO $$
DECLARE
  lower_bound DATE := CURRENT_DATE - 5;
  upper_bound DATE := CURRENT_DATE - 4;
BEGIN
  EXECUTE format(
    'CREATE TABLE %I PARTITION OF chain_event_payloads
       FOR VALUES FROM (%L) TO (%L)',
    'chain_event_payloads_' || to_char(lower_bound, 'YYYYMMDD'),
    lower_bound::text || ' 00:00:00+00',
    upper_bound::text || ' 00:00:00+00'
  );
  EXECUTE format(
    'CREATE TABLE %I PARTITION OF price_observations
       FOR VALUES FROM (%L) TO (%L)',
    'price_observations_' || to_char(lower_bound, 'YYYYMMDD'),
    lower_bound::text || ' 00:00:00+00',
    upper_bound::text || ' 00:00:00+00'
  );
END
$$;

INSERT INTO chain_event_payloads (
  event_idempotency_key, received_at, payload, payload_sha256
)
SELECT idempotency_key, received_at, payload, payload_sha256
FROM chain_event_inbox
WHERE idempotency_key = 'storage-old-retry';

INSERT INTO price_observation_keys (idempotency_key, observed_at)
VALUES ('storage-retire-price', NOW() - INTERVAL '5 days');

INSERT INTO price_observations (
  idempotency_key, chain, token_address, price_usd, liquidity_usd, rugged,
  signature, slot, provider, observed_at, strategy_version, raw
) VALUES (
  'storage-retire-price', 'solana', 'RetireMint', 1, 1000, FALSE,
  'storage-retire-price', 3, 'storage-smoke', NOW() - INTERVAL '5 days',
  'evidence-v1', '{}'::jsonb
);
