-- migrate:no-transaction

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pools_telegram_candidates
  ON pools (created_at DESC)
  INCLUDE (
    chain,
    pool_address,
    base_token_address,
    dex,
    token_symbol,
    token_name,
    liquidity_usd,
    volume_5m_usd,
    price_usd,
    market_cap_usd
  )
  WHERE created_at IS NOT NULL
    AND liquidity_usd >= 10000
    AND volume_5m_usd >= 5000;
