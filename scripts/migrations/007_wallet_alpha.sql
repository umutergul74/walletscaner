CREATE TABLE IF NOT EXISTS wallet_trade_events (
  idempotency_key TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  quote_token_address TEXT,
  pool_address TEXT,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  base_amount NUMERIC NOT NULL CHECK (base_amount > 0),
  quote_amount NUMERIC CHECK (quote_amount > 0),
  execution_price_usd NUMERIC CHECK (execution_price_usd > 0),
  quote_value_usd NUMERIC CHECK (quote_value_usd >= 0),
  pool_created_at TIMESTAMPTZ,
  pool_age_minutes NUMERIC,
  data_quality TEXT NOT NULL CHECK (
    data_quality IN (
      'observed-execution',
      'observed-balance',
      'price-proxy',
      'historical-observed',
      'historical-estimate'
    )
  ),
  signature TEXT NOT NULL,
  slot BIGINT NOT NULL,
  provider TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  strategy_version TEXT NOT NULL,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_wallet_trade_events_wallet_time
  ON wallet_trade_events (chain, wallet_address, observed_at);
CREATE INDEX IF NOT EXISTS idx_wallet_trade_events_token_time
  ON wallet_trade_events (chain, token_address, observed_at);
CREATE INDEX IF NOT EXISTS idx_wallet_trade_events_strategy_time
  ON wallet_trade_events (strategy_version, observed_at);

CREATE TABLE IF NOT EXISTS wallet_alpha_scores (
  chain TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  calculated_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('insufficient', 'observed', 'watch', 'candidate', 'validated-paper', 'excluded')
  ),
  profitability_score NUMERIC NOT NULL,
  followability_score NUMERIC NOT NULL,
  overall_score NUMERIC NOT NULL,
  completed_positions INTEGER NOT NULL,
  unique_tokens INTEGER NOT NULL,
  active_days INTEGER NOT NULL,
  metrics JSONB NOT NULL,
  gates JSONB NOT NULL,
  reasons JSONB NOT NULL,
  PRIMARY KEY (chain, wallet_address, strategy_version, calculated_at)
);

CREATE INDEX IF NOT EXISTS idx_wallet_alpha_scores_latest
  ON wallet_alpha_scores (strategy_version, status, overall_score DESC, calculated_at DESC);

CREATE TABLE IF NOT EXISTS wallet_alpha_signals (
  id TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  token_address TEXT NOT NULL,
  pool_address TEXT,
  strategy_version TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL,
  observed_price_usd NUMERIC NOT NULL CHECK (observed_price_usd > 0),
  observed_liquidity_usd NUMERIC NOT NULL CHECK (observed_liquidity_usd >= 0),
  confidence NUMERIC NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
  status TEXT NOT NULL CHECK (status IN ('paper-watch', 'paper-candidate')),
  wallet_addresses JSONB NOT NULL,
  evidence JSONB NOT NULL,
  UNIQUE (strategy_version, token_address)
);

CREATE INDEX IF NOT EXISTS idx_wallet_alpha_signals_time
  ON wallet_alpha_signals (strategy_version, detected_at DESC);
