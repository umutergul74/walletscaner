\set ON_ERROR_STOP on

DO $$
DECLARE
  old_payload_partition TEXT :=
    'chain_event_payloads_' || to_char(CURRENT_DATE - 5, 'YYYYMMDD');
  old_price_partition TEXT :=
    'price_observations_' || to_char(CURRENT_DATE - 5, 'YYYYMMDD');
BEGIN
  IF to_regclass(old_payload_partition) IS NOT NULL THEN
    RAISE EXCEPTION 'expired chain payload partition was not dropped';
  END IF;
  IF to_regclass(old_price_partition) IS NOT NULL THEN
    RAISE EXCEPTION 'expired price partition was not dropped';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM chain_event_payload_holds
    WHERE event_idempotency_key = 'storage-old-retry'
      AND payload->>'address' = 'RetryPool'
  ) THEN
    RAISE EXCEPTION 'unresolved payload was not moved to the hold table';
  END IF;
  IF EXISTS (
    SELECT 1 FROM price_observation_keys
    WHERE idempotency_key = 'storage-retire-price'
  ) THEN
    RAISE EXCEPTION 'expired price idempotency key was not retired';
  END IF;
END
$$;

SELECT
  (SELECT COUNT(*) FROM chain_event_payload_holds) AS held_payloads,
  (SELECT COUNT(*) FROM price_observations) AS retained_prices;
