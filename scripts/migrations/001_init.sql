CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS tokens (
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  symbol TEXT,
  name TEXT,
  decimals INTEGER,
  creator_address TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (chain, address)
);

CREATE TABLE IF NOT EXISTS pools (
  chain TEXT NOT NULL,
  pool_address TEXT NOT NULL,
  dex TEXT NOT NULL,
  base_token_address TEXT NOT NULL,
  quote_token_address TEXT,
  created_at TIMESTAMPTZ,
  liquidity_usd NUMERIC,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (chain, pool_address)
);

CREATE TABLE IF NOT EXISTS token_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  chain TEXT NOT NULL,
  token_address TEXT NOT NULL,
  event_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  slot BIGINT,
  block_number BIGINT,
  observed_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS swaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  chain TEXT NOT NULL,
  signature TEXT,
  slot BIGINT,
  block_number BIGINT,
  pool_address TEXT,
  trader_address TEXT NOT NULL,
  input_token_address TEXT NOT NULL,
  output_token_address TEXT NOT NULL,
  input_amount NUMERIC,
  output_amount NUMERIC,
  price_usd NUMERIC,
  volume_usd NUMERIC,
  observed_at TIMESTAMPTZ NOT NULL,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS liquidity_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  chain TEXT NOT NULL,
  pool_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  event_type TEXT NOT NULL,
  liquidity_usd NUMERIC,
  provider TEXT NOT NULL,
  slot BIGINT,
  block_number BIGINT,
  observed_at TIMESTAMPTZ NOT NULL,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS wallet_positions (
  chain TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  first_entry_at TIMESTAMPTZ,
  last_exit_at TIMESTAMPTZ,
  amount NUMERIC NOT NULL DEFAULT 0,
  cost_basis_usd NUMERIC NOT NULL DEFAULT 0,
  realized_pnl_usd NUMERIC NOT NULL DEFAULT 0,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (chain, wallet_address, token_address)
);

CREATE TABLE IF NOT EXISTS wallet_scores (
  chain TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  score NUMERIC NOT NULL,
  category TEXT NOT NULL,
  calculated_at TIMESTAMPTZ NOT NULL,
  features JSONB NOT NULL,
  reasons JSONB NOT NULL,
  PRIMARY KEY (chain, wallet_address, calculated_at)
);

CREATE TABLE IF NOT EXISTS deployers (
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  tokens_created INTEGER NOT NULL DEFAULT 0,
  rugged_tokens INTEGER NOT NULL DEFAULT 0,
  reputation_score NUMERIC NOT NULL DEFAULT 50,
  last_seen_at TIMESTAMPTZ,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (chain, address)
);

CREATE TABLE IF NOT EXISTS holder_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chain TEXT NOT NULL,
  token_address TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  holder_count INTEGER,
  top_holder_percent NUMERIC,
  top_10_holder_percent NUMERIC,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (chain, token_address, captured_at)
);

CREATE TABLE IF NOT EXISTS token_risk_assessments (
  chain TEXT NOT NULL,
  token_address TEXT NOT NULL,
  calculated_at TIMESTAMPTZ NOT NULL,
  score NUMERIC NOT NULL,
  risk_score NUMERIC NOT NULL,
  confidence NUMERIC NOT NULL,
  sub_scores JSONB NOT NULL,
  reasons JSONB NOT NULL,
  warnings JSONB NOT NULL,
  PRIMARY KEY (chain, token_address, calculated_at)
);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  token_address TEXT NOT NULL,
  pool_address TEXT,
  signal_type TEXT NOT NULL,
  confidence NUMERIC NOT NULL,
  risk_score NUMERIC NOT NULL,
  token_score NUMERIC NOT NULL,
  action_category TEXT NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL,
  key_reasons JSONB NOT NULL,
  wallets JSONB NOT NULL,
  liquidity_snapshot JSONB NOT NULL,
  volume_snapshot JSONB NOT NULL,
  holder_snapshot JSONB NOT NULL,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS paper_trades (
  id TEXT PRIMARY KEY,
  signal_id TEXT REFERENCES signals(id),
  chain TEXT NOT NULL,
  token_address TEXT NOT NULL,
  side TEXT NOT NULL,
  status TEXT NOT NULL,
  quantity NUMERIC NOT NULL,
  price_usd NUMERIC NOT NULL,
  notional_usd NUMERIC NOT NULL,
  fees_usd NUMERIC NOT NULL,
  slippage_bps NUMERIC NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  pnl_usd NUMERIC,
  reason TEXT,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id TEXT PRIMARY KEY,
  strategy_version TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  date_start TIMESTAMPTZ NOT NULL,
  date_end TIMESTAMPTZ NOT NULL,
  config JSONB NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  report_markdown TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id TEXT REFERENCES signals(id),
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  sent_at TIMESTAMPTZ,
  error TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS provider_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  status_code INTEGER,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  request_fingerprint TEXT,
  response JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS dead_letters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retried_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_token_events_token_time ON token_events (chain, token_address, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_swaps_trader_time ON swaps (chain, trader_address, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_swaps_token_time ON swaps (chain, output_token_address, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_detected_at ON signals (detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_action ON signals (action_category, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_scores_latest ON wallet_scores (chain, wallet_address, calculated_at DESC);

