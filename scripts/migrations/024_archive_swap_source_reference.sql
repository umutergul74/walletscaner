-- The live swaps table is a bounded first-entry bridge. Once an entry copies
-- the immutable source id and flow evidence, the hot bridge row may age out;
-- canonical inbox payloads and verified backups remain the raw recovery path.
SET LOCAL lock_timeout = '5s';

ALTER TABLE wallet_entry_signals
  DROP CONSTRAINT IF EXISTS wallet_entry_signals_source_swap_idempotency_key_fkey;
