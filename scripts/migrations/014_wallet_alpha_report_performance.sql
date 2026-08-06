-- Wallet-alpha reports always select the newest score per wallet for one
-- strategy. Put the equality key first so PostgreSQL can avoid walking score
-- history for unrelated strategies before applying DISTINCT ON.
CREATE INDEX IF NOT EXISTS idx_wallet_alpha_scores_strategy_wallet_latest
  ON wallet_alpha_scores (
    strategy_version,
    chain,
    wallet_address,
    calculated_at DESC
  )
  INCLUDE (status, overall_score, completed_positions);
