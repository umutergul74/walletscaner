import type { PoolClient } from "pg";

export interface DerivedLedgerReclaimResult {
  tradeSourcePresent: boolean;
  episodeRowsEstimate: number;
  lotRowsEstimate: number;
  episodeBytes: number;
  lotBytes: number;
  qualifiedWallets: number;
  requeuedObservedWallets: number;
}

export async function reclaimDerivedLedgerCache(
  client: PoolClient
): Promise<DerivedLedgerReclaimResult> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL max_parallel_workers_per_gather = 0");
    await client.query("SELECT pg_advisory_xact_lock(874213401)");

    // Exact COUNT(*) over the multi-million-row canonical and derived tables was
    // previously combined with the latest-score scan and exhausted the 30-second
    // production statement budget. The safety gate only needs proof that the
    // canonical source exists; relation size plus catalog estimates are telemetry.
    const relationState = await client.query<{
      trade_source_present: boolean;
      episode_rows_estimate: string;
      lot_rows_estimate: string;
      episode_bytes: string;
      lot_bytes: string;
    }>(
      `SELECT
         EXISTS (SELECT 1 FROM wallet_trade_events LIMIT 1) AS trade_source_present,
         GREATEST(episodes.reltuples, 0)::bigint::text AS episode_rows_estimate,
         GREATEST(lots.reltuples, 0)::bigint::text AS lot_rows_estimate,
         pg_total_relation_size(episodes.oid)::text AS episode_bytes,
         pg_total_relation_size(lots.oid)::text AS lot_bytes
       FROM pg_class AS episodes
       CROSS JOIN pg_class AS lots
       WHERE episodes.oid='wallet_position_episodes'::regclass
         AND lots.oid='wallet_position_lots'::regclass`
    );
    const before = relationState.rows[0];
    if (!before?.trade_source_present) {
      throw new Error("Canonical wallet trade source is empty; refusing ledger reclaim");
    }

    // Materialize the expensive latest-score projection exactly once and reuse it
    // for both the fail-closed qualified-wallet gate and the observed-wallet requeue.
    await client.query(
      `CREATE TEMP TABLE derived_reclaim_latest_scores ON COMMIT DROP AS
       SELECT DISTINCT ON (strategy_version, chain, wallet_address)
         strategy_version, chain, wallet_address, status
       FROM wallet_alpha_scores
       ORDER BY strategy_version, chain, wallet_address, calculated_at DESC`
    );
    await client.query(
      `CREATE UNIQUE INDEX derived_reclaim_latest_scores_identity
       ON derived_reclaim_latest_scores (strategy_version, chain, wallet_address)`
    );
    await client.query("ANALYZE derived_reclaim_latest_scores");

    const gate = await client.query<{ qualified_wallets: string }>(
      `SELECT COUNT(*) FILTER (
         WHERE status IN ('watch','candidate','validated-paper')
       )::text AS qualified_wallets
       FROM derived_reclaim_latest_scores`
    );
    const qualifiedWallets = Number(gate.rows[0]?.qualified_wallets ?? 0);
    if (qualifiedWallets !== 0) {
      throw new Error("Qualified wallets exist; refusing bulk derived-ledger reclaim");
    }

    await client.query("TRUNCATE TABLE wallet_position_lots, wallet_position_episodes");
    const requeued = await client.query(
      `UPDATE wallet_alpha_work_queue AS work
       SET revision = work.revision + 1,
           not_before = NOW(),
           locked_by = NULL,
           locked_at = NULL,
           lock_expires_at = NULL,
           last_error = NULL
       FROM derived_reclaim_latest_scores AS score
       WHERE score.status = 'observed'
         AND work.strategy_version = score.strategy_version
         AND work.chain = score.chain
         AND work.wallet_address = score.wallet_address`
    );
    await client.query("COMMIT");
    return {
      tradeSourcePresent: true,
      episodeRowsEstimate: Number(before.episode_rows_estimate),
      lotRowsEstimate: Number(before.lot_rows_estimate),
      episodeBytes: Number(before.episode_bytes),
      lotBytes: Number(before.lot_bytes),
      qualifiedWallets,
      requeuedObservedWallets: requeued.rowCount ?? 0,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
