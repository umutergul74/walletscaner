import { summarizeReturns } from "./robust-stats.js";
import { splitChronologicalWalkForward } from "./walk-forward-selection.js";

export const CONTEXTUAL_SURVIVAL_V1 = "contextual-wallet-survival-v1-20260829";

export interface ContextualSupporter {
  walletAddress: string;
  priorTokenCount: number;
}

export interface ContextualSurvivalRecord {
  marketKey: string;
  tokenAddress: string;
  poolAddress: string;
  dex: string;
  observedAt: string;
  frozenAt: string;
  netReturnPct: number;
  estimatedRoundTripCostPct: number;
  rugged: boolean;
  controlledFlow: boolean;
  tokenRiskKnown: boolean;
  tokenRiskPassed: boolean;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  liquidityUsd: number;
  volume5mUsd: number;
  transactions5m: number;
  buyShare5m: number;
  volumeLiquidityRatio: number;
  poolAgeMinutes: number;
  top10HolderPercent: number;
  supporters: ContextualSupporter[];
}

export interface ContextualSurvivalDecision {
  marketKey: string;
  marketContext: string;
  decisionFeatures: {
    dex: string;
    liquidityUsd: number;
    volume5mUsd: number;
    transactions5m: number;
    buyShare5m: number;
    volumeLiquidityRatio: number;
    poolAgeMinutes: number;
    top10HolderPercent: number;
    supporterCount: number;
  };
  observedAt: string;
  modeledReturnPct: number;
  rugged: boolean;
  terminalHazard: boolean;
  historyMature: boolean;
  marketScore: number;
  walletScore: number;
  marketRiskProbability: number;
  marketRiskUpperBound: number;
  passesSurvivalGate: boolean;
  walletEvidenceCount: number;
  experiencedSupporterCount: number;
  selectedByMarketControl: boolean;
  selectedByContextualWallet: boolean;
  decisionReasons: string[];
}

export interface ContextualSurvivalWindowStats {
  count: number;
  activeDays: number;
  averageReturnPct: number;
  medianReturnPct: number;
  averageReturnExBestPct: number;
  hitRate: number;
  profitFactor: number;
  ruggedRate: number;
  catastrophicLossRate: number;
  worstReturnPct: number;
  bestWinnerShare: number;
  passed: boolean;
  failureReasons: string[];
}

export interface ContextualSurvivalPolicyStats {
  all: ContextualSurvivalWindowStats;
  train: ContextualSurvivalWindowStats;
  validation: ContextualSurvivalWindowStats;
  holdout1: ContextualSurvivalWindowStats;
  holdout2: ContextualSurvivalWindowStats;
}

export interface ContextualSurvivalAudit {
  strategyVersion: typeof CONTEXTUAL_SURVIVAL_V1;
  records: number;
  decisions: ContextualSurvivalDecision[];
  broadBaseline: ContextualSurvivalPolicyStats;
  marketOnlyControl: ContextualSurvivalPolicyStats;
  walletShuffleControl: ContextualSurvivalPolicyStats;
  contextualWalletPolicy: ContextualSurvivalPolicyStats;
  verdict: "reject" | "future-shadow-only";
  limitations: string[];
}

interface OutcomeStats {
  count: number;
  terminalHazards: number;
  nonRugCount: number;
  nonRugSum: number;
  nonRugSquaredSum: number;
  totalReturnSum: number;
}

interface CompletedOutcome {
  record: ContextualSurvivalRecord;
  modeledReturnPct: number;
}

interface ScoreResult {
  score: number;
  riskProbability: number;
  riskUpperBound: number;
  walletEvidenceCount: number;
  experiencedSupporterCount: number;
}

const modelRoundTripCostPct = 7.1;
const modelReturnFloorPct = -100;
const modelReturnCeilingPct = 100;
const minimumHistoryMarkets = 100;
const scoreLookback = 500;
const selectionQuantile = 0.9;
const contextPriorStrength = 24;
const walletPriorStrength = 8;
const initialRugPrior = 0.1;
const scoreZ = 1.28;
const maximumHazardUpperBound = 0.12;

export function buildContextualSurvivalAudit(
  sourceRecords: ContextualSurvivalRecord[]
): ContextualSurvivalAudit {
  const records = normalizeRecords(sourceRecords).filter(isDecisionEligible);
  const decisions = buildDecisions(records);
  const shuffledDecisions = buildDecisions(shuffleSupporterBundles(records));
  const broadBaseline = summarizePolicy(decisions, (decision) => decision.historyMature);
  const marketOnlyControl = summarizePolicy(
    decisions,
    (decision) => decision.selectedByMarketControl
  );
  const walletShuffleControl = summarizePolicy(
    shuffledDecisions,
    (decision) => decision.selectedByContextualWallet
  );
  const contextualWalletPolicy = summarizePolicy(
    decisions,
    (decision) => decision.selectedByContextualWallet
  );
  const contextualPassed = allWindowsPassed(contextualWalletPolicy);
  const beatsControls = [marketOnlyControl, walletShuffleControl].every(
    (control) =>
      contextualWalletPolicy.validation.averageReturnExBestPct >
        control.validation.averageReturnExBestPct &&
      contextualWalletPolicy.holdout1.averageReturnExBestPct >
        control.holdout1.averageReturnExBestPct &&
      contextualWalletPolicy.holdout2.averageReturnExBestPct >
        control.holdout2.averageReturnExBestPct
  );

  return {
    strategyVersion: CONTEXTUAL_SURVIVAL_V1,
    records: records.length,
    decisions,
    broadBaseline,
    marketOnlyControl,
    walletShuffleControl,
    contextualWalletPolicy,
    verdict: contextualPassed && beatsControls ? "future-shadow-only" : "reject",
    limitations: [
      "Historical prices are exact-pool market observations, not executable Jupiter fills.",
      "Distinct wallet addresses are not yet proven independent funder/bundle clusters.",
      "Token-2022 behavior-changing extensions and mutable program controls are not complete historical features.",
      "Portfolio concurrency, capital contention and failed transaction probability are not modeled by this market-quality audit.",
      "All currently available history is model-development evidence and cannot be an untouched future holdout.",
      "A passing audit can authorize only an isolated future shadow; Telegram, paper and live execution remain disabled."
    ]
  };
}

function buildDecisions(records: ContextualSurvivalRecord[]): ContextualSurvivalDecision[] {
  const globalStats = emptyStats();
  const contextStats = new Map<string, OutcomeStats>();
  const walletGlobalStats = new Map<string, OutcomeStats>();
  const walletContextStats = new Map<string, OutcomeStats>();
  const pending: CompletedOutcome[] = [];
  const marketScores: number[] = [];
  const walletScores: number[] = [];
  const decisions: ContextualSurvivalDecision[] = [];

  for (const record of records) {
    admitCompletedOutcomes(record.observedAt, pending, {
      globalStats,
      contextStats,
      walletGlobalStats,
      walletContextStats
    });

    const market = scoreRecord(record, {
      globalStats,
      contextStats,
      walletGlobalStats,
      walletContextStats,
      includeWalletEvidence: false
    });
    const contextual = scoreRecord(record, {
      globalStats,
      contextStats,
      walletGlobalStats,
      walletContextStats,
      includeWalletEvidence: true
    });
    const marketThreshold = onlineQuantile(marketScores, selectionQuantile);
    const walletThreshold = onlineQuantile(walletScores, selectionQuantile);
    const historyMature = globalStats.count >= minimumHistoryMarkets;
    const passesSurvivalGate = market.riskUpperBound <= maximumHazardUpperBound;
    const selectedByMarketControl =
      historyMature && passesSurvivalGate && market.score > 0 && market.score >= marketThreshold;
    const selectedByContextualWallet =
      historyMature &&
      passesSurvivalGate &&
      contextual.walletEvidenceCount > 0 &&
      contextual.score > 0 &&
      contextual.score >= walletThreshold;
    const modeledReturnPct = modeledReturn(record);

    decisions.push({
      marketKey: record.marketKey,
      marketContext: contextKey(record),
      decisionFeatures: {
        dex: record.dex,
        liquidityUsd: record.liquidityUsd,
        volume5mUsd: record.volume5mUsd,
        transactions5m: record.transactions5m,
        buyShare5m: record.buyShare5m,
        volumeLiquidityRatio: record.volumeLiquidityRatio,
        poolAgeMinutes: record.poolAgeMinutes,
        top10HolderPercent: record.top10HolderPercent,
        supporterCount: record.supporters.length
      },
      observedAt: record.observedAt,
      modeledReturnPct,
      rugged: record.rugged,
      terminalHazard: isTerminalHazard(record, modeledReturnPct),
      historyMature,
      marketScore: market.score,
      walletScore: contextual.score,
      marketRiskProbability: contextual.riskProbability,
      marketRiskUpperBound: contextual.riskUpperBound,
      passesSurvivalGate,
      walletEvidenceCount: contextual.walletEvidenceCount,
      experiencedSupporterCount: contextual.experiencedSupporterCount,
      selectedByMarketControl,
      selectedByContextualWallet,
      decisionReasons: decisionReasons({
        historyMature,
        marketThreshold,
        walletThreshold,
        market,
        contextual,
        passesSurvivalGate,
        selectedByMarketControl,
        selectedByContextualWallet
      })
    });

    marketScores.push(market.score);
    walletScores.push(contextual.score);
    if (marketScores.length > scoreLookback) marketScores.shift();
    if (walletScores.length > scoreLookback) walletScores.shift();
    insertPending(pending, { record, modeledReturnPct });
  }
  return decisions;
}

export function modeledReturn(record: ContextualSurvivalRecord): number {
  if (record.rugged) return -100;
  const frictionAdjustment = Math.max(0, modelRoundTripCostPct - record.estimatedRoundTripCostPct);
  return record.netReturnPct - frictionAdjustment;
}

function scoreRecord(
  record: ContextualSurvivalRecord,
  state: {
    globalStats: OutcomeStats;
    contextStats: Map<string, OutcomeStats>;
    walletGlobalStats: Map<string, OutcomeStats>;
    walletContextStats: Map<string, OutcomeStats>;
    includeWalletEvidence: boolean;
  }
): ScoreResult {
  const context = contextKey(record);
  const exact = state.contextStats.get(context) ?? emptyStats();
  const globalRisk = posteriorRisk(state.globalStats, initialRugPrior, 10);
  const riskProbability = posteriorRisk(exact, globalRisk, contextPriorStrength);
  const effectiveRiskCount = exact.count + contextPriorStrength;
  const riskUpperBound = wilsonUpperBound(riskProbability, effectiveRiskCount);
  const globalConditionalMean = posteriorConditionalMean(state.globalStats, 0, 10);
  const conditionalMean = posteriorConditionalMean(
    exact,
    globalConditionalMean,
    contextPriorStrength
  );
  const conditionalVariance = posteriorConditionalVariance(exact, contextPriorStrength);
  const baseExpectedReturn =
    (1 - riskProbability) * conditionalMean + riskProbability * modelReturnFloorPct;
  const riskUncertainty = Math.max(0, riskUpperBound - riskProbability) * 100;
  const returnUncertainty =
    scoreZ * Math.sqrt(conditionalVariance / Math.max(1, exact.nonRugCount + contextPriorStrength));

  const supporterScores: Array<{ adjustment: number; evidence: number }> = [];
  let experiencedSupporterCount = 0;
  if (state.includeWalletEvidence) {
    for (const supporter of record.supporters) {
      if (supporter.priorTokenCount >= 6) experiencedSupporterCount += 1;
      const globalWallet = state.walletGlobalStats.get(supporter.walletAddress) ?? emptyStats();
      const contextualWallet =
        state.walletContextStats.get(walletContextKey(supporter.walletAddress, context)) ??
        emptyStats();
      // Context history is a subset of the wallet's global history. Counting both would inflate
      // reliability for the same completed market twice.
      const evidence = globalWallet.count;
      if (evidence === 0) continue;
      const walletBase = posteriorTotalMean(globalWallet, baseExpectedReturn, walletPriorStrength);
      const walletContext = posteriorTotalMean(contextualWallet, walletBase, walletPriorStrength);
      const reliability = evidence / (evidence + walletPriorStrength);
      supporterScores.push({
        adjustment: (walletContext - baseExpectedReturn) * reliability,
        evidence
      });
    }
  }
  supporterScores.sort((a, b) => b.adjustment - a.adjustment || b.evidence - a.evidence);
  const independentSupport = supporterScores.slice(0, 2);
  const walletAdjustment =
    independentSupport.length === 0
      ? 0
      : independentSupport.reduce((sum, item) => sum + item.adjustment, 0) /
        independentSupport.length;

  return {
    score: baseExpectedReturn + walletAdjustment - riskUncertainty - returnUncertainty,
    riskProbability,
    riskUpperBound,
    walletEvidenceCount: supporterScores.length,
    experiencedSupporterCount
  };
}

function admitCompletedOutcomes(
  decisionAt: string,
  pending: CompletedOutcome[],
  state: {
    globalStats: OutcomeStats;
    contextStats: Map<string, OutcomeStats>;
    walletGlobalStats: Map<string, OutcomeStats>;
    walletContextStats: Map<string, OutcomeStats>;
  }
): void {
  const boundary = Date.parse(decisionAt);
  while (pending.length > 0 && Date.parse(pending[0]!.record.frozenAt) < boundary) {
    const completed = pending.shift()!;
    addOutcome(state.globalStats, completed);
    const context = contextKey(completed.record);
    addOutcome(mapStats(state.contextStats, context), completed);
    for (const supporter of completed.record.supporters) {
      addOutcome(mapStats(state.walletGlobalStats, supporter.walletAddress), completed);
      addOutcome(
        mapStats(state.walletContextStats, walletContextKey(supporter.walletAddress, context)),
        completed
      );
    }
  }
}

function addOutcome(stats: OutcomeStats, completed: CompletedOutcome): void {
  const value = winsorize(completed.modeledReturnPct);
  stats.count += 1;
  stats.totalReturnSum += value;
  if (isTerminalHazard(completed.record, completed.modeledReturnPct)) {
    stats.terminalHazards += 1;
    return;
  }
  stats.nonRugCount += 1;
  stats.nonRugSum += value;
  stats.nonRugSquaredSum += value * value;
}

function summarizePolicy(
  decisions: ContextualSurvivalDecision[],
  selected: (decision: ContextualSurvivalDecision) => boolean
): ContextualSurvivalPolicyStats {
  const matching = decisions.filter(selected);
  const windows = splitChronologicalWalkForward(decisions, 40);
  return {
    all: summarizeWindow(matching, 30, 7),
    train: summarizeWindow(windows.train.filter(selected), 12, 2),
    validation: summarizeWindow(windows.validation.filter(selected), 8, 1),
    holdout1: summarizeWindow(windows.holdout1.filter(selected), 8, 1),
    holdout2: summarizeWindow(windows.holdout2.filter(selected), 8, 1)
  };
}

export function summarizeWindow(
  decisions: ContextualSurvivalDecision[],
  minimumCount: number,
  minimumActiveDays: number
): ContextualSurvivalWindowStats {
  const returns = decisions.map((decision) => decision.modeledReturnPct);
  const robust = summarizeReturns(returns);
  const wins = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const hitRate = wins.length / Math.max(returns.length, 1);
  const ruggedRate =
    decisions.filter((decision) => decision.rugged).length / Math.max(decisions.length, 1);
  const catastrophicLossRate =
    returns.filter((value) => value <= -50).length / Math.max(returns.length, 1);
  const worstReturnPct = returns.length === 0 ? 0 : Math.min(...returns);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;
  const activeDays = new Set(decisions.map((decision) => decision.observedAt.slice(0, 10))).size;
  const failureReasons = [
    ...(decisions.length < minimumCount ? [`count<${minimumCount}`] : []),
    ...(activeDays < minimumActiveDays ? [`active-days<${minimumActiveDays}`] : []),
    ...(robust.median <= 0 ? ["median<=0"] : []),
    ...(robust.averageWithoutBest <= 2 ? ["average-ex-best<=2"] : []),
    ...(hitRate < 0.6 ? ["hit-rate<60%"] : []),
    ...(profitFactor < 1.3 ? ["profit-factor<1.3"] : []),
    ...(ruggedRate > 0.03 ? ["rug-rate>3%"] : []),
    ...(catastrophicLossRate > 0.03 ? ["catastrophic-rate>3%"] : []),
    ...(robust.bestWinnerShare > 0.3 ? ["best-winner-share>30%"] : [])
  ];
  return {
    count: decisions.length,
    activeDays,
    averageReturnPct: robust.average,
    medianReturnPct: robust.median,
    averageReturnExBestPct: robust.averageWithoutBest,
    hitRate,
    profitFactor,
    ruggedRate,
    catastrophicLossRate,
    worstReturnPct,
    bestWinnerShare: robust.bestWinnerShare,
    passed: failureReasons.length === 0,
    failureReasons
  };
}

function allWindowsPassed(stats: ContextualSurvivalPolicyStats): boolean {
  return (
    stats.all.passed &&
    stats.train.passed &&
    stats.validation.passed &&
    stats.holdout1.passed &&
    stats.holdout2.passed
  );
}

function normalizeRecords(source: ContextualSurvivalRecord[]): ContextualSurvivalRecord[] {
  const byMarket = new Map<string, ContextualSurvivalRecord>();
  for (const record of [...source].sort(compareRecords)) {
    if (!Number.isFinite(Date.parse(record.observedAt))) continue;
    if (!Number.isFinite(Date.parse(record.frozenAt))) continue;
    if (Date.parse(record.frozenAt) < Date.parse(record.observedAt)) continue;
    if (!byMarket.has(record.marketKey)) {
      byMarket.set(record.marketKey, {
        ...record,
        supporters: dedupeSupporters(record.supporters)
      });
    }
  }
  return [...byMarket.values()].sort(compareRecords);
}

function isDecisionEligible(record: ContextualSurvivalRecord): boolean {
  return (
    record.controlledFlow &&
    record.tokenRiskKnown &&
    record.tokenRiskPassed &&
    record.mintAuthorityRevoked &&
    record.freezeAuthorityRevoked &&
    record.poolAgeMinutes >= 5 &&
    record.liquidityUsd > 0 &&
    record.transactions5m > 0 &&
    record.buyShare5m >= 0 &&
    record.buyShare5m <= 1 &&
    record.supporters.length > 0
  );
}

function contextKey(record: ContextualSurvivalRecord): string {
  return [
    record.dex,
    bucket(record.liquidityUsd, [15_000, 30_000, 60_000]),
    bucket(record.poolAgeMinutes, [7, 12, 20]),
    bucket(record.top10HolderPercent, [15, 25, 40]),
    bucket(record.volumeLiquidityRatio, [0.35, 0.75, 1.5]),
    bucket(record.buyShare5m, [0.48, 0.58, 0.68])
  ].join("|");
}

function bucket(value: number, cutoffs: number[]): string {
  if (!Number.isFinite(value)) return "unknown";
  const index = cutoffs.findIndex((cutoff) => value < cutoff);
  return index === -1 ? `${cutoffs.length}+` : String(index);
}

function posteriorRisk(stats: OutcomeStats, prior: number, strength: number): number {
  return (stats.terminalHazards + prior * strength) / Math.max(1, stats.count + strength);
}

function posteriorConditionalMean(stats: OutcomeStats, prior: number, strength: number): number {
  return (stats.nonRugSum + prior * strength) / Math.max(1, stats.nonRugCount + strength);
}

function posteriorConditionalVariance(stats: OutcomeStats, strength: number): number {
  if (stats.nonRugCount < 2) return 900;
  const mean = stats.nonRugSum / stats.nonRugCount;
  const sampleVariance = Math.max(
    0,
    (stats.nonRugSquaredSum - stats.nonRugCount * mean * mean) / Math.max(1, stats.nonRugCount - 1)
  );
  return (sampleVariance * stats.nonRugCount + 900 * strength) / (stats.nonRugCount + strength);
}

function posteriorTotalMean(stats: OutcomeStats, prior: number, strength: number): number {
  return (stats.totalReturnSum + prior * strength) / Math.max(1, stats.count + strength);
}

function wilsonUpperBound(probability: number, sampleSize: number): number {
  const n = Math.max(1, sampleSize);
  const z = 1.645;
  const denominator = 1 + (z * z) / n;
  const center = probability + (z * z) / (2 * n);
  const margin = z * Math.sqrt((probability * (1 - probability) + (z * z) / (4 * n)) / n);
  return Math.min(1, (center + margin) / denominator);
}

function onlineQuantile(values: number[], quantile: number): number {
  if (values.length < minimumHistoryMarkets) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((sorted.length - 1) * quantile));
  return sorted[index]!;
}

function emptyStats(): OutcomeStats {
  return {
    count: 0,
    terminalHazards: 0,
    nonRugCount: 0,
    nonRugSum: 0,
    nonRugSquaredSum: 0,
    totalReturnSum: 0
  };
}

function mapStats(map: Map<string, OutcomeStats>, key: string): OutcomeStats {
  const existing = map.get(key);
  if (existing) return existing;
  const created = emptyStats();
  map.set(key, created);
  return created;
}

function insertPending(pending: CompletedOutcome[], item: CompletedOutcome): void {
  const itemTime = Date.parse(item.record.frozenAt);
  const index = pending.findIndex((existing) => Date.parse(existing.record.frozenAt) > itemTime);
  if (index === -1) pending.push(item);
  else pending.splice(index, 0, item);
}

function winsorize(value: number): number {
  return Math.max(modelReturnFloorPct, Math.min(modelReturnCeilingPct, value));
}

function dedupeSupporters(supporters: ContextualSupporter[]): ContextualSupporter[] {
  const unique = new Map<string, ContextualSupporter>();
  for (const supporter of supporters) {
    const address = supporter.walletAddress.trim();
    if (!address) continue;
    const existing = unique.get(address);
    if (!existing || supporter.priorTokenCount > existing.priorTokenCount) {
      unique.set(address, {
        walletAddress: address,
        priorTokenCount: Math.max(0, Math.trunc(supporter.priorTokenCount))
      });
    }
  }
  return [...unique.values()].sort((a, b) => a.walletAddress.localeCompare(b.walletAddress));
}

function walletContextKey(walletAddress: string, context: string): string {
  return `${walletAddress}|${context}`;
}

function compareRecords(a: ContextualSurvivalRecord, b: ContextualSurvivalRecord): number {
  return (
    Date.parse(a.observedAt) - Date.parse(b.observedAt) || a.marketKey.localeCompare(b.marketKey)
  );
}

function decisionReasons(input: {
  historyMature: boolean;
  marketThreshold: number;
  walletThreshold: number;
  market: ScoreResult;
  contextual: ScoreResult;
  passesSurvivalGate: boolean;
  selectedByMarketControl: boolean;
  selectedByContextualWallet: boolean;
}): string[] {
  if (!input.historyMature) return ["causal-history-burn-in"];
  const reasons = [
    `risk=${input.contextual.riskProbability.toFixed(4)}`,
    `risk-upper=${input.contextual.riskUpperBound.toFixed(4)}`,
    `survival-gate=${input.passesSurvivalGate ? "pass" : "fail"}`,
    `wallet-evidence=${input.contextual.walletEvidenceCount}`,
    `experienced-supporters=${input.contextual.experiencedSupporterCount}`,
    `market-threshold=${finite(input.marketThreshold)}`,
    `wallet-threshold=${finite(input.walletThreshold)}`
  ];
  if (input.selectedByMarketControl) reasons.push("market-control-selected");
  if (input.selectedByContextualWallet) reasons.push("contextual-wallet-selected");
  if (!input.selectedByContextualWallet && input.contextual.walletEvidenceCount === 0) {
    reasons.push("no-causal-wallet-history");
  }
  return reasons;
}

function isTerminalHazard(record: ContextualSurvivalRecord, modeledReturnPct: number): boolean {
  return record.rugged || modeledReturnPct <= -80;
}

function shuffleSupporterBundles(records: ContextualSurvivalRecord[]): ContextualSurvivalRecord[] {
  if (records.length < 2) return records.map((record) => ({ ...record }));
  const supporterBundles = records.map((record) => record.supporters);
  const shift = Math.max(1, Math.floor(records.length * 0.382));
  return records.map((record, index) => ({
    ...record,
    supporters: supporterBundles[(index + shift) % supporterBundles.length]!
  }));
}

function finite(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : "unavailable";
}
