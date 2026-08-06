-- Bounded, revision-safe wallet-alpha work queue. A producer increments revision;
-- a worker only advances completed_revision to the revision it actually processed.
-- Events arriving during a lease therefore remain pending instead of being lost.
CREATE TABLE IF NOT EXISTS wallet_alpha_work_queue (
  chain TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  completed_revision BIGINT NOT NULL DEFAULT 0 CHECK (completed_revision >= 0),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  not_before TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  lock_expires_at TIMESTAMPTZ,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  PRIMARY KEY (chain, wallet_address, strategy_version),
  CHECK (completed_revision <= revision),
  CHECK (
    (locked_by IS NULL AND locked_at IS NULL AND lock_expires_at IS NULL)
    OR (locked_by IS NOT NULL AND locked_at IS NOT NULL AND lock_expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_wallet_alpha_work_claim
  ON wallet_alpha_work_queue (strategy_version, not_before, updated_at, wallet_address)
  INCLUDE (revision, completed_revision, lock_expires_at, attempt_count)
  WHERE revision > completed_revision;

-- Seed existing evidence once. Subsequent changes are queued transactionally by the repository.
INSERT INTO wallet_alpha_work_queue (chain, wallet_address, strategy_version)
SELECT DISTINCT chain, wallet_address, strategy_version
FROM (
  SELECT chain, wallet_address, strategy_version FROM wallet_trade_events
  UNION ALL
  SELECT chain, wallet_address, strategy_version FROM wallet_entry_signals
) evidence_wallets
WHERE wallet_address <> ''
ON CONFLICT (chain, wallet_address, strategy_version) DO NOTHING;

-- Global retention jobs must be able to walk old rows without scanning the JSON heap.
CREATE INDEX IF NOT EXISTS idx_price_observations_retention
  ON price_observations (observed_at, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_chain_event_inbox_retention
  ON chain_event_inbox ((COALESCE(processed_at, received_at)), idempotency_key)
  WHERE status IN ('processed', 'rolled_back');

CREATE INDEX IF NOT EXISTS idx_wallet_alpha_scores_retention
  ON wallet_alpha_scores (calculated_at, chain, wallet_address, strategy_version);

-- Incremental outcome loading joins outcomes back to a bounded wallet-entry set.
CREATE INDEX IF NOT EXISTS idx_wallet_signal_outcomes_entry_time
  ON wallet_signal_outcomes (entry_idempotency_key, strategy_version, observed_at);

CREATE INDEX IF NOT EXISTS idx_wallet_trade_events_latest
  ON wallet_trade_events (observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_chain_event_inbox_processed_slot
  ON chain_event_inbox (slot DESC)
  WHERE status = 'processed' AND slot IS NOT NULL;

ALTER TABLE wallet_alpha_work_queue SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_threshold = 500,
  autovacuum_analyze_threshold = 250
);
