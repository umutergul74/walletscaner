import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { runHistoricalReplay } from "@memecoin-alpha/backtesting";
import { loadRuntimeConfig } from "@memecoin-alpha/config";
import {
  assessFixedHorizonEvidence,
  canonicalizeHistoricalPriceObservations,
  isSourceLinkedWalletEntry
} from "@memecoin-alpha/core";
import { PostgresRepository } from "@memecoin-alpha/db";
import type {
  BacktestMetrics,
  BacktestRun,
  Signal,
  WalletEntrySignalEvidence,
  WalletSignalOutcomeEvidence
} from "@memecoin-alpha/shared";
import { summarizeReturns } from "./robust-stats.js";
import {
  lockBestCandidate,
  splitChronologicalWalkForward,
  type WalkForwardWindows
} from "./walk-forward-selection.js";

interface EntryRecord {
  entry: WalletEntrySignalEvidence;
  outcome: WalletSignalOutcomeEvidence;
  tokenAddress: string;
  observedAt: string;
  netReturnPct: number;
  features: SearchFeatures;
}

interface SearchFeatures {
  controlledFlow: boolean;
  balancedFlow: boolean;
  observedLiquidityUsd: number;
  volume5mUsd: number;
  volume1hUsd: number;
  buys5m: number;
  sells5m: number;
  swaps5m: number;
  buyShare5m: number;
  volumeLiquidityRatio: number;
  poolAgeMinutes: number;
  repeatWalletCount: number;
}

interface CandidateSpec {
  id: string;
  label: string;
  cohortMode:
    | "all"
    | "controlled"
    | "repeat-controlled"
    | "control-only"
    | "balanced"
    | "repeat-balanced"
    | "balanced-control"
    | "excluded";
  minRepeatWalletCount: number;
  minLiquidityUsd: number;
  minVolume5mUsd: number;
  minBuyShare5m: number;
  maxBuyShare5m: number;
  maxSwaps5m: number;
  maxVolumeLiquidityRatio: number;
  maxPoolAgeMinutes: number;
}

interface WindowStats {
  count: number;
  averageReturnPct: number;
  medianReturnPct: number;
  averageReturnExBestPct: number;
  bestWinnerShare: number;
  hitRate: number;
  worstReturnPct: number;
  score: number;
  passed: boolean;
}

interface CandidateResult {
  candidate: CandidateSpec;
  selectedCount: number;
  train: WindowStats;
  validation: WindowStats;
  holdout1: WindowStats;
  holdout2: WindowStats;
  replay: Pick<
    BacktestMetrics,
    | "executedTradeCount"
    | "profitFactor"
    | "winRate"
    | "averageReturnPercent"
    | "medianReturnPercent"
    | "tailLossPercent"
    | "maxDrawdownPercent"
    | "positionLimitRejectedCount"
    | "capitalRejectedCount"
  >;
  replayPassed: boolean;
  passed: boolean;
  failureReasons: string[];
  replayRun: BacktestRun;
}

type SelectionCandidateResult = Omit<
  CandidateResult,
  "holdout1" | "holdout2" | "replay" | "replayPassed" | "passed" | "replayRun"
>;

interface StrategySearchReport {
  generatedAt: string;
  strategyVersion: string;
  methodDecision: "no-method" | "watch-candidate" | "validated-candidate";
  candidateSpaceSize: number;
  candidatesEvaluated: number;
  replayCandidatesEvaluated: number;
  recordsAvailable: number;
  observationDays: number;
  bestCandidate: CandidateResult | null;
  passedCandidates: CandidateResult[];
  topCandidates: CandidateResult[];
  notes: string[];
}

const config = loadRuntimeConfig();
const repository = new PostgresRepository(config.databaseUrl);
const strategyVersion = process.env.ALPHA_STRATEGY_VERSION ?? "evidence-v1";
const generatedAt = new Date().toISOString();

const [entries, outcomes, prices] = await Promise.all([
  repository.listWalletEntrySignals(),
  repository.listWalletSignalOutcomes("mature"),
  repository.listPriceObservations()
]);
const records = dedupeRecordsByToken(buildRecords(entries, outcomes)).sort(
  (a, b) => time(a.observedAt) - time(b.observedAt)
);
const pricePoints = canonicalizeHistoricalPriceObservations(
  prices.filter((price) => price.strategyVersion === strategyVersion)
).map((price) => ({
  tokenAddress: price.tokenAddress,
  observedAt: price.observedAt,
  priceUsd: price.priceUsd,
  liquidityUsd: price.liquidityUsd,
  rugged: price.rugged
}));

const maxPreReplayCandidates = numberFromEnv("STRATEGY_SEARCH_MAX_CANDIDATES", 12_000);
const windows = splitChronologicalWalkForward(records);
const candidateSpace = generateCandidates(windows.train);
const candidates = selectCandidatesForEvaluation(candidateSpace, maxPreReplayCandidates);
const selectionResults = candidates
  .map((candidate) => evaluateCandidateForSelection(candidate, windows))
  .filter((result) => result.selectedCount > 0);
const lockedSelection = lockBestCandidate(selectionResults);
const results = lockedSelection
  ? [evaluateLockedCandidate(lockedSelection, windows, records, pricePoints)]
  : [];

const passedCandidates = results.filter((result) => result.passed);
const bestCandidate = results[0] ?? null;
const observedDays = observationDays(records);
const report: StrategySearchReport = {
  generatedAt,
  strategyVersion,
  methodDecision:
    passedCandidates.length === 0
      ? "no-method"
      : observedDays >= 7
        ? "validated-candidate"
        : "watch-candidate",
  candidateSpaceSize: candidateSpace.length,
  candidatesEvaluated: candidates.length,
  replayCandidatesEvaluated: results.length,
  recordsAvailable: records.length,
  observationDays: observedDays,
  bestCandidate,
  passedCandidates,
  topCandidates: results.slice(0, 25),
  notes: [
    "Candidates are generated from the chronological training window and ranked only on train plus validation evidence.",
    "Exactly one locked candidate is evaluated once on two untouched chronological holdouts and capital-constrained replay.",
    "Canonical search excludes wallet scans without a persisted source swap.",
    "A strategy is not promoted unless both holdouts and replay pass robust gates.",
    "Historical balanced-flow candidates use real pre-entry 5m trade flow but keep liquidity unresolved; they may generate hypotheses but cannot satisfy the final liquidity-quality gate.",
    "This search uses only locally collected PostgreSQL evidence."
  ]
};

if (passedCandidates[0]) {
  await repository.saveBacktestRun(passedCandidates[0].replayRun);
}
await persistCanonicalSearchDecision(passedCandidates[0] ?? null, bestCandidate, records);

await mkdir("reports", { recursive: true });
await writeFile("reports/evidence-strategy-search-latest.json", JSON.stringify(report, null, 2));
await writeFile("reports/evidence-strategy-search-latest.md", renderMarkdown(report));

console.log(
  JSON.stringify(
    {
      generatedAt,
      methodDecision: report.methodDecision,
      candidateSpaceSize: report.candidateSpaceSize,
      candidatesEvaluated: report.candidatesEvaluated,
      replayCandidatesEvaluated: report.replayCandidatesEvaluated,
      recordsAvailable: report.recordsAvailable,
      bestCandidate: bestCandidate
        ? {
            id: bestCandidate.candidate.id,
            label: bestCandidate.candidate.label,
            selectedCount: bestCandidate.selectedCount,
            train: bestCandidate.train,
            validation: bestCandidate.validation,
            holdout1: bestCandidate.holdout1,
            holdout2: bestCandidate.holdout2,
            replay: bestCandidate.replay,
            passed: bestCandidate.passed
          }
        : null,
      reports: [
        "reports/evidence-strategy-search-latest.json",
        "reports/evidence-strategy-search-latest.md"
      ]
    },
    null,
    2
  )
);

function buildRecords(
  allEntries: WalletEntrySignalEvidence[],
  allOutcomes: WalletSignalOutcomeEvidence[]
): EntryRecord[] {
  const canonicalEntries = allEntries.filter(
    (entry) => entry.strategyVersion === strategyVersion && isSourceLinkedWalletEntry(entry)
  );
  const entryByKey = new Map(canonicalEntries.map((entry) => [entry.idempotencyKey, entry]));
  const outcomeByEntry = new Map(
    allOutcomes
      .filter((outcome) => {
        const entry = entryByKey.get(outcome.entryIdempotencyKey);
        return Boolean(
          entry &&
          outcome.strategyVersion === strategyVersion &&
          assessFixedHorizonEvidence(entry, outcome).canonical
        );
      })
      .map((outcome) => [outcome.entryIdempotencyKey, outcome])
  );
  return canonicalEntries.flatMap((entry) => {
    const outcome = outcomeByEntry.get(entry.idempotencyKey);
    if (!outcome || outcome.netReturnPct === undefined) return [];
    return [
      {
        entry,
        outcome,
        tokenAddress: entry.tokenAddress,
        observedAt: outcome.frozenAt ?? outcome.observedAt,
        netReturnPct: outcome.netReturnPct,
        features: extractFeatures(entry)
      }
    ];
  });
}

async function persistCanonicalSearchDecision(
  passedCandidate: CandidateResult | null,
  leadingCandidate: CandidateResult | null,
  sourceRecords: EntryRecord[]
): Promise<void> {
  const candidate = passedCandidate ?? leadingCandidate;
  const selected = candidate
    ? dedupeRecordsByToken(
        sourceRecords.filter((record) => matchesCandidate(candidate.candidate, record))
      )
    : [];
  const stats = candidate?.holdout2;
  const runId = createHash("sha256")
    .update(`${strategyVersion}:canonical-strategy-search:${generatedAt}`)
    .digest("hex")
    .slice(0, 24);
  await repository.saveHypothesisRun({
    idempotencyKey: `hypothesis:${runId}`,
    runId,
    chain: "solana",
    hypothesisKey: "canonical-strategy-search",
    cohort: candidate?.candidate.label ?? "none",
    verdict: passedCandidate ? "candidate" : "reject",
    signalKeys: selected.map((record) => record.tokenAddress),
    metrics: {
      signalCount: selected.length,
      averageReturnPct: stats?.averageReturnPct ?? 0,
      medianReturnPct: stats?.medianReturnPct ?? 0,
      averageReturnExBestPct: stats?.averageReturnExBestPct ?? 0,
      bestWinnerShare: stats?.bestWinnerShare ?? 0,
      hitRate: stats?.hitRate ?? 0,
      averageDrawdownPct: candidate?.replay.maxDrawdownPercent
        ? -Math.abs(candidate.replay.maxDrawdownPercent)
        : 0,
      worstReturnPct: stats?.worstReturnPct ?? 0,
      canonicalSourceLinked: 1,
      replayPassed: candidate?.replayPassed ? 1 : 0
    },
    decisionReason: passedCandidate
      ? "Source-linked candidate passed train, two chronological holdouts, and capital-constrained replay."
      : "No source-linked candidate passed both holdouts and capital-constrained replay.",
    signature: `derived:${runId}`,
    slot: Math.max(...selected.map((record) => record.entry.slot), 0),
    provider: "evidence-strategy-search",
    observedAt: generatedAt,
    strategyVersion
  });
}

function extractFeatures(entry: WalletEntrySignalEvidence): SearchFeatures {
  const buys5m = numberValue(entry.flowEvidence.buys5m);
  const sells5m = numberValue(entry.flowEvidence.sells5m);
  const swaps5m = numberValue(entry.flowEvidence.swaps5m) || buys5m + sells5m;
  const liquidityUsd = numberValue(entry.flowEvidence.liquidityUsd) || entry.observedLiquidityUsd;
  const volume5mUsd = numberValue(entry.flowEvidence.volume5mUsd);
  return {
    controlledFlow: entry.flowEvidence.controlledFlow === true,
    balancedFlow: entry.flowEvidence.balancedFlow === true,
    observedLiquidityUsd: entry.observedLiquidityUsd,
    volume5mUsd,
    volume1hUsd: numberValue(entry.flowEvidence.volume1hUsd),
    buys5m,
    sells5m,
    swaps5m,
    buyShare5m: numberValue(entry.flowEvidence.buyShare5m) || buys5m / Math.max(swaps5m, 1),
    volumeLiquidityRatio:
      entry.flowEvidence.liquidityKnown === false
        ? Number.POSITIVE_INFINITY
        : numberValue(entry.flowEvidence.volumeLiquidityRatio) ||
          volume5mUsd / Math.max(liquidityUsd, 1),
    poolAgeMinutes: numberValue(entry.flowEvidence.poolAgeMinutes),
    repeatWalletCount: entry.repeatWalletCount
  };
}

function generateCandidates(sourceRecords: EntryRecord[]): CandidateSpec[] {
  const liquidityThresholds = thresholdsFrom(
    sourceRecords.map((record) => record.features.observedLiquidityUsd),
    [0, 0.25, 0.5, 0.75, 0.9],
    [0, config.thresholds.minimumLiquidityUsd, 20_000, 50_000]
  );
  const volumeThresholds = thresholdsFrom(
    sourceRecords.map((record) => record.features.volume5mUsd),
    [0, 0.25, 0.5, 0.75, 0.9],
    [0, config.thresholds.minimumVolume5mUsd, 10_000, 25_000, 50_000]
  );
  const maxSwapsValues = thresholdsFrom(
    sourceRecords.map((record) => record.features.swaps5m),
    [0.25, 0.5, 0.75, 0.9, 1],
    [50, 100, 300, 600, Number.POSITIVE_INFINITY]
  );
  const maxVlrValues = thresholdsFrom(
    sourceRecords.map((record) => record.features.volumeLiquidityRatio),
    [0.25, 0.5, 0.75, 0.9],
    [1, 2, 4, 8, Number.POSITIVE_INFINITY]
  );
  const buyShareRanges = [
    [0, 1],
    [0.4, 0.9],
    [0.45, 0.85],
    [0.5, 0.85],
    [0.55, 0.8],
    [0.6, 0.8]
  ] as const;
  const candidates: CandidateSpec[] = [];
  for (const cohortMode of [
    "all",
    "controlled",
    "repeat-controlled",
    "control-only",
    "balanced",
    "repeat-balanced",
    "balanced-control",
    "excluded"
  ] as const) {
    const balancedMode =
      cohortMode === "balanced" ||
      cohortMode === "repeat-balanced" ||
      cohortMode === "balanced-control";
    for (const minRepeatWalletCount of [0, 1, 2, 3]) {
      if (
        (cohortMode === "repeat-controlled" || cohortMode === "repeat-balanced") &&
        minRepeatWalletCount < 2
      ) {
        continue;
      }
      for (const minLiquidityUsd of balancedMode ? [0] : liquidityThresholds) {
        for (const minVolume5mUsd of volumeThresholds) {
          for (const maxSwaps5m of maxSwapsValues) {
            for (const maxVolumeLiquidityRatio of balancedMode
              ? [Number.POSITIVE_INFINITY]
              : maxVlrValues) {
              for (const maxPoolAgeMinutes of balancedMode
                ? [Number.POSITIVE_INFINITY]
                : [20, 40, 120, Number.POSITIVE_INFINITY]) {
                for (const [minBuyShare5m, maxBuyShare5m] of buyShareRanges) {
                  const candidate = {
                    cohortMode,
                    minRepeatWalletCount,
                    minLiquidityUsd,
                    minVolume5mUsd,
                    minBuyShare5m,
                    maxBuyShare5m,
                    maxSwaps5m,
                    maxVolumeLiquidityRatio,
                    maxPoolAgeMinutes
                  };
                  const label = labelCandidate(candidate);
                  candidates.push({
                    ...candidate,
                    id: createHash("sha256").update(label).digest("hex").slice(0, 16),
                    label
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  return candidates;
}

function evaluateCandidateForSelection(
  candidate: CandidateSpec,
  windows: WalkForwardWindows<EntryRecord>
): SelectionCandidateResult {
  const trainRecords = windows.train.filter((record) => matchesCandidate(candidate, record));
  const validationRecords = windows.validation.filter((record) =>
    matchesCandidate(candidate, record)
  );
  const train = summarizeWindow(trainRecords);
  const validation = summarizeWindow(validationRecords);
  const failureReasons = [
    ...windowFailureReasons("train", train),
    ...windowFailureReasons("validation", validation)
  ];
  return {
    candidate,
    selectedCount: trainRecords.length + validationRecords.length,
    train,
    validation,
    failureReasons
  };
}

function evaluateLockedCandidate(
  selection: SelectionCandidateResult,
  windows: WalkForwardWindows<EntryRecord>,
  sourceRecords: EntryRecord[],
  pricePoints: Array<{
    tokenAddress: string;
    observedAt: string;
    priceUsd: number;
    liquidityUsd: number;
    rugged?: boolean;
  }>
): CandidateResult {
  const holdout1 = summarizeWindow(
    windows.holdout1.filter((record) => matchesCandidate(selection.candidate, record))
  );
  const holdout2 = summarizeWindow(
    windows.holdout2.filter((record) => matchesCandidate(selection.candidate, record))
  );
  const replayStrategyVersion = `${strategyVersion}:search:${selection.candidate.id}`;
  const selected = sourceRecords.filter((record) => matchesCandidate(selection.candidate, record));
  const selectedTokens = new Set(selected.map((record) => record.tokenAddress));
  const candidatePricePoints = pricePoints.filter((point) =>
    selectedTokens.has(point.tokenAddress)
  );
  const run = runHistoricalReplay(
    selected.map((record) =>
      buildReplaySignal(record.entry, selection.candidate, replayStrategyVersion)
    ),
    candidatePricePoints,
    {
      strategyVersion: replayStrategyVersion,
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
      minimumLiquidityUsd: selection.candidate.minLiquidityUsd
    }
  );
  const replay = {
    executedTradeCount: run.metrics.executedTradeCount,
    profitFactor: run.metrics.profitFactor,
    winRate: run.metrics.winRate,
    averageReturnPercent: run.metrics.averageReturnPercent,
    medianReturnPercent: run.metrics.medianReturnPercent,
    tailLossPercent: run.metrics.tailLossPercent,
    maxDrawdownPercent: run.metrics.maxDrawdownPercent,
    positionLimitRejectedCount: run.metrics.positionLimitRejectedCount,
    capitalRejectedCount: run.metrics.capitalRejectedCount
  };
  const replayFailures = replayFailureReasons(run);
  const dataQualityFailures = selection.candidate.cohortMode.includes("balanced")
    ? ["historical-liquidity-unresolved"]
    : [];
  const failureReasons = [
    ...selection.failureReasons,
    ...windowFailureReasons("holdout-1", holdout1),
    ...windowFailureReasons("holdout-2", holdout2),
    ...replayFailures,
    ...dataQualityFailures
  ];
  const replayRun: BacktestRun = {
    ...run,
    id: createHash("sha256")
      .update(`canonical-strategy-search:${selection.candidate.id}:${run.id}`)
      .digest("hex")
      .slice(0, 24),
    strategyVersion,
    config: {
      ...run.config,
      strategyVersion,
      canonicalSourceLinked: true,
      strategySearchCandidateId: selection.candidate.id,
      strategySearchCandidateLabel: selection.candidate.label,
      evidenceSource: "source-linked wallet entries + price observations"
    }
  };
  return {
    ...selection,
    selectedCount: selected.length,
    holdout1,
    holdout2,
    replay,
    replayPassed: replayFailures.length === 0,
    passed:
      selection.train.passed &&
      selection.validation.passed &&
      holdout1.passed &&
      holdout2.passed &&
      replayFailures.length === 0 &&
      dataQualityFailures.length === 0,
    failureReasons,
    replayRun
  };
}

function matchesCandidate(candidate: CandidateSpec, record: EntryRecord): boolean {
  const { entry, features } = record;
  if (candidate.cohortMode === "controlled" && !features.controlledFlow) return false;
  if (candidate.cohortMode === "balanced" && !features.balancedFlow) return false;
  if (
    candidate.cohortMode === "repeat-controlled" &&
    (!features.controlledFlow || entry.cohort !== "repeat-wallet+controlled-flow")
  ) {
    return false;
  }
  if (
    candidate.cohortMode === "control-only" &&
    (!features.controlledFlow || entry.cohort !== "controlled-flow-control")
  ) {
    return false;
  }
  if (
    candidate.cohortMode === "repeat-balanced" &&
    (!features.balancedFlow || entry.cohort !== "repeat-wallet+balanced-flow")
  ) {
    return false;
  }
  if (
    candidate.cohortMode === "balanced-control" &&
    (!features.balancedFlow || entry.cohort !== "balanced-flow-control")
  ) {
    return false;
  }
  if (candidate.cohortMode === "excluded" && entry.cohort !== "excluded-uncontrolled-flow") {
    return false;
  }
  return (
    features.repeatWalletCount >= candidate.minRepeatWalletCount &&
    features.observedLiquidityUsd >= candidate.minLiquidityUsd &&
    features.volume5mUsd >= candidate.minVolume5mUsd &&
    features.buyShare5m >= candidate.minBuyShare5m &&
    features.buyShare5m <= candidate.maxBuyShare5m &&
    features.swaps5m <= candidate.maxSwaps5m &&
    features.volumeLiquidityRatio <= candidate.maxVolumeLiquidityRatio &&
    features.poolAgeMinutes <= candidate.maxPoolAgeMinutes
  );
}

function summarizeWindow(recordsToSummarize: EntryRecord[]): WindowStats {
  const values = recordsToSummarize.map((record) => record.netReturnPct);
  const stats = summarizeReturns(values);
  const hitRate = values.filter((value) => value > 0).length / Math.max(values.length, 1);
  const worstReturnPct = values.length > 0 ? Math.min(...values) : 0;
  const score =
    values.length < 10
      ? -1_000 + values.length
      : stats.average +
        stats.median +
        stats.averageWithoutBest +
        hitRate * 25 -
        stats.bestWinnerShare * 25 +
        Math.max(-50, worstReturnPct / 2);
  const passed =
    values.length >= 10 &&
    stats.average >= 2 &&
    stats.median >= 0 &&
    stats.averageWithoutBest > 0 &&
    stats.bestWinnerShare <= 0.35 &&
    hitRate >= 0.5 &&
    worstReturnPct >= -35;
  return {
    count: values.length,
    averageReturnPct: round(stats.average),
    medianReturnPct: round(stats.median),
    averageReturnExBestPct: round(stats.averageWithoutBest),
    bestWinnerShare: round(stats.bestWinnerShare),
    hitRate: round(hitRate),
    worstReturnPct: round(worstReturnPct),
    score: round(score),
    passed
  };
}

function windowFailureReasons(name: string, stats: WindowStats): string[] {
  const reasons: string[] = [];
  if (stats.count < 10) reasons.push(`${name}: ${stats.count}/10 samples.`);
  if (stats.averageReturnPct < 2) reasons.push(`${name}: avg ${stats.averageReturnPct}% < 2%.`);
  if (stats.medianReturnPct < 0) reasons.push(`${name}: median ${stats.medianReturnPct}% < 0%.`);
  if (stats.averageReturnExBestPct <= 0) {
    reasons.push(`${name}: avg ex-best ${stats.averageReturnExBestPct}% <= 0%.`);
  }
  if (stats.bestWinnerShare > 0.35) {
    reasons.push(`${name}: best winner share ${stats.bestWinnerShare} > 0.35.`);
  }
  if (stats.hitRate < 0.5) reasons.push(`${name}: hit rate ${round(stats.hitRate * 100)}% < 50%.`);
  if (stats.worstReturnPct < -35) reasons.push(`${name}: worst ${stats.worstReturnPct}% < -35%.`);
  return reasons;
}

function replayFailureReasons(run: BacktestRun): string[] {
  const reasons: string[] = [];
  if (run.metrics.executedTradeCount < 10) {
    reasons.push(`replay: ${run.metrics.executedTradeCount}/10 trades.`);
  }
  if (run.metrics.profitFactor < 1.2) {
    reasons.push(`replay: profit factor ${run.metrics.profitFactor} < 1.2.`);
  }
  if (run.metrics.maxDrawdownPercent > 15) {
    reasons.push(`replay: max drawdown ${run.metrics.maxDrawdownPercent}% > 15%.`);
  }
  if (run.metrics.winRate < 0.5) {
    reasons.push(`replay: win rate ${round(run.metrics.winRate * 100)}% < 50%.`);
  }
  if (run.metrics.medianReturnPercent < 0) {
    reasons.push(`replay: median ${run.metrics.medianReturnPercent}% < 0%.`);
  }
  if (run.metrics.averageReturnPercent < 2) {
    reasons.push(`replay: average ${run.metrics.averageReturnPercent}% < 2%.`);
  }
  if (run.metrics.tailLossPercent < -35) {
    reasons.push(`replay: tail loss ${run.metrics.tailLossPercent}% < -35%.`);
  }
  return reasons;
}

function buildReplaySignal(
  entry: WalletEntrySignalEvidence,
  candidate: CandidateSpec,
  replayStrategyVersion: string
): Signal {
  const signal: Signal = {
    id: `search:${candidate.id}:${entry.idempotencyKey}`,
    strategyVersion: replayStrategyVersion,
    chain: entry.chain,
    tokenAddress: entry.tokenAddress,
    tokenSymbol: shortAddress(entry.tokenAddress),
    signalType: "strategy-search-wallet-entry",
    confidence: entry.repeatWalletCount >= 2 ? 70 : 60,
    riskScore: 50,
    tokenScore: 50,
    detectedAt: entry.observedAt,
    keyReasons: [candidate.label],
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
}

function dedupeRecordsByToken(recordsToDedupe: EntryRecord[]): EntryRecord[] {
  const seen = new Set<string>();
  return [...recordsToDedupe]
    .sort((a, b) => time(a.observedAt) - time(b.observedAt))
    .filter((record) => {
      const key = `${strategyVersion}:${record.tokenAddress}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function thresholdsFrom(
  values: number[],
  quantiles: number[],
  extras: number[],
  limit = 6
): number[] {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  const raw = [
    ...extras,
    ...quantiles.map((quantile) => {
      if (sorted.length === 0) return 0;
      return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * quantile))] ?? 0;
    })
  ];
  const normalized = [
    ...new Set(raw.map((value) => (Number.isFinite(value) ? round(value) : value)))
  ]
    .filter((value) => value >= 0)
    .sort((a, b) => a - b);
  const hasInfinity = normalized.some((value) => value === Number.POSITIVE_INFINITY);
  const finite = normalized
    .filter((value) => Number.isFinite(value))
    .slice(0, hasInfinity ? Math.max(1, limit - 1) : limit);
  return hasInfinity ? [...finite, Number.POSITIVE_INFINITY] : finite;
}

function selectCandidatesForEvaluation(
  candidateSpace: CandidateSpec[],
  maxCandidates: number
): CandidateSpec[] {
  if (candidateSpace.length <= maxCandidates) return candidateSpace;
  const selected = new Map<string, CandidateSpec>();
  for (const candidate of candidateSpace) {
    if (isBaselineCandidate(candidate)) selected.set(candidate.id, candidate);
  }
  for (const candidate of [...candidateSpace].sort((a, b) => a.id.localeCompare(b.id))) {
    if (selected.size >= maxCandidates) break;
    selected.set(candidate.id, candidate);
  }
  return [...selected.values()];
}

function isBaselineCandidate(candidate: CandidateSpec): boolean {
  return (
    candidate.minRepeatWalletCount === 0 &&
    candidate.minLiquidityUsd === 0 &&
    candidate.minVolume5mUsd === 0 &&
    candidate.minBuyShare5m === 0 &&
    candidate.maxBuyShare5m === 1 &&
    candidate.maxSwaps5m === Number.POSITIVE_INFINITY &&
    candidate.maxVolumeLiquidityRatio === Number.POSITIVE_INFINITY &&
    candidate.maxPoolAgeMinutes === Number.POSITIVE_INFINITY
  );
}

function labelCandidate(candidate: Omit<CandidateSpec, "id" | "label">): string {
  return [
    candidate.cohortMode,
    `repeat>=${candidate.minRepeatWalletCount}`,
    `liq>=${candidate.minLiquidityUsd}`,
    `vol5m>=${candidate.minVolume5mUsd}`,
    `buyShare=${candidate.minBuyShare5m}-${candidate.maxBuyShare5m}`,
    `swaps<=${formatBound(candidate.maxSwaps5m)}`,
    `vlr<=${formatBound(candidate.maxVolumeLiquidityRatio)}`,
    `age<=${formatBound(candidate.maxPoolAgeMinutes)}`
  ].join(" / ");
}

function renderMarkdown(report: StrategySearchReport): string {
  return [
    "# Evidence Strategy Search",
    "",
    `Generated: ${report.generatedAt}`,
    `Strategy version: ${report.strategyVersion}`,
    `Decision: ${report.methodDecision}`,
    "",
    "Research and paper mode only. This is not financial advice.",
    "",
    "## Search Summary",
    "",
    `Candidate space: ${report.candidateSpaceSize}`,
    `Candidates evaluated: ${report.candidatesEvaluated}`,
    `Replay candidates evaluated: ${report.replayCandidatesEvaluated}`,
    `Records available: ${report.recordsAvailable}`,
    `Observation days: ${report.observationDays}`,
    `Passed candidates: ${report.passedCandidates.length}`,
    `Best candidate: ${report.bestCandidate?.candidate.label ?? "none"}`,
    "",
    "## Top Candidates",
    "",
    "| Rank | Locked candidate | Selected | Validation avg | H1 avg | H2 avg | H2 median | H2 hit | H2 worst | Replay PF | Pass |",
    "|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ...report.topCandidates
      .slice(0, 20)
      .map((result, index) =>
        [
          index + 1,
          result.candidate.label,
          result.selectedCount,
          `${result.validation.averageReturnPct}%`,
          `${result.holdout1.averageReturnPct}%`,
          `${result.holdout2.averageReturnPct}%`,
          `${result.holdout2.medianReturnPct}%`,
          `${round(result.holdout2.hitRate * 100)}%`,
          `${result.holdout2.worstReturnPct}%`,
          result.replay.profitFactor,
          result.passed ? "yes" : "no"
        ].join(" | ")
      ),
    "",
    "## Best Candidate Failure Reasons",
    "",
    ...(report.bestCandidate?.failureReasons.slice(0, 20).map((reason) => `- ${reason}`) ?? [
      "- No candidate produced any mature sample."
    ]),
    "",
    "## Notes",
    "",
    ...report.notes.map((note) => `- ${note}`)
  ].join("\n");
}

function observationDays(recordsToMeasure: EntryRecord[]): number {
  if (recordsToMeasure.length < 2) return 0;
  const sorted = [...recordsToMeasure].sort((a, b) => time(a.observedAt) - time(b.observedAt));
  return round(
    (time(sorted[sorted.length - 1]!.observedAt) - time(sorted[0]!.observedAt)) / 86_400_000
  );
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function shortAddress(address: string): string {
  return address.length > 8 ? `${address.slice(0, 4)}...${address.slice(-4)}` : address;
}

function formatBound(value: number): string {
  return Number.isFinite(value) ? String(value) : "inf";
}

function time(value: string): number {
  return new Date(value).getTime();
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
