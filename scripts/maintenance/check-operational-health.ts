import "dotenv/config";
import { mkdir, readFile, rename, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for operational monitoring.");

const maxBacklog = positiveNumber(process.env.OPERATIONS_MAX_BACKLOG, 100);
const maxPendingAgeSeconds = positiveNumber(process.env.OPERATIONS_MAX_PENDING_AGE_SECONDS, 120);
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
const alertCooldownMinutes = positiveNumber(process.env.OPERATIONS_ALERT_COOLDOWN_MINUTES, 30);
const reportPath = "reports/operational-health.json";
const alertStatePath = "reports/operational-alert-state.json";
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
  }>(
    `WITH unresolved AS (
       SELECT
         COUNT(*)::integer AS backlog,
         EXTRACT(EPOCH FROM (NOW() - MIN(received_at)))::float
           AS oldest_pending_age_seconds
       FROM chain_event_inbox
       WHERE status IN ('pending', 'processing', 'retry')
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
       pg_database_size(current_database())::text AS database_bytes
     FROM unresolved`
  );
  const row = result.rows[0]!;
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
  const reasons: string[] = [];

  if (row.backlog > maxBacklog) reasons.push(`backlog ${row.backlog} > ${maxBacklog}`);
  if ((row.oldest_pending_age_seconds ?? 0) > maxPendingAgeSeconds) {
    reasons.push(
      `oldest pending ${round(row.oldest_pending_age_seconds ?? 0)}s > ${maxPendingAgeSeconds}s`
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

  const status =
    row.dead_letters > 0 || diskUsedPercent >= criticalDiskUsedPercent
      ? "down"
      : reasons.length > 0
        ? "degraded"
        : "ok";
  const report = {
    type: "operational-health",
    status,
    checkedAt: new Date().toISOString(),
    reasons,
    pipeline: {
      backlog: row.backlog,
      deadLetters: row.dead_letters,
      oldestPendingAgeSeconds: row.oldest_pending_age_seconds,
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
    resources: {
      databaseBytes: Number(row.database_bytes),
      diskTotalBytes,
      diskAvailableBytes,
      diskUsedPercent: round(diskUsedPercent),
      load1: round(load1),
      cpuCount,
      loadPerCpu: round(loadPerCpu)
    }
  };

  await mkdir("reports", { recursive: true });
  await writeFile(`${reportPath}.tmp`, JSON.stringify(report, null, 2));
  await rename(`${reportPath}.tmp`, reportPath);
  console.log(JSON.stringify(report));
  await maybeSendAlert(report);
} finally {
  await pool.end();
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

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
