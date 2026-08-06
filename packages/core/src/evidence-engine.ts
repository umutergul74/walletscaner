import { createHash } from "node:crypto";
import type {
  PriceObservationEvidence,
  WalletEntrySignalEvidence,
  WalletSignalOutcomeEvidence
} from "@memecoin-alpha/shared";

export interface EvidenceWriter {
  saveWalletEntrySignal(signal: WalletEntrySignalEvidence): Promise<boolean>;
  saveWalletSignalOutcome(outcome: WalletSignalOutcomeEvidence): Promise<boolean>;
}

export interface WalletEntryInput {
  chain: WalletEntrySignalEvidence["chain"];
  walletAddress: string;
  tokenAddress: string;
  poolAddress?: string;
  sourceSwapIdempotencyKey?: string;
  observedEntryPriceUsd: number;
  observedLiquidityUsd: number;
  cohort: string;
  repeatWalletCount: number;
  flowEvidence: Record<string, unknown>;
  signature: string;
  slot: number;
  provider: string;
  observedAt: string;
  strategyVersion: string;
}

export interface OutcomeConfig {
  horizonMinutes?: number;
  maxDelayMinutes?: number;
  estimatedRoundTripCostPct?: number;
  exitStrategy?: WalletSignalOutcomeEvidence["exitStrategy"];
}

export interface WalletEvidenceScore {
  walletAddress: string;
  matureOutcomeCount: number;
  provisionalOutcomeCount: number;
  unresolvedOutcomeCount: number;
  averageNetReturnPct: number;
  medianNetReturnPct: number;
  averageNetReturnExBestPct: number;
  bestWinnerShare: number;
  hitRate: number;
  worstNetReturnPct: number;
  score: number;
  confidence: "insufficient" | "watch" | "candidate";
}

export interface ExperimentCohorts {
  primary: WalletEntrySignalEvidence[];
  control: WalletEntrySignalEvidence[];
}

export function canonicalizeHistoricalPriceObservations(
  observations: PriceObservationEvidence[]
): PriceObservationEvidence[] {
  const passthrough: PriceObservationEvidence[] = [];
  const grouped = new Map<string, PriceObservationEvidence[]>();
  for (const observation of observations) {
    if (observation.provider !== "helius-history") {
      passthrough.push(observation);
      continue;
    }
    const key = [
      observation.provider,
      observation.strategyVersion,
      observation.signature,
      observation.tokenAddress,
      observation.observedAt,
      String(observation.raw.priceSource ?? "unknown"),
      String(observation.raw.side ?? "unknown")
    ].join(":");
    const existing = grouped.get(key) ?? [];
    existing.push(observation);
    grouped.set(key, existing);
  }

  const canonical = [...grouped.values()].map((group) => {
    if (group.length === 1) return group[0]!;
    const first = group[0]!;
    const tokenAmount = group.reduce(
      (sum, observation) => sum + positiveNumber(observation.raw.tokenAmount),
      0
    );
    const solAmount = Math.max(
      ...group.map((observation) => positiveNumber(observation.raw.solAmount))
    );
    const solUsdEstimate = positiveNumber(first.raw.solUsdEstimate);
    if (tokenAmount <= 0 || solAmount <= 0 || solUsdEstimate <= 0) return first;
    const priceSol = solAmount / tokenAmount;
    return {
      ...first,
      priceUsd: priceSol * solUsdEstimate,
      raw: {
        ...first.raw,
        tokenAmount,
        solAmount,
        priceSol,
        consolidatedLegCount: group.length,
        consolidatedObservationKeys: group.map((observation) => observation.idempotencyKey)
      }
    };
  });
  return [...passthrough, ...canonical].sort(
    (a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime() || a.slot - b.slot
  );
}

export async function recordFirstWalletEntry(
  repository: EvidenceWriter,
  input: WalletEntryInput
): Promise<{ inserted: boolean; signal: WalletEntrySignalEvidence }> {
  const signal: WalletEntrySignalEvidence = {
    ...input,
    idempotencyKey: walletEntryKey(input)
  };
  return {
    inserted: await repository.saveWalletEntrySignal(signal),
    signal
  };
}

export type FixedHorizonEvidenceReason =
  | "valid-window"
  | "terminal-rug-before-horizon"
  | "unlinked-entry"
  | "not-mature"
  | "wrong-exit-strategy"
  | "wrong-horizon"
  | "missing-return"
  | "missing-freeze-time"
  | "outside-window";

export interface FixedHorizonEvidenceAssessment {
  canonical: boolean;
  ageMinutes: number | null;
  reason: FixedHorizonEvidenceReason;
}

export function isSourceLinkedWalletEntry(entry: WalletEntrySignalEvidence): boolean {
  return Boolean(entry.sourceSwapIdempotencyKey?.trim());
}

export function assessFixedHorizonEvidence(
  entry: WalletEntrySignalEvidence,
  outcome: WalletSignalOutcomeEvidence,
  horizonMinutes = 20,
  maxDelayMinutes = 20
): FixedHorizonEvidenceAssessment {
  if (!isSourceLinkedWalletEntry(entry)) {
    return { canonical: false, ageMinutes: null, reason: "unlinked-entry" };
  }
  if (outcome.status !== "mature") {
    return { canonical: false, ageMinutes: null, reason: "not-mature" };
  }
  if (outcome.exitStrategy !== "fixed-horizon") {
    return { canonical: false, ageMinutes: null, reason: "wrong-exit-strategy" };
  }
  if (outcome.horizonMinutes !== horizonMinutes) {
    return { canonical: false, ageMinutes: null, reason: "wrong-horizon" };
  }
  if (outcome.netReturnPct === undefined || !Number.isFinite(outcome.netReturnPct)) {
    return { canonical: false, ageMinutes: null, reason: "missing-return" };
  }
  if (!outcome.frozenAt) {
    return { canonical: false, ageMinutes: null, reason: "missing-freeze-time" };
  }

  const entryTime = new Date(entry.observedAt).getTime();
  const frozenTime = new Date(outcome.frozenAt).getTime();
  const ageMinutes = (frozenTime - entryTime) / 60_000;
  if (!Number.isFinite(ageMinutes)) {
    return { canonical: false, ageMinutes: null, reason: "missing-freeze-time" };
  }
  const deadlineMinutes = horizonMinutes + maxDelayMinutes;
  if (outcome.rugged && ageMinutes >= 0 && ageMinutes <= deadlineMinutes) {
    return {
      canonical: true,
      ageMinutes,
      reason: ageMinutes < horizonMinutes ? "terminal-rug-before-horizon" : "valid-window"
    };
  }
  if (ageMinutes >= horizonMinutes && ageMinutes <= deadlineMinutes) {
    return { canonical: true, ageMinutes, reason: "valid-window" };
  }
  return { canonical: false, ageMinutes, reason: "outside-window" };
}

function positiveNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function calculateWalletSignalOutcome(
  entry: WalletEntrySignalEvidence,
  observations: PriceObservationEvidence[],
  currentObservedAt: string,
  config: OutcomeConfig = {}
): WalletSignalOutcomeEvidence {
  const horizonMinutes = config.horizonMinutes ?? 20;
  const maxDelayMinutes = config.maxDelayMinutes ?? 20;
  const estimatedRoundTripCostPct = config.estimatedRoundTripCostPct ?? 3;
  const exitStrategy = config.exitStrategy ?? "fixed-horizon";
  const entryTime = new Date(entry.observedAt).getTime();
  const currentTime = new Date(currentObservedAt).getTime();
  const targetTime = entryTime + horizonMinutes * 60_000;
  const deadline = targetTime + maxDelayMinutes * 60_000;
  const path = observations
    .filter(
      (observation) =>
        observation.tokenAddress === entry.tokenAddress &&
        new Date(observation.observedAt).getTime() >= entryTime &&
        new Date(observation.observedAt).getTime() <= currentTime
    )
    .sort((a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime());
  const terminalRug = path.find((observation) => observation.rugged);
  const strategyExit =
    exitStrategy === "tp15-sl20-20m" ? findThresholdExit(entry, path, targetTime) : undefined;
  const horizonExit = path.find((observation) => {
    const observedTime = new Date(observation.observedAt).getTime();
    return observedTime >= targetTime && observedTime <= deadline;
  });
  const matureExit =
    currentTime >= targetTime
      ? earliestObservation([terminalRug, strategyExit, horizonExit])
      : undefined;
  const terminalRugBeforeHorizon = Boolean(
    terminalRug && new Date(terminalRug.observedAt).getTime() < targetTime
  );
  const latest = path[path.length - 1];
  const status: WalletSignalOutcomeEvidence["status"] = matureExit
    ? "mature"
    : currentTime < targetTime
      ? "provisional"
      : "unresolved";
  const selected = matureExit ?? latest;
  const outcomePriceUsd = selected ? (selected.rugged ? 0 : selected.priceUsd) : undefined;
  const grossReturnPct =
    outcomePriceUsd !== undefined && entry.observedEntryPriceUsd > 0
      ? ((outcomePriceUsd - entry.observedEntryPriceUsd) / entry.observedEntryPriceUsd) * 100
      : undefined;
  const signature = selected?.signature ?? entry.signature;
  const slot = selected?.slot ?? entry.slot;
  const observedAt = selected?.observedAt ?? currentObservedAt;
  const idempotencyKey = outcomeKey(entry, horizonMinutes, exitStrategy);

  return {
    idempotencyKey,
    chain: entry.chain,
    entryIdempotencyKey: entry.idempotencyKey,
    horizonMinutes,
    status,
    ...(outcomePriceUsd !== undefined ? { outcomePriceUsd } : {}),
    ...(matureExit ? { frozenAt: matureExit.observedAt } : {}),
    ...(grossReturnPct !== undefined ? { grossReturnPct } : {}),
    ...(grossReturnPct !== undefined
      ? { netReturnPct: grossReturnPct - estimatedRoundTripCostPct }
      : {}),
    estimatedRoundTripCostPct,
    exitStrategy,
    rugged: Boolean(matureExit?.rugged),
    signature,
    slot,
    provider: selected?.provider ?? entry.provider,
    observedAt,
    strategyVersion: entry.strategyVersion,
    raw: {
      targetObservedAt: new Date(targetTime).toISOString(),
      deadlineObservedAt: new Date(deadline).toISOString(),
      sourceObservationIdempotencyKey: selected?.idempotencyKey ?? null,
      terminalRugBeforeHorizon,
      ...(terminalRugBeforeHorizon && terminalRug
        ? {
            terminalRugObservedAt: terminalRug.observedAt,
            maturityConfirmedAt: currentObservedAt
          }
        : {})
    }
  };
}

export async function evaluateAndSaveWalletOutcome(
  repository: EvidenceWriter,
  entry: WalletEntrySignalEvidence,
  observations: PriceObservationEvidence[],
  currentObservedAt: string,
  config: OutcomeConfig = {}
): Promise<WalletSignalOutcomeEvidence> {
  const outcome = calculateWalletSignalOutcome(entry, observations, currentObservedAt, config);
  await repository.saveWalletSignalOutcome(outcome);
  return outcome;
}

export function buildExperimentCohorts(entries: WalletEntrySignalEvidence[]): ExperimentCohorts {
  const unique = dedupeEntriesByToken(entries.filter(isSourceLinkedWalletEntry));
  return {
    primary: unique.filter(
      (entry) =>
        entry.cohort === "repeat-wallet+controlled-flow" &&
        entry.repeatWalletCount >= 2 &&
        entry.flowEvidence.controlledFlow === true
    ),
    control: unique.filter(
      (entry) =>
        entry.cohort === "controlled-flow-control" &&
        entry.repeatWalletCount < 2 &&
        entry.flowEvidence.controlledFlow === true
    )
  };
}

export function scoreWalletFromEvidence(
  walletAddress: string,
  entries: WalletEntrySignalEvidence[],
  outcomes: WalletSignalOutcomeEvidence[]
): WalletEvidenceScore {
  const walletEntries = entries.filter(
    (entry) => entry.walletAddress === walletAddress && isSourceLinkedWalletEntry(entry)
  );
  const entryByKey = new Map(walletEntries.map((entry) => [entry.idempotencyKey, entry]));
  const walletOutcomes = outcomes.filter((outcome) => {
    const entry = entryByKey.get(outcome.entryIdempotencyKey);
    return Boolean(entry) && outcome.exitStrategy === "fixed-horizon";
  });
  const mature = walletOutcomes.filter((outcome) => {
    const entry = entryByKey.get(outcome.entryIdempotencyKey);
    return Boolean(entry && assessFixedHorizonEvidence(entry, outcome).canonical);
  });
  const returns = mature.map((outcome) => outcome.netReturnPct!);
  const average = mean(returns);
  const median = medianValue(returns);
  const hitRate = returns.filter((value) => value > 0).length / Math.max(returns.length, 1);
  const worst = returns.length > 0 ? Math.min(...returns) : 0;
  const bestIndex = returns.reduce(
    (best, value, index) => (value > returns[best]! ? index : best),
    0
  );
  const averageExBest =
    returns.length > 1 ? mean(returns.filter((_, index) => index !== bestIndex)) : 0;
  const positiveReturns = returns.filter((value) => value > 0);
  const positiveReturnSum = positiveReturns.reduce((sum, value) => sum + value, 0);
  const bestWinnerShare =
    positiveReturnSum > 0 ? Math.max(...positiveReturns) / positiveReturnSum : 0;
  const watchPass =
    mature.length >= 3 && average >= 0 && median >= 0 && hitRate >= 0.5 && worst >= -35;
  const candidatePass =
    mature.length >= 4 && average >= 2 && averageExBest > 0 && bestWinnerShare <= 0.35 && watchPass;
  const score = !watchPass
    ? 0
    : Math.max(
        0,
        Math.min(
          100,
          30 +
            Math.min(mature.length, 10) * 3 +
            Math.max(-20, Math.min(20, average)) +
            hitRate * 20 +
            (worst >= -35 ? 10 : -20)
        )
      );
  const confidence =
    candidatePass && score >= 60 ? "candidate" : watchPass ? "watch" : "insufficient";

  return {
    walletAddress,
    matureOutcomeCount: mature.length,
    provisionalOutcomeCount: walletOutcomes.filter((outcome) => outcome.status === "provisional")
      .length,
    unresolvedOutcomeCount: walletOutcomes.filter((outcome) => outcome.status === "unresolved")
      .length,
    averageNetReturnPct: average,
    medianNetReturnPct: median,
    averageNetReturnExBestPct: averageExBest,
    bestWinnerShare,
    hitRate,
    worstNetReturnPct: worst,
    score,
    confidence
  };
}

function walletEntryKey(input: WalletEntryInput): string {
  return createHash("sha256")
    .update(
      [
        input.chain,
        input.walletAddress,
        input.tokenAddress,
        input.strategyVersion,
        "first-observed-buy"
      ].join(":")
    )
    .digest("hex");
}

function outcomeKey(
  entry: WalletEntrySignalEvidence,
  horizonMinutes: number,
  exitStrategy: WalletSignalOutcomeEvidence["exitStrategy"]
): string {
  return createHash("sha256")
    .update([entry.idempotencyKey, horizonMinutes, exitStrategy, entry.strategyVersion].join(":"))
    .digest("hex");
}

function findThresholdExit(
  entry: WalletEntrySignalEvidence,
  path: PriceObservationEvidence[],
  targetTime: number
): PriceObservationEvidence | undefined {
  return path.find((observation) => {
    if (new Date(observation.observedAt).getTime() > targetTime) return false;
    if (observation.rugged) return true;
    const grossReturn =
      ((observation.priceUsd - entry.observedEntryPriceUsd) / entry.observedEntryPriceUsd) * 100;
    return grossReturn >= 15 || grossReturn <= -20;
  });
}

function earliestObservation(
  values: Array<PriceObservationEvidence | undefined>
): PriceObservationEvidence | undefined {
  return values
    .filter((value): value is PriceObservationEvidence => Boolean(value))
    .sort((a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime())[0];
}

function dedupeEntriesByToken(entries: WalletEntrySignalEvidence[]): WalletEntrySignalEvidence[] {
  const sorted = [...entries].sort(
    (a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime()
  );
  const seen = new Set<string>();
  return sorted.filter((entry) => {
    const key = `${entry.strategyVersion}:${entry.tokenAddress}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function medianValue(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}
