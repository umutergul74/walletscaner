CREATE TABLE IF NOT EXISTS historical_market_observations (
  idempotency_key TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  token_address TEXT NOT NULL,
  quote_token_address TEXT NOT NULL,
  pool_address TEXT,
  trader_address TEXT,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  base_amount NUMERIC NOT NULL CHECK (base_amount > 0),
  quote_amount NUMERIC NOT NULL CHECK (quote_amount > 0),
  price_quote NUMERIC NOT NULL CHECK (price_quote > 0),
  price_usd_estimate NUMERIC NOT NULL CHECK (price_usd_estimate > 0),
  volume_usd_estimate NUMERIC NOT NULL CHECK (volume_usd_estimate >= 0),
  price_source TEXT NOT NULL,
  confidence NUMERIC NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  signature TEXT NOT NULL,
  slot BIGINT NOT NULL,
  provider TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  strategy_version TEXT NOT NULL,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_historical_market_token_time
  ON historical_market_observations (chain, token_address, observed_at);
CREATE INDEX IF NOT EXISTS idx_historical_market_pool_time
  ON historical_market_observations (chain, pool_address, observed_at)
  WHERE pool_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_historical_market_trader_time
  ON historical_market_observations (chain, trader_address, observed_at)
  WHERE trader_address IS NOT NULL;

CREATE TABLE IF NOT EXISTS historical_market_buckets (
  pair_key TEXT NOT NULL,
  chain TEXT NOT NULL,
  token_address TEXT NOT NULL,
  quote_token_address TEXT NOT NULL,
  pool_address TEXT,
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes > 0),
  bucket_start TIMESTAMPTZ NOT NULL,
  open_price_quote NUMERIC NOT NULL,
  high_price_quote NUMERIC NOT NULL,
  low_price_quote NUMERIC NOT NULL,
  close_price_quote NUMERIC NOT NULL,
  volume_quote NUMERIC NOT NULL,
  volume_usd_estimate NUMERIC NOT NULL,
  buy_count INTEGER NOT NULL,
  sell_count INTEGER NOT NULL,
  unique_traders INTEGER NOT NULL,
  observation_count INTEGER NOT NULL,
  average_confidence NUMERIC NOT NULL,
  first_slot BIGINT NOT NULL,
  last_slot BIGINT NOT NULL,
  provider TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pair_key, interval_minutes, bucket_start, strategy_version)
);

CREATE INDEX IF NOT EXISTS idx_historical_buckets_token_time
  ON historical_market_buckets (chain, token_address, bucket_start);

CREATE TABLE IF NOT EXISTS historical_backfill_windows (
  run_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('program', 'pool', 'mint')),
  address TEXT NOT NULL,
  window_start_unix BIGINT NOT NULL,
  window_end_unix BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'saturated', 'error')),
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  transactions_fetched INTEGER NOT NULL DEFAULT 0,
  last_signature TEXT,
  last_slot BIGINT,
  provider TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (run_id, stage, address, window_start_unix, window_end_unix)
);

CREATE INDEX IF NOT EXISTS idx_historical_backfill_windows_status
  ON historical_backfill_windows (run_id, stage, status, updated_at);
