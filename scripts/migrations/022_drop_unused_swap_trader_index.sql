-- migrate:no-transaction

-- This legacy index had zero production scans. First-entry reads use
-- idx_swaps_wallet_token_first_entry and the token-time indexes instead.
DROP INDEX CONCURRENTLY IF EXISTS idx_swaps_trader_time;
