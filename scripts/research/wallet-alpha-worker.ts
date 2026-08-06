import "dotenv/config";
import { PostgresRepository } from "@memecoin-alpha/db";
import {
  processWalletAlphaQueue,
  refreshWalletAlphaSignals
} from "./wallet-alpha-report-builder.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to process wallet alpha evidence.");

const strategyVersion = process.env.ALPHA_STRATEGY_VERSION ?? "evidence-v1";
const sourceWindowDays = positiveInt(process.env.WALLET_ALPHA_WINDOW_DAYS, 30);
const repository = new PostgresRepository(databaseUrl);
const startedAt = Date.now();

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
    maximumEntriesPerWallet: positiveInt(process.env.WALLET_ALPHA_MAX_ENTRIES_PER_WALLET, 2_000),
    maximumOutcomesPerWallet: positiveInt(process.env.WALLET_ALPHA_MAX_OUTCOMES_PER_WALLET, 4_000),
    oversizedRetrySeconds: positiveInt(process.env.WALLET_ALPHA_OVERSIZED_RETRY_SECONDS, 86_400),
    maximumRunSeconds: positiveInt(process.env.WALLET_ALPHA_MAX_RUN_SECONDS, 240),
    minimumTradeEvents: positiveInt(process.env.WALLET_ALPHA_MIN_TRADE_EVENTS, 6),
    minimumEntries: positiveInt(process.env.WALLET_ALPHA_MIN_ENTRIES, 3),
    onProgress(progress) {
      console.log(
        JSON.stringify({
          type: "wallet-alpha-progress",
          ...progress,
          memoryMb: currentMemoryMb()
        })
      );
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

console.log(
  JSON.stringify({
    type: "wallet-alpha-cycle",
    strategyVersion,
    elapsedMs: Date.now() - startedAt,
    queue,
    workQueue,
    admission: {
      minimumTradeEvents: positiveInt(process.env.WALLET_ALPHA_MIN_TRADE_EVENTS, 6),
      minimumEntries: positiveInt(process.env.WALLET_ALPHA_MIN_ENTRIES, 3)
    },
    signals: signals.length,
    memoryMb: currentMemoryMb()
  })
);

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
