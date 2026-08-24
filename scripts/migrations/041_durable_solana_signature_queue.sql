SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- WebSocket notifications must cross a durable boundary before an in-memory
-- queue can apply backpressure. A completed row is intentionally retained for
-- a short operational window so reconnect duplicates remain idempotent.
CREATE TABLE IF NOT EXISTS solana_signature_queue (
  provider TEXT NOT NULL CHECK (BTRIM(provider) <> ''),
  address TEXT NOT NULL CHECK (BTRIM(address) <> ''),
  signature TEXT NOT NULL CHECK (BTRIM(signature) <> ''),
  slot BIGINT NOT NULL CHECK (slot >= 0),
  notified_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed')),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, address, signature),
  CHECK (
    (status = 'pending' AND completed_at IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_solana_signature_queue_pending
  ON solana_signature_queue (provider, address, slot, notified_at, signature)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_solana_signature_queue_completed_retention
  ON solana_signature_queue (completed_at, provider, address, signature)
  WHERE status = 'completed';
