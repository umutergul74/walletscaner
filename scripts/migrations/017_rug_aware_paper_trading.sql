CREATE TABLE IF NOT EXISTS paper_portfolios (
  strategy_version TEXT PRIMARY KEY,
  starting_balance_usd NUMERIC NOT NULL CHECK (starting_balance_usd > 0),
  activated_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  config JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS paper_trade_events (
  id TEXT PRIMARY KEY,
  trade_id TEXT NOT NULL REFERENCES paper_trades(id),
  strategy_version TEXT NOT NULL REFERENCES paper_portfolios(strategy_version),
  event_type TEXT NOT NULL CHECK (
    event_type IN ('opened', 'partial_exit', 'closed', 'rugged')
  ),
  quantity NUMERIC NOT NULL CHECK (quantity >= 0),
  price_usd NUMERIC NOT NULL CHECK (price_usd >= 0),
  gross_value_usd NUMERIC NOT NULL CHECK (gross_value_usd >= 0),
  fees_usd NUMERIC NOT NULL CHECK (fees_usd >= 0),
  cash_delta_usd NUMERIC NOT NULL,
  realized_pnl_usd NUMERIC NOT NULL DEFAULT 0,
  slippage_bps NUMERIC NOT NULL CHECK (slippage_bps >= 0),
  liquidity_usd NUMERIC,
  occurred_at TIMESTAMPTZ NOT NULL,
  reason TEXT NOT NULL,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_paper_trade_events_strategy_time
  ON paper_trade_events (strategy_version, occurred_at, id);

CREATE INDEX IF NOT EXISTS idx_paper_trades_strategy_open
  ON paper_trades (strategy_version, opened_at, id)
  WHERE status = 'open';

CREATE UNIQUE INDEX IF NOT EXISTS idx_paper_trades_strategy_signal
  ON paper_trades (strategy_version, signal_id);

ALTER TABLE telegram_notification_outbox
  DROP CONSTRAINT IF EXISTS telegram_notification_outbox_event_type_check;

ALTER TABLE telegram_notification_outbox
  ADD CONSTRAINT telegram_notification_outbox_event_type_check
  CHECK (event_type IN ('qualified-pool', 'status', 'paper-trade'));
