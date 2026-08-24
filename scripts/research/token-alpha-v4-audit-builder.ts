import { createHash } from "node:crypto";
import { summarizeReturns } from "./robust-stats.js";
import {
  lockBestCandidate,
  splitChronologicalWalkForward,
  type WalkForwardWindows
} from "./walk-forward-selection.js";

export interface TokenAlphaV4MarketRecord {
  tokenAddress: string;
  poolAddress: string;
  dex: string;
  creatorAddress?: string;
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
  supporterCount: number;
  scoredSupporterCount: number;
  causalSafeWallets3: number;
  causalSafeWallets6: number;
  creatorPriorMarkets?: number;
  creatorPriorRugs?: number;
  creatorPriorCatastrophicLosses?: number;
  creatorPriorRugRate?: number;
  creatorPriorCatastrophicLossRate?: number;
  modeledNetReturnPct?: number;
}

export interface TokenAlphaV4Candidate {
  id: string;
  walletEvidence: "safe3" | "safe6";
  minimumSafeWallets: number;
  minimumLiquidityUsd: number;
  minimumBuyShare5m: number;
  maximumBuyShare5mExclusive: number;
  maximumVolumeLiquidityRatioExclusive: number;
  minimumPoolAgeMinutes: number;
  maximumPoolAgeMinutes: number;
  maximumTop10HolderPercentExclusive: number;
  minimumCreatorPriorMarkets: number;
  maximumCreatorPriorRugRate: number;
}

export interface TokenAlphaV4WindowStats {
  count: number;
  averageReturnPct: number;
  medianReturnPct: number;
  averageReturnExBestPct: number;
  bestWinnerShare: number;
  hitRate: number;
  profitFactor: number;
  ruggedRate: number;
  catastrophicLossRate: number;
  worstReturnPct: number;
  score: number;
  passed: boolean;
  failureReasons: string[];
}

export interface TokenAlphaV4CandidateResult {
  candidate: TokenAlphaV4Candidate;
  selectedCount: number;
  train: TokenAlphaV4WindowStats;
  validation: TokenAlphaV4WindowStats;
  holdout1?: TokenAlphaV4WindowStats;
  holdout2?: TokenAlphaV4WindowStats;
  passed?: boolean;
}

export interface TokenAlphaV4AuditResult {
  records: TokenAlphaV4MarketRecord[];
  windows: WalkForwardWindows<TokenAlphaV4MarketRecord>;
  baseline: {
    train: TokenAlphaV4WindowStats;
    validation: TokenAlphaV4WindowStats;
    holdout1: TokenAlphaV4WindowStats;
    holdout2: TokenAlphaV4WindowStats;
  };
  candidatesEvaluated: number;
  lockedCandidate: TokenAlphaV4CandidateResult | null;
  verdict: "no-promotable-v4" | "future-shadow-only";
}

const modeledRoundTripCostPct = 7.1;

export function buildTokenAlphaV4Audit(
  sourceRecords: TokenAlphaV4MarketRecord[]
): TokenAlphaV4AuditResult {
  const records = attachCausalCreatorHistory(sourceRecords).map((record) => ({
    ...record,
    modeledNetReturnPct: modeledReturn(record)
  }));
  const windows = splitChronologicalWalkForward(records, 40);
  const baselineMatches = (record: TokenAlphaV4MarketRecord) => matchesStrictV2(record);
  const baseline = {
    train: summarizeWindow(windows.train.filter(baselineMatches), 12),
    validation: summarizeWindow(windows.validation.filter(baselineMatches), 6),
    holdout1: summarizeWindow(windows.holdout1.filter(baselineMatches), 6),
    holdout2: summarizeWindow(windows.holdout2.filter(baselineMatches), 6)
  };

  const candidates = generateCandidates();
  const selection = candidates.map((candidate) => {
    const train = summarizeWindow(
      windows.train.filter((record) => matchesCandidate(candidate, record)),
      12
    );
    const validation = summarizeWindow(
      windows.validation.filter((record) => matchesCandidate(candidate, record)),
      6
    );
    return {
      candidate,
      selectedCount: train.count + validation.count,
      train,
      validation
    };
  });
  const eligibleSelection = selection.filter(
    (result) => result.train.passed && result.validation.passed
  );
  const locked = lockBestCandidate(eligibleSelection);
  const lockedCandidate = locked ? evaluateLockedCandidate(locked, windows) : null;
  return {
    records,
    windows,
    baseline,
    candidatesEvaluated: candidates.length,
    lockedCandidate,
    verdict: lockedCandidate?.passed ? "future-shadow-only" : "no-promotable-v4"
  };
}

export function matchesStrictV2(record: TokenAlphaV4MarketRecord): boolean {
  return (
    record.controlledFlow &&
    record.tokenRiskKnown &&
    record.tokenRiskPassed &&
    record.mintAuthorityRevoked &&
    record.freezeAuthorityRevoked &&
    record.liquidityUsd >= 10_000 &&
    record.volume5mUsd >= 5_000 &&
    record.poolAgeMinutes >= 5 &&
    record.transactions5m >= 20 &&
    record.buyShare5m >= 0.5 &&
    record.buyShare5m < 0.6 &&
    record.volumeLiquidityRatio < 0.5 &&
    record.top10HolderPercent < 20
  );
}

export function matchesCandidate(
  candidate: TokenAlphaV4Candidate,
  record: TokenAlphaV4MarketRecord
): boolean {
  if (!matchesStrictV2(record)) return false;
  const safeWallets =
    candidate.walletEvidence === "safe6" ? record.causalSafeWallets6 : record.causalSafeWallets3;
  if (safeWallets < candidate.minimumSafeWallets) return false;
  if (record.liquidityUsd < candidate.minimumLiquidityUsd) return false;
  if (record.buyShare5m < candidate.minimumBuyShare5m) return false;
  if (record.buyShare5m >= candidate.maximumBuyShare5mExclusive) return false;
  if (record.volumeLiquidityRatio >= candidate.maximumVolumeLiquidityRatioExclusive) return false;
  if (record.poolAgeMinutes < candidate.minimumPoolAgeMinutes) return false;
  if (record.poolAgeMinutes > candidate.maximumPoolAgeMinutes) return false;
  if (record.top10HolderPercent >= candidate.maximumTop10HolderPercentExclusive) return false;
  if (candidate.minimumCreatorPriorMarkets > 0) {
    if ((record.creatorPriorMarkets ?? 0) < candidate.minimumCreatorPriorMarkets) return false;
    if ((record.creatorPriorRugRate ?? 1) > candidate.maximumCreatorPriorRugRate) return false;
  }
  return true;
}

export function summarizeWindow(
  records: TokenAlphaV4MarketRecord[],
  minimumCount: number
): TokenAlphaV4WindowStats {
  const values = records.map((record) => record.modeledNetReturnPct ?? modeledReturn(record));
  const robust = summarizeReturns(values);
  const wins = values.filter((value) => value > 0);
  const losses = values.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const hitRate = wins.length / Math.max(values.length, 1);
  const ruggedRate = records.filter((record) => record.rugged).length / Math.max(records.length, 1);
  const catastrophicLossRate =
    values.filter((value) => value <= -50).length / Math.max(values.length, 1);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;
  const worstReturnPct = values.length > 0 ? Math.min(...values) : 0;
  const failureReasons = [
    ...(records.length < minimumCount ? [`count<${minimumCount}`] : []),
    ...(robust.median <= 0 ? ["median<=0"] : []),
    ...(robust.averageWithoutBest <= 0 ? ["average-ex-best<=0"] : []),
    ...(hitRate < 0.6 ? ["hit-rate<60%"] : []),
    ...(profitFactor < 1.2 ? ["profit-factor<1.2"] : []),
    ...(ruggedRate > 0.05 ? ["rug-rate>5%"] : []),
    ...(catastrophicLossRate > 0.05 ? ["catastrophic-rate>5%"] : []),
    ...(worstReturnPct < -35 ? ["worst<-35%"] : []),
    ...(robust.bestWinnerShare > 0.4 ? ["best-winner-share>40%"] : [])
  ];
  return {
    count: records.length,
    averageReturnPct: robust.average,
    medianReturnPct: robust.median,
    averageReturnExBestPct: robust.averageWithoutBest,
    bestWinnerShare: robust.bestWinnerShare,
    hitRate,
    profitFactor,
    ruggedRate,
    catastrophicLossRate,
    worstReturnPct,
    score:
      robust.median +
      robust.averageWithoutBest +
      hitRate * 20 +
      Math.log10(records.length + 1) * 2 -
      ruggedRate * 300 -
      catastrophicLossRate * 200 -
      Math.max(0, robust.bestWinnerShare - 0.4) * 100,
    passed: failureReasons.length === 0,
    failureReasons
  };
}

function evaluateLockedCandidate(
  selection: TokenAlphaV4CandidateResult,
  windows: WalkForwardWindows<TokenAlphaV4MarketRecord>
): TokenAlphaV4CandidateResult {
  const holdout1Records = windows.holdout1.filter((record) =>
    matchesCandidate(selection.candidate, record)
  );
  const holdout2Records = windows.holdout2.filter((record) =>
    matchesCandidate(selection.candidate, record)
  );
  const holdout1 = summarizeWindow(holdout1Records, 6);
  const holdout2 = summarizeWindow(holdout2Records, 6);
  return {
    ...selection,
    selectedCount: selection.selectedCount + holdout1.count + holdout2.count,
    holdout1,
    holdout2,
    passed:
      selection.train.passed &&
      selection.validation.passed &&
      holdout1.passed &&
      holdout2.passed &&
      selection.selectedCount + holdout1.count + holdout2.count >= 30
  };
}

function generateCandidates(): TokenAlphaV4Candidate[] {
  const candidates: TokenAlphaV4Candidate[] = [];
  const creatorPolicies = [
    { minimumCreatorPriorMarkets: 0, maximumCreatorPriorRugRate: 1 },
    { minimumCreatorPriorMarkets: 1, maximumCreatorPriorRugRate: 0 },
    { minimumCreatorPriorMarkets: 2, maximumCreatorPriorRugRate: 0 }
  ];
  for (const walletEvidence of ["safe3", "safe6"] as const) {
    for (const minimumSafeWallets of [1, 2]) {
      for (const minimumLiquidityUsd of [10_000, 20_000, 30_000, 40_000]) {
        for (const [minimumBuyShare5m, maximumBuyShare5mExclusive] of [
          [0.5, 0.56],
          [0.5, 0.58],
          [0.5, 0.6],
          [0.52, 0.58],
          [0.52, 0.6]
        ] as const) {
          for (const maximumVolumeLiquidityRatioExclusive of [0.35, 0.4, 0.45, 0.5]) {
            for (const [minimumPoolAgeMinutes, maximumPoolAgeMinutes] of [
              [0, 10],
              [2, 20],
              [5, 40]
            ] as const) {
              for (const maximumTop10HolderPercentExclusive of [15, 20]) {
                for (const creatorPolicy of creatorPolicies) {
                  const payload = {
                    walletEvidence,
                    minimumSafeWallets,
                    minimumLiquidityUsd,
                    minimumBuyShare5m,
                    maximumBuyShare5mExclusive,
                    maximumVolumeLiquidityRatioExclusive,
                    minimumPoolAgeMinutes,
                    maximumPoolAgeMinutes,
                    maximumTop10HolderPercentExclusive,
                    ...creatorPolicy
                  };
                  candidates.push({
                    id: createHash("sha256")
                      .update(JSON.stringify(payload))
                      .digest("hex")
                      .slice(0, 16),
                    ...payload
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

export function attachCausalCreatorHistory(
  sourceRecords: TokenAlphaV4MarketRecord[]
): TokenAlphaV4MarketRecord[] {
  const records = [...sourceRecords].sort((a, b) => time(a.observedAt) - time(b.observedAt));
  const completions = [...sourceRecords]
    .filter((record) => record.creatorAddress)
    .sort((a, b) => time(a.frozenAt) - time(b.frozenAt));
  const creatorHistory = new Map<
    string,
    { markets: number; rugs: number; catastrophicLosses: number }
  >();
  let completionIndex = 0;
  return records.map((record) => {
    const observedAt = time(record.observedAt);
    while (
      completionIndex < completions.length &&
      time(completions[completionIndex]!.frozenAt) < observedAt
    ) {
      const completed = completions[completionIndex]!;
      const creator = completed.creatorAddress!;
      const history = creatorHistory.get(creator) ?? {
        markets: 0,
        rugs: 0,
        catastrophicLosses: 0
      };
      history.markets += 1;
      if (completed.rugged) history.rugs += 1;
      if (modeledReturn(completed) <= -50) history.catastrophicLosses += 1;
      creatorHistory.set(creator, history);
      completionIndex += 1;
    }
    const history = record.creatorAddress ? creatorHistory.get(record.creatorAddress) : undefined;
    return {
      ...record,
      creatorPriorMarkets: history?.markets ?? 0,
      creatorPriorRugs: history?.rugs ?? 0,
      creatorPriorCatastrophicLosses: history?.catastrophicLosses ?? 0,
      ...(history
        ? {
            creatorPriorRugRate: history.rugs / Math.max(history.markets, 1),
            creatorPriorCatastrophicLossRate:
              history.catastrophicLosses / Math.max(history.markets, 1)
          }
        : {})
    };
  });
}

export function modeledReturn(record: TokenAlphaV4MarketRecord): number {
  if (record.rugged) return -100;
  return (
    record.netReturnPct - Math.max(0, modeledRoundTripCostPct - record.estimatedRoundTripCostPct)
  );
}

function time(value: string): number {
  return new Date(value).getTime();
}
