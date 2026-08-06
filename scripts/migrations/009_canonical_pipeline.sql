CREATE TABLE IF NOT EXISTS chain_event_inbox (
  idempotency_key TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  signature TEXT,
  slot BIGINT,
  transaction_index INTEGER CHECK (transaction_index IS NULL OR transaction_index >= 0),
  instruction_index INTEGER CHECK (instruction_index IS NULL OR instruction_index >= 0),
  inner_instruction_index INTEGER CHECK (
    inner_instruction_index IS NULL OR inner_instruction_index >= 0
  ),
  event_type TEXT NOT NULL,
  token_address TEXT,
  pool_address TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  commitment TEXT NOT NULL CHECK (commitment IN ('confirmed', 'finalized')),
  source TEXT NOT NULL,
  decoder_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'retry', 'processed', 'dead_letter', 'rolled_back')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  lock_expires_at TIMESTAMPTZ,
  last_error TEXT,
  payload JSONB NOT NULL,
  CHECK (
    (status = 'processing' AND locked_by IS NOT NULL AND lock_expires_at IS NOT NULL)
    OR status <> 'processing'
  )
);

CREATE INDEX IF NOT EXISTS idx_chain_event_inbox_claim
  ON chain_event_inbox (next_attempt_at, slot, received_at)
  WHERE status IN ('pending', 'retry');
CREATE INDEX IF NOT EXISTS idx_chain_event_inbox_expired_locks
  ON chain_event_inbox (lock_expires_at)
  WHERE status = 'processing';
CREATE INDEX IF NOT EXISTS idx_chain_event_inbox_slot
  ON chain_event_inbox (chain, slot, transaction_index, instruction_index)
  WHERE slot IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_chain_event_inbox_type_time
  ON chain_event_inbox (event_type, occurred_at DESC);

CREATE TABLE IF NOT EXISTS event_processing_attempts (
  id BIGSERIAL PRIMARY KEY,
  event_idempotency_key TEXT NOT NULL REFERENCES chain_event_inbox(idempotency_key) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'succeeded', 'retry', 'dead_letter')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  error TEXT,
  UNIQUE (event_idempotency_key, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_event_processing_attempts_status_time
  ON event_processing_attempts (status, started_at DESC);

CREATE TABLE IF NOT EXISTS pipeline_watermarks (
  pipeline TEXT NOT NULL,
  partition_key TEXT NOT NULL DEFAULT 'global',
  chain TEXT NOT NULL,
  last_contiguous_slot BIGINT NOT NULL CHECK (last_contiguous_slot >= 0),
  last_signature TEXT,
  status TEXT NOT NULL DEFAULT 'healthy' CHECK (
    status IN ('healthy', 'stalled', 'reconciling')
  ),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (pipeline, partition_key)
);

CREATE INDEX IF NOT EXISTS idx_pipeline_watermarks_updated
  ON pipeline_watermarks (status, updated_at);

CREATE TABLE IF NOT EXISTS quote_price_observations (
  idempotency_key TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  quote_token_address TEXT NOT NULL,
  price_usd NUMERIC NOT NULL CHECK (price_usd > 0),
  confidence_usd NUMERIC CHECK (confidence_usd IS NULL OR confidence_usd >= 0),
  source TEXT NOT NULL,
  quality TEXT NOT NULL CHECK (quality IN ('oracle-live', 'oracle-historical', 'stablecoin-peg')),
  publish_time TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  staleness_seconds INTEGER NOT NULL CHECK (staleness_seconds >= 0),
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source, quote_token_address, publish_time)
);

CREATE INDEX IF NOT EXISTS idx_quote_price_observations_lookup
  ON quote_price_observations (chain, quote_token_address, publish_time DESC);

CREATE TABLE IF NOT EXISTS wallet_position_episodes (
  id TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  episode_index INTEGER NOT NULL CHECK (episode_index >= 0),
  status TEXT NOT NULL CHECK (status IN ('open', 'realized', 'terminal_risk')),
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  cost_basis_usd NUMERIC NOT NULL DEFAULT 0 CHECK (cost_basis_usd >= 0),
  proceeds_usd NUMERIC NOT NULL DEFAULT 0 CHECK (proceeds_usd >= 0),
  realized_pnl_usd NUMERIC NOT NULL DEFAULT 0,
  return_pct NUMERIC,
  remaining_raw_amount NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (remaining_raw_amount >= 0),
  token_decimals SMALLINT NOT NULL CHECK (token_decimals BETWEEN 0 AND 30),
  realized_lot_count INTEGER NOT NULL DEFAULT 0 CHECK (realized_lot_count >= 0),
  high_quality_price_coverage NUMERIC NOT NULL DEFAULT 0 CHECK (
    high_quality_price_coverage >= 0 AND high_quality_price_coverage <= 1
  ),
  terminal_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (chain, wallet_address, token_address, strategy_version, episode_index),
  CHECK (closed_at IS NULL OR closed_at >= opened_at),
  CHECK (status = 'open' OR closed_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_wallet_position_episodes_wallet_time
  ON wallet_position_episodes (strategy_version, wallet_address, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_position_episodes_status
  ON wallet_position_episodes (strategy_version, status, opened_at);

CREATE TABLE IF NOT EXISTS wallet_position_lots (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL REFERENCES wallet_position_episodes(id) ON DELETE CASCADE,
  source_event_idempotency_key TEXT NOT NULL,
  lot_sequence INTEGER NOT NULL CHECK (lot_sequence >= 0),
  raw_amount NUMERIC(78, 0) NOT NULL CHECK (raw_amount > 0),
  remaining_raw_amount NUMERIC(78, 0) NOT NULL CHECK (
    remaining_raw_amount >= 0 AND remaining_raw_amount <= raw_amount
  ),
  token_decimals SMALLINT NOT NULL CHECK (token_decimals BETWEEN 0 AND 30),
  quote_cost_usd NUMERIC NOT NULL CHECK (quote_cost_usd >= 0),
  fees_usd NUMERIC NOT NULL DEFAULT 0 CHECK (fees_usd >= 0),
  slippage_usd NUMERIC NOT NULL DEFAULT 0 CHECK (slippage_usd >= 0),
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('open', 'partially_realized', 'realized', 'transferred')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (episode_id, source_event_idempotency_key, lot_sequence),
  CHECK (closed_at IS NULL OR closed_at >= opened_at),
  CHECK (
    (status IN ('realized', 'transferred') AND remaining_raw_amount = 0 AND closed_at IS NOT NULL)
    OR status IN ('open', 'partially_realized')
  )
);

CREATE INDEX IF NOT EXISTS idx_wallet_position_lots_fifo
  ON wallet_position_lots (episode_id, status, opened_at, lot_sequence);

CREATE TABLE IF NOT EXISTS signal_outbox (
  id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL REFERENCES wallet_alpha_signals(id) ON DELETE CASCADE,
  destination TEXT NOT NULL CHECK (destination IN ('paper', 'alert')),
  event_type TEXT NOT NULL DEFAULT 'wallet-alpha-signal' CHECK (
    event_type = 'wallet-alpha-signal'
  ),
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'processing', 'retry', 'delivered', 'dead_letter')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  lock_expires_at TIMESTAMPTZ,
  last_error TEXT,
  UNIQUE (signal_id, destination),
  CHECK (
    (status = 'processing' AND locked_by IS NOT NULL AND lock_expires_at IS NOT NULL)
    OR status <> 'processing'
  )
);

CREATE INDEX IF NOT EXISTS idx_signal_outbox_claim
  ON signal_outbox (destination, available_at, created_at)
  WHERE status IN ('pending', 'retry');
CREATE INDEX IF NOT EXISTS idx_signal_outbox_expired_locks
  ON signal_outbox (lock_expires_at)
  WHERE status = 'processing';

-- Paper fills can originate from either legacy signals or wallet-alpha signals. PostgreSQL cannot
-- express that polymorphic relationship as one foreign key, so integrity is enforced by the
-- transactional outbox consumer and the signal_id index instead.
ALTER TABLE paper_trades
  DROP CONSTRAINT IF EXISTS paper_trades_signal_id_fkey;
CREATE INDEX IF NOT EXISTS idx_paper_trades_signal_id
  ON paper_trades (signal_id, opened_at DESC);

ALTER TABLE wallet_trade_events
  DROP CONSTRAINT IF EXISTS wallet_trade_events_data_quality_check;
ALTER TABLE wallet_trade_events
  ADD CONSTRAINT wallet_trade_events_data_quality_check CHECK (
    data_quality IN (
      'observed-execution',
      'oracle-converted',
      'market-proxy',
      'historical-estimate',
      'observed-balance',
      'price-proxy',
      'historical-observed'
    )
  );
