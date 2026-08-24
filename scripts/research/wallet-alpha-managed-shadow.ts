import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { PostgresRepository } from "@memecoin-alpha/db";
import {
  buildManagedShadowReport,
  renderManagedShadowMarkdown
} from "./wallet-alpha-managed-shadow-builder.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the managed-exit shadow report.");

const sourceStrategyVersion = process.env.ALPHA_STRATEGY_VERSION ?? "evidence-v1";
const maximumWallets = positiveInt(process.env.WALLET_ALPHA_MANAGED_SHADOW_MAX_WALLETS, 25);
const sourceScoreReadLimit = positiveInt(
  process.env.WALLET_ALPHA_MANAGED_SHADOW_SCORE_READ_LIMIT,
  250
);
const walletBatchSize = positiveInt(process.env.WALLET_ALPHA_MANAGED_SHADOW_BATCH_SIZE, 5);
const maximumEntryDetectionDelaySeconds = positiveInt(
  process.env.WALLET_ALPHA_MANAGED_SHADOW_MAX_ENTRY_DELAY_SECONDS,
  60
);
const repository = new PostgresRepository(databaseUrl);
const report = await buildManagedShadowReport(repository, sourceStrategyVersion, undefined, {
  maximumWallets,
  sourceScoreReadLimit,
  walletBatchSize,
  maximumEntryDetectionDelaySeconds
});

await mkdir("reports", { recursive: true });
await Promise.all([
  writeFile("reports/wallet-alpha-managed-shadow-latest.json", JSON.stringify(report, null, 2)),
  writeFile("reports/wallet-alpha-managed-shadow-latest.md", renderManagedShadowMarkdown(report))
]);

console.log(
  JSON.stringify({
    type: "wallet-alpha-managed-shadow",
    generatedAt: report.generatedAt,
    persisted: report.persisted,
    signalsEnabled: report.signalsEnabled,
    selectedWallets: report.selection.selectedWallets,
    statusCounts: report.statusCounts,
    inputs: report.inputs,
    memoryMb: {
      rss: roundMb(process.memoryUsage().rss),
      heapUsed: roundMb(process.memoryUsage().heapUsed)
    },
    reports: [
      "reports/wallet-alpha-managed-shadow-latest.json",
      "reports/wallet-alpha-managed-shadow-latest.md"
    ]
  })
);

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Math.trunc(Number(value ?? fallback));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function roundMb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}
