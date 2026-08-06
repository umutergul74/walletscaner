-- Two evidence tables were applied historically under migration filenames that are no longer
-- present in the repository. Re-declare the schema idempotently so a fresh database and the
-- existing production database converge without rewriting either table.
CREATE TABLE IF NOT EXISTS outcome_resolution_attempts (
  entry_idempotency_key TEXT PRIMARY KEY,
  strategy_version TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL,
  last_status TEXT NOT NULL CHECK (
    last_status IN ('mature', 'provisional', 'unresolved')
  ),
  last_reason TEXT NOT NULL,
  signature TEXT NOT NULL,
  slot BIGINT NOT NULL DEFAULT 0,
  provider TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  idempotency_key TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_outcome_resolution_idempotency
  ON outcome_resolution_attempts (idempotency_key);
CREATE INDEX IF NOT EXISTS idx_outcome_resolution_due
  ON outcome_resolution_attempts (strategy_version, next_attempt_at);

CREATE TABLE IF NOT EXISTS pipeline_health_snapshots (
  idempotency_key TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  chain TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'degraded', 'down')),
  diagnostics JSONB NOT NULL DEFAULT '{}'::jsonb,
  signature TEXT NOT NULL,
  slot BIGINT NOT NULL DEFAULT 0,
  provider TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  strategy_version TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pipeline_health_service_time
  ON pipeline_health_snapshots (service, observed_at DESC);
