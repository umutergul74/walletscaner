SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Existing evidence is not relabelled. Only events explicitly written by the
-- new producer cross this future-only gate.
ALTER TABLE chain_event_inbox
  ADD COLUMN IF NOT EXISTS finality_required BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS solana_transaction_finality (
  chain TEXT NOT NULL CHECK (chain = 'solana'),
  signature TEXT NOT NULL CHECK (BTRIM(signature) <> ''),
  slot BIGINT NOT NULL CHECK (slot >= 0),
  first_seen_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'finalized', 'failed', 'unresolved')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_checked_at TIMESTAMPTZ,
  finalized_at TIMESTAMPTZ,
  confirmation_status TEXT CHECK (
    confirmation_status IS NULL
    OR confirmation_status IN ('processed', 'confirmed', 'finalized')
  ),
  root_slot BIGINT CHECK (root_slot IS NULL OR root_slot >= 0),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain, signature),
  CHECK (status <> 'finalized' OR finalized_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_solana_transaction_finality_pending
  ON solana_transaction_finality (slot, first_seen_at, signature)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_solana_transaction_finality_retention
  ON solana_transaction_finality (updated_at, signature)
  WHERE status <> 'pending';

CREATE INDEX IF NOT EXISTS idx_chain_event_inbox_finality_pending
  ON chain_event_inbox (received_at, signature)
  WHERE finality_required = TRUE
    AND commitment = 'confirmed'
    AND status IN ('pending', 'retry');
