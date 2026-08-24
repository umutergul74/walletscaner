import "dotenv/config";
import pg from "pg";
import { PostgresRepository } from "@memecoin-alpha/db";
import {
  processWalletAlphaQueue,
  refreshWalletAlphaSignals
} from "./wallet-alpha-report-builder.js";
import {
  CoalescingWakeSignal,
  parseWalletAlphaWake,
  walletAlphaPollDelayMs
} from "./wallet-alpha-wake.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to process wallet alpha evidence.");
if (process.env.ENABLE_LIVE_EXECUTION === "true") {
  throw new Error("Wallet-alpha worker refuses to run while live execution is enabled.");
}

const strategyVersion = process.env.ALPHA_STRATEGY_VERSION ?? "evidence-v1";
const sourceWindowDays = positiveInt(process.env.WALLET_ALPHA_WINDOW_DAYS, 30);
const backlogPollSeconds = positiveInt(process.env.WALLET_ALPHA_BACKLOG_POLL_SECONDS, 30);
const idlePollSeconds = positiveInt(process.env.WALLET_ALPHA_IDLE_POLL_SECONDS, 300);
const runOnce = process.env.WALLET_ALPHA_RUN_ONCE === "true";
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 5,
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
  application_name: "walletscaner-wallet-alpha"
});
const repository = new PostgresRepository(pool);
const wake = new CoalescingWakeSignal();
let stopping = false;
let listener: pg.PoolClient | undefined;
let listenerReconnectAt = 0;
let listenerFailures = 0;

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    stopping = true;
    wake.signal();
  });
}

try {
  while (!stopping) {
    await ensureListener();
    const startedAt = Date.now();
    try {
      let immediateSignalRefreshes = 0;
      let immediateSignals = 0;
      const queue = await processWalletAlphaQueue(
        repository,
        strategyVersion,
        new Date().toISOString(),
        sourceWindowDays,
        {
          materializeHistorical: false,
          workBatchSize: positiveInt(process.env.WALLET_ALPHA_WORK_BATCH_SIZE, 50),
          maxWorkBatches: positiveInt(process.env.WALLET_ALPHA_MAX_WORK_BATCHES, 2),
          workLeaseSeconds: positiveInt(process.env.WALLET_ALPHA_WORK_LEASE_SECONDS, 300),
          persistenceConcurrency: positiveInt(process.env.WALLET_ALPHA_PERSISTENCE_CONCURRENCY, 2),
          maximumTradeEventsPerWallet: positiveInt(
            process.env.WALLET_ALPHA_MAX_TRADE_EVENTS_PER_WALLET,
            10_000
          ),
          maximumEntriesPerWallet: positiveInt(
            process.env.WALLET_ALPHA_MAX_ENTRIES_PER_WALLET,
            2_000
          ),
          maximumOutcomesPerWallet: positiveInt(
            process.env.WALLET_ALPHA_MAX_OUTCOMES_PER_WALLET,
            4_000
          ),
          oversizedRetrySeconds: positiveInt(
            process.env.WALLET_ALPHA_OVERSIZED_RETRY_SECONDS,
            86_400
          ),
          maximumRunSeconds: positiveInt(process.env.WALLET_ALPHA_MAX_RUN_SECONDS, 240),
          minimumTradeEvents: positiveInt(process.env.WALLET_ALPHA_MIN_TRADE_EVENTS, 6),
          minimumEntries: positiveInt(process.env.WALLET_ALPHA_MIN_ENTRIES, 3),
          async onSignalRelevantWalletProcessed(item) {
            const signals = await refreshWalletAlphaSignals(
              repository,
              strategyVersion,
              new Date().toISOString(),
              positiveInt(process.env.WALLET_ALPHA_PERSISTENCE_CONCURRENCY, 2)
            );
            immediateSignalRefreshes += 1;
            immediateSignals += signals.length;
            log({
              type: "wallet-alpha-priority-refresh",
              walletAddress: item.walletAddress,
              pendingSince: item.pendingSince,
              queueLatencyMs: Math.max(0, Date.now() - new Date(item.pendingSince).getTime()),
              signals: signals.length,
              memoryMb: currentMemoryMb()
            });
          },
          onProgress(progress) {
            log({ type: "wallet-alpha-progress", ...progress, memoryMb: currentMemoryMb() });
          }
        }
      );
      const signals = await refreshWalletAlphaSignals(
        repository,
        strategyVersion,
        new Date().toISOString(),
        positiveInt(process.env.WALLET_ALPHA_PERSISTENCE_CONCURRENCY, 2)
      );
      const workQueue = await repository.getWalletAlphaWorkSummary(strategyVersion);
      log({
        type: "wallet-alpha-cycle",
        strategyVersion,
        elapsedMs: Date.now() - startedAt,
        queue,
        workQueue,
        listener: listener ? "listening" : "poll-fallback",
        immediateSignalRefreshes,
        immediateSignals,
        admission: {
          minimumTradeEvents: positiveInt(process.env.WALLET_ALPHA_MIN_TRADE_EVENTS, 6),
          minimumEntries: positiveInt(process.env.WALLET_ALPHA_MIN_ENTRIES, 3)
        },
        signals: signals.length,
        memoryMb: currentMemoryMb()
      });
      if (runOnce) break;
      const pollDelay = walletAlphaPollDelayMs(
        workQueue.pending,
        backlogPollSeconds,
        idlePollSeconds
      );
      const reconnectDelay = listener ? pollDelay : Math.max(1, listenerReconnectAt - Date.now());
      await wake.wait(Math.min(pollDelay, reconnectDelay));
    } catch (error) {
      log({
        type: "wallet-alpha-cycle-failed",
        strategyVersion,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        memoryMb: currentMemoryMb()
      });
      if (runOnce) throw error;
      await wake.wait(60_000);
    }
  }
} finally {
  if (listener) {
    listener.removeAllListeners();
    listener.release();
  }
  await pool.end();
}

async function ensureListener(): Promise<void> {
  if (listener || stopping || Date.now() < listenerReconnectAt) return;
  let client: pg.PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query("LISTEN wallet_alpha_work");
    const activeClient = client;
    listener = activeClient;
    listenerFailures = 0;
    activeClient.on("notification", (notification) => {
      const parsed = parseWalletAlphaWake(notification.payload, strategyVersion);
      if (parsed) wake.signal();
    });
    activeClient.on("error", (error) => {
      log({ type: "wallet-alpha-listener-failed", error: error.message });
      if (listener === activeClient) listener = undefined;
      activeClient.removeAllListeners();
      activeClient.release(true);
      listenerFailures += 1;
      listenerReconnectAt = Date.now() + retryDelayMs(listenerFailures);
      wake.signal();
    });
    log({ type: "wallet-alpha-listener-ready", strategyVersion });
  } catch (error) {
    if (client) {
      client.removeAllListeners();
      client.release(true);
    }
    listenerFailures += 1;
    listenerReconnectAt = Date.now() + retryDelayMs(listenerFailures);
    log({
      type: "wallet-alpha-listener-connect-failed",
      strategyVersion,
      retryMs: listenerReconnectAt - Date.now(),
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function retryDelayMs(failures: number): number {
  return Math.min(300_000, 5_000 * 2 ** Math.min(6, Math.max(0, failures - 1)));
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Math.trunc(Number(value ?? fallback));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function currentMemoryMb(): Record<string, number> {
  const memory = process.memoryUsage();
  return {
    rss: roundMb(memory.rss),
    heapUsed: roundMb(memory.heapUsed),
    heapTotal: roundMb(memory.heapTotal),
    external: roundMb(memory.external)
  };
}

function roundMb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

function log(value: Record<string, unknown>): void {
  console.log(JSON.stringify(value));
}
