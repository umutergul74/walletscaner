-- Future-only, exact-pool research evidence for survival and executable exit
-- quality. This migration does not emit alerts, open paper positions, or
-- authorize live execution. Provider response payloads are deliberately not
-- stored in these compact tables.

CREATE TABLE IF NOT EXISTS alpha_decision_tape_runs (
  strategy_version TEXT PRIMARY KEY,
  hypothesis_key TEXT NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'shadow' CHECK (status IN ('shadow', 'frozen', 'rejected')),
  policy JSONB NOT NULL CHECK (
    jsonb_typeof(policy) = 'object'
    AND octet_length(policy::text) <= 16384
    AND policy->>'liveExecutionEnabled' = 'false'
    AND policy->>'paperEnabled' = 'false'
    AND policy->>'telegramEnabled' = 'false'
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO alpha_decision_tape_runs (
  strategy_version, hypothesis_key, policy
)
VALUES (
  'survival-execution-tape-v1-20260830',
  'exact-pool-survival-sellability-independence',
  jsonb_build_object(
    'futureOnly', true,
    'liveExecutionEnabled', false,
    'paperEnabled', false,
    'telegramEnabled', false,
    'sourceStrategyVersion', 'evidence-v1',
    'decisionPoolAgeSeconds', 120,
    'maximumDecisionPoolAgeSeconds', 1800,
    'minimumLiquidityUsd', 5000,
    'minimumVolume5mUsd', 1000,
    'minimumTransactions5m', 5,
    'minimumRiskConfidence', 90,
    'requiredRiskScore', 0,
    'checkpointSeconds', jsonb_build_array(0, 15, 30, 60, 120, 300),
    'quoteNotionalUsdCents', jsonb_build_array(600, 2500, 10000),
    'quoteSlippageBps', 400,
    'retentionDays', 60,
    'maximumDecisionsPerUtcDay', 100,
    'maximumSeedBatch', 25,
    'maximumCheckpointClaimBatch', 2,
    'maximumCheckpointAttempts', 6,
    'promotion', jsonb_build_object(
      'minimumStableFutureDays', 7,
      'minimumDistinctMatureMarkets', 30,
      'minimumPaperDays', 14,
      'minimumProfitFactor', 1.30,
      'maximumCatastrophicLossRate', 0.03,
      'maximumRugRate', 0.03,
      'maximumBestWinnerShare', 0.30,
      'requirePositiveMedian', true,
      'requirePositiveAverageExBest', true,
      'requireExactPoolTwoWayQuotes', true,
      'requireIdentityIndependence', true,
      'requireCoverageAndFinality', true
    )
  )
)
ON CONFLICT (strategy_version) DO NOTHING;

CREATE TABLE IF NOT EXISTS alpha_decision_tape (
  id TEXT PRIMARY KEY,
  strategy_version TEXT NOT NULL
    REFERENCES alpha_decision_tape_runs(strategy_version) ON DELETE RESTRICT,
  chain TEXT NOT NULL CHECK (chain = 'solana'),
  token_address TEXT NOT NULL,
  quote_token_address TEXT,
  pool_address TEXT NOT NULL,
  dex TEXT NOT NULL,
  pool_created_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL,
  retain_until TIMESTAMPTZ NOT NULL,
  source_strategy_version TEXT NOT NULL,
  source_slot BIGINT CHECK (source_slot IS NULL OR source_slot >= 0),
  price_usd NUMERIC CHECK (price_usd IS NULL OR price_usd >= 0),
  liquidity_usd NUMERIC NOT NULL CHECK (liquidity_usd >= 0),
  volume_5m_usd NUMERIC NOT NULL CHECK (volume_5m_usd >= 0),
  buys_5m INTEGER NOT NULL CHECK (buys_5m >= 0),
  sells_5m INTEGER NOT NULL CHECK (sells_5m >= 0),
  unique_buyers_5m INTEGER NOT NULL CHECK (unique_buyers_5m >= 0),
  unique_sellers_5m INTEGER NOT NULL CHECK (unique_sellers_5m >= 0),
  creator_buys_before_decision INTEGER CHECK (
    creator_buys_before_decision IS NULL OR creator_buys_before_decision >= 0
  ),
  trade_coverage_complete BOOLEAN NOT NULL,
  coverage_status TEXT NOT NULL CHECK (coverage_status IN ('passed', 'failed', 'unknown')),
  coverage_reason TEXT NOT NULL,
  risk_status TEXT NOT NULL CHECK (risk_status IN ('passed', 'failed', 'unknown')),
  risk_score NUMERIC CHECK (risk_score IS NULL OR risk_score BETWEEN 0 AND 100),
  risk_confidence NUMERIC CHECK (risk_confidence IS NULL OR risk_confidence BETWEEN 0 AND 100),
  risk_assessed_at TIMESTAMPTZ,
  mint_authority_revoked BOOLEAN,
  freeze_authority_revoked BOOLEAN,
  top_10_holder_percent NUMERIC CHECK (
    top_10_holder_percent IS NULL OR top_10_holder_percent BETWEEN 0 AND 100
  ),
  token_program TEXT CHECK (token_program IS NULL OR token_program IN ('spl-token', 'token-2022', 'unknown')),
  token_extension_evidence_known BOOLEAN,
  blocking_token_extension_count INTEGER CHECK (
    blocking_token_extension_count IS NULL OR blocking_token_extension_count >= 0
  ),
  creator_address TEXT,
  creator_status TEXT NOT NULL CHECK (creator_status IN ('passed', 'failed', 'unknown')),
  identity_independence_status TEXT NOT NULL CHECK (
    identity_independence_status IN ('passed', 'failed', 'unknown')
  ),
  research_eligible BOOLEAN NOT NULL,
  paper_eligible BOOLEAN NOT NULL DEFAULT FALSE CHECK (paper_eligible = FALSE),
  missing_evidence TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[] CHECK (
    cardinality(missing_evidence) <= 16
    AND octet_length(array_to_string(missing_evidence, ',')) <= 2048
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (strategy_version, chain, pool_address),
  CHECK (decided_at >= pool_created_at),
  CHECK (retain_until >= decided_at + INTERVAL '30 days'),
  CHECK (risk_status <> 'passed' OR ((
    risk_score = 0
    AND risk_confidence >= 90
    AND mint_authority_revoked
    AND freeze_authority_revoked
    AND top_10_holder_percent IS NOT NULL
    AND top_10_holder_percent <= 70
    AND token_program IN ('spl-token', 'token-2022')
    AND token_extension_evidence_known
    AND blocking_token_extension_count = 0
  ) IS TRUE)),
  CHECK (creator_status <> 'passed' OR creator_address IS NOT NULL),
  CHECK (research_eligible = FALSE OR (
    coverage_status = 'passed'
    AND risk_status = 'passed'
    AND creator_status <> 'failed'
    AND liquidity_usd >= 5000
    AND volume_5m_usd >= 1000
    AND buys_5m + sells_5m >= 5
  ))
);

CREATE INDEX IF NOT EXISTS idx_alpha_decision_tape_time
  ON alpha_decision_tape (strategy_version, decided_at, id);
CREATE INDEX IF NOT EXISTS idx_alpha_decision_tape_retention
  ON alpha_decision_tape (retain_until, id);

CREATE TABLE IF NOT EXISTS alpha_decision_checkpoints (
  id BIGSERIAL PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES alpha_decision_tape(id) ON DELETE CASCADE,
  horizon_seconds INTEGER NOT NULL CHECK (horizon_seconds IN (0, 15, 30, 60, 120, 300)),
  due_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'retry', 'completed', 'dead_letter')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 6),
  available_at TIMESTAMPTZ NOT NULL,
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  lock_expires_at TIMESTAMPTZ,
  exact_pair_status TEXT CHECK (
    exact_pair_status IS NULL OR exact_pair_status IN ('live', 'liquidity-zero', 'missing', 'provider-error')
  ),
  price_usd NUMERIC CHECK (price_usd IS NULL OR price_usd >= 0),
  liquidity_usd NUMERIC CHECK (liquidity_usd IS NULL OR liquidity_usd >= 0),
  buys_5m INTEGER CHECK (buys_5m IS NULL OR buys_5m >= 0),
  sells_5m INTEGER CHECK (sells_5m IS NULL OR sells_5m >= 0),
  unique_buyers_since_decision INTEGER CHECK (
    unique_buyers_since_decision IS NULL OR unique_buyers_since_decision >= 0
  ),
  unique_sellers_since_decision INTEGER CHECK (
    unique_sellers_since_decision IS NULL OR unique_sellers_since_decision >= 0
  ),
  cluster_adjusted_buyers INTEGER CHECK (
    cluster_adjusted_buyers IS NULL OR cluster_adjusted_buyers >= 0
  ),
  identity_independence_status TEXT CHECK (
    identity_independence_status IS NULL
    OR identity_independence_status IN ('passed', 'failed', 'unknown')
  ),
  liquidity_removed BOOLEAN,
  market_observed_at TIMESTAMPTZ,
  market_provider TEXT,
  market_provider_latency_ms INTEGER CHECK (
    market_provider_latency_ms IS NULL OR market_provider_latency_ms >= 0
  ),
  completed_at TIMESTAMPTZ,
  last_error TEXT CHECK (last_error IS NULL OR octet_length(last_error) <= 1024),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (decision_id, horizon_seconds),
  CHECK (due_at >= created_at - INTERVAL '5 seconds'),
  CHECK (
    (status = 'processing' AND locked_by IS NOT NULL AND lock_expires_at IS NOT NULL)
    OR status <> 'processing'
  ),
  CHECK (
    (status IN ('completed', 'dead_letter') AND completed_at IS NOT NULL)
    OR status NOT IN ('completed', 'dead_letter')
  )
);

CREATE INDEX IF NOT EXISTS idx_alpha_decision_checkpoint_claim
  ON alpha_decision_checkpoints (available_at, due_at, id)
  WHERE status IN ('pending', 'retry');
CREATE INDEX IF NOT EXISTS idx_alpha_decision_checkpoint_expired
  ON alpha_decision_checkpoints (lock_expires_at, id)
  WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS alpha_execution_quote_evidence (
  checkpoint_id BIGINT NOT NULL
    REFERENCES alpha_decision_checkpoints(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('buy', 'sell')),
  notional_usd_cents INTEGER NOT NULL CHECK (notional_usd_cents IN (600, 2500, 10000)),
  position_source TEXT NOT NULL CHECK (position_source IN ('new-buy', 'decision-entry')),
  status TEXT NOT NULL CHECK (
    status IN ('quoted-not-filled', 'no-route', 'wrong-pool', 'stale', 'provider-error', 'not-attempted')
  ),
  input_mint TEXT NOT NULL,
  output_mint TEXT NOT NULL,
  raw_input_amount NUMERIC(78, 0) CHECK (raw_input_amount IS NULL OR raw_input_amount > 0),
  raw_expected_output_amount NUMERIC(78, 0) CHECK (
    raw_expected_output_amount IS NULL OR raw_expected_output_amount > 0
  ),
  raw_minimum_output_amount NUMERIC(78, 0) CHECK (
    raw_minimum_output_amount IS NULL OR raw_minimum_output_amount > 0
  ),
  slippage_bps INTEGER NOT NULL CHECK (slippage_bps BETWEEN 0 AND 10000),
  price_impact_percent NUMERIC CHECK (
    price_impact_percent IS NULL OR price_impact_percent BETWEEN -100 AND 100
  ),
  expected_pool_address TEXT NOT NULL,
  route_pool_address TEXT,
  route_label TEXT,
  route_router TEXT,
  provider_fee_bps INTEGER CHECK (
    provider_fee_bps IS NULL OR provider_fee_bps BETWEEN 0 AND 10000
  ),
  provider_fee_mint TEXT,
  platform_fee_raw_amount NUMERIC(78, 0) CHECK (
    platform_fee_raw_amount IS NULL OR platform_fee_raw_amount >= 0
  ),
  platform_fee_bps INTEGER CHECK (
    platform_fee_bps IS NULL OR platform_fee_bps BETWEEN 0 AND 10000
  ),
  platform_fee_mint TEXT,
  context_slot BIGINT CHECK (context_slot IS NULL OR context_slot >= 0),
  provider TEXT NOT NULL,
  provider_time_ms INTEGER CHECK (provider_time_ms IS NULL OR provider_time_ms >= 0),
  http_latency_ms INTEGER CHECK (http_latency_ms IS NULL OR http_latency_ms >= 0),
  observed_at TIMESTAMPTZ NOT NULL,
  failure_reason TEXT CHECK (failure_reason IS NULL OR octet_length(failure_reason) <= 1024),
  PRIMARY KEY (checkpoint_id, direction, notional_usd_cents),
  CHECK (
    ((status = 'quoted-not-filled'
      AND raw_input_amount IS NOT NULL
      AND raw_expected_output_amount IS NOT NULL
      AND raw_minimum_output_amount IS NOT NULL
      AND route_pool_address = expected_pool_address
      AND failure_reason IS NULL) IS TRUE)
    OR (status <> 'quoted-not-filled' AND failure_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_alpha_execution_quote_status
  ON alpha_execution_quote_evidence (status, observed_at, checkpoint_id);

COMMENT ON TABLE alpha_decision_tape IS
  'Immutable future-only exact-pool decision features; never a fill or live-capital authorization.';
COMMENT ON TABLE alpha_execution_quote_evidence IS
  'Read-only route quotes with exact-pool identity; quoted-not-filled is not transaction execution.';
