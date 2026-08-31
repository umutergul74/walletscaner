-- Transaction-safe, additive FIFO continuation foundation.
--
-- This migration does not redirect a production reader, rewrite canonical evidence or seed from
-- wallet_trade_events. Missing state deliberately means "full rebuild required" to avoid a large
-- migration-time scan and to preserve fail-closed semantics.

-- Exact token quantity is an accounting boundary. These nullable columns are metadata-only on
-- upgrade (no DEFAULT/table rewrite). Historical rows remain explicitly unknown until a verified
-- replay supplies both values; the NOT VALID constraint still checks every new/updated row.
ALTER TABLE wallet_trade_events
  ADD COLUMN IF NOT EXISTS base_raw_amount NUMERIC(78, 0),
  ADD COLUMN IF NOT EXISTS base_token_decimals SMALLINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'wallet_trade_events'::regclass
      AND conname = 'wallet_trade_events_exact_base_quantity_check'
  ) THEN
    ALTER TABLE wallet_trade_events
      ADD CONSTRAINT wallet_trade_events_exact_base_quantity_check CHECK (
        (base_raw_amount IS NULL AND base_token_decimals IS NULL)
        OR
        (base_raw_amount > 0 AND base_token_decimals BETWEEN 0 AND 30)
      ) NOT VALID;
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS wallet_trade_revisions (
  chain TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  dirty_order_known BOOLEAN NOT NULL DEFAULT FALSE,
  dirty_min_slot BIGINT,
  dirty_min_observed_at TIMESTAMPTZ,
  dirty_min_signature TEXT,
  dirty_min_idempotency_key TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain, wallet_address, strategy_version),
  CHECK (
    (dirty_order_known AND dirty_min_slot IS NOT NULL
      AND dirty_min_observed_at IS NOT NULL AND dirty_min_signature IS NOT NULL
      AND dirty_min_idempotency_key IS NOT NULL)
    OR
    (NOT dirty_order_known AND dirty_min_slot IS NULL
      AND dirty_min_observed_at IS NULL AND dirty_min_signature IS NULL
      AND dirty_min_idempotency_key IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_wallet_trade_revisions_dirty
  ON wallet_trade_revisions (strategy_version, updated_at, wallet_address)
  WHERE dirty_order_known;

CREATE TABLE IF NOT EXISTS wallet_fifo_continuations (
  chain TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  checkpoint_version TEXT NOT NULL CHECK (checkpoint_version = 'fifo-continuation-v1'),
  checkpoint_payload TEXT NOT NULL CHECK (
    octet_length(checkpoint_payload) > 0
    AND octet_length(checkpoint_payload) <= 4194304
  ),
  checkpoint_sha256 BYTEA NOT NULL CHECK (octet_length(checkpoint_sha256) = 32),
  trade_revision BIGINT NOT NULL CHECK (trade_revision >= 0),
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
  last_slot BIGINT NOT NULL,
  last_observed_at TIMESTAMPTZ NOT NULL,
  last_signature TEXT NOT NULL,
  last_idempotency_key TEXT NOT NULL,
  calculated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain, wallet_address, strategy_version),
  CHECK (checkpoint_sha256 = digest(checkpoint_payload, 'sha256'))
);

CREATE INDEX IF NOT EXISTS idx_wallet_fifo_continuations_age
  ON wallet_fifo_continuations (strategy_version, calculated_at, wallet_address);

CREATE TABLE IF NOT EXISTS wallet_fifo_realization_facts (
  realization_id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  chain TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  round_trip_index INTEGER NOT NULL CHECK (round_trip_index > 0),
  sell_event_idempotency_key TEXT NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ NOT NULL CHECK (closed_at >= opened_at),
  realized_raw_amount NUMERIC(78, 0) NOT NULL CHECK (realized_raw_amount > 0),
  remaining_raw_amount NUMERIC(78, 0) NOT NULL CHECK (remaining_raw_amount >= 0),
  token_decimals SMALLINT NOT NULL CHECK (token_decimals BETWEEN 0 AND 30),
  invested_usd NUMERIC NOT NULL CHECK (invested_usd > 0),
  proceeds_usd NUMERIC NOT NULL CHECK (proceeds_usd >= 0),
  net_pnl_usd NUMERIC NOT NULL,
  net_return_pct NUMERIC NOT NULL,
  high_quality BOOLEAN NOT NULL,
  price_quality TEXT NOT NULL CHECK (
    price_quality IN (
      'observed-execution', 'oracle-converted', 'market-proxy', 'historical-estimate'
    )
  ),
  exact BOOLEAN NOT NULL,
  source_trade_revision BIGINT NOT NULL CHECK (source_trade_revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (episode_id, sell_event_idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_wallet_fifo_realization_facts_wallet_time
  ON wallet_fifo_realization_facts (
    strategy_version, chain, wallet_address, closed_at, realization_id
  );

-- Called once per affected wallet by the same statement/transaction that changes canonical trade
-- evidence. It increments the revision and retains the oldest unprocessed order boundary. Text
-- tie-breakers use the C collation so their ordering is stable across database locales.
CREATE OR REPLACE FUNCTION record_wallet_trade_revision(
  p_chain TEXT,
  p_wallet_address TEXT,
  p_strategy_version TEXT,
  p_slot BIGINT,
  p_observed_at TIMESTAMPTZ,
  p_signature TEXT,
  p_idempotency_key TEXT
) RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  next_revision BIGINT;
BEGIN
  IF p_chain IS NULL OR btrim(p_chain) = ''
     OR p_wallet_address IS NULL OR btrim(p_wallet_address) = ''
     OR p_strategy_version IS NULL OR btrim(p_strategy_version) = ''
     OR p_slot IS NULL OR p_observed_at IS NULL
     OR p_signature IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'wallet trade revision requires a complete scope and order';
  END IF;

  INSERT INTO wallet_trade_revisions (
    chain, wallet_address, strategy_version, revision, dirty_order_known,
    dirty_min_slot, dirty_min_observed_at, dirty_min_signature,
    dirty_min_idempotency_key, updated_at
  ) VALUES (
    p_chain, p_wallet_address, p_strategy_version, 1, TRUE,
    p_slot, p_observed_at, p_signature, p_idempotency_key, NOW()
  )
  ON CONFLICT (chain, wallet_address, strategy_version) DO UPDATE SET
    revision = wallet_trade_revisions.revision + 1,
    dirty_order_known = TRUE,
    dirty_min_slot = CASE WHEN NOT wallet_trade_revisions.dirty_order_known OR
      ROW(
        EXCLUDED.dirty_min_slot,
        EXCLUDED.dirty_min_observed_at,
        EXCLUDED.dirty_min_signature COLLATE "C",
        EXCLUDED.dirty_min_idempotency_key COLLATE "C"
      ) < ROW(
        wallet_trade_revisions.dirty_min_slot,
        wallet_trade_revisions.dirty_min_observed_at,
        wallet_trade_revisions.dirty_min_signature COLLATE "C",
        wallet_trade_revisions.dirty_min_idempotency_key COLLATE "C"
      ) THEN EXCLUDED.dirty_min_slot ELSE wallet_trade_revisions.dirty_min_slot END,
    dirty_min_observed_at = CASE WHEN NOT wallet_trade_revisions.dirty_order_known OR
      ROW(
        EXCLUDED.dirty_min_slot,
        EXCLUDED.dirty_min_observed_at,
        EXCLUDED.dirty_min_signature COLLATE "C",
        EXCLUDED.dirty_min_idempotency_key COLLATE "C"
      ) < ROW(
        wallet_trade_revisions.dirty_min_slot,
        wallet_trade_revisions.dirty_min_observed_at,
        wallet_trade_revisions.dirty_min_signature COLLATE "C",
        wallet_trade_revisions.dirty_min_idempotency_key COLLATE "C"
      ) THEN EXCLUDED.dirty_min_observed_at
      ELSE wallet_trade_revisions.dirty_min_observed_at END,
    dirty_min_signature = CASE WHEN NOT wallet_trade_revisions.dirty_order_known OR
      ROW(
        EXCLUDED.dirty_min_slot,
        EXCLUDED.dirty_min_observed_at,
        EXCLUDED.dirty_min_signature COLLATE "C",
        EXCLUDED.dirty_min_idempotency_key COLLATE "C"
      ) < ROW(
        wallet_trade_revisions.dirty_min_slot,
        wallet_trade_revisions.dirty_min_observed_at,
        wallet_trade_revisions.dirty_min_signature COLLATE "C",
        wallet_trade_revisions.dirty_min_idempotency_key COLLATE "C"
      ) THEN EXCLUDED.dirty_min_signature ELSE wallet_trade_revisions.dirty_min_signature END,
    dirty_min_idempotency_key = CASE WHEN NOT wallet_trade_revisions.dirty_order_known OR
      ROW(
        EXCLUDED.dirty_min_slot,
        EXCLUDED.dirty_min_observed_at,
        EXCLUDED.dirty_min_signature COLLATE "C",
        EXCLUDED.dirty_min_idempotency_key COLLATE "C"
      ) < ROW(
        wallet_trade_revisions.dirty_min_slot,
        wallet_trade_revisions.dirty_min_observed_at,
        wallet_trade_revisions.dirty_min_signature COLLATE "C",
        wallet_trade_revisions.dirty_min_idempotency_key COLLATE "C"
      ) THEN EXCLUDED.dirty_min_idempotency_key
      ELSE wallet_trade_revisions.dirty_min_idempotency_key END,
    updated_at = NOW()
  RETURNING revision INTO next_revision;

  RETURN next_revision;
END;
$$;

-- The caller must write realization/open-state deltas in the same transaction and roll back when
-- this returns FALSE. Clearing dirty state and replacing the checkpoint are one atomic CAS.
CREATE OR REPLACE FUNCTION commit_wallet_fifo_continuation(
  p_chain TEXT,
  p_wallet_address TEXT,
  p_strategy_version TEXT,
  p_expected_revision BIGINT,
  p_checkpoint_version TEXT,
  p_checkpoint_payload TEXT,
  p_checkpoint_sha256 BYTEA,
  p_last_slot BIGINT,
  p_last_observed_at TIMESTAMPTZ,
  p_last_signature TEXT,
  p_last_idempotency_key TEXT,
  p_calculated_at TIMESTAMPTZ
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  current_revision BIGINT;
BEGIN
  IF p_expected_revision < 0 THEN
    RAISE EXCEPTION 'wallet FIFO continuation revision cannot be negative';
  END IF;

  INSERT INTO wallet_trade_revisions (
    chain, wallet_address, strategy_version, revision, dirty_order_known, updated_at
  ) VALUES (
    p_chain, p_wallet_address, p_strategy_version, 0, FALSE, NOW()
  )
  ON CONFLICT (chain, wallet_address, strategy_version) DO NOTHING;

  SELECT revision INTO current_revision
  FROM wallet_trade_revisions
  WHERE chain = p_chain
    AND wallet_address = p_wallet_address
    AND strategy_version = p_strategy_version
  FOR UPDATE;

  IF current_revision IS DISTINCT FROM p_expected_revision THEN
    RETURN FALSE;
  END IF;

  INSERT INTO wallet_fifo_continuations (
    chain, wallet_address, strategy_version, checkpoint_version,
    checkpoint_payload, checkpoint_sha256, trade_revision, generation,
    last_slot, last_observed_at, last_signature, last_idempotency_key,
    calculated_at, created_at, updated_at
  ) VALUES (
    p_chain, p_wallet_address, p_strategy_version, p_checkpoint_version,
    p_checkpoint_payload, p_checkpoint_sha256, p_expected_revision, 1,
    p_last_slot, p_last_observed_at, p_last_signature, p_last_idempotency_key,
    p_calculated_at, NOW(), NOW()
  )
  ON CONFLICT (chain, wallet_address, strategy_version) DO UPDATE SET
    checkpoint_version = EXCLUDED.checkpoint_version,
    checkpoint_payload = EXCLUDED.checkpoint_payload,
    checkpoint_sha256 = EXCLUDED.checkpoint_sha256,
    trade_revision = EXCLUDED.trade_revision,
    generation = wallet_fifo_continuations.generation + 1,
    last_slot = EXCLUDED.last_slot,
    last_observed_at = EXCLUDED.last_observed_at,
    last_signature = EXCLUDED.last_signature,
    last_idempotency_key = EXCLUDED.last_idempotency_key,
    calculated_at = EXCLUDED.calculated_at,
    updated_at = NOW();

  UPDATE wallet_trade_revisions
  SET dirty_order_known = FALSE,
      dirty_min_slot = NULL,
      dirty_min_observed_at = NULL,
      dirty_min_signature = NULL,
      dirty_min_idempotency_key = NULL,
      updated_at = NOW()
  WHERE chain = p_chain
    AND wallet_address = p_wallet_address
    AND strategy_version = p_strategy_version
    AND revision = p_expected_revision;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'wallet FIFO continuation CAS changed while locked';
  END IF;
  RETURN TRUE;
END;
$$;

COMMENT ON TABLE wallet_trade_revisions IS
  'Per-wallet source revision and oldest dirty order used by FIFO continuation CAS.';
COMMENT ON TABLE wallet_fifo_continuations IS
  'Bounded integrity-checked FIFO state; not archive proof or source-retirement permission.';
COMMENT ON TABLE wallet_fifo_realization_facts IS
  'Durable per-partial-sale profitability facts for scorer parity without full trade replay.';
COMMENT ON COLUMN wallet_trade_events.base_raw_amount IS
  'Exact raw base-token quantity when proven by canonical balance/instruction evidence.';
COMMENT ON COLUMN wallet_trade_events.base_token_decimals IS
  'Decimals paired with base_raw_amount; NULL means exact quantity is not yet proven.';
