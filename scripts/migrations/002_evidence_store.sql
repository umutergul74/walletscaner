CREATE TABLE IF NOT EXISTS price_observations (
  idempotency_key TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  token_address TEXT NOT NULL,
  pool_address TEXT,
  price_usd NUMERIC NOT NULL CHECK (price_usd >= 0),
  liquidity_usd NUMERIC NOT NULL CHECK (liquidity_usd >= 0),
  rugged BOOLEAN NOT NULL DEFAULT FALSE,
  signature TEXT NOT NULL,
  slot BIGINT NOT NULL,
  provider TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  strategy_version TEXT NOT NULL,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS strategy_version TEXT NOT NULL DEFAULT 'legacy-v0';
ALTER TABLE paper_trades
  ADD COLUMN IF NOT EXISTS strategy_version TEXT NOT NULL DEFAULT 'legacy-v0';

CREATE TABLE IF NOT EXISTS wallet_entry_signals (
  idempotency_key TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  pool_address TEXT,
  observed_entry_price_usd NUMERIC NOT NULL CHECK (observed_entry_price_usd > 0),
  observed_liquidity_usd NUMERIC NOT NULL CHECK (observed_liquidity_usd >= 0),
  cohort TEXT NOT NULL,
  repeat_wallet_count INTEGER NOT NULL DEFAULT 0 CHECK (repeat_wallet_count >= 0),
  flow_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  signature TEXT NOT NULL,
  slot BIGINT NOT NULL,
  provider TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  strategy_version TEXT NOT NULL,
  UNIQUE (chain, wallet_address, token_address, strategy_version)
);

CREATE TABLE IF NOT EXISTS wallet_signal_outcomes (
  idempotency_key TEXT PRIMARY KEY,
  entry_idempotency_key TEXT NOT NULL REFERENCES wallet_entry_signals(idempotency_key),
  chain TEXT NOT NULL,
  horizon_minutes INTEGER NOT NULL CHECK (horizon_minutes > 0),
  status TEXT NOT NULL CHECK (status IN ('mature', 'provisional', 'unresolved')),
  outcome_price_usd NUMERIC CHECK (outcome_price_usd >= 0),
  frozen_at TIMESTAMPTZ,
  gross_return_pct NUMERIC,
  net_return_pct NUMERIC,
  estimated_round_trip_cost_pct NUMERIC NOT NULL DEFAULT 3,
  exit_strategy TEXT NOT NULL CHECK (exit_strategy IN ('fixed-horizon', 'tp15-sl20-20m')),
  rugged BOOLEAN NOT NULL DEFAULT FALSE,
  signature TEXT NOT NULL,
  slot BIGINT NOT NULL,
  provider TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  strategy_version TEXT NOT NULL,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (entry_idempotency_key, horizon_minutes, exit_strategy, strategy_version)
);

CREATE TABLE IF NOT EXISTS hypothesis_runs (
  idempotency_key TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  chain TEXT NOT NULL,
  hypothesis_key TEXT NOT NULL,
  cohort TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('reject', 'watch', 'candidate')),
  signal_keys JSONB NOT NULL,
  metrics JSONB NOT NULL,
  decision_reason TEXT NOT NULL,
  signature TEXT NOT NULL,
  slot BIGINT NOT NULL,
  provider TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  strategy_version TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingestion_cursors (
  source TEXT NOT NULL,
  address TEXT NOT NULL,
  chain TEXT NOT NULL,
  last_signature TEXT NOT NULL,
  last_slot BIGINT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  signature TEXT NOT NULL,
  slot BIGINT NOT NULL,
  provider TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  strategy_version TEXT NOT NULL,
  PRIMARY KEY (source, address)
);

CREATE INDEX IF NOT EXISTS idx_price_observations_token_time
  ON price_observations (chain, token_address, observed_at);
CREATE INDEX IF NOT EXISTS idx_wallet_entries_wallet_time
  ON wallet_entry_signals (chain, wallet_address, observed_at);
CREATE INDEX IF NOT EXISTS idx_wallet_entries_token_time
  ON wallet_entry_signals (chain, token_address, observed_at);
CREATE INDEX IF NOT EXISTS idx_wallet_outcomes_status_time
  ON wallet_signal_outcomes (status, observed_at);
CREATE INDEX IF NOT EXISTS idx_hypothesis_runs_key_time
  ON hypothesis_runs (hypothesis_key, observed_at);
