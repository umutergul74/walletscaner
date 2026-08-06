import "dotenv/config";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for operational maintenance.");

const priceRetentionDays = positiveInt(process.env.PRICE_OBSERVATION_RETENTION_DAYS, 2);
const inboxRetentionDays = positiveInt(process.env.CHAIN_EVENT_RETENTION_DAYS, 3);
const swapRetentionDays = positiveInt(process.env.SWAP_RETENTION_DAYS, 3);
const rawPayloadRetentionHours = positiveInt(
  process.env.CHAIN_EVENT_RAW_PAYLOAD_RETENTION_HOURS,
  48
);
const scoreRetentionDays = positiveInt(process.env.WALLET_ALPHA_SCORE_RETENTION_DAYS, 7);
const walletEvidenceRetentionDays = positiveInt(
  process.env.WALLET_EVIDENCE_RETENTION_DAYS,
  95
);
const rejectedWalletEvidenceRetentionDays = positiveInt(
  process.env.REJECTED_WALLET_EVIDENCE_RETENTION_DAYS,
  3
);
const batchSize = positiveInt(process.env.MAINTENANCE_DELETE_BATCH_SIZE, 5_000);
const compactBatchSize = positiveInt(process.env.MAINTENANCE_COMPACT_BATCH_SIZE, 500);
const maxBatches = positiveInt(process.env.MAINTENANCE_MAX_BATCHES_PER_RUN, 50);
const maxRunSeconds = positiveInt(process.env.MAINTENANCE_MAX_RUN_SECONDS, 30);
const statementTimeoutMs = positiveInt(process.env.MAINTENANCE_STATEMENT_TIMEOUT_MS, 5_000);
const inventoryTimeoutMs = positiveInt(
  process.env.MAINTENANCE_INVENTORY_STATEMENT_TIMEOUT_MS,
  15_000
);
const payloadPartitionFutureDays = positiveInt(
  process.env.CHAIN_EVENT_PAYLOAD_PARTITION_FUTURE_DAYS,
  8
);
const dryRun = parseBoolean(process.env.MAINTENANCE_DRY_RUN, false);
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 1,
  statement_timeout: inventoryTimeoutMs
});
let queryTimeoutCount = 0;

try {
  const lock = await pool.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
    ["walletscaner-operational-maintenance"]
  );
  if (!lock.rows[0]?.locked) {
    console.log(JSON.stringify({ type: "operational-maintenance", status: "skipped-lock-held" }));
    process.exitCode = 0;
  } else {
    const eligible = await pool.query<{
      price_observations: boolean;
      chain_event_payloads: boolean;
      chain_events: boolean;
      swaps: boolean;
      wallet_alpha_scores: boolean;
      database_bytes: string;
    }>(
      `SELECT
         EXISTS(SELECT 1 FROM price_observations
          WHERE observed_at < NOW() - make_interval(days => $1::integer))
           AS price_observations,
         EXISTS(SELECT 1 FROM chain_event_inbox
          WHERE status = 'processed'
            AND payload_compacted_at IS NULL
            AND COALESCE(processed_at, received_at) <
                NOW() - make_interval(hours => $4::integer))
           AS chain_event_payloads,
         EXISTS(SELECT 1 FROM chain_event_inbox
          WHERE status IN ('processed', 'rolled_back')
            AND COALESCE(processed_at, received_at) <
                NOW() - make_interval(days => $2::integer))
           AS chain_events,
         EXISTS(SELECT 1 FROM swaps
          WHERE observed_at < NOW() - make_interval(days => $5::integer))
           AS swaps,
         EXISTS(SELECT 1 FROM wallet_alpha_scores score
          WHERE score.calculated_at < NOW() - make_interval(days => $3::integer)
            AND EXISTS (
              SELECT 1 FROM wallet_alpha_scores newer
              WHERE newer.chain = score.chain
                AND newer.wallet_address = score.wallet_address
                AND newer.strategy_version = score.strategy_version
                AND newer.calculated_at > score.calculated_at
            )) AS wallet_alpha_scores,
         pg_database_size(current_database())::text AS database_bytes`,
      [
        priceRetentionDays,
        inboxRetentionDays,
        scoreRetentionDays,
        rawPayloadRetentionHours,
        swapRetentionDays
      ]
    );
    await pool.query("SELECT set_config('statement_timeout', $1, false)", [
      `${statementTimeoutMs}ms`
    ]);

    let deletedPriceObservations = 0;
    let compactedChainEventPayloads = 0;
    let deletedChainEvents = 0;
    let deletedSwaps = 0;
    let deletedWalletAlphaScores = 0;
    let deletedRejectedWalletOutcomes = 0;
    let deletedRejectedWalletEntries = 0;
    let deletedWalletOutcomes = 0;
    let deletedWalletEntries = 0;
    let deletedWalletTrades = 0;
    let deletedWalletEpisodes = 0;
    let retiredPayloadPartitions = 0;
    let heldUnresolvedPayloads = 0;
    let retiredPricePartitions = 0;
    const maintenanceStartedAt = Date.now();
    const totalBudgetMs = maxRunSeconds * 1_000;
    if (!dryRun) {
      await ensurePayloadPartitions(payloadPartitionFutureDays);
      const retired = await retirePayloadPartitions(inboxRetentionDays);
      retiredPayloadPartitions = retired.partitions;
      heldUnresolvedPayloads = retired.heldPayloads;
      await ensurePricePartitions(payloadPartitionFutureDays);
      retiredPricePartitions = await retirePricePartitions(priceRetentionDays);
      deletedPriceObservations = await pruneInBatches(
        `WITH doomed AS (
           SELECT ctid FROM price_observations
           WHERE observed_at < NOW() - make_interval(days => $1::integer)
           ORDER BY observed_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
         DELETE FROM price_observations AS target
         USING doomed
         WHERE target.ctid = doomed.ctid`,
        priceRetentionDays,
        maintenanceStartedAt + totalBudgetMs * 0.3
      );
      await pruneInBatches(
        `WITH doomed AS (
           SELECT idempotency_key FROM price_observation_keys
           WHERE observed_at < NOW() - make_interval(days => $1::integer)
           ORDER BY observed_at, idempotency_key
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         DELETE FROM price_observation_keys AS target
         USING doomed
         WHERE target.idempotency_key = doomed.idempotency_key`,
        priceRetentionDays,
        maintenanceStartedAt + totalBudgetMs * 0.32
      );
      deletedSwaps = await pruneInBatches(
        `WITH doomed AS (
           SELECT ctid FROM swaps
           WHERE observed_at < NOW() - make_interval(days => $1::integer)
           ORDER BY observed_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
         DELETE FROM swaps AS target
         USING doomed
         WHERE target.ctid = doomed.ctid`,
        swapRetentionDays,
        maintenanceStartedAt + totalBudgetMs * 0.45
      );
      deletedChainEvents = await pruneInBatches(
        `WITH doomed AS (
           SELECT ctid FROM chain_event_inbox
           WHERE status IN ('processed', 'rolled_back')
             AND COALESCE(processed_at, received_at) <
                 NOW() - make_interval(days => $1::integer)
           ORDER BY COALESCE(processed_at, received_at)
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
         DELETE FROM chain_event_inbox AS target
         USING doomed
         WHERE target.ctid = doomed.ctid`,
        inboxRetentionDays,
        maintenanceStartedAt + totalBudgetMs * 0.52
      );
      compactedChainEventPayloads = await pruneInBatches(
        `WITH candidates AS (
           SELECT ctid, idempotency_key, payload_sha256
           FROM chain_event_inbox
           WHERE status = 'processed'
             AND payload_compacted_at IS NULL
             AND payload_sha256 IS NOT NULL
             AND COALESCE(processed_at, received_at) <
                 NOW() - make_interval(hours => $1::integer)
             AND COALESCE(processed_at, received_at) >=
                 NOW() - make_interval(days => $3::integer)
           ORDER BY COALESCE(processed_at, received_at), idempotency_key
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         ), retired_hot_payload AS (
           DELETE FROM chain_event_payloads AS payload
           USING candidates
           WHERE payload.event_idempotency_key = candidates.idempotency_key
           RETURNING payload.event_idempotency_key
         ), retired_held_payload AS (
           DELETE FROM chain_event_payload_holds AS payload
           USING candidates
           WHERE payload.event_idempotency_key = candidates.idempotency_key
           RETURNING payload.event_idempotency_key
         )
         UPDATE chain_event_inbox AS target
         SET payload_compacted_at = NOW(),
             payload = jsonb_build_object(
           'storageCompacted', TRUE,
           'originalPayloadSha256', candidates.payload_sha256,
           'compactedAt', NOW(),
           'rawPayloadRetentionHours', $1::integer
         )
         FROM candidates
         WHERE target.ctid = candidates.ctid`,
        rawPayloadRetentionHours,
        maintenanceStartedAt + totalBudgetMs * 0.6,
        compactBatchSize,
        [inboxRetentionDays]
      );
      deletedRejectedWalletOutcomes = await pruneInBatches(
        `WITH doomed AS (
           SELECT outcome.ctid
           FROM wallet_signal_outcomes AS outcome
           JOIN wallet_entry_signals AS entry
             ON entry.idempotency_key = outcome.entry_idempotency_key
           WHERE entry.observed_at < NOW() - make_interval(days => $1::integer)
             AND (
               entry.cohort = 'excluded-uncontrolled-flow'
               OR (
                 entry.flow_evidence @> '{"tokenRiskKnown":true}'::jsonb
                 AND NOT (entry.flow_evidence @> '{"tokenRiskPassed":true}'::jsonb)
               )
             )
           ORDER BY entry.observed_at, outcome.idempotency_key
           LIMIT $2
           FOR UPDATE OF outcome SKIP LOCKED
         )
         DELETE FROM wallet_signal_outcomes AS target
         USING doomed
         WHERE target.ctid = doomed.ctid`,
        rejectedWalletEvidenceRetentionDays,
        maintenanceStartedAt + totalBudgetMs * 0.64
      );
      deletedRejectedWalletEntries = await pruneInBatches(
        `WITH doomed AS (
           SELECT entry.ctid
           FROM wallet_entry_signals AS entry
           WHERE entry.observed_at < NOW() - make_interval(days => $1::integer)
             AND (
               entry.cohort = 'excluded-uncontrolled-flow'
               OR (
                 entry.flow_evidence @> '{"tokenRiskKnown":true}'::jsonb
                 AND NOT (entry.flow_evidence @> '{"tokenRiskPassed":true}'::jsonb)
               )
             )
             AND NOT EXISTS (
               SELECT 1 FROM wallet_signal_outcomes AS outcome
               WHERE outcome.entry_idempotency_key = entry.idempotency_key
             )
           ORDER BY entry.observed_at, entry.idempotency_key
           LIMIT $2
           FOR UPDATE OF entry SKIP LOCKED
         )
         DELETE FROM wallet_entry_signals AS target
         USING doomed
         WHERE target.ctid = doomed.ctid`,
        rejectedWalletEvidenceRetentionDays,
        maintenanceStartedAt + totalBudgetMs * 0.68
      );
      deletedWalletOutcomes = await pruneInBatches(
        `WITH doomed AS (
           SELECT ctid
           FROM wallet_signal_outcomes
           WHERE observed_at < NOW() - make_interval(days => $1::integer)
           ORDER BY observed_at, idempotency_key
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         DELETE FROM wallet_signal_outcomes AS target
         USING doomed
         WHERE target.ctid = doomed.ctid`,
        walletEvidenceRetentionDays,
        maintenanceStartedAt + totalBudgetMs * 0.72
      );
      deletedWalletEntries = await pruneInBatches(
        `WITH doomed AS (
           SELECT entry.ctid
           FROM wallet_entry_signals AS entry
           WHERE entry.observed_at < NOW() - make_interval(days => $1::integer)
             AND NOT EXISTS (
               SELECT 1 FROM wallet_signal_outcomes AS outcome
               WHERE outcome.entry_idempotency_key = entry.idempotency_key
             )
           ORDER BY entry.observed_at, entry.idempotency_key
           LIMIT $2
           FOR UPDATE OF entry SKIP LOCKED
         )
         DELETE FROM wallet_entry_signals AS target
         USING doomed
         WHERE target.ctid = doomed.ctid`,
        walletEvidenceRetentionDays,
        maintenanceStartedAt + totalBudgetMs * 0.76
      );
      deletedWalletTrades = await pruneInBatches(
        `WITH doomed AS (
           SELECT ctid, chain, wallet_address, strategy_version
           FROM wallet_trade_events
           WHERE observed_at < NOW() - make_interval(days => $1::integer)
           ORDER BY observed_at, idempotency_key
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         ), queued AS (
           INSERT INTO wallet_alpha_work_queue (
             chain, wallet_address, strategy_version, revision, updated_at, not_before
           )
           SELECT DISTINCT chain, wallet_address, strategy_version, 1, NOW(), NOW()
           FROM doomed
           ON CONFLICT (chain, wallet_address, strategy_version) DO UPDATE SET
             revision = wallet_alpha_work_queue.revision + 1,
             updated_at = NOW(),
             not_before = LEAST(wallet_alpha_work_queue.not_before, NOW())
           RETURNING 1
         )
         DELETE FROM wallet_trade_events AS target
         USING doomed
         WHERE target.ctid = doomed.ctid`,
        walletEvidenceRetentionDays,
        maintenanceStartedAt + totalBudgetMs * 0.88
      );
      deletedWalletEpisodes = await pruneInBatches(
        `WITH doomed AS (
           SELECT ctid
           FROM wallet_position_episodes
           WHERE status <> 'open'
             AND COALESCE(closed_at, opened_at) <
                 NOW() - make_interval(days => $1::integer)
           ORDER BY COALESCE(closed_at, opened_at), id
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         DELETE FROM wallet_position_episodes AS target
         USING doomed
         WHERE target.ctid = doomed.ctid`,
        walletEvidenceRetentionDays,
        maintenanceStartedAt + totalBudgetMs * 0.94
      );
      deletedWalletAlphaScores = await pruneInBatches(
        `WITH doomed AS (
           SELECT score.ctid
           FROM wallet_alpha_scores score
           WHERE (
               score.calculated_at < NOW() - make_interval(days => $3::integer)
               OR (
                 score.calculated_at < NOW() - make_interval(days => $1::integer)
                 AND EXISTS (
                   SELECT 1 FROM wallet_alpha_scores newer
                   WHERE newer.chain = score.chain
                     AND newer.wallet_address = score.wallet_address
                     AND newer.strategy_version = score.strategy_version
                     AND newer.calculated_at > score.calculated_at
                 )
               )
             )
           ORDER BY score.calculated_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         DELETE FROM wallet_alpha_scores AS target
         USING doomed
         WHERE target.ctid = doomed.ctid`,
        scoreRetentionDays,
        maintenanceStartedAt + totalBudgetMs,
        batchSize,
        [walletEvidenceRetentionDays]
      );
    }

    const priceRetentionState = await pool.query<{
      oldest_observed_at: Date | null;
      retention_lag_seconds: number;
    }>(
      `SELECT
         oldest.observed_at AS oldest_observed_at,
         GREATEST(
           0,
           EXTRACT(EPOCH FROM (
             NOW() - make_interval(days => $1::integer) - oldest.observed_at
           ))
         )::float AS retention_lag_seconds
       FROM (
         SELECT observed_at
         FROM price_observations
         ORDER BY observed_at
         LIMIT 1
       ) oldest`,
      [priceRetentionDays]
    );
    const chainPayloadState = await pool.query<{
      oldest_uncompacted_at: Date | null;
      compaction_lag_seconds: number;
    }>(
      `SELECT
         oldest.event_at AS oldest_uncompacted_at,
         GREATEST(
           0,
           EXTRACT(EPOCH FROM (
             NOW() - make_interval(hours => $1::integer) - oldest.event_at
           ))
         )::float AS compaction_lag_seconds
       FROM (
         SELECT COALESCE(processed_at, received_at) AS event_at
         FROM chain_event_inbox
         WHERE status = 'processed'
           AND payload_compacted_at IS NULL
         ORDER BY COALESCE(processed_at, received_at), idempotency_key
         LIMIT 1
       ) oldest`,
      [rawPayloadRetentionHours]
    );

    console.log(
      JSON.stringify({
        type: "operational-maintenance",
        status: dryRun ? "dry-run" : "completed",
        checkedAt: new Date().toISOString(),
        retentionDays: {
          priceObservations: priceRetentionDays,
          processedChainEvents: inboxRetentionDays,
          entryCandidateSwaps: swapRetentionDays,
          rawChainEventPayloadHours: rawPayloadRetentionHours,
          walletAlphaScores: scoreRetentionDays,
          walletEvidence: walletEvidenceRetentionDays,
          rejectedWalletEvidence: rejectedWalletEvidenceRetentionDays
        },
        eligibleBeforeRun: {
          priceObservations: Boolean(eligible.rows[0]?.price_observations),
          chainEventPayloads: Boolean(eligible.rows[0]?.chain_event_payloads),
          chainEvents: Boolean(eligible.rows[0]?.chain_events),
          swaps: Boolean(eligible.rows[0]?.swaps),
          walletAlphaScores: Boolean(eligible.rows[0]?.wallet_alpha_scores)
        },
        deleted: {
          priceObservations: deletedPriceObservations,
          compactedChainEventPayloads,
          chainEvents: deletedChainEvents,
          swaps: deletedSwaps,
          walletAlphaScores: deletedWalletAlphaScores,
          rejectedWalletOutcomes: deletedRejectedWalletOutcomes,
          rejectedWalletEntries: deletedRejectedWalletEntries,
          walletOutcomes: deletedWalletOutcomes,
          walletEntries: deletedWalletEntries,
          walletTrades: deletedWalletTrades,
          walletEpisodes: deletedWalletEpisodes,
          retiredPricePartitions,
          retiredPayloadPartitions,
          heldUnresolvedPayloads
        },
        databaseBytes: Number(eligible.rows[0]?.database_bytes ?? 0),
        priceRetention: {
          oldestObservedAt: priceRetentionState.rows[0]?.oldest_observed_at?.toISOString() ?? null,
          lagSeconds: Number(priceRetentionState.rows[0]?.retention_lag_seconds ?? 0)
        },
        chainPayloadCompaction: {
          oldestUncompactedAt:
            chainPayloadState.rows[0]?.oldest_uncompacted_at?.toISOString() ?? null,
          lagSeconds: Number(chainPayloadState.rows[0]?.compaction_lag_seconds ?? 0)
        },
        batchSize,
        compactBatchSize,
        maxBatches,
        maxRunSeconds,
        statementTimeoutMs,
        inventoryTimeoutMs,
        queryTimeoutCount
      })
    );
    await pool.query("SELECT pg_advisory_unlock(hashtext($1))", [
      "walletscaner-operational-maintenance"
    ]);
  }
} finally {
  await pool.end();
}

async function pruneInBatches(
  sql: string,
  retentionValue: number,
  deadline: number,
  mutationBatchSize = batchSize,
  additionalParameters: number[] = []
): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    if (Date.now() >= deadline) break;
    let result: pg.QueryResult;
    try {
      result = await pool.query(sql, [
        retentionValue,
        mutationBatchSize,
        ...additionalParameters
      ]);
    } catch (error) {
      if (isStatementTimeout(error)) {
        queryTimeoutCount += 1;
        break;
      }
      throw error;
    }
    const rows = result.rowCount ?? 0;
    deleted += rows;
    if (rows < mutationBatchSize) break;
  }
  return deleted;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function isStatementTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "57014"
  );
}

async function ensurePayloadPartitions(futureDays: number): Promise<void> {
  const today = utcDayStart(new Date());
  for (let offset = -1; offset <= futureDays; offset += 1) {
    const lower = addUtcDays(today, offset);
    const upper = addUtcDays(lower, 1);
    const name = payloadPartitionName(lower);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${name}
         PARTITION OF chain_event_payloads
         FOR VALUES FROM ('${timestampBoundary(lower)}')
                    TO ('${timestampBoundary(upper)}')`
    );
  }
}

async function ensurePricePartitions(futureDays: number): Promise<void> {
  const today = utcDayStart(new Date());
  for (let offset = 0; offset <= futureDays; offset += 1) {
    const lower = addUtcDays(today, offset);
    const upper = addUtcDays(lower, 1);
    const name = pricePartitionName(lower);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${name}
         PARTITION OF price_observations
         FOR VALUES FROM ('${timestampBoundary(lower)}')
                    TO ('${timestampBoundary(upper)}')`
    );
    await pool.query(
      `ALTER TABLE ${name} SET (
         autovacuum_vacuum_scale_factor = 0.03,
         autovacuum_analyze_scale_factor = 0.02,
         autovacuum_vacuum_threshold = 2000,
         autovacuum_analyze_threshold = 1000
       )`
    );
  }
}

async function retirePricePartitions(retentionDays: number): Promise<number> {
  const result = await pool.query<{ relname: string }>(
    `SELECT child.relname
     FROM pg_inherits
     JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
     JOIN pg_class child ON child.oid = pg_inherits.inhrelid
     WHERE parent.oid = 'price_observations'::regclass
     ORDER BY child.relname`
  );
  const cutoff = addUtcDays(utcDayStart(new Date()), -Math.max(retentionDays, 1));
  let partitions = 0;
  for (const row of result.rows) {
    const lower = pricePartitionDate(row.relname);
    if (!lower || addUtcDays(lower, 1).getTime() > cutoff.getTime()) continue;
    await pool.query(`DROP TABLE ${row.relname}`);
    partitions += 1;
  }
  return partitions;
}

async function retirePayloadPartitions(
  retentionDays: number
): Promise<{ partitions: number; heldPayloads: number }> {
  const result = await pool.query<{ relname: string }>(
    `SELECT child.relname
     FROM pg_inherits
     JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
     JOIN pg_class child ON child.oid = pg_inherits.inhrelid
     WHERE parent.oid = 'chain_event_payloads'::regclass
     ORDER BY child.relname`
  );
  const cutoff = addUtcDays(utcDayStart(new Date()), -Math.max(retentionDays, 1));
  let partitions = 0;
  let heldPayloads = 0;
  for (const row of result.rows) {
    const lower = payloadPartitionDate(row.relname);
    if (!lower || addUtcDays(lower, 1).getTime() > cutoff.getTime()) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const held = await client.query(
        `INSERT INTO chain_event_payload_holds (
           event_idempotency_key, received_at, payload, payload_sha256
         )
         SELECT payload.event_idempotency_key, payload.received_at,
                payload.payload, payload.payload_sha256
         FROM ${row.relname} AS payload
         JOIN chain_event_inbox AS event
           ON event.idempotency_key = payload.event_idempotency_key
         WHERE event.status NOT IN ('processed', 'rolled_back')
         ON CONFLICT (event_idempotency_key) DO NOTHING`
      );
      await client.query(`DROP TABLE ${row.relname}`);
      await client.query("COMMIT");
      partitions += 1;
      heldPayloads += held.rowCount ?? 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return { partitions, heldPayloads };
}

function payloadPartitionName(date: Date): string {
  return `chain_event_payloads_${date.toISOString().slice(0, 10).replaceAll("-", "")}`;
}

function pricePartitionName(date: Date): string {
  return `price_observations_${date.toISOString().slice(0, 10).replaceAll("-", "")}`;
}

function pricePartitionDate(name: string): Date | undefined {
  const match = /^price_observations_(\d{4})(\d{2})(\d{2})$/.exec(name);
  if (!match) return undefined;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function payloadPartitionDate(name: string): Date | undefined {
  const match = /^chain_event_payloads_(\d{4})(\d{2})(\d{2})$/.exec(name);
  if (!match) return undefined;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function timestampBoundary(date: Date): string {
  return `${date.toISOString().slice(0, 10)} 00:00:00+00`;
}
