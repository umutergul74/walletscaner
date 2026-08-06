import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { PostgresRepository } from "@memecoin-alpha/db";
import {
  buildWalletAlphaReport,
  renderWalletAlphaMarkdown
} from "./wallet-alpha-report-builder.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to generate wallet alpha evidence.");

const strategyVersion = process.env.ALPHA_STRATEGY_VERSION ?? "evidence-v1";
const sourceWindowDays = Number(process.env.WALLET_ALPHA_WINDOW_DAYS ?? 30);
const materializeHistorical = ["1", "true", "yes", "on"].includes(
  (process.env.WALLET_ALPHA_MATERIALIZE_HISTORICAL ?? "false").trim().toLowerCase()
);
const workBatchSize = positiveInt(process.env.WALLET_ALPHA_WORK_BATCH_SIZE, 100);
const maxWorkBatches = positiveInt(process.env.WALLET_ALPHA_MAX_WORK_BATCHES, 5);
const workLeaseSeconds = positiveInt(process.env.WALLET_ALPHA_WORK_LEASE_SECONDS, 300);
const persistenceConcurrency = positiveInt(process.env.WALLET_ALPHA_PERSISTENCE_CONCURRENCY, 4);
const repository = new PostgresRepository(databaseUrl);
const report = await buildWalletAlphaReport(
  repository,
  strategyVersion,
  new Date().toISOString(),
  sourceWindowDays,
  {
    materializeHistorical,
    workBatchSize,
    maxWorkBatches,
    workLeaseSeconds,
    persistenceConcurrency,
    onProgress(progress) {
      const memory = process.memoryUsage();
      console.log(
        JSON.stringify({
          type: "wallet-alpha-progress",
          ...progress,
          memoryMb: {
            rss: roundMb(memory.rss),
            heapUsed: roundMb(memory.heapUsed),
            heapTotal: roundMb(memory.heapTotal),
            external: roundMb(memory.external)
          }
        })
      );
    }
  }
);

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Math.trunc(Number(value ?? fallback));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function roundMb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

await mkdir("reports", { recursive: true });
await writeFile("reports/wallet-alpha-latest.json", JSON.stringify(report, null, 2));
await writeFile("reports/wallet-alpha-latest.md", renderWalletAlphaMarkdown(report));

console.log(
  JSON.stringify(
    {
      generatedAt: report.generatedAt,
      mode: report.mode,
      wallets: report.coverage.walletsSeen,
      completedPositions: report.coverage.completedPositions,
      paperSignals: report.livePaperSignals.length,
      workQueue: report.workQueue,
      memoryMb: {
        rss: roundMb(process.memoryUsage().rss),
        heapUsed: roundMb(process.memoryUsage().heapUsed)
      },
      reports: ["reports/wallet-alpha-latest.json", "reports/wallet-alpha-latest.md"]
    },
    null,
    2
  )
);
