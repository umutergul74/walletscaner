import "dotenv/config";
import { mkdir, rename, writeFile } from "node:fs/promises";
import pg from "pg";
import {
  archiveRetirementPolicyStatus,
  retireVerifiedPayloadPartitions
} from "@memecoin-alpha/db/archive-retention";
import {
  ensurePayloadPartitions,
  ensurePricePartitions,
  type PartitionEnsureResult
} from "./partition-maintenance.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for operational maintenance.");

const priceRetentionDays = positiveInt(process.env.PRICE_OBSERVATION_RETENTION_DAYS, 2);
const inboxRetentionDays = positiveInt(process.env.CHAIN_EVENT_RETENTION_DAYS, 3);
const swapRetentionDays = positiveInt(process.env.SWAP_RETENTION_DAYS, 3);
const signatureQueueRetentionDays = positiveInt(
  process.env.SOLANA_SIGNATURE_QUEUE_RETENTION_DAYS,
  3
);
const gapRepairSignatureRetentionDays = positiveInt(
  process.env.SOLANA_GAP_REPAIR_SIGNATURE_RETENTION_DAYS,
  3
);
const finalityRetentionDays = positiveInt(process.env.SOLANA_FINALITY_RETENTION_DAYS, 95);
const rawPayloadRetentionHours = positiveInt(
  process.env.CHAIN_EVENT_RAW_PAYLOAD_RETENTION_HOURS,
  48
);
const scoreRetentionDays = positiveInt(process.env.WALLET_ALPHA_SCORE_RETENTION_DAYS, 7);
const walletEvidenceRetentionDays = positiveInt(process.env.WALLET_EVIDENCE_RETENTION_DAYS, 95);
const rejectedWalletEvidenceRetentionDays = positiveInt(
  process.env.REJECTED_WALLET_EVIDENCE_RETENTION_DAYS,
  3
);
const batchSize = positiveInt(process.env.MAINTENANCE_DELETE_BATCH_SIZE, 5_000);
const inboxBatchSize = positiveInt(process.env.MAINTENANCE_INBOX_DELETE_BATCH_SIZE, 500);
const compactBatchSize = positiveInt(process.env.MAINTENANCE_COMPACT_BATCH_SIZE, 500);
const maxBatches = positiveInt(process.env.MAINTENANCE_MAX_BATCHES_PER_RUN, 50);
const maxRunSeconds = positiveInt(process.env.MAINTENANCE_MAX_RUN_SECONDS, 30);
const statementTimeoutMs = positiveInt(process.env.MAINTENANCE_STATEMENT_TIMEOUT_MS, 5_000);
const compactionStatementTimeoutMs = positiveInt(
  process.env.MAINTENANCE_COMPACTION_STATEMENT_TIMEOUT_MS,
  7_500
);
const inventoryTimeoutMs = positiveInt(
  process.env.MAINTENANCE_INVENTORY_STATEMENT_TIMEOUT_MS,
  15_000
);
const payloadPartitionFutureDays = positiveInt(
  process.env.CHAIN_EVENT_PAYLOAD_PARTITION_FUTURE_DAYS,
  8
);
const partitionLockTimeoutMs = positiveInt(
  process.env.MAINTENANCE_PARTITION_LOCK_TIMEOUT_MS,
  1_500
);
const compactionPriorityLagSeconds = positiveInt(
  process.env.MAINTENANCE_COMPACTION_PRIORITY_LAG_SECONDS,
  3_600
);
const dryRun = parseBoolean(process.env.MAINTENANCE_DRY_RUN, false);
const archiveRetirementEnabled = parseBoolean(process.env.ARCHIVE_RETIREMENT_ENABLED, false);
const archiveMinimumRemainingDays = positiveInt(
  process.env.ARCHIVE_OBJECT_LOCK_MIN_REMAINING_DAYS,
  7
);
const maintenanceReportPath = "reports/operational-maintenance-latest.json";
const pool = new pg.Pool({
  connectionString: databaseUrl,
  // One pinned session owns the advisory lock while the second connection
  // performs bounded maintenance work. Session-level advisory locks must be
  // released by the same PostgreSQL backend that acquired them.
  max: 2,
  statement_timeout: inventoryTimeoutMs
});
let queryTimeoutCount = 0;
const queryTimeoutsByStage: Record<string, number> = {};
let lockClient: pg.PoolClient | undefined;
let lockAcquired = false;

try {
  lockClient = await pool.connect();
  const lock = await lockClient.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
    ["walletscaner-operational-maintenance"]
  );
  lockAcquired = Boolean(lock.rows[0]?.locked);
  if (!lockAcquired) {
    console.log(JSON.stringify({ type: "operational-maintenance", status: "skipped-lock-held" }));
    process.exitCode = 0;
  } else {
    const eligible = await pool.query<{
      price_observations: boolean;
      chain_event_payloads: boolean;
      chain_event_payloads_overdue: boolean;
      chain_events: boolean;
      swaps: boolean;
      solana_signature_queue: boolean;
      ingestion_gap_repair_signatures: boolean;
      solana_transaction_finality: boolean;
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
          WHERE status = 'processed'
            AND payload_compacted_at IS NULL
            AND COALESCE(processed_at, received_at) <
                NOW() - make_interval(hours => $4::integer)
                      - make_interval(secs => $10::integer))
           AS chain_event_payloads_overdue,
         EXISTS(SELECT 1 FROM chain_event_inbox
          WHERE status IN ('processed', 'rolled_back')
            AND COALESCE(processed_at, received_at) <
                NOW() - make_interval(days => $2::integer))
           AS chain_events,
         EXISTS(SELECT 1 FROM swaps
          WHERE observed_at < NOW() - make_interval(days => $5::integer))
           AS swaps,
         EXISTS(SELECT 1 FROM solana_signature_queue
          WHERE status = 'completed'
            AND completed_at < NOW() - make_interval(days => $7::integer))
           AS solana_signature_queue,
         EXISTS(
           SELECT 1
           FROM ingestion_gap_repair_signatures signature
           JOIN ingestion_gap_repairs repair ON repair.repair_id = signature.repair_id
           WHERE repair.status = 'completed'
             AND signature.completed_at < NOW() - make_interval(days => $9::integer)
         ) AS ingestion_gap_repair_signatures,
         EXISTS(SELECT 1 FROM solana_transaction_finality
          WHERE status <> 'pending'
            AND updated_at < NOW() - make_interval(days => $8::integer))
           AS solana_transaction_finality,
         (
           EXISTS(SELECT 1 FROM wallet_alpha_scores score
            WHERE score.calculated_at < NOW() - make_interval(days => $6::integer))
           OR EXISTS(SELECT 1 FROM wallet_alpha_score_supersessions supersession
            WHERE supersession.calculated_at <
                  NOW() - make_interval(days => $3::integer))
         ) AS wallet_alpha_scores,
         pg_database_size(current_database())::text AS database_bytes`,
      [
        priceRetentionDays,
        inboxRetentionDays,
        scoreRetentionDays,
        rawPayloadRetentionHours,
        swapRetentionDays,
        walletEvidenceRetentionDays,
        signatureQueueRetentionDays,
        finalityRetentionDays,
        gapRepairSignatureRetentionDays,
        compactionPriorityLagSeconds
      ]
    );
    const archivePolicy = await archiveRetirementPolicyStatus(pool, archiveMinimumRemainingDays);
    const archiveMutationsEnabled = archiveRetirementEnabled && archivePolicy.ready;
    await pool.query("SELECT set_config('statement_timeout', $1, false)", [
      `${statementTimeoutMs}ms`
    ]);

    let deletedPriceObservations = 0;
    let compactedChainEventPayloads = 0;
    let deletedChainEvents = 0;
    let deletedSwaps = 0;
    let deletedSolanaSignatures = 0;
    let deletedGapRepairSignatures = 0;
    let deletedSolanaFinalities = 0;
    let deletedWalletAlphaScores = 0;
    let deletedExpiredWalletAlphaScores = 0;
    let deletedSupersededWalletAlphaScores = 0;
    let deletedRejectedWalletOutcomes = 0;
    let deletedRejectedWalletEntries = 0;
    let deletedWalletOutcomes = 0;
    let deletedWalletEntries = 0;
    let deletedWalletTrades = 0;
    let deletedWalletEpisodes = 0;
    let retiredPayloadPartitions = 0;
    let archiveBlockedPayloadPartitions = 0;
    let heldUnresolvedPayloads = 0;
    let retiredPricePartitions = 0;
    let payloadPartitionEnsure: PartitionEnsureResult = { existing: 0, created: 0, deferred: 0 };
    let pricePartitionEnsure: PartitionEnsureResult = { existing: 0, created: 0, deferred: 0 };
    const maintenanceStartedAt = Date.now();
    const totalBudgetMs = maxRunSeconds * 1_000;
    if (!dryRun) {
      payloadPartitionEnsure = await ensurePayloadPartitions(pool, payloadPartitionFutureDays, {
        lockTimeoutMs: partitionLockTimeoutMs,
        statementTimeoutMs
      });
      const retired = await retireVerifiedPayloadPartitions(
        pool,
        rawPayloadRetentionHours,
        archiveRetirementEnabled,
        archiveMinimumRemainingDays
      );
      retiredPayloadPartitions = retired.partitions;
      heldUnresolvedPayloads = retired.heldPayloads;
      archiveBlockedPayloadPartitions = retired.blockedPartitions;
      pricePartitionEnsure = await ensurePricePartitions(pool, payloadPartitionFutureDays, {
        lockTimeoutMs: partitionLockTimeoutMs,
        statementTimeoutMs
      });
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
        maintenanceStartedAt + totalBudgetMs * 0.3,
        batchSize,
        [],
        "price-observations"
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
        maintenanceStartedAt + totalBudgetMs * 0.32,
        batchSize,
        [],
        "price-observation-keys"
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
        maintenanceStartedAt + totalBudgetMs * 0.45,
        batchSize,
        [],
        "swaps"
      );
      deletedSolanaSignatures = await pruneInBatches(
        `WITH doomed AS (
           SELECT provider, address, signature
           FROM solana_signature_queue
           WHERE status = 'completed'
             AND completed_at < NOW() - make_interval(days => $1::integer)
           ORDER BY completed_at, provider, address, signature
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         DELETE FROM solana_signature_queue AS target
         USING doomed
         WHERE target.provider = doomed.provider
           AND target.address = doomed.address
           AND target.signature = doomed.signature`,
        signatureQueueRetentionDays,
        maintenanceStartedAt + totalBudgetMs * 0.5,
        batchSize,
        [],
        "solana-signature-queue"
      );
      deletedGapRepairSignatures = await pruneInBatches(
        `WITH doomed AS (
           SELECT signature.repair_id, signature.signature
           FROM ingestion_gap_repair_signatures signature
           JOIN ingestion_gap_repairs repair ON repair.repair_id = signature.repair_id
           WHERE repair.status = 'completed'
             AND signature.completed_at < NOW() - make_interval(days => $1::integer)
           ORDER BY signature.completed_at, signature.repair_id, signature.signature
           LIMIT $2
           FOR UPDATE OF signature SKIP LOCKED
         )
         DELETE FROM ingestion_gap_repair_signatures AS target
         USING doomed
         WHERE target.repair_id = doomed.repair_id
           AND target.signature = doomed.signature`,
        gapRepairSignatureRetentionDays,
        maintenanceStartedAt + totalBudgetMs * 0.51,
        batchSize,
        [],
        "ingestion-gap-repair-signatures"
      );
      deletedSolanaFinalities = await pruneInBatches(
        `WITH doomed AS (
           SELECT chain, signature
           FROM solana_transaction_finality
           WHERE status <> 'pending'
             AND updated_at < NOW() - make_interval(days => $1::integer)
           ORDER BY updated_at, signature
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         DELETE FROM solana_transaction_finality AS target
         USING doomed
         WHERE target.chain = doomed.chain
           AND target.signature = doomed.signature`,
        finalityRetentionDays,
        maintenanceStartedAt + totalBudgetMs * 0.52,
        batchSize,
        [],
        "solana-finality"
      );
      if (archiveMutationsEnabled) {
        if (!eligible.rows[0]?.chain_event_payloads_overdue) {
          deletedChainEvents = await pruneInBatches(
            `WITH eligible_archive AS MATERIALIZED (
           SELECT archive.range_start, archive.range_end
           FROM archive_segments AS archive
           WHERE archive.source_kind = 'chain-event-payloads'
             AND archive.status = 'verified'
             AND archive.object_lock_evidence IN (
               'api-verified', 'attested-default-policy'
             )
             AND archive.retain_until >
                 NOW() + make_interval(days => $3::integer)
             AND EXISTS (
               SELECT 1
               FROM chain_event_inbox AS candidate
               WHERE candidate.status IN ('processed', 'rolled_back')
                 AND candidate.received_at >= archive.range_start
                 AND candidate.received_at < archive.range_end
                 AND COALESCE(candidate.processed_at, candidate.received_at) <
                     NOW() - make_interval(days => $1::integer)
             )
           ORDER BY archive.range_start
           LIMIT 1
         ), doomed AS (
           SELECT candidate.ctid
           FROM eligible_archive AS archive
           CROSS JOIN LATERAL (
             SELECT target.ctid
             FROM chain_event_inbox AS target
             WHERE target.status IN ('processed', 'rolled_back')
               AND target.received_at >= archive.range_start
               AND target.received_at < archive.range_end
               AND COALESCE(target.processed_at, target.received_at) <
                   NOW() - make_interval(days => $1::integer)
             ORDER BY target.received_at, target.idempotency_key
             LIMIT $2
             FOR UPDATE OF target SKIP LOCKED
           ) AS candidate
        )
         DELETE FROM chain_event_inbox AS target
         USING doomed
         WHERE target.ctid = doomed.ctid`,
            inboxRetentionDays,
            // Inbox metadata retirement is useful but must not consume the
            // payload-compaction capacity that returns hot JSON space. If the
            // earlier bounded stages run long, skip this cycle and preserve the
            // later compaction budget.
            maintenanceStartedAt + totalBudgetMs * 0.48,
            inboxBatchSize,
            [archiveMinimumRemainingDays],
            "chain-event-inbox"
          );
        }
        await pool.query("SELECT set_config('statement_timeout', $1, false)", [
          `${compactionStatementTimeoutMs}ms`
        ]);
        try {
          compactedChainEventPayloads = await pruneInBatches(
            `WITH candidates AS MATERIALIZED (
           SELECT target.ctid, target.idempotency_key,
                  target.received_at, target.payload_sha256
           FROM chain_event_inbox AS target
           WHERE target.status = 'processed'
             AND target.payload_compacted_at IS NULL
             AND target.payload_sha256 IS NOT NULL
             AND COALESCE(target.processed_at, target.received_at) <
                 NOW() - make_interval(hours => $1::integer)
             AND EXISTS (
               SELECT 1
               FROM archive_segments AS archive
               WHERE archive.source_kind = 'chain-event-payloads'
                 AND archive.status = 'verified'
                 AND archive.object_lock_evidence IN (
                   'api-verified', 'attested-default-policy'
                 )
                 AND archive.retain_until >
                     NOW() + make_interval(days => $3::integer)
                 AND target.received_at >= archive.range_start
                 AND target.received_at < archive.range_end
             )
           ORDER BY COALESCE(target.processed_at, target.received_at),
                    target.idempotency_key
           LIMIT $2
           FOR UPDATE OF target SKIP LOCKED
         ), retired_hot_payload AS (
           DELETE FROM chain_event_payloads AS payload
           USING candidates
           WHERE payload.received_at = candidates.received_at
             AND payload.event_idempotency_key = candidates.idempotency_key
           RETURNING payload.event_idempotency_key
         ), retired_held_payload AS (
           DELETE FROM chain_event_payload_holds AS payload
           USING candidates
           WHERE payload.received_at = candidates.received_at
             AND payload.event_idempotency_key = candidates.idempotency_key
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
            maintenanceStartedAt + totalBudgetMs * 0.92,
            compactBatchSize,
            [archiveMinimumRemainingDays],
            "chain-event-payloads"
          );
        } finally {
          await pool.query("SELECT set_config('statement_timeout', $1, false)", [
            `${statementTimeoutMs}ms`
          ]);
        }
      }
      const rejectedEvidence = await pruneRejectedWalletEvidence(
        maintenanceStartedAt + totalBudgetMs * 0.94
      );
      deletedRejectedWalletOutcomes = rejectedEvidence.outcomes;
      deletedRejectedWalletEntries = rejectedEvidence.entries;
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
        maintenanceStartedAt + totalBudgetMs * 0.95,
        batchSize,
        [],
        "wallet-outcomes"
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
        maintenanceStartedAt + totalBudgetMs * 0.96,
        batchSize,
        [],
        "wallet-entries"
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
           SELECT enqueue_wallet_alpha_work(
             chain,
             wallet_address,
             strategy_version,
             0::smallint,
             'trade-retention'
           )
           FROM (
             SELECT DISTINCT chain, wallet_address, strategy_version FROM doomed
           ) wallets
         )
         DELETE FROM wallet_trade_events AS target
         USING doomed
         WHERE target.ctid = doomed.ctid`,
        walletEvidenceRetentionDays,
        maintenanceStartedAt + totalBudgetMs * 0.98,
        batchSize,
        [],
        "wallet-trades"
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
        maintenanceStartedAt + totalBudgetMs * 0.94,
        batchSize,
        [],
        "wallet-episodes"
      );
      deletedExpiredWalletAlphaScores = await pruneInBatches(
        `WITH doomed AS (
           SELECT score.ctid
           FROM wallet_alpha_scores AS score
           WHERE score.calculated_at < NOW() - make_interval(days => $1::integer)
           ORDER BY score.calculated_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
         )
         DELETE FROM wallet_alpha_scores AS target
         USING doomed
         WHERE target.ctid = doomed.ctid`,
        walletEvidenceRetentionDays,
        maintenanceStartedAt + totalBudgetMs,
        inboxBatchSize,
        [],
        "wallet-alpha-scores-hard-expiry"
      );
      deletedSupersededWalletAlphaScores = await pruneInBatches(
        `WITH doomed AS (
           SELECT
             supersession.chain,
             supersession.wallet_address,
             supersession.strategy_version,
             supersession.calculated_at
           FROM wallet_alpha_score_supersessions AS supersession
           JOIN wallet_alpha_scores AS score
             ON score.chain = supersession.chain
            AND score.wallet_address = supersession.wallet_address
            AND score.strategy_version = supersession.strategy_version
            AND score.calculated_at = supersession.calculated_at
           WHERE supersession.calculated_at <
                 NOW() - make_interval(days => $1::integer)
           ORDER BY supersession.calculated_at, supersession.chain,
                    supersession.wallet_address, supersession.strategy_version
           LIMIT $2
           FOR UPDATE OF score SKIP LOCKED
         )
         DELETE FROM wallet_alpha_scores AS target
         USING doomed
         WHERE target.chain = doomed.chain
           AND target.wallet_address = doomed.wallet_address
           AND target.strategy_version = doomed.strategy_version
           AND target.calculated_at = doomed.calculated_at`,
        scoreRetentionDays,
        maintenanceStartedAt + totalBudgetMs,
        inboxBatchSize,
        [],
        "wallet-alpha-scores-superseded"
      );
      deletedWalletAlphaScores =
        deletedExpiredWalletAlphaScores + deletedSupersededWalletAlphaScores;
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

    const maintenanceReport = {
      type: "operational-maintenance",
      status: dryRun ? "dry-run" : "completed",
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - maintenanceStartedAt,
      retentionDays: {
        priceObservations: priceRetentionDays,
        processedChainEvents: inboxRetentionDays,
        entryCandidateSwaps: swapRetentionDays,
        completedSolanaSignatures: signatureQueueRetentionDays,
        completedGapRepairSignatures: gapRepairSignatureRetentionDays,
        solanaFinality: finalityRetentionDays,
        rawChainEventPayloadHours: rawPayloadRetentionHours,
        walletAlphaScores: scoreRetentionDays,
        walletEvidence: walletEvidenceRetentionDays,
        rejectedWalletEvidence: rejectedWalletEvidenceRetentionDays
      },
      eligibleBeforeRun: {
        priceObservations: Boolean(eligible.rows[0]?.price_observations),
        chainEventPayloads: Boolean(eligible.rows[0]?.chain_event_payloads),
        chainEventPayloadsOverdue: Boolean(eligible.rows[0]?.chain_event_payloads_overdue),
        chainEvents: Boolean(eligible.rows[0]?.chain_events),
        swaps: Boolean(eligible.rows[0]?.swaps),
        solanaSignatureQueue: Boolean(eligible.rows[0]?.solana_signature_queue),
        gapRepairSignatures: Boolean(eligible.rows[0]?.ingestion_gap_repair_signatures),
        solanaFinality: Boolean(eligible.rows[0]?.solana_transaction_finality),
        walletAlphaScores: Boolean(eligible.rows[0]?.wallet_alpha_scores)
      },
      archiveRetirement: {
        runtimeEnabled: archiveRetirementEnabled,
        policyReady: archivePolicy.ready,
        mutationsEnabled: archiveMutationsEnabled,
        activatedAt: archivePolicy.activatedAt ?? null,
        futureCanaryRangeStart: archivePolicy.futureCanaryRangeStart ?? null,
        retirementEnabledAt: archivePolicy.retirementEnabledAt ?? null
      },
      deleted: {
        priceObservations: deletedPriceObservations,
        compactedChainEventPayloads,
        chainEvents: deletedChainEvents,
        swaps: deletedSwaps,
        solanaSignatures: deletedSolanaSignatures,
        gapRepairSignatures: deletedGapRepairSignatures,
        solanaFinalities: deletedSolanaFinalities,
        walletAlphaScores: deletedWalletAlphaScores,
        walletAlphaScoresHardExpiry: deletedExpiredWalletAlphaScores,
        walletAlphaScoresSuperseded: deletedSupersededWalletAlphaScores,
        rejectedWalletOutcomes: deletedRejectedWalletOutcomes,
        rejectedWalletEntries: deletedRejectedWalletEntries,
        walletOutcomes: deletedWalletOutcomes,
        walletEntries: deletedWalletEntries,
        walletTrades: deletedWalletTrades,
        walletEpisodes: deletedWalletEpisodes,
        retiredPricePartitions,
        retiredPayloadPartitions,
        heldUnresolvedPayloads,
        archiveBlockedPayloadPartitions
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
      partitionEnsure: {
        payload: payloadPartitionEnsure,
        price: pricePartitionEnsure,
        lockTimeoutMs: partitionLockTimeoutMs
      },
      compactionPriorityLagSeconds,
      batchSize,
      inboxBatchSize,
      compactBatchSize,
      maxBatches,
      maxRunSeconds,
      statementTimeoutMs,
      compactionStatementTimeoutMs,
      inventoryTimeoutMs,
      queryTimeoutCount,
      queryTimeoutsByStage
    };
    try {
      await mkdir("reports", { recursive: true });
      await writeFile(`${maintenanceReportPath}.tmp`, JSON.stringify(maintenanceReport, null, 2));
      await rename(`${maintenanceReportPath}.tmp`, maintenanceReportPath);
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "operational-maintenance-report-error",
          message: error instanceof Error ? error.message : String(error)
        })
      );
    }
    console.log(JSON.stringify(maintenanceReport));
  }
} finally {
  try {
    if (lockClient && lockAcquired) {
      await lockClient.query("SELECT pg_advisory_unlock(hashtext($1))", [
        "walletscaner-operational-maintenance"
      ]);
    }
  } finally {
    lockClient?.release();
    await pool.end();
  }
}

async function pruneRejectedWalletEvidence(
  deadline: number
): Promise<{ outcomes: number; entries: number }> {
  let deletedOutcomes = 0;
  let deletedEntries = 0;
  const client = await pool.connect();
  let destroyClient = false;
  try {
    for (let batch = 0; batch < maxBatches; batch += 1) {
      if (Date.now() >= deadline) break;
      let stage = "rejected-wallet-selection";
      try {
        await client.query("BEGIN");
        const selected = await client.query<{ idempotency_key: string }>(
          `SELECT entry.idempotency_key
           FROM wallet_entry_signals AS entry
           WHERE entry.observed_at < NOW() - make_interval(days => $1::integer)
             AND (
               entry.cohort = 'excluded-uncontrolled-flow'
               OR (
                 entry.flow_evidence @> '{"tokenRiskKnown":true}'::jsonb
                 AND NOT (entry.flow_evidence @> '{"tokenRiskPassed":true}'::jsonb)
               )
             )
           ORDER BY entry.observed_at, entry.idempotency_key
           LIMIT $2
           FOR UPDATE OF entry SKIP LOCKED`,
          [rejectedWalletEvidenceRetentionDays, inboxBatchSize]
        );
        const entryKeys = selected.rows.map((row) => row.idempotency_key);
        if (entryKeys.length === 0) {
          await client.query("COMMIT");
          break;
        }

        stage = "rejected-wallet-outcomes";
        const outcomes = await client.query(
          `DELETE FROM wallet_signal_outcomes
           WHERE entry_idempotency_key = ANY($1::text[])`,
          [entryKeys]
        );

        stage = "rejected-wallet-entries";
        const entries = await client.query(
          `DELETE FROM wallet_entry_signals
           WHERE idempotency_key = ANY($1::text[])`,
          [entryKeys]
        );
        if ((entries.rowCount ?? 0) !== entryKeys.length) {
          throw new Error(
            `Rejected-evidence retention selected ${entryKeys.length} entries but deleted ${entries.rowCount ?? 0}.`
          );
        }
        await client.query("COMMIT");
        deletedOutcomes += outcomes.rowCount ?? 0;
        deletedEntries += entries.rowCount ?? 0;
        if (entryKeys.length < inboxBatchSize) break;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          destroyClient = true;
        }
        if (isStatementTimeout(error)) {
          recordStageTimeout(stage);
          break;
        }
        throw error;
      }
    }
  } finally {
    client.release(destroyClient);
  }
  return { outcomes: deletedOutcomes, entries: deletedEntries };
}

async function pruneInBatches(
  sql: string,
  retentionValue: number,
  deadline: number,
  mutationBatchSize = batchSize,
  additionalParameters: number[] = [],
  stage = "unknown"
): Promise<number> {
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    if (Date.now() >= deadline) break;
    let result: pg.QueryResult;
    try {
      result = await pool.query(sql, [retentionValue, mutationBatchSize, ...additionalParameters]);
    } catch (error) {
      if (isStatementTimeout(error)) {
        recordStageTimeout(stage);
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

function recordStageTimeout(stage: string): void {
  queryTimeoutCount += 1;
  queryTimeoutsByStage[stage] = (queryTimeoutsByStage[stage] ?? 0) + 1;
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
  return typeof error === "object" && error !== null && "code" in error && error.code === "57014";
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

function pricePartitionDate(name: string): Date | undefined {
  const match = /^price_observations_(\d{4})(\d{2})(\d{2})$/.exec(name);
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
