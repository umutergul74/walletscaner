import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { runHistoricalReplay } from "@memecoin-alpha/backtesting";
import { loadRuntimeConfig } from "@memecoin-alpha/config";
import {
  canonicalizeHistoricalPriceObservations,
  isSourceLinkedWalletEntry
} from "@memecoin-alpha/core";
import { PostgresRepository } from "@memecoin-alpha/db";
import type { BacktestRun, Signal, WalletEntrySignalEvidence } from "@memecoin-alpha/shared";

interface ReplayCohortDefinition {
  key: string;
  label: string;
  canonical?: boolean;
  include(entry: WalletEntrySignalEvidence): boolean;
}

interface ReplayCohortResult {
  key: string;
  label: string;
  signalCount: number;
  executedTradeCount: number;
  rejectedSignalCount: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  averageReturnPercent: number;
  medianReturnPercent: number;
  tailLossPercent: number;
  liquidityFailureRate: number;
  passed: boolean;
  failureReasons: string[];
  run: BacktestRun;
}

interface EvidenceReplayReport {
  generatedAt: string;
  strategyVersion: string;
  source: string;
  observationDays: number;
  priceObservationCount: number;
  walletEntryCount: number;
  matureEntryCount: number;
  replayConfig: Record<string, unknown>;
  canonicalReplaySaved: boolean;
  cohorts: ReplayCohortResult[];
  limitations: string[];
}

const config = loadRuntimeConfig();
const repository = new PostgresRepository(config.databaseUrl);
const strategyVersion = process.env.ALPHA_STRATEGY_VERSION ?? "evidence-v1";
const generatedAt = new Date().toISOString();

const [allEntries, allPrices, allOutcomes] = await Promise.all([
  repository.listWalletEntrySignals(),
  repository.listPriceObservations(),
  repository.listWalletSignalOutcomes()
]);
const entries = allEntries
  .filter((entry) => entry.strategyVersion === strategyVersion)
  .sort((a, b) => time(a.observedAt) - time(b.observedAt));
const prices = canonicalizeHistoricalPriceObservations(
  allPrices.filter((price) => price.strategyVersion === strategyVersion)
).sort((a, b) => time(a.observedAt) - time(b.observedAt));
const matureEntryKeys = new Set(
  allOutcomes
    .filter(
      (outcome) =>
        outcome.strategyVersion === strategyVersion &&
        outcome.status === "mature" &&
        outcome.exitStrategy === "fixed-horizon"
    )
    .map((outcome) => outcome.entryIdempotencyKey)
);

const replayConfig = {
  strategyVersion,
  canonicalSourceLinked: true,
  startingBalanceUsd: config.paperTrading.startingBalanceUsd,
  positionSizeUsd: config.thresholds.paperPositionSizeUsd,
  maxOpenPositions: config.thresholds.maxOpenPaperPositions,
  feeBps: 30,
  slippageBps: 120,
  providerLatencyMs: 1_000,
  failedFillRate: 0,
  stopLossPercent: 20,
  takeProfitPercent: 15,
  timeExitMinutes: 20,
  minimumLiquidityUsd: config.thresholds.minimumLiquidityUsd
};

const cohortDefinitions: ReplayCohortDefinition[] = [
  {
    key: "all-controlled-flow",
    label: "Source-linked controlled-flow wallet entries",
    canonical: true,
    include: (entry) =>
      isSourceLinkedWalletEntry(entry) && entry.flowEvidence.controlledFlow === true
  },
  {
    key: "repeat-wallet+controlled-flow",
    label: "Repeat wallet + controlled-flow",
    include: (entry) =>
      isSourceLinkedWalletEntry(entry) &&
      entry.cohort === "repeat-wallet+controlled-flow" &&
      entry.repeatWalletCount >= 2 &&
      entry.flowEvidence.controlledFlow === true
  },
  {
    key: "controlled-flow-control",
    label: "Controlled-flow without repeat wallet",
    include: (entry) =>
      isSourceLinkedWalletEntry(entry) &&
      entry.cohort === "controlled-flow-control" &&
      entry.flowEvidence.controlledFlow === true
  },
  {
    key: "all-balanced-flow",
    label: "Historical balanced-flow with liquidity unresolved",
    include: (entry) => entry.flowEvidence.balancedFlow === true
  },
  {
    key: "repeat-wallet+balanced-flow",
    label: "Repeat wallet + historical balanced-flow",
    include: (entry) =>
      entry.cohort === "repeat-wallet+balanced-flow" &&
      entry.repeatWalletCount >= 2 &&
      entry.flowEvidence.balancedFlow === true
  },
  {
    key: "balanced-flow-control",
    label: "Historical balanced-flow without repeat wallet",
    include: (entry) =>
      entry.cohort === "balanced-flow-control" && entry.flowEvidence.balancedFlow === true
  },
  {
    key: "excluded-uncontrolled-flow-baseline",
    label: "Excluded uncontrolled-flow baseline",
    include: (entry) => entry.cohort === "excluded-uncontrolled-flow"
  },
  {
    key: "all-observed-wallet-buys-baseline",
    label: "All observed wallet buys baseline",
    include: (entry) => Boolean(entry.sourceSwapIdempotencyKey)
  }
];

const pricePoints = prices.map((price) => ({
  tokenAddress: price.tokenAddress,
  observedAt: price.observedAt,
  priceUsd: price.priceUsd,
  liquidityUsd: price.liquidityUsd,
  rugged: price.rugged
}));
const cohortResults = cohortDefinitions.map((definition) => {
  const cohortEntries = entries.filter(definition.include);
  const cohortSignals = buildSignals(cohortEntries, definition);
  const run = runHistoricalReplay(
    cohortSignals,
    pricePoints,
    {
      ...replayConfig,
      minimumLiquidityUsd: definition.key.includes("balanced-flow")
        ? 0
        : replayConfig.minimumLiquidityUsd,
      strategyVersion: definition.canonical
        ? strategyVersion
        : `${strategyVersion}:${definition.key}`
    },
    generatedAt
  );
  const normalizedRun = normalizeRun(run, definition);
  const failureReasons = replayFailureReasons(normalizedRun);
  return {
    key: definition.key,
    label: definition.label,
    signalCount: cohortSignals.length,
    executedTradeCount: normalizedRun.metrics.executedTradeCount,
    rejectedSignalCount: normalizedRun.metrics.rejectedSignalCount,
    winRate: normalizedRun.metrics.winRate,
    profitFactor: normalizedRun.metrics.profitFactor,
    maxDrawdownPercent: normalizedRun.metrics.maxDrawdownPercent,
    averageReturnPercent: normalizedRun.metrics.averageReturnPercent,
    medianReturnPercent: normalizedRun.metrics.medianReturnPercent,
    tailLossPercent: normalizedRun.metrics.tailLossPercent,
    liquidityFailureRate: normalizedRun.metrics.liquidityFailureRate,
    passed: failureReasons.length === 0,
    failureReasons,
    run: normalizedRun
  };
});

const canonical = cohortResults.find((result) => result.key === "all-controlled-flow");
let canonicalReplaySaved = false;
if (canonical && canonical.signalCount > 0) {
  await repository.saveBacktestRun(canonical.run);
  canonicalReplaySaved = true;
}

const report: EvidenceReplayReport = {
  generatedAt,
  strategyVersion,
  source: "PostgreSQL evidence store; canonical replay uses source-swap-linked entries only.",
  observationDays: observationDays(entries),
  priceObservationCount: prices.length,
  walletEntryCount: entries.length,
  matureEntryCount: entries.filter((entry) => matureEntryKeys.has(entry.idempotencyKey)).length,
  replayConfig,
  canonicalReplaySaved,
  cohorts: cohortResults,
  limitations: [
    "This replay only covers evidence already captured locally in PostgreSQL.",
    "Unlinked market-watch wallet scans are excluded from canonical replay.",
    "A real multi-day historical test still needs archival Solana transaction and price backfill.",
    "Signals are replayed chronologically with capital and max-open-position limits; no live execution is enabled."
  ]
};

await mkdir("reports", { recursive: true });
await writeFile("reports/evidence-replay-latest.json", JSON.stringify(report, null, 2));
await writeFile("reports/evidence-replay-latest.md", renderReplayMarkdown(report));

console.log(
  JSON.stringify(
    {
      generatedAt: report.generatedAt,
      canonicalReplaySaved,
      bestCohort: cohortResults.slice().sort((a, b) => b.profitFactor - a.profitFactor)[0]?.key,
      reports: ["reports/evidence-replay-latest.json", "reports/evidence-replay-latest.md"]
    },
    null,
    2
  )
);

function buildSignals(
  cohortEntries: WalletEntrySignalEvidence[],
  definition: ReplayCohortDefinition
): Signal[] {
  const replayStrategyVersion = definition.canonical
    ? strategyVersion
    : `${strategyVersion}:${definition.key}`;
  return dedupeEntriesByToken(cohortEntries).map((entry) => {
    const signal: Signal = {
      id: `${definition.key}:${entry.idempotencyKey}`,
      strategyVersion: replayStrategyVersion,
      chain: entry.chain,
      tokenAddress: entry.tokenAddress,
      tokenSymbol: shortAddress(entry.tokenAddress),
      signalType: "evidence-replay-wallet-entry",
      confidence: entry.repeatWalletCount >= 2 ? 70 : 60,
      riskScore: 50,
      tokenScore: 50,
      detectedAt: entry.observedAt,
      keyReasons: [
        definition.label,
        `cohort=${entry.cohort}`,
        `repeatWalletCount=${entry.repeatWalletCount}`
      ],
      wallets: [],
      liquiditySnapshot: {
        liquidityUsd: entry.observedLiquidityUsd
      },
      volumeSnapshot: {
        volume5mUsd: numberValue(entry.flowEvidence.volume5mUsd),
        volume1hUsd: numberValue(entry.flowEvidence.volume1hUsd),
        buys5m: numberValue(entry.flowEvidence.buys5m),
        sells5m: numberValue(entry.flowEvidence.sells5m)
      },
      holderSnapshot: {
        holderCount: 0,
        topHolderPercent: 0,
        top10HolderPercent: 0,
        capturedAt: entry.observedAt
      },
      actionCategory: "paper-trade candidate",
      noFinancialAdvice: true
    };
    return entry.poolAddress ? { ...signal, poolAddress: entry.poolAddress } : signal;
  });
}

function normalizeRun(run: BacktestRun, definition: ReplayCohortDefinition): BacktestRun {
  return {
    ...run,
    id: createHash("sha256")
      .update(`evidence-replay:${definition.key}:${run.id}`)
      .digest("hex")
      .slice(0, 24),
    config: {
      ...run.config,
      replayCohort: definition.key,
      replayLabel: definition.label,
      canonicalSourceLinked: Boolean(definition.canonical),
      evidenceSource: "wallet_entry_signals + price_observations"
    }
  };
}

function replayFailureReasons(run: BacktestRun): string[] {
  const reasons: string[] = [];
  if (run.metrics.executedTradeCount < 10) {
    reasons.push(`${run.metrics.executedTradeCount}/10 executed trades.`);
  }
  if (run.metrics.profitFactor < 1.2) {
    reasons.push(`profit factor ${run.metrics.profitFactor} < 1.2.`);
  }
  if (run.metrics.maxDrawdownPercent > 15) {
    reasons.push(`max drawdown ${run.metrics.maxDrawdownPercent}% > 15%.`);
  }
  if (run.metrics.winRate < 0.5) {
    reasons.push(`win rate ${round(run.metrics.winRate * 100)}% < 50%.`);
  }
  if (run.metrics.medianReturnPercent < 0) {
    reasons.push(`median return ${run.metrics.medianReturnPercent}% < 0%.`);
  }
  if (run.metrics.averageReturnPercent < 2) {
    reasons.push(`average return ${run.metrics.averageReturnPercent}% < 2%.`);
  }
  if (run.metrics.tailLossPercent < -35) {
    reasons.push(`tail loss ${run.metrics.tailLossPercent}% < -35%.`);
  }
  return reasons;
}

function renderReplayMarkdown(report: EvidenceReplayReport): string {
  return [
    "# Evidence Walk-Forward Replay",
    "",
    `Generated: ${report.generatedAt}`,
    `Strategy version: ${report.strategyVersion}`,
    `Source: ${report.source}`,
    "",
    "Research and paper mode only. This is not financial advice.",
    "",
    "## Data Window",
    "",
    `Observation days: ${report.observationDays}`,
    `Price observations: ${report.priceObservationCount}`,
    `Wallet entries: ${report.walletEntryCount}`,
    `Mature entries: ${report.matureEntryCount}`,
    `Canonical replay saved: ${report.canonicalReplaySaved ? "yes" : "no"}`,
    "",
    "## Replay Cohorts",
    "",
    "| Cohort | Signals | Trades | PF | Win | Avg | Median | Tail | Max DD | Verdict |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ...report.cohorts.map((cohort) =>
      [
        cohort.key,
        cohort.signalCount,
        cohort.executedTradeCount,
        cohort.profitFactor,
        `${round(cohort.winRate * 100)}%`,
        `${cohort.averageReturnPercent}%`,
        `${cohort.medianReturnPercent}%`,
        `${cohort.tailLossPercent}%`,
        `${cohort.maxDrawdownPercent}%`,
        cohort.passed ? "pass" : "fail"
      ].join(" | ")
    ),
    "",
    "## Failure Reasons",
    "",
    ...report.cohorts.flatMap((cohort) => [
      `### ${cohort.key}`,
      ...(cohort.failureReasons.length > 0
        ? cohort.failureReasons.map((reason) => `- ${reason}`)
        : ["- Passed replay gates."]),
      ""
    ]),
    "## Limitations",
    "",
    ...report.limitations.map((item) => `- ${item}`)
  ].join("\n");
}

function dedupeEntriesByToken(
  cohortEntries: WalletEntrySignalEvidence[]
): WalletEntrySignalEvidence[] {
  const seen = new Set<string>();
  return [...cohortEntries]
    .sort((a, b) => time(a.observedAt) - time(b.observedAt))
    .filter((entry) => {
      const key = `${entry.strategyVersion}:${entry.tokenAddress}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function observationDays(cohortEntries: WalletEntrySignalEvidence[]): number {
  if (cohortEntries.length < 2) return 0;
  const start = time(cohortEntries[0]!.observedAt);
  const end = time(cohortEntries[cohortEntries.length - 1]!.observedAt);
  return round((end - start) / 86_400_000);
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function shortAddress(address: string): string {
  return address.length > 8 ? `${address.slice(0, 4)}...${address.slice(-4)}` : address;
}

function time(value: string): number {
  return new Date(value).getTime();
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
