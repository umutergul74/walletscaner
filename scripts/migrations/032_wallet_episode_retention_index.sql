-- migrate:no-transaction

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_position_episodes_retention
  ON wallet_position_episodes (
    (COALESCE(closed_at, opened_at)),
    id
  )
  WHERE status <> 'open';
