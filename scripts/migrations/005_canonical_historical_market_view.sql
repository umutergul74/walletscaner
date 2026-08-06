CREATE OR REPLACE VIEW canonical_historical_market_observations AS
SELECT
  MIN(idempotency_key) AS idempotency_key,
  chain,
  token_address,
  quote_token_address,
  MAX(pool_address) AS pool_address,
  MAX(trader_address) AS trader_address,
  side,
  SUM(base_amount) AS base_amount,
  MAX(quote_amount) AS quote_amount,
  MAX(quote_amount) / NULLIF(SUM(base_amount), 0) AS price_quote,
  (
    MAX(quote_amount) / NULLIF(SUM(base_amount), 0)
  ) * MAX(price_usd_estimate / NULLIF(price_quote, 0)) AS price_usd_estimate,
  MAX(volume_usd_estimate) AS volume_usd_estimate,
  MAX(price_source) AS price_source,
  MAX(confidence) AS confidence,
  signature,
  MIN(slot) AS slot,
  MAX(provider) AS provider,
  MIN(observed_at) AS observed_at,
  strategy_version,
  jsonb_build_object(
    'consolidatedLegCount', COUNT(*),
    'sourceObservationKeys', jsonb_agg(idempotency_key ORDER BY idempotency_key)
  ) AS raw
FROM historical_market_observations
GROUP BY
  chain,
  token_address,
  quote_token_address,
  signature,
  side,
  strategy_version;
