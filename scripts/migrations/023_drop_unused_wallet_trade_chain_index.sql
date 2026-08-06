-- migrate:no-transaction

-- Production wallet ledger reads filter by strategy and wallet and use
-- idx_wallet_trade_events_strategy_wallet_time. The chain-first predecessor
-- had zero scans and duplicated write/WAL cost.
DROP INDEX CONCURRENTLY IF EXISTS idx_wallet_trade_events_wallet_time;
