-- Additive, future-only collection policy. Never rewrite the v1 evidence cohort.
INSERT INTO alpha_decision_tape_runs (strategy_version, hypothesis_key, policy)
SELECT 'survival-execution-tape-v2-20260830', hypothesis_key,
       policy || jsonb_build_object(
         'maximumDecisionsPerUtcHour', 4,
         'maximumSeedBatch', 1,
         'maximumCheckpointClaimBatch', 1,
         'maximumCheckpointLatenessMs', 10000,
         'sampling', 'oldest-unseen-with-hourly-cap-not-a-census',
         'checkpointDependency', 'initial-terminal-before-later-sell')
FROM alpha_decision_tape_runs
WHERE strategy_version = 'survival-execution-tape-v1-20260830'
ON CONFLICT (strategy_version) DO NOTHING;

ALTER TABLE alpha_decision_checkpoints ADD COLUMN IF NOT EXISTS timing_status TEXT
  NOT NULL DEFAULT 'unmeasured'
  CHECK (timing_status IN ('unmeasured', 'on-time', 'late'));

-- Terminal late checkpoints retain evidence of the missed observation; no invented fill.
-- v1 rows keep unmeasured timing until explicitly collected; no historical backfill.
