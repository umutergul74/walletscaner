import type {
  BacktestRun,
  HypothesisRunEvidence,
  WalletEntrySignalEvidence,
  WalletSignalOutcomeEvidence
} from "@memecoin-alpha/shared";
import type { EvidenceRepository } from "@memecoin-alpha/db";
import {
  assessFixedHorizonEvidence,
  isSourceLinkedWalletEntry,
  scoreWalletFromEvidence
} from "@memecoin-alpha/core";
import { buildGoalCompletionAudit, type GoalCompletionAudit } from "./goal-completion-audit.js";

export interface CanonicalEvidenceRepository extends EvidenceRepository {
  listBacktestRuns(limit?: number): Promise<BacktestRun[]>;
}

export interface IngestionDiagnosticsInput {
  providerStatus: "ok" | "degraded" | "down";
  providerLatencyMs?: number | null;
  reconnectCount?: number | null;
  backfillEventCount?: number | null;
}

export interface CanonicalEvidenceReport {
  generatedAt: string;
  strategyVersion: string;
  recommendedMode: "observe-only" | "paper-watch" | "paper-validate candidate";
  rawLead: string | null;
  funnel: {
    discoveredPools: number;
    eligibleCandidates: number;
    observedEntries: number;
    matureOutcomes: number;
    repeatingWallets: number;
    holdoutSignals: number;
  };
  dataQuality: {
    providerStatus: "ok" | "degraded" | "down";
    providerLatencyMs: number | null;
    missingSlotCount: number;
    reconnectCount: number | null;
    backfillEventCount: number | null;
    sourceLinkedEntryCount: number;
    exploratoryEntryCount: number;
    invalidFixedHorizonOutcomeCount: number;
    earlyTerminalRugCount: number;
    provisionalOutcomeCount: number;
    unresolvedOutcomeCount: number;
  };
  goalCompletionAudit: GoalCompletionAudit;
  topWallets: ReturnType<typeof scoreWalletFromEvidence>[];
  hypotheses: HypothesisRunEvidence[];
}

export async function buildCanonicalEvidenceReport(
  repository: CanonicalEvidenceRepository,
  strategyVersion: string,
  diagnostics: IngestionDiagnosticsInput,
  generatedAt = new Date().toISOString()
): Promise<CanonicalEvidenceReport> {
  const minObservedTime = new Date(
    new Date(generatedAt).getTime() - 7 * 24 * 60 * 60 * 1000 - 40 * 60 * 1000
  ).toISOString();
  const [allPrices, allEntries, allOutcomes, allHypotheses, backtests] = await Promise.all([
    repository.listPriceObservations(undefined, strategyVersion, minObservedTime),
    repository.listWalletEntrySignals(undefined, strategyVersion, minObservedTime),
    repository.listWalletSignalOutcomes(undefined, strategyVersion, minObservedTime),
    repository.listHypothesisRuns(),
    repository.listBacktestRuns(25)
  ]);
  const prices = allPrices.filter((observation) => observation.strategyVersion === strategyVersion);
  const entries = allEntries.filter((entry) => entry.strategyVersion === strategyVersion);
  const outcomes = allOutcomes.filter((outcome) => outcome.strategyVersion === strategyVersion);
  const hypotheses = allHypotheses
    .filter(
      (run) =>
        run.strategyVersion === strategyVersion &&
        isCanonicalHypothesis(run) &&
        new Date(run.observedAt).getTime() >= new Date(minObservedTime).getTime()
    )
    .sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime());
  const latestHypotheses = latestHypothesesByKey(hypotheses);
  const latestStrategyCandidate = latestHypotheses.find(
    (run) =>
      run.provider === "evidence-strategy-search" &&
      run.verdict === "candidate" &&
      run.metrics.replayPassed === 1
  );
  const latestReplay = backtests.find(
    (run) =>
      run.strategyVersion === strategyVersion &&
      run.config.canonicalSourceLinked === true &&
      Boolean(latestStrategyCandidate) &&
      run.config.strategySearchCandidateLabel === latestStrategyCandidate?.cohort
  );
  const sourceLinkedEntries = entries.filter(isSourceLinkedWalletEntry);
  const sourceLinkedEntryKeys = new Set(sourceLinkedEntries.map((entry) => entry.idempotencyKey));
  const sourceLinkedOutcomes = outcomes.filter((outcome) =>
    sourceLinkedEntryKeys.has(outcome.entryIdempotencyKey)
  );
  const entryByKey = new Map(sourceLinkedEntries.map((entry) => [entry.idempotencyKey, entry]));
  const fixedHorizonAssessments = sourceLinkedOutcomes
    .filter((outcome) => outcome.exitStrategy === "fixed-horizon" && outcome.status === "mature")
    .flatMap((outcome) => {
      const entry = entryByKey.get(outcome.entryIdempotencyKey);
      return entry ? [{ outcome, assessment: assessFixedHorizonEvidence(entry, outcome) }] : [];
    });
  const matureOutcomes = dedupeMatureOutcomes(sourceLinkedEntries, sourceLinkedOutcomes);
  const candidateTokenAddresses = latestStrategyCandidate
    ? new Set(latestStrategyCandidate.signalKeys)
    : null;
  const audit = buildGoalCompletionAudit(
    matureOutcomes.flatMap((outcome) => {
      const entry = entryByKey.get(outcome.entryIdempotencyKey);
      if (
        !entry ||
        outcome.netReturnPct === undefined ||
        (candidateTokenAddresses && !candidateTokenAddresses.has(entry.tokenAddress))
      ) {
        return [];
      }
      return [
        {
          key: entry.tokenAddress,
          observedAt: outcome.frozenAt ?? outcome.observedAt,
          netReturnPct: outcome.netReturnPct
        }
      ];
    }),
    latestReplay?.metrics
  );
  const walletAddresses = [...new Set(sourceLinkedEntries.map((entry) => entry.walletAddress))];
  const topWallets = walletAddresses
    .map((wallet) => scoreWalletFromEvidence(wallet, sourceLinkedEntries, sourceLinkedOutcomes))
    .filter((wallet) => wallet.matureOutcomeCount > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.matureOutcomeCount - a.matureOutcomeCount ||
        b.averageNetReturnPct - a.averageNetReturnPct
    )
    .slice(0, 20);
  const latestLead = latestHypotheses.find((run) => run.verdict !== "reject");
  const hasPaperWatch =
    matureOutcomes.length > 0 &&
    latestHypotheses.some((run) => run.verdict === "watch" || run.verdict === "candidate");
  const hasValidatedSystemCandidate = Boolean(latestStrategyCandidate && audit.completed);

  return {
    generatedAt,
    strategyVersion,
    recommendedMode: hasValidatedSystemCandidate
      ? "paper-validate candidate"
      : hasPaperWatch
        ? "paper-watch"
        : "observe-only",
    rawLead: latestLead ? `${latestLead.hypothesisKey} / raw lead / unvalidated` : null,
    funnel: {
      discoveredPools: uniqueCount(prices, (observation) => observation.poolAddress),
      eligibleCandidates: uniqueCount(
        sourceLinkedEntries.filter((entry) => entry.flowEvidence.controlledFlow === true),
        (entry) => entry.tokenAddress
      ),
      observedEntries: sourceLinkedEntries.length,
      matureOutcomes: matureOutcomes.length,
      repeatingWallets: uniqueCount(
        sourceLinkedEntries.filter((entry) => entry.repeatWalletCount >= 2),
        (entry) => entry.walletAddress
      ),
      holdoutSignals: audit.holdouts.reduce((sum, holdout) => sum + holdout.signalCount, 0)
    },
    dataQuality: {
      providerStatus: diagnostics.providerStatus,
      providerLatencyMs: diagnostics.providerLatencyMs ?? null,
      missingSlotCount: countMissingSlots(sourceLinkedEntries, hypotheses),
      reconnectCount: diagnostics.reconnectCount ?? null,
      backfillEventCount: diagnostics.backfillEventCount ?? null,
      sourceLinkedEntryCount: sourceLinkedEntries.length,
      exploratoryEntryCount: entries.length - sourceLinkedEntries.length,
      invalidFixedHorizonOutcomeCount: fixedHorizonAssessments.filter(
        ({ assessment }) => !assessment.canonical
      ).length,
      earlyTerminalRugCount: fixedHorizonAssessments.filter(
        ({ assessment }) => assessment.reason === "terminal-rug-before-horizon"
      ).length,
      provisionalOutcomeCount: sourceLinkedOutcomes.filter(
        (outcome) => outcome.exitStrategy === "fixed-horizon" && outcome.status === "provisional"
      ).length,
      unresolvedOutcomeCount: sourceLinkedOutcomes.filter(
        (outcome) => outcome.exitStrategy === "fixed-horizon" && outcome.status === "unresolved"
      ).length
    },
    goalCompletionAudit: audit,
    topWallets,
    hypotheses: latestHypotheses.slice(0, 30)
  };
}

export function renderCanonicalEvidenceMarkdown(report: CanonicalEvidenceReport): string {
  return [
    "# Solana Evidence-First Alpha Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Strategy version: ${report.strategyVersion}`,
    `Mode: ${report.recommendedMode}`,
    `Raw lead: ${report.rawLead ?? "none"}`,
    "",
    "Research and paper mode only. This is not financial advice.",
    "",
    "## Evidence Funnel",
    "",
    `Discovered pools: ${report.funnel.discoveredPools}`,
    `Eligible candidates: ${report.funnel.eligibleCandidates}`,
    `Observed entries: ${report.funnel.observedEntries}`,
    `Mature outcomes: ${report.funnel.matureOutcomes}`,
    `Repeating wallets: ${report.funnel.repeatingWallets}`,
    `Holdout signals: ${report.funnel.holdoutSignals}`,
    "",
    "## Data Quality",
    "",
    `Provider status: ${report.dataQuality.providerStatus}`,
    `Provider latency: ${report.dataQuality.providerLatencyMs ?? "unavailable"} ms`,
    `Unknown source slots: ${report.dataQuality.missingSlotCount}`,
    `Reconnects: ${report.dataQuality.reconnectCount ?? "unavailable"}`,
    `Backfill events: ${report.dataQuality.backfillEventCount ?? "unavailable"}`,
    `Source-linked entries: ${report.dataQuality.sourceLinkedEntryCount}`,
    `Exploratory/unlinked entries: ${report.dataQuality.exploratoryEntryCount}`,
    `Invalid fixed-horizon outcomes: ${report.dataQuality.invalidFixedHorizonOutcomeCount}`,
    `Early terminal rugs retained: ${report.dataQuality.earlyTerminalRugCount}`,
    `Provisional outcomes: ${report.dataQuality.provisionalOutcomeCount}`,
    `Unresolved outcomes: ${report.dataQuality.unresolvedOutcomeCount}`,
    "",
    "## Goal Completion Audit",
    "",
    `Completed: ${report.goalCompletionAudit.completed ? "yes" : "no"}`,
    `Independent mature signals: ${report.goalCompletionAudit.independentMatureSignalCount}/30`,
    `Observation days: ${report.goalCompletionAudit.observationDays}/7`,
    `Replay passed: ${report.goalCompletionAudit.replay.passed ? "yes" : "no"}`,
    ...report.goalCompletionAudit.reasons.map((reason) => `- ${reason}`),
    "",
    "## Top Wallets",
    "",
    "| Wallet | Mature | Provisional | Avg net | Median net | Avg ex-best | Best-winner share | Hit rate | Worst | Verdict |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ...report.topWallets.map((wallet) =>
      [
        wallet.walletAddress,
        wallet.matureOutcomeCount,
        wallet.provisionalOutcomeCount,
        `${round(wallet.averageNetReturnPct)}%`,
        `${round(wallet.medianNetReturnPct)}%`,
        `${round(wallet.averageNetReturnExBestPct)}%`,
        `${round(wallet.bestWinnerShare * 100)}%`,
        `${round(wallet.hitRate * 100)}%`,
        `${round(wallet.worstNetReturnPct)}%`,
        wallet.confidence
      ].join(" | ")
    )
  ].join("\n");
}

function latestHypothesesByKey(hypotheses: HypothesisRunEvidence[]): HypothesisRunEvidence[] {
  const seen = new Set<string>();
  return hypotheses.filter((run) => {
    if (seen.has(run.hypothesisKey)) return false;
    seen.add(run.hypothesisKey);
    return true;
  });
}

function dedupeMatureOutcomes(
  entries: WalletEntrySignalEvidence[],
  outcomes: WalletSignalOutcomeEvidence[]
): WalletSignalOutcomeEvidence[] {
  const entryByKey = new Map(entries.map((entry) => [entry.idempotencyKey, entry]));
  const seen = new Set<string>();
  return outcomes
    .filter((outcome) => {
      const entry = entryByKey.get(outcome.entryIdempotencyKey);
      return Boolean(entry && assessFixedHorizonEvidence(entry, outcome).canonical);
    })
    .sort((a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime())
    .filter((outcome) => {
      if (seen.has(outcome.entryIdempotencyKey)) return false;
      seen.add(outcome.entryIdempotencyKey);
      return true;
    });
}

function isCanonicalHypothesis(run: HypothesisRunEvidence): boolean {
  return run.provider === "evidence-strategy-search" && run.metrics.canonicalSourceLinked === 1;
}

function uniqueCount<T>(values: T[], key: (value: T) => string | undefined): number {
  return new Set(values.map(key).filter((value): value is string => Boolean(value))).size;
}

function countMissingSlots(
  entries: WalletEntrySignalEvidence[],
  hypotheses: HypothesisRunEvidence[]
): number {
  return [...entries, ...hypotheses].filter((record) => record.slot <= 0).length;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
