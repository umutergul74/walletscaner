import type { EvidenceRepository, IntelligenceRepository } from "@memecoin-alpha/db";
import { buildWalletAlphaScores, MANAGED_EXIT_V2_POLICY } from "@memecoin-alpha/core";
import type { WalletAlphaScoreSnapshot } from "@memecoin-alpha/shared";

type ManagedShadowRepository = Pick<
  EvidenceRepository,
  | "listWalletAlphaScores"
  | "listWalletTradeEventsForWallets"
  | "listWalletEntrySignalsForWallets"
  | "listWalletSignalOutcomesForWallets"
> &
  Pick<IntelligenceRepository, "listTokenCreatorAddresses">;

export interface ManagedShadowOptions {
  maximumWallets?: number;
  sourceScoreReadLimit?: number;
  sourceWindowDays?: number;
}

export interface ManagedShadowWalletComparison {
  walletAddress: string;
  cohort: "top-score" | "bounded-negative-control";
  sourceStatus: WalletAlphaScoreSnapshot["status"];
  managedStatus: WalletAlphaScoreSnapshot["status"];
  sourceOverallScore: number;
  managedOverallScore: number;
  managedFollowability: WalletAlphaScoreSnapshot["metrics"]["followability"];
  managedReasons: string[];
}

export interface ManagedShadowReport {
  generatedAt: string;
  sourceStrategyVersion: string;
  scoreStrategyVersion: string;
  scoringPolicy: "managed-exit-v2";
  persisted: false;
  signalsEnabled: false;
  selection: {
    maximumWallets: number;
    sourceScoreReadLimit: number;
    selectedWallets: number;
    topScoreWallets: number;
    boundedNegativeControls: number;
    warning: string;
  };
  inputs: {
    trades: number;
    entries: number;
    outcomes: number;
  };
  statusCounts: Record<WalletAlphaScoreSnapshot["status"], number>;
  comparisons: ManagedShadowWalletComparison[];
  decision: string;
}

export async function buildManagedShadowReport(
  repository: ManagedShadowRepository,
  sourceStrategyVersion = "evidence-v1",
  now = new Date().toISOString(),
  options: ManagedShadowOptions = {}
): Promise<ManagedShadowReport> {
  const maximumWallets = boundedInt(options.maximumWallets, 25, 1, 100);
  const sourceScoreReadLimit = boundedInt(options.sourceScoreReadLimit, 250, maximumWallets, 1_000);
  const sourceWindowDays = boundedInt(options.sourceWindowDays, 90, 90, 180);
  const minimumObservedAt = new Date(
    new Date(now).getTime() - sourceWindowDays * 24 * 60 * 60 * 1_000
  ).toISOString();
  const sourceScores = (
    await repository.listWalletAlphaScores(sourceStrategyVersion, sourceScoreReadLimit)
  ).filter((score) => !["insufficient", "excluded"].includes(score.status));
  const controlCount = sourceScores.length > 4 ? Math.max(1, Math.floor(maximumWallets * 0.2)) : 0;
  const topCount = maximumWallets - controlCount;
  const topScores = sourceScores.slice(0, topCount);
  const topWallets = new Set(topScores.map((score) => score.walletAddress));
  const controlScores = [...sourceScores]
    .reverse()
    .filter((score) => !topWallets.has(score.walletAddress))
    .slice(0, controlCount);
  const selectedScores = [...topScores, ...controlScores];
  const walletAddresses = selectedScores.map((score) => score.walletAddress);

  if (walletAddresses.length === 0) {
    return emptyReport(
      now,
      sourceStrategyVersion,
      maximumWallets,
      sourceScoreReadLimit,
      "No observed source wallets were available for the managed-exit shadow comparison."
    );
  }

  const [trades, entries, outcomes, creatorAddresses] = await Promise.all([
    repository.listWalletTradeEventsForWallets(walletAddresses, sourceStrategyVersion),
    repository.listWalletEntrySignalsForWallets(
      walletAddresses,
      sourceStrategyVersion,
      minimumObservedAt
    ),
    repository.listWalletSignalOutcomesForWallets(
      walletAddresses,
      sourceStrategyVersion,
      minimumObservedAt
    ),
    repository.listTokenCreatorAddresses()
  ]);
  const scores = buildWalletAlphaScores({
    trades,
    entries,
    outcomes,
    strategyVersion: sourceStrategyVersion,
    scoreStrategyVersion: MANAGED_EXIT_V2_POLICY.scoreStrategyVersion,
    scoringPolicy: "managed-exit-v2",
    calculatedAt: now,
    creatorWallets: new Set(creatorAddresses)
  });
  const managedByWallet = new Map(scores.map((score) => [score.walletAddress, score]));
  const sourceByWallet = new Map(selectedScores.map((score) => [score.walletAddress, score]));
  const controlWallets = new Set(controlScores.map((score) => score.walletAddress));
  const comparisons = walletAddresses
    .map((walletAddress) => {
      const source = sourceByWallet.get(walletAddress);
      const managed = managedByWallet.get(walletAddress);
      if (!source || !managed) return undefined;
      return {
        walletAddress,
        cohort: controlWallets.has(walletAddress)
          ? ("bounded-negative-control" as const)
          : ("top-score" as const),
        sourceStatus: source.status,
        managedStatus: managed.status,
        sourceOverallScore: source.overallScore,
        managedOverallScore: managed.overallScore,
        managedFollowability: managed.metrics.followability,
        managedReasons: managed.reasons
      };
    })
    .filter((value): value is ManagedShadowWalletComparison => value !== undefined)
    .sort(
      (a, b) =>
        statusRank(b.managedStatus) - statusRank(a.managedStatus) ||
        b.managedOverallScore - a.managedOverallScore ||
        a.walletAddress.localeCompare(b.walletAddress)
    );
  const statusCounts = emptyStatusCounts();
  for (const comparison of comparisons) statusCounts[comparison.managedStatus] += 1;
  const qualified = statusCounts.watch + statusCounts.candidate + statusCounts["validated-paper"];

  return {
    generatedAt: now,
    sourceStrategyVersion,
    scoreStrategyVersion: MANAGED_EXIT_V2_POLICY.scoreStrategyVersion,
    scoringPolicy: "managed-exit-v2",
    persisted: false,
    signalsEnabled: false,
    selection: {
      maximumWallets,
      sourceScoreReadLimit,
      selectedWallets: walletAddresses.length,
      topScoreWallets: topScores.length,
      boundedNegativeControls: controlScores.length,
      warning:
        "This bounded top-score/control comparison is model-selection evidence, not an untouched chronological validation cohort."
    },
    inputs: { trades: trades.length, entries: entries.length, outcomes: outcomes.length },
    statusCounts,
    comparisons,
    decision:
      qualified > 0
        ? `${qualified} wallet(s) passed the managed-exit watch-or-better gate in this bounded read-only shadow sample. Keep signals disabled until fill realism, resource bounds, and future chronological evidence pass.`
        : "No wallet passed the managed-exit watch gate in this bounded read-only shadow sample. Do not relax the tail-risk gates without new evidence."
  };
}

export function renderManagedShadowMarkdown(report: ManagedShadowReport): string {
  const lines = [
    "# Wallet Alpha Managed-Exit Shadow Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Evidence strategy: ${report.sourceStrategyVersion}`,
    `Score strategy: ${report.scoreStrategyVersion}`,
    "Persisted: no",
    "Signals enabled: no",
    "",
    "## Decision",
    "",
    report.decision,
    "",
    `Selection warning: ${report.selection.warning}`,
    "",
    "## Bounded Inputs",
    "",
    `Wallets: ${report.selection.selectedWallets} (${report.selection.topScoreWallets} top-score, ${report.selection.boundedNegativeControls} controls)`,
    `Trades: ${report.inputs.trades}`,
    `Entries: ${report.inputs.entries}`,
    `Outcomes: ${report.inputs.outcomes}`,
    "",
    "## Managed Status",
    "",
    `Observed: ${report.statusCounts.observed}`,
    `Watch: ${report.statusCounts.watch}`,
    `Candidate: ${report.statusCounts.candidate}`,
    `Validated paper: ${report.statusCounts["validated-paper"]}`,
    `Excluded: ${report.statusCounts.excluded}`,
    "",
    "## Wallet Comparison",
    "",
    "| Wallet | Cohort | Source | Managed | Managed score | Samples | Hit | PF | Rug | Catastrophic | Tail avg |",
    "|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ...report.comparisons.map((comparison) => {
      const metrics = comparison.managedFollowability;
      return `| ${comparison.walletAddress} | ${comparison.cohort} | ${comparison.sourceStatus} | ${comparison.managedStatus} | ${comparison.managedOverallScore} | ${metrics.sampleCount} | ${round(metrics.hitRate * 100)}% | ${round(metrics.profitFactor)} | ${round((metrics.ruggedOutcomeRate ?? 0) * 100)}% | ${round((metrics.catastrophicLossRate ?? 0) * 100)}% | ${round(metrics.lowerTailAverageReturnPct ?? 0)}% |`;
    })
  ];
  return `${lines.join("\n")}\n`;
}

function emptyReport(
  generatedAt: string,
  sourceStrategyVersion: string,
  maximumWallets: number,
  sourceScoreReadLimit: number,
  decision: string
): ManagedShadowReport {
  return {
    generatedAt,
    sourceStrategyVersion,
    scoreStrategyVersion: MANAGED_EXIT_V2_POLICY.scoreStrategyVersion,
    scoringPolicy: "managed-exit-v2",
    persisted: false,
    signalsEnabled: false,
    selection: {
      maximumWallets,
      sourceScoreReadLimit,
      selectedWallets: 0,
      topScoreWallets: 0,
      boundedNegativeControls: 0,
      warning:
        "This bounded top-score/control comparison is model-selection evidence, not an untouched chronological validation cohort."
    },
    inputs: { trades: 0, entries: 0, outcomes: 0 },
    statusCounts: emptyStatusCounts(),
    comparisons: [],
    decision
  };
}

function emptyStatusCounts(): Record<WalletAlphaScoreSnapshot["status"], number> {
  return {
    insufficient: 0,
    observed: 0,
    watch: 0,
    candidate: 0,
    "validated-paper": 0,
    excluded: 0
  };
}

function statusRank(status: WalletAlphaScoreSnapshot["status"]): number {
  return {
    excluded: -1,
    insufficient: 0,
    observed: 1,
    watch: 2,
    candidate: 3,
    "validated-paper": 4
  }[status];
}

function boundedInt(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = Math.trunc(value ?? fallback);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
