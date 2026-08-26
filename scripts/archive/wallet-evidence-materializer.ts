import "dotenv/config";
import { mkdir, rename, writeFile } from "node:fs/promises";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for wallet evidence materialization");

const maxDaysPerRun = positiveInt(process.env.WALLET_EVIDENCE_MATERIALIZER_MAX_DAYS_PER_RUN, 1);
const maxRunSeconds = positiveInt(process.env.WALLET_EVIDENCE_MATERIALIZER_MAX_RUN_SECONDS, 1_800);
const statementTimeoutMs = positiveInt(
  process.env.WALLET_EVIDENCE_MATERIALIZER_STATEMENT_TIMEOUT_MS,
  600_000
);
const reportPath = "reports/wallet-evidence-materializer-latest.json";
async function main() {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const startedAt = Date.now();
  let processed = 0;
  let verified = 0;
  let failed = 0;
  const days: Array<Record<string, unknown>> = [];

  try {
    const client = await pool.connect();
    try {
      const lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
        ["wallet-evidence-compact-shadow"]
      );
      if (!lock.rows[0]?.locked) {
        console.log(
          JSON.stringify({ type: "wallet-evidence-materializer", status: "skipped-lock" })
        );
        return;
      }

      while (processed < maxDaysPerRun && Date.now() - startedAt < maxRunSeconds * 1_000) {
        const candidate = await client.query<ArchiveCandidate>(
          `WITH oldest_unmaterialized AS (
             SELECT segment.id::text, segment.revision, segment.range_start,
                    segment.range_end, segment.record_type_counts,
                    compact.range_start AS compact_range_start,
                    compact.archive_segment_id AS compact_segment_id,
                    compact.archive_revision AS compact_revision,
                    compact.not_before AS compact_not_before
             FROM archive_segments AS segment
             LEFT JOIN wallet_evidence_compact_days AS compact
               ON compact.range_start = segment.range_start
             WHERE segment.source_kind = 'wallet-evidence'
               AND segment.status = 'verified'
               AND segment.canonical_metadata_row_count = segment.source_row_count
               AND segment.record_type_counts IS NOT NULL
               AND (compact.range_start IS NULL
                    OR compact.archive_segment_id <> segment.id
                    OR compact.archive_revision <> segment.revision
                    OR compact.status <> 'verified')
             ORDER BY segment.range_start
             LIMIT 1
           )
           SELECT id, revision, range_start, range_end, record_type_counts
           FROM oldest_unmaterialized
           WHERE compact_range_start IS NULL
              OR compact_segment_id <> id::bigint
              OR compact_revision <> revision
              OR compact_not_before <= NOW()`
        );
        const segment = candidate.rows[0];
        if (!segment) break;
        processed += 1;
        try {
          const receipt = await materializeDay(client, segment);
          verified += 1;
          days.push(receipt);
        } catch (error) {
          failed += 1;
          const message = errorMessage(error);
          const disposition =
            error instanceof CompactMaterializationError ? error.disposition : "retry";
          days.push({
            rangeStart: segment.range_start.toISOString(),
            revision: segment.revision,
            status: disposition,
            error: message
          });
          await recordFailure(client, segment, disposition, message);
          break;
        }
      }
    } finally {
      await client
        .query("SELECT pg_advisory_unlock(hashtext($1))", ["wallet-evidence-compact-shadow"])
        .catch(() => undefined);
      client.release();
    }

    const report = {
      type: "wallet-evidence-materializer",
      status: failed > 0 ? "degraded" : "completed",
      checkedAt: new Date().toISOString(),
      processed,
      verified,
      failed,
      elapsedMs: Date.now() - startedAt,
      days
    };
    await mkdir("reports", { recursive: true });
    await writeFile(`${reportPath}.tmp`, JSON.stringify(report, null, 2));
    await rename(`${reportPath}.tmp`, reportPath);
    console.log(JSON.stringify(report));
    if (failed > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

interface ArchiveCandidate {
  id: string;
  revision: number;
  range_start: Date;
  range_end: Date;
  record_type_counts: Record<string, number>;
}

interface Aggregate {
  rows: number;
  digest0: string;
  digest1: string;
}

type CompactFailureDisposition = "mismatch" | "retry";

class CompactMaterializationError extends Error {
  constructor(
    readonly phase: string,
    readonly disposition: CompactFailureDisposition,
    message: string,
    options?: ErrorOptions
  ) {
    super(`${phase}: ${message}`, options);
    this.name = "CompactMaterializationError";
  }
}

async function materializeDay(
  client: pg.PoolClient,
  segment: ArchiveCandidate
): Promise<Record<string, unknown>> {
  const start = segment.range_start.toISOString();
  const end = segment.range_end.toISOString();
  const phaseDurationsMs: Record<string, number> = {};
  const phase = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    const phaseStartedAt = Date.now();
    try {
      return await operation();
    } catch (error) {
      if (error instanceof CompactMaterializationError) throw error;
      throw new CompactMaterializationError(name, "retry", errorMessage(error), { cause: error });
    } finally {
      phaseDurationsMs[name] = Date.now() - phaseStartedAt;
    }
  };
  // Every compact table and its parity proof must describe one source-ledger version.
  // Wallet alpha replaces episode/lot snapshots concurrently, so READ COMMITTED can
  // otherwise observe a newer child lot after the parent-fact statement has finished.
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    await client.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
    const current = await phase("lock-segment", () =>
      client.query<ArchiveCandidate>(
        `SELECT id::text, revision, range_start, range_end, record_type_counts
         FROM archive_segments
         WHERE id=$1 AND revision=$2 AND source_kind='wallet-evidence' AND status='verified'
         FOR SHARE`,
        [segment.id, segment.revision]
      )
    );
    if (!current.rows[0]) {
      throw new CompactMaterializationError(
        "lock-segment",
        "retry",
        "Archive segment changed before materialization"
      );
    }

    const sourceCounts = await phase("source-counts", () =>
      client.query<{
        wallet_trade_event: string;
        wallet_entry_signal: string;
        wallet_signal_outcome: string;
      }>(
        `SELECT
           (SELECT COUNT(*) FROM wallet_trade_events
            WHERE observed_at >= $1 AND observed_at < $2)::text AS wallet_trade_event,
           (SELECT COUNT(*) FROM wallet_entry_signals
            WHERE observed_at >= $1 AND observed_at < $2)::text AS wallet_entry_signal,
           (SELECT COUNT(*) FROM wallet_signal_outcomes
            WHERE observed_at >= $1 AND observed_at < $2)::text AS wallet_signal_outcome`,
        [start, end]
      )
    );
    const actualSourceCounts = {
      wallet_trade_event: Number(sourceCounts.rows[0]?.wallet_trade_event ?? 0),
      wallet_entry_signal: Number(sourceCounts.rows[0]?.wallet_entry_signal ?? 0),
      wallet_signal_outcome: Number(sourceCounts.rows[0]?.wallet_signal_outcome ?? 0)
    };
    if (!sameCounts(actualSourceCounts, segment.record_type_counts)) {
      throw new CompactMaterializationError(
        "source-counts",
        "mismatch",
        "Current source counts differ from the verified B2 manifest"
      );
    }

    await phase("dimensions", () => materializeDimensions(client, start, end));
    await phase("reconcile-episodes", () => reconcileMissingEpisodes(client, start, end));
    await phase("episodes", () => materializeEpisodes(client, start, end));
    await phase("open-lots", () => materializeOpenLots(client, start, end));
    await phase("followability", () => materializeFollowability(client, start, end));

    // A pg client executes one statement at a time. Keep these reads explicit and
    // sequential so transaction ordering remains supported by pg 9+ as well.
    const episodeSource = await phase("parity-episode-source", () =>
      aggregate(client, episodeSourceAggregateSql, start, end)
    );
    const episodeFact = await phase("parity-episode-fact", () =>
      aggregate(client, episodeFactAggregateSql, start, end)
    );
    const lotSource = await phase("parity-lot-source", () =>
      aggregate(client, lotSourceAggregateSql, start, end)
    );
    const lotFact = await phase("parity-lot-fact", () =>
      aggregate(client, lotFactAggregateSql, start, end)
    );
    const followSource = await phase("parity-followability-source", () =>
      aggregate(client, followSourceAggregateSql, start, end)
    );
    const followFact = await phase("parity-followability-fact", () =>
      aggregate(client, followFactAggregateSql, start, end)
    );
    const parity = {
      episodes: aggregateMatches(episodeSource, episodeFact),
      openLots: aggregateMatches(lotSource, lotFact),
      matureFollowability: aggregateMatches(followSource, followFact),
      episodeSource,
      episodeFact,
      lotSource,
      lotFact,
      followSource,
      followFact
    };
    if (!parity.episodes || !parity.openLots || !parity.matureFollowability) {
      throw new CompactMaterializationError(
        "parity",
        "mismatch",
        "Compact wallet evidence digest parity failed"
      );
    }

    await phase("write-receipt", () =>
      client.query(
        `INSERT INTO wallet_evidence_compact_days (
         range_start, range_end, archive_segment_id, archive_revision, status,
         source_record_type_counts, affected_episode_count, open_lot_count,
         mature_followability_count, parity, attempt_count, not_before, last_error,
         materialized_at, updated_at
       ) VALUES ($1,$2,$3,$4,'verified',$5::jsonb,$6,$7,$8,$9::jsonb,0,NOW(),NULL,NOW(),NOW())
       ON CONFLICT (range_start) DO UPDATE SET
         range_end=EXCLUDED.range_end,
         archive_segment_id=EXCLUDED.archive_segment_id,
         archive_revision=EXCLUDED.archive_revision,
         status='verified',
         source_record_type_counts=EXCLUDED.source_record_type_counts,
         affected_episode_count=EXCLUDED.affected_episode_count,
         open_lot_count=EXCLUDED.open_lot_count,
         mature_followability_count=EXCLUDED.mature_followability_count,
         parity=EXCLUDED.parity,
         attempt_count=0,
         not_before=NOW(),
         last_error=NULL,
         materialized_at=NOW(),
         updated_at=NOW()`,
        [
          start,
          end,
          segment.id,
          segment.revision,
          JSON.stringify(actualSourceCounts),
          episodeFact.rows,
          lotFact.rows,
          followFact.rows,
          JSON.stringify(parity)
        ]
      )
    );
    await client.query("COMMIT");
    return {
      rangeStart: start,
      revision: segment.revision,
      status: "verified",
      episodeCount: episodeFact.rows,
      openLotCount: lotFact.rows,
      matureFollowabilityCount: followFact.rows,
      phaseDurationsMs
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function materializeDimensions(client: pg.PoolClient, start: string, end: string) {
  await client.query(
    `WITH touched AS (
       SELECT chain, wallet_address FROM wallet_trade_events
       WHERE observed_at >= $1 AND observed_at < $2
       UNION
       SELECT chain, wallet_address FROM wallet_entry_signals
       WHERE observed_at >= $1 AND observed_at < $2
       UNION
       SELECT entry.chain, entry.wallet_address
       FROM wallet_signal_outcomes outcome
       JOIN wallet_entry_signals entry
         ON entry.idempotency_key=outcome.entry_idempotency_key
        AND entry.strategy_version=outcome.strategy_version
       WHERE outcome.observed_at >= $1 AND outcome.observed_at < $2
     )
     INSERT INTO wallet_evidence_wallet_dimensions (chain, wallet_address)
     SELECT chain, wallet_address FROM touched
     ON CONFLICT (chain, wallet_address) DO NOTHING`,
    [start, end]
  );
  await client.query(
    `WITH touched_wallets AS (
       SELECT chain, wallet_address, strategy_version FROM wallet_trade_events
       WHERE observed_at >= $1 AND observed_at < $2
     ), tokens AS (
       SELECT chain, token_address FROM wallet_trade_events
       WHERE observed_at >= $1 AND observed_at < $2
       UNION
       SELECT chain, token_address FROM wallet_entry_signals
       WHERE observed_at >= $1 AND observed_at < $2
       UNION
       SELECT entry.chain, entry.token_address
       FROM wallet_signal_outcomes outcome
       JOIN wallet_entry_signals entry
         ON entry.idempotency_key=outcome.entry_idempotency_key
        AND entry.strategy_version=outcome.strategy_version
       WHERE outcome.observed_at >= $1 AND outcome.observed_at < $2
       UNION
       SELECT episode.chain, episode.token_address
       FROM wallet_position_episodes episode
       JOIN touched_wallets touched
         ON touched.chain=episode.chain
        AND touched.wallet_address=episode.wallet_address
        AND touched.strategy_version=episode.strategy_version
     )
     INSERT INTO wallet_evidence_token_dimensions (chain, token_address)
     SELECT chain, token_address FROM tokens
     ON CONFLICT (chain, token_address) DO NOTHING`,
    [start, end]
  );
  await client.query(
    `WITH strategies AS (
       SELECT strategy_version FROM wallet_trade_events
       WHERE observed_at >= $1 AND observed_at < $2
       UNION
       SELECT strategy_version FROM wallet_entry_signals
       WHERE observed_at >= $1 AND observed_at < $2
       UNION
       SELECT strategy_version FROM wallet_signal_outcomes
       WHERE observed_at >= $1 AND observed_at < $2
     )
     INSERT INTO wallet_evidence_strategy_dimensions (strategy_version)
     SELECT strategy_version FROM strategies
     ON CONFLICT (strategy_version) DO NOTHING`,
    [start, end]
  );
}

async function materializeEpisodes(client: pg.PoolClient, start: string, end: string) {
  await client.query(
    `WITH touched AS MATERIALIZED (
       SELECT DISTINCT chain, wallet_address, strategy_version
       FROM wallet_trade_events
       WHERE observed_at >= $1 AND observed_at < $2
     ), desired AS MATERIALIZED (
       SELECT digest(convert_to(episode.id,'UTF8'),'sha256') AS episode_hash,
              wallet.id AS wallet_id, token.id AS token_id, strategy.id AS strategy_id,
              episode.episode_index, episode.status, episode.opened_at,
              episode.closed_at, episode.cost_basis_usd, episode.proceeds_usd,
              episode.realized_pnl_usd, episode.return_pct,
              episode.remaining_raw_amount, episode.token_decimals,
              episode.realized_lot_count, episode.high_quality_price_coverage,
              episode.terminal_reason
       FROM wallet_position_episodes episode
       JOIN touched ON touched.chain=episode.chain
         AND touched.wallet_address=episode.wallet_address
         AND touched.strategy_version=episode.strategy_version
       JOIN wallet_evidence_wallet_dimensions wallet
         ON wallet.chain=episode.chain AND wallet.wallet_address=episode.wallet_address
       JOIN wallet_evidence_token_dimensions token
         ON token.chain=episode.chain AND token.token_address=episode.token_address
       JOIN wallet_evidence_strategy_dimensions strategy
         ON strategy.strategy_version=episode.strategy_version
     )
     MERGE INTO wallet_profitability_episode_facts AS fact
     USING desired ON fact.episode_hash=desired.episode_hash
     WHEN MATCHED AND ROW(
       fact.wallet_id, fact.token_id, fact.strategy_id, fact.episode_index,
       fact.status, fact.opened_at, fact.closed_at, fact.cost_basis_usd,
       fact.proceeds_usd, fact.realized_pnl_usd, fact.return_pct,
       fact.remaining_raw_amount, fact.token_decimals, fact.realized_lot_count,
       fact.high_quality_price_coverage, fact.terminal_reason
     ) IS DISTINCT FROM ROW(
       desired.wallet_id, desired.token_id, desired.strategy_id,
       desired.episode_index, desired.status, desired.opened_at,
       desired.closed_at, desired.cost_basis_usd, desired.proceeds_usd,
       desired.realized_pnl_usd, desired.return_pct,
       desired.remaining_raw_amount, desired.token_decimals,
       desired.realized_lot_count, desired.high_quality_price_coverage,
       desired.terminal_reason
     ) THEN UPDATE SET
       wallet_id=desired.wallet_id, token_id=desired.token_id,
       strategy_id=desired.strategy_id, episode_index=desired.episode_index,
       status=desired.status, opened_at=desired.opened_at,
       closed_at=desired.closed_at, cost_basis_usd=desired.cost_basis_usd,
       proceeds_usd=desired.proceeds_usd, realized_pnl_usd=desired.realized_pnl_usd,
       return_pct=desired.return_pct, remaining_raw_amount=desired.remaining_raw_amount,
       token_decimals=desired.token_decimals,
       realized_lot_count=desired.realized_lot_count,
       high_quality_price_coverage=desired.high_quality_price_coverage,
       terminal_reason=desired.terminal_reason, updated_at=NOW()
     WHEN NOT MATCHED THEN INSERT (
       episode_hash, wallet_id, token_id, strategy_id, episode_index, status,
       opened_at, closed_at, cost_basis_usd, proceeds_usd, realized_pnl_usd,
       return_pct, remaining_raw_amount, token_decimals, realized_lot_count,
       high_quality_price_coverage, terminal_reason, updated_at
     ) VALUES (
       desired.episode_hash, desired.wallet_id, desired.token_id, desired.strategy_id,
       desired.episode_index, desired.status, desired.opened_at, desired.closed_at,
       desired.cost_basis_usd, desired.proceeds_usd, desired.realized_pnl_usd,
       desired.return_pct, desired.remaining_raw_amount, desired.token_decimals,
       desired.realized_lot_count, desired.high_quality_price_coverage,
       desired.terminal_reason, NOW()
     )`,
    [start, end]
  );
}

async function reconcileMissingEpisodes(client: pg.PoolClient, start: string, end: string) {
  await client.query(
    `WITH touched AS MATERIALIZED (
       SELECT DISTINCT chain, wallet_address, strategy_version
       FROM wallet_trade_events
       WHERE observed_at >= $1 AND observed_at < $2
     ), stale AS (
       SELECT fact.episode_hash
       FROM wallet_profitability_episode_facts fact
       JOIN wallet_evidence_wallet_dimensions wallet ON wallet.id=fact.wallet_id
       JOIN wallet_evidence_strategy_dimensions strategy ON strategy.id=fact.strategy_id
       JOIN touched ON touched.chain=wallet.chain
         AND touched.wallet_address=wallet.wallet_address
         AND touched.strategy_version=strategy.strategy_version
       WHERE NOT EXISTS (
         SELECT 1 FROM wallet_position_episodes episode
         WHERE digest(convert_to(episode.id,'UTF8'),'sha256')=fact.episode_hash
       )
     )
     DELETE FROM wallet_profitability_episode_facts fact
     USING stale WHERE fact.episode_hash=stale.episode_hash`,
    [start, end]
  );
}

async function materializeOpenLots(client: pg.PoolClient, start: string, end: string) {
  await client.query(
    `WITH touched AS MATERIALIZED (
       SELECT DISTINCT chain, wallet_address, strategy_version
       FROM wallet_trade_events
       WHERE observed_at >= $1 AND observed_at < $2
     ), affected AS MATERIALIZED (
       SELECT episode.id AS episode_id,
              digest(convert_to(episode.id,'UTF8'),'sha256') AS episode_hash
       FROM wallet_position_episodes episode
       JOIN touched ON touched.chain=episode.chain
         AND touched.wallet_address=episode.wallet_address
         AND touched.strategy_version=episode.strategy_version
     ), current_lots AS MATERIALIZED (
       SELECT digest(convert_to(lot.id,'UTF8'),'sha256') AS lot_hash,
              affected.episode_hash
       FROM wallet_position_lots lot
       JOIN affected ON affected.episode_id=lot.episode_id
       WHERE lot.status <> 'realized'
     )
     DELETE FROM wallet_open_lot_facts fact
     USING affected
     WHERE fact.episode_hash=affected.episode_hash
       AND NOT EXISTS (
         SELECT 1 FROM current_lots current
         WHERE current.lot_hash=fact.lot_hash
           AND current.episode_hash=fact.episode_hash
       )`,
    [start, end]
  );
  await client.query(
    `WITH touched AS MATERIALIZED (
       SELECT DISTINCT chain, wallet_address, strategy_version
       FROM wallet_trade_events
       WHERE observed_at >= $1 AND observed_at < $2
     ), desired AS MATERIALIZED (
       SELECT digest(convert_to(lot.id,'UTF8'),'sha256') AS lot_hash,
              digest(convert_to(episode.id,'UTF8'),'sha256') AS episode_hash,
              lot.lot_sequence, lot.raw_amount, lot.remaining_raw_amount,
              lot.token_decimals, lot.quote_cost_usd, lot.fees_usd,
              lot.slippage_usd, lot.opened_at, lot.closed_at, lot.status
       FROM wallet_position_lots lot
       JOIN wallet_position_episodes episode ON episode.id=lot.episode_id
       JOIN touched ON touched.chain=episode.chain
         AND touched.wallet_address=episode.wallet_address
         AND touched.strategy_version=episode.strategy_version
       WHERE lot.status <> 'realized'
     )
     MERGE INTO wallet_open_lot_facts AS fact
     USING desired ON fact.lot_hash=desired.lot_hash
     WHEN MATCHED AND ROW(
       fact.episode_hash, fact.lot_sequence, fact.raw_amount,
       fact.remaining_raw_amount, fact.token_decimals, fact.quote_cost_usd,
       fact.fees_usd, fact.slippage_usd, fact.opened_at, fact.closed_at,
       fact.status
     ) IS DISTINCT FROM ROW(
       desired.episode_hash, desired.lot_sequence, desired.raw_amount,
       desired.remaining_raw_amount, desired.token_decimals,
       desired.quote_cost_usd, desired.fees_usd, desired.slippage_usd,
       desired.opened_at, desired.closed_at, desired.status
     ) THEN UPDATE SET
       episode_hash=desired.episode_hash, lot_sequence=desired.lot_sequence,
       raw_amount=desired.raw_amount, remaining_raw_amount=desired.remaining_raw_amount,
       token_decimals=desired.token_decimals, quote_cost_usd=desired.quote_cost_usd,
       fees_usd=desired.fees_usd, slippage_usd=desired.slippage_usd,
       opened_at=desired.opened_at, closed_at=desired.closed_at,
       status=desired.status, updated_at=NOW()
     WHEN NOT MATCHED THEN INSERT (
       lot_hash, episode_hash, lot_sequence, raw_amount, remaining_raw_amount,
       token_decimals, quote_cost_usd, fees_usd, slippage_usd, opened_at,
       closed_at, status, updated_at
     ) VALUES (
       desired.lot_hash, desired.episode_hash, desired.lot_sequence,
       desired.raw_amount, desired.remaining_raw_amount, desired.token_decimals,
       desired.quote_cost_usd, desired.fees_usd, desired.slippage_usd,
       desired.opened_at, desired.closed_at, desired.status, NOW()
     )`,
    [start, end]
  );
}

async function materializeFollowability(client: pg.PoolClient, start: string, end: string) {
  await client.query(
    `WITH current_outcomes AS MATERIALIZED (
       SELECT digest(convert_to(outcome.idempotency_key,'UTF8'),'sha256') AS outcome_hash
       FROM wallet_signal_outcomes outcome
       WHERE outcome.status='mature'
         AND outcome.observed_at >= $1 AND outcome.observed_at < $2
     )
     DELETE FROM wallet_followability_facts fact
     WHERE fact.outcome_observed_at >= $1 AND fact.outcome_observed_at < $2
       AND NOT EXISTS (
         SELECT 1 FROM current_outcomes current
         WHERE current.outcome_hash=fact.outcome_hash
       )`,
    [start, end]
  );
  await client.query(
    `WITH desired AS MATERIALIZED (
       SELECT digest(convert_to(outcome.idempotency_key,'UTF8'),'sha256') AS outcome_hash,
              digest(convert_to(entry.idempotency_key,'UTF8'),'sha256') AS entry_hash,
              wallet.id AS wallet_id, token.id AS token_id, strategy.id AS strategy_id,
              entry.observed_at AS entry_observed_at,
              outcome.observed_at AS outcome_observed_at,
              entry.observed_entry_price_usd, entry.observed_liquidity_usd,
              entry.cohort, entry.repeat_wallet_count,
              ${safeJsonCast("controlledFlow", "boolean")} AS controlled_flow,
              ${safeJsonCast("balancedFlow", "boolean")} AS balanced_flow,
              ${safeJsonCast("poolAgeMinutes", "numeric")} AS pool_age_minutes,
              ${safeJsonCast("liquidityUsd", "numeric")} AS liquidity_usd,
              ${safeJsonCast("liquidityKnown", "boolean")} AS liquidity_known,
              ${safeJsonCast("volume5mUsd", "numeric")} AS volume_5m_usd,
              ${safeJsonCast("volume1hUsd", "numeric")} AS volume_1h_usd,
              ${safeJsonCast("buys5m", "integer")} AS buys_5m,
              ${safeJsonCast("sells5m", "integer")} AS sells_5m,
              ${safeJsonCast("swaps5m", "integer")} AS swaps_5m,
              ${safeJsonCast("buyShare5m", "numeric")} AS buy_share_5m,
              ${safeJsonCast("volumeLiquidityRatio", "numeric")} AS volume_liquidity_ratio,
              ${safeJsonCast("tokenRiskKnown", "boolean")} AS token_risk_known,
              ${safeJsonCast("tokenRiskPassed", "boolean")} AS token_risk_passed,
              ${safeJsonCast("mintAuthorityRevoked", "boolean")} AS mint_authority_revoked,
              ${safeJsonCast("freezeAuthorityRevoked", "boolean")} AS freeze_authority_revoked,
              ${safeJsonCast("top10HolderPercent", "numeric")} AS top_10_holder_percent,
              ${safeJsonCast("buyObservedAt", "timestamptz")} AS buy_observed_at,
              outcome.horizon_minutes, outcome.outcome_price_usd, outcome.frozen_at,
              outcome.gross_return_pct, outcome.net_return_pct,
              outcome.estimated_round_trip_cost_pct, outcome.exit_strategy, outcome.rugged
       FROM wallet_signal_outcomes outcome
       JOIN wallet_entry_signals entry
         ON entry.idempotency_key=outcome.entry_idempotency_key
        AND entry.strategy_version=outcome.strategy_version
       JOIN wallet_evidence_wallet_dimensions wallet
         ON wallet.chain=entry.chain AND wallet.wallet_address=entry.wallet_address
       JOIN wallet_evidence_token_dimensions token
         ON token.chain=entry.chain AND token.token_address=entry.token_address
       JOIN wallet_evidence_strategy_dimensions strategy
         ON strategy.strategy_version=outcome.strategy_version
       WHERE outcome.status='mature'
         AND outcome.observed_at >= $1 AND outcome.observed_at < $2
     )
     MERGE INTO wallet_followability_facts AS fact
     USING desired ON fact.outcome_hash=desired.outcome_hash
     WHEN MATCHED AND ROW(
       fact.entry_hash, fact.wallet_id, fact.token_id, fact.strategy_id,
       fact.entry_observed_at, fact.outcome_observed_at,
       fact.observed_entry_price_usd, fact.observed_liquidity_usd,
       fact.cohort, fact.repeat_wallet_count, fact.controlled_flow,
       fact.balanced_flow, fact.pool_age_minutes, fact.liquidity_usd,
       fact.liquidity_known, fact.volume_5m_usd, fact.volume_1h_usd,
       fact.buys_5m, fact.sells_5m, fact.swaps_5m, fact.buy_share_5m,
       fact.volume_liquidity_ratio, fact.token_risk_known,
       fact.token_risk_passed, fact.mint_authority_revoked,
       fact.freeze_authority_revoked, fact.top_10_holder_percent,
       fact.buy_observed_at, fact.horizon_minutes, fact.outcome_price_usd,
       fact.frozen_at, fact.gross_return_pct, fact.net_return_pct,
       fact.estimated_round_trip_cost_pct, fact.exit_strategy, fact.rugged
     ) IS DISTINCT FROM ROW(
       desired.entry_hash, desired.wallet_id, desired.token_id,
       desired.strategy_id, desired.entry_observed_at,
       desired.outcome_observed_at, desired.observed_entry_price_usd,
       desired.observed_liquidity_usd, desired.cohort,
       desired.repeat_wallet_count, desired.controlled_flow,
       desired.balanced_flow, desired.pool_age_minutes,
       desired.liquidity_usd, desired.liquidity_known,
       desired.volume_5m_usd, desired.volume_1h_usd,
       desired.buys_5m, desired.sells_5m, desired.swaps_5m,
       desired.buy_share_5m, desired.volume_liquidity_ratio,
       desired.token_risk_known, desired.token_risk_passed,
       desired.mint_authority_revoked, desired.freeze_authority_revoked,
       desired.top_10_holder_percent, desired.buy_observed_at,
       desired.horizon_minutes, desired.outcome_price_usd,
       desired.frozen_at, desired.gross_return_pct, desired.net_return_pct,
       desired.estimated_round_trip_cost_pct, desired.exit_strategy, desired.rugged
     ) THEN UPDATE SET
       entry_hash=desired.entry_hash, wallet_id=desired.wallet_id,
       token_id=desired.token_id, strategy_id=desired.strategy_id,
       entry_observed_at=desired.entry_observed_at,
       outcome_observed_at=desired.outcome_observed_at,
       observed_entry_price_usd=desired.observed_entry_price_usd,
       observed_liquidity_usd=desired.observed_liquidity_usd,
       cohort=desired.cohort, repeat_wallet_count=desired.repeat_wallet_count,
       controlled_flow=desired.controlled_flow, balanced_flow=desired.balanced_flow,
       pool_age_minutes=desired.pool_age_minutes, liquidity_usd=desired.liquidity_usd,
       liquidity_known=desired.liquidity_known, volume_5m_usd=desired.volume_5m_usd,
       volume_1h_usd=desired.volume_1h_usd, buys_5m=desired.buys_5m,
       sells_5m=desired.sells_5m, swaps_5m=desired.swaps_5m,
       buy_share_5m=desired.buy_share_5m,
       volume_liquidity_ratio=desired.volume_liquidity_ratio,
       token_risk_known=desired.token_risk_known,
       token_risk_passed=desired.token_risk_passed,
       mint_authority_revoked=desired.mint_authority_revoked,
       freeze_authority_revoked=desired.freeze_authority_revoked,
       top_10_holder_percent=desired.top_10_holder_percent,
       buy_observed_at=desired.buy_observed_at,
       horizon_minutes=desired.horizon_minutes,
       outcome_price_usd=desired.outcome_price_usd, frozen_at=desired.frozen_at,
       gross_return_pct=desired.gross_return_pct, net_return_pct=desired.net_return_pct,
       estimated_round_trip_cost_pct=desired.estimated_round_trip_cost_pct,
       exit_strategy=desired.exit_strategy, rugged=desired.rugged, updated_at=NOW()
     WHEN NOT MATCHED THEN INSERT (
       outcome_hash, entry_hash, wallet_id, token_id, strategy_id,
       entry_observed_at, outcome_observed_at, observed_entry_price_usd,
       observed_liquidity_usd, cohort, repeat_wallet_count, controlled_flow,
       balanced_flow, pool_age_minutes, liquidity_usd, liquidity_known,
       volume_5m_usd, volume_1h_usd, buys_5m, sells_5m, swaps_5m,
       buy_share_5m, volume_liquidity_ratio, token_risk_known, token_risk_passed,
       mint_authority_revoked, freeze_authority_revoked, top_10_holder_percent,
       buy_observed_at, horizon_minutes, outcome_price_usd, frozen_at,
       gross_return_pct, net_return_pct, estimated_round_trip_cost_pct,
       exit_strategy, rugged, updated_at
     ) VALUES (
       desired.outcome_hash, desired.entry_hash, desired.wallet_id,
       desired.token_id, desired.strategy_id, desired.entry_observed_at,
       desired.outcome_observed_at, desired.observed_entry_price_usd,
       desired.observed_liquidity_usd, desired.cohort,
       desired.repeat_wallet_count, desired.controlled_flow,
       desired.balanced_flow, desired.pool_age_minutes, desired.liquidity_usd,
       desired.liquidity_known, desired.volume_5m_usd, desired.volume_1h_usd,
       desired.buys_5m, desired.sells_5m, desired.swaps_5m,
       desired.buy_share_5m, desired.volume_liquidity_ratio,
       desired.token_risk_known, desired.token_risk_passed,
       desired.mint_authority_revoked, desired.freeze_authority_revoked,
       desired.top_10_holder_percent, desired.buy_observed_at,
       desired.horizon_minutes, desired.outcome_price_usd, desired.frozen_at,
       desired.gross_return_pct, desired.net_return_pct,
       desired.estimated_round_trip_cost_pct, desired.exit_strategy,
       desired.rugged, NOW()
     )`,
    [start, end]
  );
}

async function aggregate(
  client: pg.PoolClient,
  sql: string,
  start: string,
  end: string
): Promise<Aggregate> {
  const result = await client.query<{ rows: string; digest0: string; digest1: string }>(sql, [
    start,
    end
  ]);
  return {
    rows: Number(result.rows[0]?.rows ?? 0),
    digest0: String(result.rows[0]?.digest0 ?? "0"),
    digest1: String(result.rows[0]?.digest1 ?? "0")
  };
}

function aggregateMatches(left: Aggregate, right: Aggregate): boolean {
  return (
    left.rows === right.rows && left.digest0 === right.digest0 && left.digest1 === right.digest1
  );
}

async function recordFailure(
  client: pg.PoolClient,
  segment: ArchiveCandidate,
  disposition: CompactFailureDisposition,
  error: string
) {
  await client.query(
    `INSERT INTO wallet_evidence_compact_days (
       range_start, range_end, archive_segment_id, archive_revision, status,
       source_record_type_counts, affected_episode_count, open_lot_count,
       mature_followability_count, parity, attempt_count, not_before, last_error,
       materialized_at, updated_at
     ) VALUES (
       $1,$2,$3,$4,$6,$5::jsonb,0,0,0,'{}'::jsonb,1,
       NOW() + CASE WHEN $6='retry' THEN INTERVAL '30 minutes' ELSE INTERVAL '6 hours' END,
       $7,NOW(),NOW()
     )
     ON CONFLICT (range_start) DO UPDATE SET
       archive_segment_id=EXCLUDED.archive_segment_id,
       archive_revision=EXCLUDED.archive_revision,
       status=EXCLUDED.status, source_record_type_counts=EXCLUDED.source_record_type_counts,
       parity='{}'::jsonb,
       attempt_count=CASE
         WHEN wallet_evidence_compact_days.archive_segment_id=EXCLUDED.archive_segment_id
          AND wallet_evidence_compact_days.archive_revision=EXCLUDED.archive_revision
         THEN wallet_evidence_compact_days.attempt_count + 1 ELSE 1 END,
       not_before=NOW() + CASE
         WHEN EXCLUDED.status='retry' THEN INTERVAL '30 minutes' ELSE INTERVAL '6 hours' END,
       last_error=EXCLUDED.last_error,
       materialized_at=NOW(), updated_at=NOW()`,
    [
      segment.range_start.toISOString(),
      segment.range_end.toISOString(),
      segment.id,
      segment.revision,
      JSON.stringify(segment.record_type_counts),
      disposition,
      error.slice(0, 4_000)
    ]
  );
}

function sameCounts(left: Record<string, number>, right: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if ((left[key] ?? 0) !== Number(right[key] ?? 0)) return false;
  return true;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(
    0,
    4_000
  );
}

function safeJsonCast(field: string, type: string): string {
  const value = `entry.flow_evidence->>'${field}'`;
  return `CASE WHEN pg_input_is_valid(${value}, '${type}') THEN (${value})::${type} END`;
}

const affectedEpisodesCte = `WITH touched AS MATERIALIZED (
  SELECT DISTINCT chain, wallet_address, strategy_version
  FROM wallet_trade_events WHERE observed_at >= $1 AND observed_at < $2
), affected AS MATERIALIZED (
  SELECT episode.* FROM wallet_position_episodes episode
  JOIN touched ON touched.chain=episode.chain
    AND touched.wallet_address=episode.wallet_address
    AND touched.strategy_version=episode.strategy_version
)`;

const episodePayloadSource = `jsonb_build_array(
  encode(digest(convert_to(episode.id,'UTF8'),'sha256'),'hex'), episode.chain,
  episode.wallet_address, episode.token_address, episode.strategy_version,
  episode.episode_index, episode.status, episode.opened_at, episode.closed_at,
  episode.cost_basis_usd, episode.proceeds_usd, episode.realized_pnl_usd,
  episode.return_pct, episode.remaining_raw_amount, episode.token_decimals,
  episode.realized_lot_count, episode.high_quality_price_coverage, episode.terminal_reason
)::text`;
const episodePayloadFact = `jsonb_build_array(
  encode(fact.episode_hash,'hex'), wallet.chain, wallet.wallet_address,
  token.token_address, strategy.strategy_version, fact.episode_index, fact.status,
  fact.opened_at, fact.closed_at, fact.cost_basis_usd, fact.proceeds_usd,
  fact.realized_pnl_usd, fact.return_pct, fact.remaining_raw_amount,
  fact.token_decimals, fact.realized_lot_count, fact.high_quality_price_coverage,
  fact.terminal_reason
)::text`;

const episodeSourceAggregateSql = `${affectedEpisodesCte}, payloads AS (
  SELECT ${episodePayloadSource} AS payload FROM affected episode
) SELECT COUNT(*)::text AS rows,
  COALESCE(SUM(hashtextextended(payload,0)::numeric),0)::text AS digest0,
  COALESCE(SUM(hashtextextended(payload,1)::numeric),0)::text AS digest1 FROM payloads`;
const episodeFactAggregateSql = `${affectedEpisodesCte}, payloads AS (
  SELECT ${episodePayloadFact} AS payload
  FROM wallet_profitability_episode_facts fact
  JOIN affected episode ON fact.episode_hash=digest(convert_to(episode.id,'UTF8'),'sha256')
  JOIN wallet_evidence_wallet_dimensions wallet ON wallet.id=fact.wallet_id
  JOIN wallet_evidence_token_dimensions token ON token.id=fact.token_id
  JOIN wallet_evidence_strategy_dimensions strategy ON strategy.id=fact.strategy_id
) SELECT COUNT(*)::text AS rows,
  COALESCE(SUM(hashtextextended(payload,0)::numeric),0)::text AS digest0,
  COALESCE(SUM(hashtextextended(payload,1)::numeric),0)::text AS digest1 FROM payloads`;

const lotPayloadSource = `jsonb_build_array(
  encode(digest(convert_to(lot.id,'UTF8'),'sha256'),'hex'),
  encode(digest(convert_to(episode.id,'UTF8'),'sha256'),'hex'), lot.lot_sequence,
  lot.raw_amount, lot.remaining_raw_amount, lot.token_decimals, lot.quote_cost_usd,
  lot.fees_usd, lot.slippage_usd, lot.opened_at, lot.closed_at, lot.status
)::text`;
const lotPayloadFact = `jsonb_build_array(
  encode(fact.lot_hash,'hex'), encode(fact.episode_hash,'hex'), fact.lot_sequence,
  fact.raw_amount, fact.remaining_raw_amount, fact.token_decimals, fact.quote_cost_usd,
  fact.fees_usd, fact.slippage_usd, fact.opened_at, fact.closed_at, fact.status
)::text`;
const lotSourceAggregateSql = `${affectedEpisodesCte}, payloads AS (
  SELECT ${lotPayloadSource} AS payload FROM wallet_position_lots lot
  JOIN affected episode ON episode.id=lot.episode_id WHERE lot.status <> 'realized'
) SELECT COUNT(*)::text AS rows,
  COALESCE(SUM(hashtextextended(payload,0)::numeric),0)::text AS digest0,
  COALESCE(SUM(hashtextextended(payload,1)::numeric),0)::text AS digest1 FROM payloads`;
const lotFactAggregateSql = `${affectedEpisodesCte}, payloads AS (
  SELECT ${lotPayloadFact} AS payload FROM wallet_open_lot_facts fact
  JOIN affected episode ON fact.episode_hash=digest(convert_to(episode.id,'UTF8'),'sha256')
) SELECT COUNT(*)::text AS rows,
  COALESCE(SUM(hashtextextended(payload,0)::numeric),0)::text AS digest0,
  COALESCE(SUM(hashtextextended(payload,1)::numeric),0)::text AS digest1 FROM payloads`;

const followPayloadSource = `jsonb_build_array(
  encode(digest(convert_to(outcome.idempotency_key,'UTF8'),'sha256'),'hex'),
  encode(digest(convert_to(entry.idempotency_key,'UTF8'),'sha256'),'hex'), entry.chain,
  entry.wallet_address, entry.token_address, outcome.strategy_version,
  entry.observed_at, outcome.observed_at, entry.observed_entry_price_usd,
  entry.observed_liquidity_usd, entry.cohort, entry.repeat_wallet_count,
  ${safeJsonCast("controlledFlow", "boolean")},
  ${safeJsonCast("balancedFlow", "boolean")},
  ${safeJsonCast("poolAgeMinutes", "numeric")},
  ${safeJsonCast("liquidityUsd", "numeric")},
  ${safeJsonCast("liquidityKnown", "boolean")},
  ${safeJsonCast("volume5mUsd", "numeric")},
  ${safeJsonCast("volume1hUsd", "numeric")},
  ${safeJsonCast("buys5m", "integer")},
  ${safeJsonCast("sells5m", "integer")},
  ${safeJsonCast("swaps5m", "integer")},
  ${safeJsonCast("buyShare5m", "numeric")},
  ${safeJsonCast("volumeLiquidityRatio", "numeric")},
  ${safeJsonCast("tokenRiskKnown", "boolean")},
  ${safeJsonCast("tokenRiskPassed", "boolean")},
  ${safeJsonCast("mintAuthorityRevoked", "boolean")},
  ${safeJsonCast("freezeAuthorityRevoked", "boolean")},
  ${safeJsonCast("top10HolderPercent", "numeric")},
  ${safeJsonCast("buyObservedAt", "timestamptz")},
  outcome.horizon_minutes, outcome.outcome_price_usd, outcome.frozen_at,
  outcome.gross_return_pct, outcome.net_return_pct,
  outcome.estimated_round_trip_cost_pct, outcome.exit_strategy, outcome.rugged
)::text`;
const followPayloadFact = `jsonb_build_array(
  encode(fact.outcome_hash,'hex'), encode(fact.entry_hash,'hex'), wallet.chain,
  wallet.wallet_address, token.token_address, strategy.strategy_version,
  fact.entry_observed_at, fact.outcome_observed_at, fact.observed_entry_price_usd,
  fact.observed_liquidity_usd, fact.cohort, fact.repeat_wallet_count,
  fact.controlled_flow, fact.balanced_flow, fact.pool_age_minutes, fact.liquidity_usd,
  fact.liquidity_known, fact.volume_5m_usd, fact.volume_1h_usd, fact.buys_5m,
  fact.sells_5m, fact.swaps_5m, fact.buy_share_5m, fact.volume_liquidity_ratio,
  fact.token_risk_known, fact.token_risk_passed, fact.mint_authority_revoked,
  fact.freeze_authority_revoked, fact.top_10_holder_percent, fact.buy_observed_at,
  fact.horizon_minutes, fact.outcome_price_usd, fact.frozen_at,
  fact.gross_return_pct, fact.net_return_pct, fact.estimated_round_trip_cost_pct,
  fact.exit_strategy, fact.rugged
)::text`;
const followSourceAggregateSql = `WITH payloads AS (
  SELECT ${followPayloadSource} AS payload FROM wallet_signal_outcomes outcome
  JOIN wallet_entry_signals entry ON entry.idempotency_key=outcome.entry_idempotency_key
    AND entry.strategy_version=outcome.strategy_version
  WHERE outcome.status='mature' AND outcome.observed_at >= $1 AND outcome.observed_at < $2
) SELECT COUNT(*)::text AS rows,
  COALESCE(SUM(hashtextextended(payload,0)::numeric),0)::text AS digest0,
  COALESCE(SUM(hashtextextended(payload,1)::numeric),0)::text AS digest1 FROM payloads`;
const followFactAggregateSql = `WITH payloads AS (
  SELECT ${followPayloadFact} AS payload FROM wallet_followability_facts fact
  JOIN wallet_evidence_wallet_dimensions wallet ON wallet.id=fact.wallet_id
  JOIN wallet_evidence_token_dimensions token ON token.id=fact.token_id
  JOIN wallet_evidence_strategy_dimensions strategy ON strategy.id=fact.strategy_id
  WHERE fact.outcome_observed_at >= $1 AND fact.outcome_observed_at < $2
) SELECT COUNT(*)::text AS rows,
  COALESCE(SUM(hashtextextended(payload,0)::numeric),0)::text AS digest0,
  COALESCE(SUM(hashtextextended(payload,1)::numeric),0)::text AS digest1 FROM payloads`;

await main();
