import { performance } from "node:perf_hooks";
import { MemoryRepository } from "@memecoin-alpha/db";
import type { WalletEntrySignalEvidence, WalletTradeEvidence } from "@memecoin-alpha/shared";
import { processWalletAlphaQueue } from "./wallet-alpha-report-builder.js";

const repository = createRepository();
const strategyVersion = "evidence-v1";
const oversizedTradeCount = 10_001;
const healthyWalletCount = 99;
const roundTripsPerHealthyWallet = 30;

await repository.saveWalletEntrySignal(entry("APathologicalWallet", 0));
for (let walletIndex = 0; walletIndex < healthyWalletCount; walletIndex += 1) {
  const walletAddress = `HealthyWallet${String(walletIndex).padStart(3, "0")}`;
  await repository.saveWalletEntrySignal(entry(walletAddress, walletIndex + 1));
}

const startedAt = performance.now();
const result = await processWalletAlphaQueue(
  repository,
  strategyVersion,
  "2026-08-01T00:00:00.000Z",
  30,
  {
    materializeHistorical: false,
    workBatchSize: 100,
    maxWorkBatches: 1,
    maximumTradeEventsPerWallet: 10_000,
    maximumRunSeconds: 30,
    oversizedRetrySeconds: 300,
    persistenceConcurrency: 2
  }
);
const durationMs = performance.now() - startedAt;
const memory = process.memoryUsage();
const heapUsedMb = toMb(memory.heapUsed);
const rssMb = toMb(memory.rss);

if (
  result.processedWallets !== healthyWalletCount ||
  result.failedWallets !== 1 ||
  result.oversizedWallets !== 1
) {
  throw new Error(`Unexpected bounded worker result: ${JSON.stringify(result)}.`);
}
if (durationMs > 30_000) {
  throw new Error(`Wallet-alpha worker benchmark exceeded 30s: ${durationMs.toFixed(2)}ms.`);
}
if (heapUsedMb > 100) {
  throw new Error(`Wallet-alpha worker benchmark exceeded 100 MiB heap: ${heapUsedMb} MiB.`);
}
if (rssMb > 160) {
  throw new Error(`Wallet-alpha worker benchmark exceeded 160 MiB RSS: ${rssMb} MiB.`);
}

console.log(
  JSON.stringify({
    type: "wallet-alpha-worker-benchmark",
    oversizedTradeCount,
    healthyWalletCount,
    roundTripsPerHealthyWallet,
    result,
    durationMs: Math.round(durationMs * 100) / 100,
    memoryMb: { heapUsed: heapUsedMb, rss: rssMb },
    limits: { durationMs: 30_000, heapUsedMb: 100, rssMb: 160 }
  })
);

function createRepository(): MemoryRepository {
  const generated = new MemoryRepository();
  generated.listWalletTradeEventsForWallets = async (
    walletAddresses: string[],
    requestedStrategyVersion: string,
    _minimumObservedAt?: string,
    maxRows?: number
  ): Promise<WalletTradeEvidence[]> => {
    const walletAddress = walletAddresses[0];
    if (!walletAddress || requestedStrategyVersion !== strategyVersion) return [];
    const count =
      walletAddress === "APathologicalWallet"
        ? oversizedTradeCount
        : roundTripsPerHealthyWallet * 2;
    return Array.from({ length: Math.min(count, maxRows ?? count) }, (_, index) => {
      const side = walletAddress === "APathologicalWallet" || index % 2 === 0 ? "buy" : "sell";
      const tokenIndex = walletAddress === "APathologicalWallet" ? index : Math.floor(index / 2);
      return trade(
        walletAddress,
        `${walletAddress}:Token${tokenIndex}`,
        side,
        index,
        side === "buy" ? 1 : 1.2
      );
    });
  };
  return generated;
}

function entry(walletAddress: string, sequence: number): WalletEntrySignalEvidence {
  return {
    idempotencyKey: `entry:${walletAddress}`,
    chain: "solana",
    walletAddress,
    tokenAddress: `EntryToken:${walletAddress}`,
    poolAddress: `EntryPool:${walletAddress}`,
    sourceSwapIdempotencyKey: `entry-swap:${walletAddress}`,
    observedEntryPriceUsd: 1,
    observedLiquidityUsd: 20_000,
    cohort: "wallet-alpha",
    repeatWalletCount: 1,
    flowEvidence: { tokenRiskKnown: true, tokenRiskPassed: true, poolAgeMinutes: 5 },
    signature: `entry-signature:${walletAddress}`,
    slot: sequence,
    provider: "benchmark",
    observedAt: "2026-07-01T00:00:00.000Z",
    strategyVersion
  };
}

function trade(
  walletAddress: string,
  tokenAddress: string,
  side: "buy" | "sell",
  sequence: number,
  executionPriceUsd: number
): WalletTradeEvidence {
  const observedAt = new Date(Date.UTC(2026, 6, 1) + sequence * 1_000).toISOString();
  return {
    idempotencyKey: `${walletAddress}:${tokenAddress}:${side}:${sequence}`,
    chain: "solana",
    walletAddress,
    tokenAddress,
    poolAddress: `Pool:${tokenAddress}`,
    side,
    baseAmount: 100,
    executionPriceUsd,
    quoteValueUsd: 100 * executionPriceUsd,
    poolCreatedAt: "2026-07-01T00:00:00.000Z",
    poolAgeMinutes: 5,
    dataQuality: "observed-execution",
    signature: `${walletAddress}:${sequence}`,
    slot: sequence,
    provider: "benchmark",
    observedAt,
    strategyVersion,
    raw: {}
  };
}

function toMb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}
