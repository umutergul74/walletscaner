import "dotenv/config";
import { mkdir, readFile, rename, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import pg from "pg";
import { updateStorageHistory } from "./storage-runway";
import { inspectBackupDirectory } from "./backup-health";
import { quotePricePrerequisite } from "./quote-price-prerequisite";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for operational monitoring.");

const maxBacklog = positiveNumber(process.env.OPERATIONS_MAX_BACKLOG, 100);
const maxPendingAgeSeconds = positiveNumber(process.env.OPERATIONS_MAX_PENDING_AGE_SECONDS, 120);
const maxFinalityPendingAgeSeconds = positiveNumber(
  process.env.OPERATIONS_MAX_FINALITY_PENDING_AGE_SECONDS,
  120
);
const maxSignaturePendingAgeSeconds = positiveNumber(
  process.env.OPERATIONS_MAX_SIGNATURE_PENDING_AGE_SECONDS,
  120
);
const maxEventLagSeconds = positiveNumber(process.env.OPERATIONS_MAX_EVENT_LAG_SECONDS, 600);
const maxDiskUsedPercent = positiveNumber(process.env.OPERATIONS_MAX_DISK_USED_PERCENT, 85);
const maxLoadPerCpu = positiveNumber(process.env.OPERATIONS_MAX_LOAD_PER_CPU, 1.5);
const criticalDiskUsedPercent = positiveNumber(
  process.env.OPERATIONS_CRITICAL_DISK_USED_PERCENT,
  92
);
const maxDatabaseBytes = positiveNumber(process.env.OPERATIONS_MAX_DATABASE_BYTES, 10 * 1024 ** 3);
const priceRetentionDays = positiveNumber(process.env.PRICE_OBSERVATION_RETENTION_DAYS, 2);
const swapRetentionDays = positiveNumber(process.env.SWAP_RETENTION_DAYS, 3);
const rawPayloadRetentionHours = positiveNumber(
  process.env.CHAIN_EVENT_RAW_PAYLOAD_RETENTION_HOURS,
  48
);
const maxPriceRetentionLagSeconds = positiveNumber(
  process.env.OPERATIONS_MAX_PRICE_RETENTION_LAG_SECONDS,
  3_600
);
const maxChainPayloadCompactionLagSeconds = positiveNumber(
  process.env.OPERATIONS_MAX_CHAIN_PAYLOAD_COMPACTION_LAG_SECONDS,
  3_600
);
const maxSwapRetentionLagSeconds = positiveNumber(
  process.env.OPERATIONS_MAX_SWAP_RETENTION_LAG_SECONDS,
  3_600
);
const archiveEnabled = parseBoolean(process.env.ARCHIVE_ENABLED, false);
const maxArchiveUnverifiedAgeSeconds = positiveNumber(
  process.env.OPERATIONS_MAX_ARCHIVE_UNVERIFIED_AGE_SECONDS,
  86_400
);
const walletArchiveSettleHours = positiveNumber(
  process.env.ARCHIVE_WALLET_EVIDENCE_SETTLE_HOURS,
  72
);
const maxWalletArchiveLagSeconds = positiveNumber(
  process.env.OPERATIONS_MAX_WALLET_ARCHIVE_LAG_SECONDS,
  2 * 86_400
);
const maxWalletCompactLagSeconds = positiveNumber(
  process.env.OPERATIONS_MAX_WALLET_COMPACT_LAG_SECONDS,
  86_400
);
const archiveMinimumRemainingDays = Math.floor(
  positiveNumber(process.env.ARCHIVE_OBJECT_LOCK_MIN_REMAINING_DAYS, 7)
);
const alertCooldownMinutes = positiveNumber(process.env.OPERATIONS_ALERT_COOLDOWN_MINUTES, 30);
const storageReserveBytes = positiveNumber(
  process.env.OPERATIONS_STORAGE_RESERVE_BYTES,
  8 * 1024 ** 3
);
const minimumStorageRunwayDays = positiveNumber(process.env.OPERATIONS_MIN_STORAGE_RUNWAY_DAYS, 14);
const maximumBackupAgeSeconds = positiveNumber(
  process.env.OPERATIONS_MAX_BACKUP_AGE_SECONDS,
  30 * 3_600
);
const reportPath = "reports/operational-health.json";
const alertStatePath = "reports/operational-alert-state.json";
const storageHistoryPath = "reports/operational-storage-history.jsonl";
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });

try {
  const result = await pool.query<{
    backlog: number;
    dead_letters: number;
    oldest_pending_age_seconds: number | null;
    last_pool_age_seconds: number | null;
    last_swap_age_seconds: number | null;
    last_wallet_trade_age_seconds: number | null;
    database_bytes: string;
    oldest_price_observed_at: Date | null;
    recent_price_observation_count: number;
    oldest_swap_observed_at: Date | null;
    oldest_uncompacted_chain_event_at: Date | null;
    archive_pending_segments: number;
    archive_verify_pending_segments: number;
    archive_dead_letter_segments: number;
    archive_oldest_unverified_at: Date | null;
    archive_latest_verified_at: Date | null;
    archive_retirement_policy_ready: boolean;
    wallet_archive_pending_segments: number;
    wallet_archive_dead_letter_segments: number;
    wallet_archive_latest_verified_end: Date | null;
    wallet_compact_pending_days: number;
    wallet_compact_mismatch_days: number;
    wallet_compact_retry_days: number;
    wallet_compact_latest_verified_end: Date | null;
    wallet_compact_oldest_pending_verified_at: Date | null;
    finality_pending: number;
    finality_oldest_pending_age_seconds: number | null;
    finality_unresolved_24h: number;
    signature_queue_pending: number;
    signature_queue_oldest_pending_age_seconds: number | null;
  }>(
    `WITH unresolved AS (
       SELECT
         COUNT(*)::integer AS backlog,
         EXTRACT(EPOCH FROM (NOW() - MIN(received_at)))::float
           AS oldest_pending_age_seconds
       FROM chain_event_inbox
       WHERE status IN ('pending', 'processing', 'retry')
         AND (NOT finality_required OR commitment = 'finalized')
     )
     SELECT unresolved.*,
       CASE WHEN EXISTS(
         SELECT 1 FROM chain_event_inbox WHERE status = 'dead_letter' LIMIT 1
       ) THEN 1 ELSE 0 END::integer AS dead_letters,
       EXTRACT(EPOCH FROM (NOW() - (
         SELECT occurred_at FROM chain_event_inbox
         WHERE event_type = 'pool_created'
         ORDER BY occurred_at DESC LIMIT 1
       )))::float AS last_pool_age_seconds,
       EXTRACT(EPOCH FROM (NOW() - (
         SELECT occurred_at FROM chain_event_inbox
         WHERE event_type = 'swap'
         ORDER BY occurred_at DESC LIMIT 1
       )))::float AS last_swap_age_seconds,
       EXTRACT(EPOCH FROM (NOW() - (
         SELECT observed_at FROM wallet_trade_events
         ORDER BY observed_at DESC LIMIT 1
       )))::float AS last_wallet_trade_age_seconds,
       (
         SELECT observed_at FROM price_observations
         ORDER BY observed_at LIMIT 1
       ) AS oldest_price_observed_at,
       (
         SELECT COUNT(*)::integer FROM price_observations
         WHERE observed_at >= NOW() - INTERVAL '5 minutes'
       ) AS recent_price_observation_count,
       (
         SELECT observed_at FROM swaps
         ORDER BY observed_at LIMIT 1
       ) AS oldest_swap_observed_at,
       (
         SELECT COALESCE(processed_at, received_at)
         FROM chain_event_inbox
         WHERE status = 'processed'
           AND payload_compacted_at IS NULL
         ORDER BY COALESCE(processed_at, received_at), idempotency_key
         LIMIT 1
       ) AS oldest_uncompacted_chain_event_at,
       (
         SELECT COUNT(*)::integer FROM archive_segments
         WHERE status IN ('pending', 'exporting', 'retry_export')
       ) AS archive_pending_segments,
       (
         SELECT COUNT(*)::integer FROM archive_segments
         WHERE status IN ('verify_pending', 'verifying', 'retry_verify')
       ) AS archive_verify_pending_segments,
       (
         SELECT COUNT(*)::integer FROM archive_segments
         WHERE status = 'dead_letter'
       ) AS archive_dead_letter_segments,
       (
         SELECT MIN(range_end) FROM archive_segments
         WHERE status <> 'verified'
       ) AS archive_oldest_unverified_at,
       (
         SELECT MAX(verified_at) FROM archive_segments
         WHERE status = 'verified'
       ) AS archive_latest_verified_at,
        archive_retirement_policy_ready($1::integer) AS archive_retirement_policy_ready,
        (
          SELECT COUNT(*)::integer FROM archive_segments
          WHERE source_kind='wallet-evidence'
            AND status IN ('pending','exporting','retry_export','verify_pending','verifying','retry_verify')
        ) AS wallet_archive_pending_segments,
        (
          SELECT COUNT(*)::integer FROM archive_segments
          WHERE source_kind='wallet-evidence' AND status='dead_letter'
        ) AS wallet_archive_dead_letter_segments,
        (
          SELECT MAX(range_end) FROM archive_segments
          WHERE source_kind='wallet-evidence' AND status='verified'
        ) AS wallet_archive_latest_verified_end,
        (
          SELECT COUNT(*)::integer
          FROM archive_segments segment
          LEFT JOIN wallet_evidence_compact_days compact
            ON compact.range_start=segment.range_start
           AND compact.archive_segment_id=segment.id
           AND compact.archive_revision=segment.revision
           AND compact.status='verified'
          WHERE segment.source_kind='wallet-evidence'
            AND segment.status='verified'
            AND compact.range_start IS NULL
        ) AS wallet_compact_pending_days,
        (
          SELECT COUNT(*)::integer FROM wallet_evidence_compact_days
          WHERE status = 'mismatch'
        ) AS wallet_compact_mismatch_days,
        (
          SELECT COUNT(*)::integer FROM wallet_evidence_compact_days
          WHERE status = 'retry'
        ) AS wallet_compact_retry_days,
        (
          SELECT MAX(range_end) FROM wallet_evidence_compact_days WHERE status='verified'
        ) AS wallet_compact_latest_verified_end,
        (
          SELECT MIN(segment.verified_at)
          FROM archive_segments segment
          LEFT JOIN wallet_evidence_compact_days compact
            ON compact.range_start=segment.range_start
           AND compact.archive_segment_id=segment.id
           AND compact.archive_revision=segment.revision
           AND compact.status='verified'
          WHERE segment.source_kind='wallet-evidence'
            AND segment.status='verified'
            AND compact.range_start IS NULL
        ) AS wallet_compact_oldest_pending_verified_at,
       (
         SELECT COUNT(*)::integer FROM solana_transaction_finality
         WHERE status = 'pending'
       ) AS finality_pending,
       (
         SELECT EXTRACT(EPOCH FROM (NOW() - MIN(first_seen_at)))::float
         FROM solana_transaction_finality WHERE status = 'pending'
       ) AS finality_oldest_pending_age_seconds,
       (
         SELECT COUNT(*)::integer FROM solana_transaction_finality
         WHERE status = 'unresolved' AND updated_at >= NOW() - INTERVAL '24 hours'
       ) AS finality_unresolved_24h,
       (
         SELECT COUNT(*)::integer FROM solana_signature_queue WHERE status = 'pending'
       ) AS signature_queue_pending,
       (
         SELECT EXTRACT(EPOCH FROM (NOW() - MIN(notified_at)))::float
         FROM solana_signature_queue WHERE status = 'pending'
       ) AS signature_queue_oldest_pending_age_seconds,
       pg_database_size(current_database())::text AS database_bytes
     FROM unresolved`,
    [archiveMinimumRemainingDays]
  );
  const row = result.rows[0]!;
  const checkedAtMs = Date.now();
  const walletEligibleEndMs =
    Math.floor((checkedAtMs - walletArchiveSettleHours * 3_600_000) / 86_400_000) * 86_400_000;
  const walletArchiveLatestEndMs = row.wallet_archive_latest_verified_end?.getTime();
  const walletArchiveLagSeconds =
    walletArchiveLatestEndMs === undefined
      ? null
      : Math.max(0, (walletEligibleEndMs - walletArchiveLatestEndMs) / 1_000);
  const walletCompactOldestPendingMs = row.wallet_compact_oldest_pending_verified_at?.getTime();
  const walletCompactLagSeconds =
    walletCompactOldestPendingMs === undefined
      ? 0
      : Math.max(0, (checkedAtMs - walletCompactOldestPendingMs) / 1_000);
  const filesystem = await statfs("/app");
  const diskTotalBytes = filesystem.blocks * filesystem.bsize;
  const diskAvailableBytes = filesystem.bavail * filesystem.bsize;
  const diskUsedPercent =
    diskTotalBytes <= 0 ? 0 : ((diskTotalBytes - diskAvailableBytes) / diskTotalBytes) * 100;
  const load1 = os.loadavg()[0] ?? 0;
  const cpuCount = Math.max(os.cpus().length, 1);
  const loadPerCpu = load1 / cpuCount;
  const oldestPriceObservedAt = row.oldest_price_observed_at
    ? new Date(row.oldest_price_observed_at).getTime()
    : undefined;
  const priceRetentionLagSeconds =
    oldestPriceObservedAt === undefined
      ? 0
      : Math.max(0, (Date.now() - oldestPriceObservedAt) / 1_000 - priceRetentionDays * 86_400);
  const priceObservationsPerHour = row.recent_price_observation_count * 12;
  const oldestSwapObservedAt = row.oldest_swap_observed_at
    ? new Date(row.oldest_swap_observed_at).getTime()
    : undefined;
  const swapRetentionLagSeconds =
    oldestSwapObservedAt === undefined
      ? 0
      : Math.max(0, (Date.now() - oldestSwapObservedAt) / 1_000 - swapRetentionDays * 86_400);
  const oldestUncompactedChainEventAt = row.oldest_uncompacted_chain_event_at
    ? new Date(row.oldest_uncompacted_chain_event_at).getTime()
    : undefined;
  const chainPayloadCompactionLagSeconds =
    oldestUncompactedChainEventAt === undefined
      ? 0
      : Math.max(
          0,
          (Date.now() - oldestUncompactedChainEventAt) / 1_000 - rawPayloadRetentionHours * 3_600
        );
  const archiveOldestUnverifiedAt = row.archive_oldest_unverified_at
    ? new Date(row.archive_oldest_unverified_at).getTime()
    : undefined;
  const archiveUnverifiedAgeSeconds =
    archiveOldestUnverifiedAt === undefined
      ? 0
      : Math.max(0, (Date.now() - archiveOldestUnverifiedAt) / 1_000);
  await mkdir("reports", { recursive: true });
  const checkedAt = new Date().toISOString();
  const storageRunway = await updateStorageHistory(
    storageHistoryPath,
    {
      checkedAt,
      databaseBytes: Number(row.database_bytes),
      diskAvailableBytes
    },
    { reserveBytes: storageReserveBytes }
  );
  const sqlTelemetry = await readSqlTelemetry(pool);
  const backup = await inspectBackupDirectory("/app/backups");
  const reasons: string[] = [];
  const quotePrice = quotePricePrerequisite(process.env.PYTH_API_KEY);
  if (quotePrice.reason) reasons.push(quotePrice.reason);

  if (!backup.available) reasons.push(`backup unavailable: ${backup.reason ?? "unknown"}`);
  if (backup.available && !backup.offsiteAcknowledged) {
    reasons.push(`backup not offsite-acknowledged: ${backup.reason ?? "unknown"}`);
  }
  if ((backup.ageSeconds ?? 0) > maximumBackupAgeSeconds) {
    reasons.push(`backup age ${round(backup.ageSeconds ?? 0)}s > ${maximumBackupAgeSeconds}s`);
  }

  if (row.backlog > maxBacklog) reasons.push(`backlog ${row.backlog} > ${maxBacklog}`);
  if ((row.oldest_pending_age_seconds ?? 0) > maxPendingAgeSeconds) {
    reasons.push(
      `oldest pending ${round(row.oldest_pending_age_seconds ?? 0)}s > ${maxPendingAgeSeconds}s`
    );
  }
  if ((row.finality_oldest_pending_age_seconds ?? 0) > maxFinalityPendingAgeSeconds) {
    reasons.push(
      `finality pending age ${round(row.finality_oldest_pending_age_seconds ?? 0)}s > ${maxFinalityPendingAgeSeconds}s`
    );
  }
  if ((row.signature_queue_oldest_pending_age_seconds ?? 0) > maxSignaturePendingAgeSeconds) {
    reasons.push(
      `signature queue age ${round(row.signature_queue_oldest_pending_age_seconds ?? 0)}s > ${maxSignaturePendingAgeSeconds}s`
    );
  }
  if (row.dead_letters > 0) reasons.push(`${row.dead_letters} dead-letter events`);
  if ((row.last_pool_age_seconds ?? 0) > maxEventLagSeconds) {
    reasons.push(`last pool event ${round(row.last_pool_age_seconds ?? 0)}s ago`);
  }
  if ((row.last_wallet_trade_age_seconds ?? 0) > maxEventLagSeconds) {
    reasons.push(`last wallet trade ${round(row.last_wallet_trade_age_seconds ?? 0)}s ago`);
  }
  if (diskUsedPercent > maxDiskUsedPercent) {
    reasons.push(`disk usage ${round(diskUsedPercent)}% > ${maxDiskUsedPercent}%`);
  }
  if (loadPerCpu > maxLoadPerCpu) {
    reasons.push(`load per CPU ${round(loadPerCpu)} > ${maxLoadPerCpu}`);
  }
  if (Number(row.database_bytes) > maxDatabaseBytes) {
    reasons.push(`database size ${Number(row.database_bytes)} > ${maxDatabaseBytes} bytes`);
  }
  if (priceRetentionLagSeconds > maxPriceRetentionLagSeconds) {
    reasons.push(
      `price retention lag ${round(priceRetentionLagSeconds)}s > ${maxPriceRetentionLagSeconds}s`
    );
  }
  if (chainPayloadCompactionLagSeconds > maxChainPayloadCompactionLagSeconds) {
    reasons.push(
      `chain payload compaction lag ${round(chainPayloadCompactionLagSeconds)}s > ${maxChainPayloadCompactionLagSeconds}s`
    );
  }
  if (swapRetentionLagSeconds > maxSwapRetentionLagSeconds) {
    reasons.push(
      `swap retention lag ${round(swapRetentionLagSeconds)}s > ${maxSwapRetentionLagSeconds}s`
    );
  }
  if (archiveEnabled && row.archive_dead_letter_segments > 0) {
    reasons.push(`${row.archive_dead_letter_segments} archive dead-letter segments`);
  }
  if (archiveEnabled && archiveUnverifiedAgeSeconds > maxArchiveUnverifiedAgeSeconds) {
    reasons.push(
      `archive unverified age ${round(archiveUnverifiedAgeSeconds)}s > ${maxArchiveUnverifiedAgeSeconds}s`
    );
  }
  if (archiveEnabled && row.wallet_compact_mismatch_days > 0) {
    reasons.push(`${row.wallet_compact_mismatch_days} wallet compact parity mismatch days`);
  }
  if (archiveEnabled && row.wallet_compact_retry_days > 0) {
    reasons.push(`${row.wallet_compact_retry_days} wallet compact operational retry days`);
  }
  if (
    archiveEnabled &&
    walletArchiveLagSeconds !== null &&
    walletArchiveLagSeconds > maxWalletArchiveLagSeconds
  ) {
    reasons.push(
      `wallet archive lag ${round(walletArchiveLagSeconds)}s > ${maxWalletArchiveLagSeconds}s`
    );
  }
  if (
    archiveEnabled &&
    walletCompactLagSeconds !== null &&
    walletCompactLagSeconds > maxWalletCompactLagSeconds
  ) {
    reasons.push(
      `wallet compact lag ${round(walletCompactLagSeconds)}s > ${maxWalletCompactLagSeconds}s`
    );
  }
  if (
    storageRunway.mature &&
    storageRunway.runwayDays !== null &&
    storageRunway.runwayDays < minimumStorageRunwayDays
  ) {
    reasons.push(
      `storage runway ${round(storageRunway.runwayDays)}d < ${minimumStorageRunwayDays}d above reserve`
    );
  }

  const status =
    row.dead_letters > 0 ||
    (archiveEnabled && row.archive_dead_letter_segments > 0) ||
    diskUsedPercent >= criticalDiskUsedPercent
      ? "down"
      : reasons.length > 0
        ? "degraded"
        : "ok";
  const report = {
    type: "operational-health",
    status,
    checkedAt,
    reasons,
    pipeline: {
      quotePrice,
      backlog: row.backlog,
      deadLetters: row.dead_letters,
      oldestPendingAgeSeconds: row.oldest_pending_age_seconds,
      finalityPending: row.finality_pending,
      finalityOldestPendingAgeSeconds: row.finality_oldest_pending_age_seconds,
      finalityUnresolved24h: row.finality_unresolved_24h,
      signatureQueuePending: row.signature_queue_pending,
      signatureQueueOldestPendingAgeSeconds: row.signature_queue_oldest_pending_age_seconds,
      lastPoolAgeSeconds: row.last_pool_age_seconds,
      lastSwapAgeSeconds: row.last_swap_age_seconds,
      lastWalletTradeAgeSeconds: row.last_wallet_trade_age_seconds,
      priceObservationsPerHour,
      priceRetentionLagSeconds: round(priceRetentionLagSeconds),
      oldestPriceObservedAt:
        oldestPriceObservedAt === undefined ? null : new Date(oldestPriceObservedAt).toISOString(),
      swapRetentionLagSeconds: round(swapRetentionLagSeconds),
      oldestSwapObservedAt:
        oldestSwapObservedAt === undefined ? null : new Date(oldestSwapObservedAt).toISOString(),
      chainPayloadCompactionLagSeconds: round(chainPayloadCompactionLagSeconds),
      oldestUncompactedChainEventAt:
        oldestUncompactedChainEventAt === undefined
          ? null
          : new Date(oldestUncompactedChainEventAt).toISOString()
    },
    archive: {
      enabled: archiveEnabled,
      pendingSegments: row.archive_pending_segments,
      verifyPendingSegments: row.archive_verify_pending_segments,
      deadLetterSegments: row.archive_dead_letter_segments,
      unverifiedAgeSeconds: round(archiveUnverifiedAgeSeconds),
      oldestUnverifiedAt:
        archiveOldestUnverifiedAt === undefined
          ? null
          : new Date(archiveOldestUnverifiedAt).toISOString(),
      latestVerifiedAt: row.archive_latest_verified_at?.toISOString() ?? null,
      retirementPolicyReady: row.archive_retirement_policy_ready,
      walletEvidence: {
        pendingSegments: row.wallet_archive_pending_segments,
        deadLetterSegments: row.wallet_archive_dead_letter_segments,
        latestVerifiedEnd: row.wallet_archive_latest_verified_end?.toISOString() ?? null,
        lagSeconds: walletArchiveLagSeconds === null ? null : round(walletArchiveLagSeconds),
        compactPendingDays: row.wallet_compact_pending_days,
        compactMismatchDays: row.wallet_compact_mismatch_days,
        compactRetryDays: row.wallet_compact_retry_days,
        compactLatestVerifiedEnd: row.wallet_compact_latest_verified_end?.toISOString() ?? null,
        compactOldestPendingVerifiedAt:
          row.wallet_compact_oldest_pending_verified_at?.toISOString() ?? null,
        compactLagSeconds: round(walletCompactLagSeconds)
      }
    },
    backup,
    resources: {
      databaseBytes: Number(row.database_bytes),
      diskTotalBytes,
      diskAvailableBytes,
      diskUsedPercent: round(diskUsedPercent),
      load1: round(load1),
      cpuCount,
      loadPerCpu: round(loadPerCpu),
      storageRunway,
      sqlTelemetry
    }
  };

  await writeFile(`${reportPath}.tmp`, JSON.stringify(report, null, 2));
  await rename(`${reportPath}.tmp`, reportPath);
  console.log(JSON.stringify(report));
  await maybeSendAlert(report);
} finally {
  await pool.end();
}

interface SqlTelemetryEntry {
  metric: "totalExecTime" | "tempBytes" | "walBytes";
  queryId: string;
  calls: number;
  totalExecTimeMs: number;
  meanExecTimeMs: number;
  rows: number;
  sharedBlocksRead: number;
  tempBytes: number;
  walBytes: number;
}

async function readSqlTelemetry(database: pg.Pool): Promise<{
  available: boolean;
  statsReset: string | null;
  top: SqlTelemetryEntry[];
  reason?: string;
}> {
  try {
    const installed = await database.query<{ installed: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS installed"
    );
    if (!installed.rows[0]?.installed) {
      return { available: false, statsReset: null, top: [], reason: "extension-not-installed" };
    }
    await database.query("SET statement_timeout = '2s'");
    const [info, ranked] = await Promise.all([
      database.query<{ stats_reset: Date | null }>(
        "SELECT stats_reset FROM pg_stat_statements_info"
      ),
      database.query<{
        metric: SqlTelemetryEntry["metric"];
        query_id: string;
        calls: string;
        total_exec_time_ms: number;
        mean_exec_time_ms: number;
        rows: string;
        shared_blocks_read: string;
        temp_bytes: string;
        wal_bytes: string;
      }>(
        `WITH metrics AS (
           (SELECT 'totalExecTime'::text AS metric, queryid::text AS query_id, calls,
                   total_exec_time AS total_exec_time_ms, mean_exec_time AS mean_exec_time_ms,
                   rows, shared_blks_read AS shared_blocks_read,
                   temp_blks_written * current_setting('block_size')::bigint AS temp_bytes,
                   wal_bytes
            FROM pg_stat_statements
            ORDER BY total_exec_time DESC NULLS LAST LIMIT 5)
           UNION ALL
           (SELECT 'tempBytes'::text, queryid::text, calls, total_exec_time, mean_exec_time,
                   rows, shared_blks_read,
                   temp_blks_written * current_setting('block_size')::bigint,
                   wal_bytes
            FROM pg_stat_statements
            ORDER BY temp_blks_written DESC NULLS LAST LIMIT 5)
           UNION ALL
           (SELECT 'walBytes'::text, queryid::text, calls, total_exec_time, mean_exec_time,
                   rows, shared_blks_read,
                   temp_blks_written * current_setting('block_size')::bigint,
                   wal_bytes
            FROM pg_stat_statements
            ORDER BY wal_bytes DESC NULLS LAST LIMIT 5)
         )
         SELECT * FROM metrics`
      )
    ]);
    return {
      available: true,
      statsReset: info.rows[0]?.stats_reset?.toISOString() ?? null,
      top: ranked.rows.map((row) => ({
        metric: row.metric,
        queryId: row.query_id,
        calls: Number(row.calls),
        totalExecTimeMs: round(Number(row.total_exec_time_ms)),
        meanExecTimeMs: round(Number(row.mean_exec_time_ms)),
        rows: Number(row.rows),
        sharedBlocksRead: Number(row.shared_blocks_read),
        tempBytes: Number(row.temp_bytes),
        walBytes: Number(row.wal_bytes)
      }))
    };
  } catch (error) {
    return {
      available: false,
      statsReset: null,
      top: [],
      reason: error instanceof Error ? error.message.slice(0, 200) : "sql-telemetry-unavailable"
    };
  } finally {
    await database.query("SET statement_timeout = 0").catch(() => undefined);
  }
}

async function maybeSendAlert(report: {
  status: string;
  checkedAt: string;
  reasons: string[];
}): Promise<void> {
  const webhookUrl = process.env.OPERATIONS_ALERT_WEBHOOK_URL?.trim();
  if (!webhookUrl || report.status === "ok") return;
  let lastAlertAt = 0;
  let lastStatus = "";
  try {
    const previous = JSON.parse(await readFile(alertStatePath, "utf8")) as {
      status?: string;
      alertedAt?: string;
    };
    lastStatus = previous.status ?? "";
    lastAlertAt = previous.alertedAt ? new Date(previous.alertedAt).getTime() : 0;
  } catch {
    // Missing state means this is the first alert.
  }
  const cooldownMs = alertCooldownMinutes * 60_000;
  if (lastStatus === report.status && Date.now() - lastAlertAt < cooldownMs) return;
  const message = `Walletscaner operational status: ${report.status}. ${report.reasons.join("; ")}`;
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message, text: message, report })
  });
  if (!response.ok)
    throw new Error(`Operations alert webhook failed with HTTP ${response.status}.`);
  await writeFile(
    alertStatePath,
    JSON.stringify({ status: report.status, alertedAt: report.checkedAt }, null, 2)
  );
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
