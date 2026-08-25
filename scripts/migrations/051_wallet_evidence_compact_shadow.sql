-- Compact wallet-evidence shadow state. This migration is additive and does
-- not redirect readers or retire canonical source rows.

CREATE TABLE IF NOT EXISTS wallet_evidence_wallet_dimensions (
  id BIGSERIAL PRIMARY KEY,
  chain TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  UNIQUE (chain, wallet_address)
);

CREATE TABLE IF NOT EXISTS wallet_evidence_token_dimensions (
  id BIGSERIAL PRIMARY KEY,
  chain TEXT NOT NULL,
  token_address TEXT NOT NULL,
  UNIQUE (chain, token_address)
);

CREATE TABLE IF NOT EXISTS wallet_evidence_strategy_dimensions (
  id SMALLSERIAL PRIMARY KEY,
  strategy_version TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS wallet_profitability_episode_facts (
  episode_hash BYTEA PRIMARY KEY CHECK (octet_length(episode_hash) = 32),
  wallet_id BIGINT NOT NULL REFERENCES wallet_evidence_wallet_dimensions(id) ON DELETE RESTRICT,
  token_id BIGINT NOT NULL REFERENCES wallet_evidence_token_dimensions(id) ON DELETE RESTRICT,
  strategy_id SMALLINT NOT NULL
    REFERENCES wallet_evidence_strategy_dimensions(id) ON DELETE RESTRICT,
  episode_index INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'realized', 'terminal_risk')),
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  cost_basis_usd NUMERIC NOT NULL,
  proceeds_usd NUMERIC NOT NULL,
  realized_pnl_usd NUMERIC NOT NULL,
  return_pct NUMERIC,
  remaining_raw_amount NUMERIC NOT NULL,
  token_decimals SMALLINT NOT NULL,
  realized_lot_count INTEGER NOT NULL,
  high_quality_price_coverage NUMERIC NOT NULL,
  terminal_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_profitability_fact_wallet_time
  ON wallet_profitability_episode_facts (strategy_id, wallet_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_profitability_fact_closed
  ON wallet_profitability_episode_facts (closed_at, episode_hash)
  WHERE status <> 'open';

CREATE TABLE IF NOT EXISTS wallet_open_lot_facts (
  lot_hash BYTEA PRIMARY KEY CHECK (octet_length(lot_hash) = 32),
  episode_hash BYTEA NOT NULL
    REFERENCES wallet_profitability_episode_facts(episode_hash) ON DELETE CASCADE,
  lot_sequence INTEGER NOT NULL,
  raw_amount NUMERIC NOT NULL,
  remaining_raw_amount NUMERIC NOT NULL,
  token_decimals SMALLINT NOT NULL,
  quote_cost_usd NUMERIC NOT NULL,
  fees_usd NUMERIC NOT NULL,
  slippage_usd NUMERIC NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('open', 'partially_realized', 'transferred')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_open_lot_fact_fifo
  ON wallet_open_lot_facts (episode_hash, status, opened_at, lot_sequence);

CREATE TABLE IF NOT EXISTS wallet_followability_facts (
  outcome_hash BYTEA PRIMARY KEY CHECK (octet_length(outcome_hash) = 32),
  entry_hash BYTEA NOT NULL CHECK (octet_length(entry_hash) = 32),
  wallet_id BIGINT NOT NULL REFERENCES wallet_evidence_wallet_dimensions(id) ON DELETE RESTRICT,
  token_id BIGINT NOT NULL REFERENCES wallet_evidence_token_dimensions(id) ON DELETE RESTRICT,
  strategy_id SMALLINT NOT NULL
    REFERENCES wallet_evidence_strategy_dimensions(id) ON DELETE RESTRICT,
  entry_observed_at TIMESTAMPTZ NOT NULL,
  outcome_observed_at TIMESTAMPTZ NOT NULL,
  observed_entry_price_usd NUMERIC NOT NULL,
  observed_liquidity_usd NUMERIC NOT NULL,
  cohort TEXT NOT NULL,
  repeat_wallet_count INTEGER NOT NULL,
  controlled_flow BOOLEAN,
  balanced_flow BOOLEAN,
  pool_age_minutes NUMERIC,
  liquidity_usd NUMERIC,
  liquidity_known BOOLEAN,
  volume_5m_usd NUMERIC,
  volume_1h_usd NUMERIC,
  buys_5m INTEGER,
  sells_5m INTEGER,
  swaps_5m INTEGER,
  buy_share_5m NUMERIC,
  volume_liquidity_ratio NUMERIC,
  token_risk_known BOOLEAN,
  token_risk_passed BOOLEAN,
  mint_authority_revoked BOOLEAN,
  freeze_authority_revoked BOOLEAN,
  top_10_holder_percent NUMERIC,
  buy_observed_at TIMESTAMPTZ,
  horizon_minutes INTEGER NOT NULL,
  outcome_price_usd NUMERIC,
  frozen_at TIMESTAMPTZ,
  gross_return_pct NUMERIC,
  net_return_pct NUMERIC,
  estimated_round_trip_cost_pct NUMERIC NOT NULL,
  exit_strategy TEXT NOT NULL,
  rugged BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_followability_fact_wallet_time
  ON wallet_followability_facts (strategy_id, wallet_id, outcome_observed_at);
CREATE INDEX IF NOT EXISTS idx_wallet_followability_fact_retention
  ON wallet_followability_facts (outcome_observed_at, outcome_hash);

CREATE TABLE IF NOT EXISTS wallet_evidence_compact_days (
  range_start TIMESTAMPTZ PRIMARY KEY,
  range_end TIMESTAMPTZ NOT NULL,
  archive_segment_id BIGINT NOT NULL REFERENCES archive_segments(id) ON DELETE RESTRICT,
  archive_revision INTEGER NOT NULL CHECK (archive_revision > 0),
  status TEXT NOT NULL CHECK (status IN ('verified', 'mismatch', 'retry')),
  source_record_type_counts JSONB NOT NULL CHECK (
    jsonb_typeof(source_record_type_counts) = 'object'
    AND octet_length(source_record_type_counts::text) <= 4096
  ),
  affected_episode_count BIGINT NOT NULL CHECK (affected_episode_count >= 0),
  open_lot_count BIGINT NOT NULL CHECK (open_lot_count >= 0),
  mature_followability_count BIGINT NOT NULL CHECK (mature_followability_count >= 0),
  parity JSONB NOT NULL CHECK (
    jsonb_typeof(parity) = 'object'
    AND octet_length(parity::text) <= 4096
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  not_before TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  materialized_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (archive_segment_id, archive_revision),
  CHECK (range_end = range_start + INTERVAL '1 day'),
  CHECK ((status = 'verified') = (last_error IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_wallet_evidence_compact_days_status
  ON wallet_evidence_compact_days (status, not_before, range_start);

COMMENT ON TABLE wallet_evidence_compact_days IS
  'Shadow materialization/parity receipt for one independently verified wallet-evidence revision.';
COMMENT ON TABLE wallet_open_lot_facts IS
  'Minimal non-realized FIFO continuation state; full lot history remains reconstructible from B2 evidence.';
