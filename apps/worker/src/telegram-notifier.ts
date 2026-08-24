import "dotenv/config";
import { hostname } from "node:os";
import pg from "pg";
import { loadRuntimeConfig } from "@memecoin-alpha/config";
import {
  PostgresRepository,
  TelegramNotificationStore,
  type SignalOutboxMessage,
  type TelegramNotificationMessage
} from "@memecoin-alpha/db";
import {
  strictQualifiedPoolNotificationPolicy,
  type PaperTradeNotification,
  type PipelineStatusNotification,
  type QualifiedPoolNotification,
  type WalletAlphaSignalEvidence
} from "@memecoin-alpha/shared";
import {
  formatPaperTradeAlert,
  formatPipelineStatusAlert,
  formatQualifiedPoolAlert,
  formatWalletAlphaAlert,
  sendTelegramMessage
} from "../../bot/src/alerts.js";

const excludedTokenAddresses = [
  "11111111111111111111111111111111",
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYDqKgZ7xJmRz1nqDgW5hQ7"
];

const config = loadRuntimeConfig();
if (!config.alerts.telegramBotToken || !config.alerts.telegramChatId) {
  throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required.");
}

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 2 });
const repository = new PostgresRepository(pool);
const store = new TelegramNotificationStore(pool);
const walletAlphaStrategyVersion = process.env.ALPHA_STRATEGY_VERSION?.trim() || "evidence-v1";
const workerId = `${hostname()}:${process.pid}:telegram-notifier`;
const startedAt = await store.initializeStartedAt(config.alerts.initialLookbackMinutes);
const statusIntervalMs = config.alerts.statusIntervalMinutes * 60_000;
let currentStatusBucket = statusBucket(Date.now(), statusIntervalMs);
let stopping = false;
let lastHealthLogAt = 0;

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

await repository.assertReady();
await enqueueStatus("startup");

while (!stopping) {
  const cycleStartedAt = Date.now();
  try {
    await processSignalAlerts();
    const poolScan = await store.enqueueQualifiedPools({
      startedAt,
      maxAgeMinutes: config.alerts.poolMaxAgeMinutes,
      minimumLiquidityUsd: config.thresholds.minimumLiquidityUsd,
      minimumVolume5mUsd: config.thresholds.minimumVolume5mUsd,
      excludedTokenAddresses,
      deliveryMode: config.alerts.qualifiedPoolDeliveryMode
    });
    const coverageTransitionsEnqueued = await store.enqueueCoverageIncidentTransitions(
      walletAlphaStrategyVersion
    );
    const nextBucket = statusBucket(Date.now(), statusIntervalMs);
    if (nextBucket !== currentStatusBucket) {
      currentStatusBucket = nextBucket;
      await enqueueStatus(`periodic:${nextBucket}`);
    }
    const delivered = await processNotificationOutbox();
    if (Date.now() - lastHealthLogAt >= 300_000) {
      console.log(
        JSON.stringify({
          type: "telegram-notifier-health",
          workerId,
          startedAt,
          walletAlphaStrategyVersion,
          qualificationVersion: strictQualifiedPoolNotificationPolicy.version,
          qualifiedPoolDeliveryMode: config.alerts.qualifiedPoolDeliveryMode,
          scannedPoolCount: poolScan.scannedPoolCount,
          riskPassedPoolCount: poolScan.riskPassedPoolCount,
          strictCandidateCount: poolScan.strictCandidateCount,
          poolsEnqueued: poolScan.inserted,
          coverageTransitionsEnqueued,
          notificationsDelivered: delivered,
          cycleDurationMs: Date.now() - cycleStartedAt
        })
      );
      lastHealthLogAt = Date.now();
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "telegram-notifier-error",
        workerId,
        message: error instanceof Error ? error.message : String(error)
      })
    );
  }
  await sleep(config.alerts.notifierPollIntervalMs);
}

await pool.end();

async function processSignalAlerts(): Promise<void> {
  const messages = await repository.claimSignalOutbox({
    destination: "alert",
    workerId,
    limit: config.alerts.notificationClaimLimit,
    leaseSeconds: 60
  });
  for (const message of messages) {
    try {
      const signal = parseWalletAlphaSignal(message);
      assertRiskPassed(signal);
      if (!(await isSuppressedByAlertCooldown(signal))) {
        await requireTelegramDelivery(formatWalletAlphaAlert(signal));
      }
      await repository.completeSignalOutbox(message.id, workerId);
    } catch (error) {
      const delaySeconds = retryDelaySeconds(message.attemptCount);
      await repository.failSignalOutbox(message.id, workerId, safeError(error), {
        maxAttempts: 8,
        retryAt: new Date(Date.now() + delaySeconds * 1_000).toISOString()
      });
    }
  }
}

async function processNotificationOutbox(): Promise<number> {
  const messages = await store.claim({
    workerId,
    limit: config.alerts.notificationClaimLimit,
    leaseSeconds: 60
  });
  let delivered = 0;
  for (const message of messages) {
    try {
      if (await store.suppressClaimedCoverageTainted(message.id, workerId)) {
        continue;
      }
      await requireTelegramDelivery(formatNotification(message));
      if (!(await store.complete(message.id, workerId))) {
        throw new Error("Notification lease was lost before completion.");
      }
      delivered += 1;
    } catch (error) {
      const delaySeconds = retryDelaySeconds(message.attemptCount);
      await store.fail(message.id, workerId, safeError(error), {
        maxAttempts: 8,
        retryAt: new Date(Date.now() + delaySeconds * 1_000).toISOString()
      });
    }
  }
  return delivered;
}

async function enqueueStatus(sourceKey: string): Promise<void> {
  const status = await store.getPipelineStatus(walletAlphaStrategyVersion);
  await store.enqueueStatus(sourceKey, status);
}

function formatNotification(message: TelegramNotificationMessage): string {
  if (message.eventType === "qualified-pool") {
    return formatQualifiedPoolAlert(message.payload as QualifiedPoolNotification);
  }
  if (message.eventType === "paper-trade") {
    return formatPaperTradeAlert(message.payload as PaperTradeNotification);
  }
  return formatPipelineStatusAlert(message.payload as PipelineStatusNotification);
}

async function requireTelegramDelivery(text: string): Promise<void> {
  if (!(await sendTelegramMessage(text, config))) {
    throw new Error("Telegram sendMessage request was rejected.");
  }
}

function parseWalletAlphaSignal(message: SignalOutboxMessage): WalletAlphaSignalEvidence {
  const payload = message.payload;
  if (
    typeof payload.id !== "string" ||
    payload.chain !== "solana" ||
    typeof payload.tokenAddress !== "string" ||
    typeof payload.strategyVersion !== "string" ||
    typeof payload.detectedAt !== "string" ||
    !Array.isArray(payload.walletAddresses) ||
    typeof payload.evidence !== "object" ||
    payload.evidence === null
  ) {
    throw new Error("Signal outbox payload is not a wallet-alpha signal.");
  }
  return payload as unknown as WalletAlphaSignalEvidence;
}

function assertRiskPassed(signal: WalletAlphaSignalEvidence): void {
  if (signal.evidence.tokenRiskKnown !== true || signal.evidence.tokenRiskPassed !== true) {
    throw new Error("Wallet-alpha signal is blocked because token risk evidence did not pass.");
  }
}

async function isSuppressedByAlertCooldown(signal: WalletAlphaSignalEvidence): Promise<boolean> {
  if (config.alerts.cooldownMinutes <= 0) return false;
  const signalTime = new Date(signal.detectedAt).getTime();
  const cutoff = signalTime - config.alerts.cooldownMinutes * 60_000;
  const contenders = (await repository.listWalletAlphaSignals(undefined, 2_000))
    .filter((candidate) => candidate.tokenAddress === signal.tokenAddress)
    .filter((candidate) => {
      const detectedAt = new Date(candidate.detectedAt).getTime();
      return detectedAt >= cutoff && detectedAt <= signalTime;
    })
    .sort(
      (a, b) =>
        new Date(a.detectedAt).getTime() - new Date(b.detectedAt).getTime() ||
        a.id.localeCompare(b.id)
    );
  return contenders[0]?.id !== signal.id;
}

function statusBucket(now: number, intervalMs: number): number {
  return Math.floor(now / intervalMs);
}

function retryDelaySeconds(attemptCount: number): number {
  return Math.min(900, 5 * 2 ** Math.min(attemptCount, 8));
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
