SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Supersession is decided once, when a newer score is persisted. Keeping that
-- fact in a narrow side table makes seven-day retention independent of an
-- increasingly expensive self-probe over the JSON-heavy score history.
CREATE TABLE IF NOT EXISTS wallet_alpha_score_supersessions (
  chain TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  calculated_at TIMESTAMPTZ NOT NULL,
  superseded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (chain, wallet_address, strategy_version, calculated_at),
  CONSTRAINT wallet_alpha_score_supersessions_score_fkey
    FOREIGN KEY (chain, wallet_address, strategy_version, calculated_at)
    REFERENCES wallet_alpha_scores (
      chain, wallet_address, strategy_version, calculated_at
    )
    ON DELETE CASCADE
);

-- The one-time backfill reads only the score primary-key columns. The existing
-- latest-per-wallet index supplies this order without detoasting score JSON.
-- LAG identifies the exact next-newer score that superseded each historical row.
WITH ranked AS (
  SELECT
    score.chain,
    score.wallet_address,
    score.strategy_version,
    score.calculated_at,
    LAG(score.calculated_at) OVER (
      PARTITION BY score.chain, score.wallet_address, score.strategy_version
      ORDER BY score.calculated_at DESC
    ) AS superseded_at
  FROM wallet_alpha_scores AS score
)
INSERT INTO wallet_alpha_score_supersessions (
  chain, wallet_address, strategy_version, calculated_at, superseded_at
)
SELECT
  ranked.chain,
  ranked.wallet_address,
  ranked.strategy_version,
  ranked.calculated_at,
  ranked.superseded_at
FROM ranked
WHERE ranked.superseded_at IS NOT NULL
ON CONFLICT (chain, wallet_address, strategy_version, calculated_at) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_wallet_alpha_score_supersessions_retention
  ON wallet_alpha_score_supersessions (
    calculated_at, chain, wallet_address, strategy_version
  );
