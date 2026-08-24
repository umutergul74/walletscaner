ALTER TABLE telegram_notification_outbox
  DROP CONSTRAINT IF EXISTS telegram_notification_outbox_status_check;

ALTER TABLE telegram_notification_outbox
  ADD CONSTRAINT telegram_notification_outbox_status_check CHECK (
    status IN (
      'pending', 'processing', 'retry', 'delivered', 'dead_letter', 'suppressed', 'shadow'
    )
  ) NOT VALID;

ALTER TABLE telegram_notification_outbox
  VALIDATE CONSTRAINT telegram_notification_outbox_status_check;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM paper_trades
    WHERE strategy_version = 'qualified-pool-paper-v3-strict-flow'
      AND status = 'open'
  ) THEN
    RAISE EXCEPTION
      'Cannot pause qualified-pool-paper-v3-strict-flow while an open position exists';
  END IF;
END
$$;

UPDATE paper_portfolios
SET status = 'paused', updated_at = NOW()
WHERE strategy_version = 'qualified-pool-paper-v3-strict-flow'
  AND status <> 'paused';

INSERT INTO hypothesis_runs (
  idempotency_key, run_id, chain, hypothesis_key, cohort, verdict,
  signal_keys, metrics, decision_reason, signature, slot, provider,
  observed_at, strategy_version
)
VALUES (
  'hypothesis:token-alpha-v4-causal-shadow-future-freeze',
  'token-alpha-v4-causal-shadow-future-freeze',
  'solana',
  'token-alpha-causal-wallet-support',
  'strict-flow-v4-causal-shadow-20260822',
  'watch',
  '[]'::jsonb,
  jsonb_build_object(
    'paperEnabled', false,
    'telegramEnabled', false,
    'liveExecutionEnabled', false,
    'parentQualificationVersion', 'strict-flow-v2-20260817',
    'supporterLookbackMinutes', 10,
    'modeledRoundTripCostPct', 7.1,
    'safe3', jsonb_build_object(
      'minimumSamples', 3,
      'minimumMedianReturnPctExclusive', 0,
      'maximumCatastrophicLossRate', 0,
      'maximumRuggedOutcomeRate', 0
    ),
    'safe6', jsonb_build_object(
      'minimumSamples', 6,
      'minimumMedianReturnPctExclusive', 0,
      'minimumHitRate', 0.55,
      'minimumProfitFactor', 1.2,
      'maximumCatastrophicLossRate', 0.05,
      'maximumRuggedOutcomeRate', 0.05,
      'minimumWorstReturnPct', -35
    ),
    'promotion', jsonb_build_object(
      'minimumCompleteUtcDays', 7,
      'minimumDistinctMarkets', 30,
      'minimumHitRate', 0.60,
      'minimumProfitFactor', 1.2,
      'maximumCatastrophicLossRate', 0.05,
      'maximumRuggedOutcomeRate', 0.05,
      'minimumWorstReturnPct', -35,
      'maximumBestWinnerShare', 0.40,
      'requirePositiveMedian', true,
      'requirePositiveAverageExBest', true,
      'requireExactPoolFillReplay', true,
      'requireCreatorFunderIndependence', true
    )
  ),
  'V3 lost 14.1623381901 USD across three opened positions; the causal audit found no candidate that passed train and validation. Freeze V3 and collect future-only shadow evidence without Telegram or paper entry.',
  'derived:token-alpha-v4-causal-shadow-future-freeze',
  COALESCE((SELECT MAX(slot) FROM wallet_trade_events), 0),
  'token-alpha-v4-audit',
  NOW(),
  'strict-flow-v4-causal-shadow-20260822'
)
ON CONFLICT (idempotency_key) DO NOTHING;
