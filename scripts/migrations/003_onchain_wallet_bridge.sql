ALTER TABLE swaps
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS strategy_version TEXT NOT NULL DEFAULT 'legacy-v0';

ALTER TABLE wallet_entry_signals
  ADD COLUMN IF NOT EXISTS source_swap_idempotency_key TEXT
    REFERENCES swaps(idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_entries_source_swap
  ON wallet_entry_signals (source_swap_idempotency_key)
  WHERE source_swap_idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_swaps_pending_wallet_entry
  ON swaps (chain, output_token_address, observed_at)
  WHERE output_token_address IS NOT NULL;
