SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Priority 2 is a latency/SLO lane, not a synonym for every risk-passed
-- research entry. Preserve every revision and all evidence while moving an
-- entry to the signal lane only when the wallet's latest persisted score can
-- actually emit a paper signal.
WITH classified AS MATERIALIZED (
  SELECT
    work.chain,
    work.wallet_address,
    work.strategy_version,
    COALESCE((
      SELECT score.status
      FROM wallet_alpha_scores score
      WHERE score.chain = work.chain
        AND score.wallet_address = work.wallet_address
        AND score.strategy_version = work.strategy_version
      ORDER BY score.calculated_at DESC
      LIMIT 1
    ), '') AS latest_status
  FROM wallet_alpha_work_queue work
  WHERE work.revision > work.completed_revision
    AND work.priority = 2
    AND work.priority_reason = 'risk-passed-source-entry'
)
UPDATE wallet_alpha_work_queue work
SET
  priority = CASE
    WHEN classified.latest_status IN ('watch', 'candidate', 'validated-paper') THEN 2
    ELSE 1
  END,
  priority_reason = CASE
    WHEN classified.latest_status IN ('watch', 'candidate', 'validated-paper')
      THEN 'risk-passed-qualified-wallet-entry'
    ELSE 'risk-passed-unqualified-wallet-entry'
  END
FROM classified
WHERE work.chain = classified.chain
  AND work.wallet_address = classified.wallet_address
  AND work.strategy_version = classified.strategy_version;

COMMENT ON COLUMN wallet_alpha_work_queue.priority IS
  '0=historical/background, 1=score-changing research, 2=risk-passed entry from a latest watch/candidate/validated-paper wallet.';
