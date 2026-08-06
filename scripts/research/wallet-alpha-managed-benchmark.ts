import { performance } from "node:perf_hooks";
import { buildWalletAlphaScores, MANAGED_EXIT_V2_POLICY } from "@memecoin-alpha/core";
import type {
  WalletEntrySignalEvidence,
  WalletSignalOutcomeEvidence,
  WalletTradeEvidence
} from "@memecoin-alpha/shared";

const walletCount = 100;
const samplesPerWallet = 30;
const trades: WalletTradeEvidence[] = [];
const entries: WalletEntrySignalEvidence[] = [];
const outcomes: WalletSignalOutcomeEvidence[] = [];

for (let walletIndex = 0; walletIndex < walletCount; walletIndex += 1) {
  const walletAddress = `BenchmarkWallet${walletIndex}`;
  for (let sampleIndex = 0; sampleIndex < samplesPerWallet; sampleIndex += 1) {
    const tokenAddress = `BenchmarkToken${walletIndex}:${sampleIndex}`;
    const observedAt = sampleTime(sampleIndex, 6);
    const entryKey = `entry:${walletIndex}:${sampleIndex}`;
    trades.push(
      trade(walletAddress, tokenAddress, "buy", sampleTime(sampleIndex, 5), 1),
      trade(walletAddress, tokenAddress, "sell", sampleTime(sampleIndex, 20), 1.2)
    );
    entries.push({
      idempotencyKey: entryKey,
      chain: "solana",
      walletAddress,
      tokenAddress,
      poolAddress: `Pool:${tokenAddress}`,
      sourceSwapIdempotencyKey: `swap:${walletIndex}:${sampleIndex}`,
      observedEntryPriceUsd: 1,
      observedLiquidityUsd: 20_000,
      cohort: "wallet-alpha",
      repeatWalletCount: sampleIndex,
      flowEvidence: { poolAgeMinutes: 6, tokenRiskKnown: true, tokenRiskPassed: true },
      signature: `entry-signature:${walletIndex}:${sampleIndex}`,
      slot: walletIndex * 10_000 + sampleIndex * 2 + 1,
      provider: "benchmark",
      observedAt,
      strategyVersion: "evidence-v1"
    });
    const rugged = sampleIndex === 0;
    const netReturnPct = rugged ? -103 : 15;
    outcomes.push({
      idempotencyKey: `managed-outcome:${walletIndex}:${sampleIndex}`,
      chain: "solana",
      entryIdempotencyKey: entryKey,
      horizonMinutes: 20,
      status: "mature",
      outcomePriceUsd: rugged ? 0 : 1.18,
      frozenAt: sampleTime(sampleIndex, 26),
      grossReturnPct: netReturnPct + 3,
      netReturnPct,
      estimatedRoundTripCostPct: 3,
      exitStrategy: "tp15-sl20-20m",
      rugged,
      signature: `managed-outcome-signature:${walletIndex}:${sampleIndex}`,
      slot: walletIndex * 10_000 + sampleIndex * 2 + 2,
      provider: "benchmark",
      observedAt: sampleTime(sampleIndex, 26),
      strategyVersion: "evidence-v1",
      raw: {}
    });
  }
}

const startedAt = performance.now();
const scores = buildWalletAlphaScores({
  trades,
  entries,
  outcomes,
  strategyVersion: "evidence-v1",
  scoreStrategyVersion: MANAGED_EXIT_V2_POLICY.scoreStrategyVersion,
  scoringPolicy: "managed-exit-v2",
  calculatedAt: "2026-08-15T00:00:00.000Z"
});
const durationMs = performance.now() - startedAt;
const memory = process.memoryUsage();
const heapUsedMb = toMb(memory.heapUsed);
const rssMb = toMb(memory.rss);
const watchCount = scores.filter((score) => score.status === "watch").length;

if (scores.length !== walletCount || watchCount !== walletCount) {
  throw new Error(
    `Managed benchmark produced ${scores.length} scores and ${watchCount} watches; expected ${walletCount}.`
  );
}
if (durationMs > 10_000) {
  throw new Error(
    `Managed benchmark exceeded the 10s runtime boundary: ${durationMs.toFixed(2)}ms.`
  );
}
if (heapUsedMb > 100) {
  throw new Error(`Managed benchmark exceeded the 100 MiB heap boundary: ${heapUsedMb} MiB.`);
}
if (rssMb > 160) {
  throw new Error(`Managed benchmark exceeded the 160 MiB RSS boundary: ${rssMb} MiB.`);
}

console.log(
  JSON.stringify({
    type: "wallet-alpha-managed-benchmark",
    walletCount,
    samplesPerWallet,
    inputs: { trades: trades.length, entries: entries.length, outcomes: outcomes.length },
    scores: scores.length,
    watchCount,
    durationMs: Math.round(durationMs * 100) / 100,
    memoryMb: { heapUsed: heapUsedMb, rss: rssMb },
    limits: { durationMs: 10_000, heapUsedMb: 100, rssMb: 160 }
  })
);

function trade(
  walletAddress: string,
  tokenAddress: string,
  side: "buy" | "sell",
  observedAt: string,
  executionPriceUsd: number
): WalletTradeEvidence {
  return {
    idempotencyKey: `${walletAddress}:${tokenAddress}:${side}`,
    chain: "solana",
    walletAddress,
    tokenAddress,
    poolAddress: `Pool:${tokenAddress}`,
    side,
    baseAmount: 100,
    executionPriceUsd,
    poolCreatedAt: observedAt.slice(0, 11) + "00:00:00.000Z",
    poolAgeMinutes: 5,
    dataQuality: "observed-execution",
    signature: `${walletAddress}:${tokenAddress}:${side}`,
    slot: Number.parseInt(walletAddress.replace("BenchmarkWallet", ""), 10) * 10_000,
    provider: "benchmark",
    observedAt,
    strategyVersion: "evidence-v1",
    raw: {}
  };
}

function sampleTime(sampleIndex: number, minute: number): string {
  const date = new Date("2026-07-01T00:00:00.000Z");
  date.setUTCDate(date.getUTCDate() + sampleIndex);
  date.setUTCMinutes(minute);
  return date.toISOString();
}

function toMb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}
