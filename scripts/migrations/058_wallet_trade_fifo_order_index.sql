-- migrate:no-transaction

-- FIFO continuation reads use Solana slot as their primary deterministic order. The older
-- strategy/wallet/observed_at index forces an append probe to revisit every historical trade for
-- an active wallet before it can find a handful of rows after the checkpoint.
--
-- Keep the index prefix compact: signature and idempotency_key are only same-slot/time
-- tie-breakers, so callers use this prefix to seek to the checkpoint and retain the complete
-- four-column C-collated predicate for exact correctness.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_trade_events_fifo_order_prefix
  ON wallet_trade_events (
    chain,
    wallet_address,
    strategy_version,
    slot,
    observed_at
  );
