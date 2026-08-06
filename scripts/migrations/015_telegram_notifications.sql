ALTER TABLE pools
  ADD COLUMN IF NOT EXISTS token_symbol TEXT,
  ADD COLUMN IF NOT EXISTS token_name TEXT,
  ADD COLUMN IF NOT EXISTS volume_5m_usd NUMERIC,
  ADD COLUMN IF NOT EXISTS price_usd NUMERIC,
  ADD COLUMN IF NOT EXISTS market_cap_usd NUMERIC;

CREATE TABLE IF NOT EXISTS telegram_notification_outbox (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('qualified-pool', 'status')),
  source_key TEXT NOT NULL,
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
  UNIQUE (event_type, source_key),
  CHECK (
    (status = 'processing' AND locked_by IS NOT NULL AND lock_expires_at IS NOT NULL)
    OR status <> 'processing'
  )
);

CREATE INDEX IF NOT EXISTS idx_telegram_notification_outbox_claim
  ON telegram_notification_outbox (available_at, created_at)
  WHERE status IN ('pending', 'retry');

CREATE INDEX IF NOT EXISTS idx_telegram_notification_outbox_expired_locks
  ON telegram_notification_outbox (lock_expires_at)
  WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS telegram_notification_state (
  state_key TEXT PRIMARY KEY,
  state_value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
