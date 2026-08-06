-- Creator exclusion only needs the non-empty address set, not full token JSON rows.
CREATE INDEX IF NOT EXISTS idx_tokens_creator_address_known
  ON tokens (creator_address)
  WHERE creator_address IS NOT NULL AND creator_address <> '';

-- First-entry materialization selects the earliest still-linkable swap for each
-- wallet/token/strategy tuple.
CREATE INDEX IF NOT EXISTS idx_swaps_wallet_token_first_entry
  ON swaps (
    output_token_address,
    chain,
    trader_address,
    strategy_version,
    observed_at
  )
  INCLUDE (id)
  WHERE output_token_address IS NOT NULL;
