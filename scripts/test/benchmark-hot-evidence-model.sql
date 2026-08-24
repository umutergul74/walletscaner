\set ON_ERROR_STOP on

DO $$
BEGIN
  IF current_database() !~ '_lab$' THEN
    RAISE EXCEPTION 'This storage benchmark may run only on a disposable *_lab database';
  END IF;
END
$$;

DROP SCHEMA IF EXISTS storage_benchmark CASCADE;
CREATE SCHEMA storage_benchmark;

CREATE UNLOGGED TABLE storage_benchmark.wallet_dim AS
SELECT row_number() OVER (ORDER BY chain, wallet_address)::bigint AS id,
       chain,
       wallet_address
FROM (
  SELECT chain, wallet_address FROM wallet_trade_events
  UNION
  SELECT chain, wallet_address FROM wallet_entry_signals
  UNION
  SELECT chain, wallet_address FROM wallet_position_episodes
) wallets;
CREATE UNIQUE INDEX wallet_dim_id ON storage_benchmark.wallet_dim (id);
CREATE UNIQUE INDEX wallet_dim_address ON storage_benchmark.wallet_dim (chain, wallet_address);

CREATE UNLOGGED TABLE storage_benchmark.token_dim AS
SELECT row_number() OVER (ORDER BY chain, token_address)::bigint AS id,
       chain,
       token_address
FROM (
  SELECT chain, token_address FROM wallet_trade_events
  UNION
  SELECT chain, token_address FROM wallet_entry_signals
  UNION
  SELECT chain, token_address FROM wallet_position_episodes
) tokens;
CREATE UNIQUE INDEX token_dim_id ON storage_benchmark.token_dim (id);
CREATE UNIQUE INDEX token_dim_address ON storage_benchmark.token_dim (chain, token_address);

CREATE UNLOGGED TABLE storage_benchmark.strategy_dim AS
SELECT row_number() OVER (ORDER BY strategy_version)::smallint AS id,
       strategy_version
FROM (
  SELECT strategy_version FROM wallet_trade_events
  UNION
  SELECT strategy_version FROM wallet_entry_signals
  UNION
  SELECT strategy_version FROM wallet_signal_outcomes
  UNION
  SELECT strategy_version FROM wallet_position_episodes
) strategies;
CREATE UNIQUE INDEX strategy_dim_id ON storage_benchmark.strategy_dim (id);
CREATE UNIQUE INDEX strategy_dim_version ON storage_benchmark.strategy_dim (strategy_version);

-- Closed and open episode scalars are sufficient profitability input. Full
-- realization arrays and source rows belong in the independently restored
-- evidence archive, not in the 95-day hot scorer working set.
CREATE UNLOGGED TABLE storage_benchmark.profitability_episode_fact AS
SELECT row_number() OVER (ORDER BY episode.id)::bigint AS id,
       sha256(convert_to(episode.id, 'UTF8')) AS episode_hash,
       wallet.id AS wallet_id,
       token.id AS token_id,
       strategy.id AS strategy_id,
       episode.episode_index,
       episode.status,
       episode.opened_at,
       episode.closed_at,
       episode.cost_basis_usd,
       episode.proceeds_usd,
       episode.realized_pnl_usd,
       episode.return_pct,
       episode.remaining_raw_amount,
       episode.token_decimals,
       episode.realized_lot_count,
       episode.high_quality_price_coverage,
       episode.terminal_reason
FROM wallet_position_episodes episode
JOIN storage_benchmark.wallet_dim wallet
  ON wallet.chain = episode.chain AND wallet.wallet_address = episode.wallet_address
JOIN storage_benchmark.token_dim token
  ON token.chain = episode.chain AND token.token_address = episode.token_address
JOIN storage_benchmark.strategy_dim strategy
  ON strategy.strategy_version = episode.strategy_version;
CREATE UNIQUE INDEX profitability_episode_fact_id
  ON storage_benchmark.profitability_episode_fact (id);
CREATE UNIQUE INDEX profitability_episode_fact_hash
  ON storage_benchmark.profitability_episode_fact (episode_hash);
CREATE INDEX profitability_episode_fact_wallet_time
  ON storage_benchmark.profitability_episode_fact (strategy_id, wallet_id, opened_at DESC);
CREATE INDEX profitability_episode_fact_retention
  ON storage_benchmark.profitability_episode_fact (COALESCE(closed_at, opened_at), id)
  WHERE status <> 'open';

-- Only non-realized lots are required for incremental FIFO continuation.
CREATE UNLOGGED TABLE storage_benchmark.open_lot_fact AS
SELECT sha256(convert_to(lot.id, 'UTF8')) AS lot_hash,
       episode_fact.id AS episode_id,
       lot.lot_sequence,
       lot.raw_amount,
       lot.remaining_raw_amount,
       lot.token_decimals,
       lot.quote_cost_usd,
       lot.fees_usd,
       lot.slippage_usd,
       lot.opened_at,
       lot.closed_at,
       lot.status
FROM wallet_position_lots lot
JOIN wallet_position_episodes episode ON episode.id = lot.episode_id
JOIN storage_benchmark.profitability_episode_fact episode_fact
  ON episode_fact.episode_hash = sha256(convert_to(episode.id, 'UTF8'))
WHERE lot.status <> 'realized';
CREATE UNIQUE INDEX open_lot_fact_hash ON storage_benchmark.open_lot_fact (lot_hash);
CREATE INDEX open_lot_fact_fifo
  ON storage_benchmark.open_lot_fact (episode_id, status, opened_at, lot_sequence);

-- Mature outcomes are joined once with the entry fields used by scoring and
-- model research. Provider payloads, signatures and verbose flow JSON remain
-- recoverable from the cold evidence artifact.
CREATE UNLOGGED TABLE storage_benchmark.followability_fact AS
SELECT sha256(convert_to(outcome.idempotency_key, 'UTF8')) AS outcome_hash,
       wallet.id AS wallet_id,
       token.id AS token_id,
       strategy.id AS strategy_id,
       entry.observed_at AS entry_observed_at,
       outcome.observed_at AS outcome_observed_at,
       entry.observed_entry_price_usd,
       entry.observed_liquidity_usd,
       entry.cohort,
       entry.repeat_wallet_count,
       (entry.flow_evidence->>'controlledFlow')::boolean AS controlled_flow,
       (entry.flow_evidence->>'balancedFlow')::boolean AS balanced_flow,
       (entry.flow_evidence->>'poolAgeMinutes')::numeric AS pool_age_minutes,
       (entry.flow_evidence->>'liquidityUsd')::numeric AS liquidity_usd,
       (entry.flow_evidence->>'volume5mUsd')::numeric AS volume_5m_usd,
       (entry.flow_evidence->>'volume1hUsd')::numeric AS volume_1h_usd,
       (entry.flow_evidence->>'buys5m')::integer AS buys_5m,
       (entry.flow_evidence->>'sells5m')::integer AS sells_5m,
       (entry.flow_evidence->>'swaps5m')::integer AS swaps_5m,
       (entry.flow_evidence->>'buyShare5m')::numeric AS buy_share_5m,
       (entry.flow_evidence->>'volumeLiquidityRatio')::numeric AS volume_liquidity_ratio,
       (entry.flow_evidence->>'tokenRiskKnown')::boolean AS token_risk_known,
       (entry.flow_evidence->>'tokenRiskPassed')::boolean AS token_risk_passed,
       outcome.horizon_minutes,
       outcome.status,
       outcome.outcome_price_usd,
       outcome.frozen_at,
       outcome.gross_return_pct,
       outcome.net_return_pct,
       outcome.estimated_round_trip_cost_pct,
       outcome.exit_strategy,
       outcome.rugged
FROM wallet_signal_outcomes outcome
JOIN wallet_entry_signals entry ON entry.idempotency_key = outcome.entry_idempotency_key
JOIN storage_benchmark.wallet_dim wallet
  ON wallet.chain = entry.chain AND wallet.wallet_address = entry.wallet_address
JOIN storage_benchmark.token_dim token
  ON token.chain = entry.chain AND token.token_address = entry.token_address
JOIN storage_benchmark.strategy_dim strategy
  ON strategy.strategy_version = outcome.strategy_version
WHERE outcome.status = 'mature';
CREATE UNIQUE INDEX followability_fact_hash
  ON storage_benchmark.followability_fact (outcome_hash);
CREATE INDEX followability_fact_wallet_time
  ON storage_benchmark.followability_fact (strategy_id, wallet_id, outcome_observed_at);
CREATE INDEX followability_fact_retention
  ON storage_benchmark.followability_fact (outcome_observed_at, outcome_hash);

-- Full-fidelity rows remain hot only long enough for late enrichment and
-- deterministic handoff to the compact ledger/followability facts.
CREATE UNLOGGED TABLE storage_benchmark.recent_trade_staging AS
SELECT *
FROM wallet_trade_events
WHERE observed_at >= (
  SELECT max(observed_at) - INTERVAL '3 days' FROM wallet_trade_events
);
CREATE UNIQUE INDEX recent_trade_staging_key
  ON storage_benchmark.recent_trade_staging (idempotency_key);
CREATE INDEX recent_trade_staging_wallet_time
  ON storage_benchmark.recent_trade_staging (strategy_version, wallet_address, observed_at);
CREATE INDEX recent_trade_staging_retention
  ON storage_benchmark.recent_trade_staging (observed_at, idempotency_key);

ANALYZE storage_benchmark.wallet_dim;
ANALYZE storage_benchmark.token_dim;
ANALYZE storage_benchmark.strategy_dim;
ANALYZE storage_benchmark.profitability_episode_fact;
ANALYZE storage_benchmark.open_lot_fact;
ANALYZE storage_benchmark.followability_fact;
ANALYZE storage_benchmark.recent_trade_staging;

SELECT c.relname,
       pg_total_relation_size(c.oid) AS total_bytes,
       pg_relation_size(c.oid) AS heap_bytes,
       pg_indexes_size(c.oid) AS index_bytes,
       c.reltuples::bigint AS estimated_rows
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'storage_benchmark' AND c.relkind = 'r'
ORDER BY pg_total_relation_size(c.oid) DESC;
