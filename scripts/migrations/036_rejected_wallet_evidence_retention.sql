-- migrate:no-transaction

-- Rejected evidence has a three-day horizon, but the rejection decision lives
-- in the entry JSON. Without this partial index, an empty or mostly-retired
-- cohort repeatedly detoasts the full admitted-entry heap before maintenance
-- can prove that no rejected outcome remains.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_entry_signals_rejected_retention
  ON wallet_entry_signals (observed_at, idempotency_key)
  WHERE cohort = 'excluded-uncontrolled-flow'
     OR (
       flow_evidence @> '{"tokenRiskKnown":true}'::jsonb
       AND NOT (flow_evidence @> '{"tokenRiskPassed":true}'::jsonb)
     );
