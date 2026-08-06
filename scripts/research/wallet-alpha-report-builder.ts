import type {
  CanonicalRepository,
  EvidenceRepository,
  IntelligenceRepository,
  WalletAlphaWorkSummary,
  WalletPositionLedgerSnapshot
} from "@memecoin-alpha/db";
import {
  buildWalletLedger,
  buildWalletAlphaScores,
  buildWalletAlphaSignals
} from "@memecoin-alpha/core";
import type { WalletLedger } from "@memecoin-alpha/core";
import type { WalletAlphaScoreSnapshot, WalletAlphaSignalEvidence } from "@memecoin-alpha/shared";

export type WalletAlphaMode = "observe-only" | "paper-watch" | "paper-validate candidate";

export interface WalletAlphaReport {
  generatedAt: string;
  strategyVersion: string;
  sourceWindowDays: number;
  mode: WalletAlphaMode;
  materializedHistoricalTrades: number;
  workQueue: WalletAlphaWorkSummary & { processed: number };
  coverage: {
    tradeEvents: number;
    buyEvents: number;
    sellEvents: number;
    pricedEvents: number;
    highQualityPricedEvents: number;
    highQualityPriceCoverage: number;
    walletsSeen: number;
    completedPositions: number;
    openInventories: number;
    sourceLinkedFollowerEntries: number;
    eligibleSourceLinkedFollowerEntries: number;
    excludedUncontrolledFlowEntries: number;
    matureFollowerOutcomes: number;
    eligibleMatureFollowerOutcomes: number;
    riskPassedEntries: number;
    unknownRiskBlockedEntries: number;
    failedRiskBlockedEntries: number;
  };
  statusCounts: Record<WalletAlphaScoreSnapshot["status"], number>;
  topWallets: WalletAlphaScoreSnapshot[];
  livePaperSignals: WalletAlphaSignalEvidence[];
  decision: string;
}

type WalletAlphaRepository = EvidenceRepository &
  Pick<IntelligenceRepository, "listMatchingTokenCreatorAddresses"> &
  Pick<CanonicalRepository, "listWalletAlphaRankings">;

export interface WalletAlphaReportProgress {
  stage: string;
  elapsedMs: number;
  details?: Record<string, number | string>;
}

export interface WalletAlphaReportOptions {
  onProgress?: (progress: WalletAlphaReportProgress) => void;
  persistenceConcurrency?: number;
  materializeHistorical?: boolean;
  workBatchSize?: number;
  maxWorkBatches?: number;
  workLeaseSeconds?: number;
  workerId?: string;
  maximumTradeEventsPerWallet?: number;
  maximumEntriesPerWallet?: number;
  maximumOutcomesPerWallet?: number;
  oversizedRetrySeconds?: number;
  maximumRunSeconds?: number;
  minimumTradeEvents?: number;
  minimumEntries?: number;
}

export interface WalletAlphaQueueResult {
  materializedHistoricalTrades: number;
  processedWallets: number;
  skippedLowEvidenceWallets: number;
  failedWallets: number;
  oversizedWallets: number;
  minimumObservedAt: string;
}

export async function buildWalletAlphaReport(
  repository: WalletAlphaRepository,
  strategyVersion: string,
  now = new Date().toISOString(),
  sourceWindowDays = 30,
  options: WalletAlphaReportOptions = {}
): Promise<WalletAlphaReport> {
  const startedAt = Date.now();
  // Wallet-alpha v2 always needs the 90-day side of its 30/90 scoring windows.
  // A larger caller-provided window remains valid for research runs.
  const effectiveSourceWindowDays = Math.max(90, sourceWindowDays);
  const progress = (stage: string, details?: Record<string, number | string>) =>
    options.onProgress?.({
      stage,
      elapsedMs: Date.now() - startedAt,
      ...(details ? { details } : {})
    });
  const minimumObservedAt = new Date(
    new Date(now).getTime() - effectiveSourceWindowDays * 24 * 60 * 60 * 1_000
  ).toISOString();
  const queueResult = await processWalletAlphaQueue(
    repository,
    strategyVersion,
    now,
    effectiveSourceWindowDays,
    options
  );
  const { materializedHistoricalTrades, processedWallets } = queueResult;
  const livePaperSignals = await refreshWalletAlphaSignals(
    repository,
    strategyVersion,
    now,
    options.persistenceConcurrency
  );
  progress("persist-signals-finished", { signals: livePaperSignals.length });

  const latestScores = await repository.listWalletAlphaScores(strategyVersion, 5_000);
  const [statusCounts, coverageSummary, workSummary] = await Promise.all([
    repository.getWalletAlphaStatusCounts(strategyVersion),
    repository.getWalletAlphaCoverageSummary(strategyVersion, minimumObservedAt),
    repository.getWalletAlphaWorkSummary(strategyVersion)
  ]);
  const mode: WalletAlphaMode =
    statusCounts["validated-paper"] > 0
      ? "paper-validate candidate"
      : statusCounts.watch > 0 || statusCounts.candidate > 0
        ? "paper-watch"
        : "observe-only";
  const topWallets = latestScores
    .filter((score) => !["insufficient", "excluded"].includes(score.status))
    .slice(0, 50);
  const highQualityPriceCoverage =
    coverageSummary.highQualityPricedEvents / Math.max(coverageSummary.pricedEvents, 1);

  const report = {
    generatedAt: now,
    strategyVersion,
    sourceWindowDays: effectiveSourceWindowDays,
    mode,
    materializedHistoricalTrades,
    workQueue: { ...workSummary, processed: processedWallets },
    coverage: {
      ...coverageSummary,
      highQualityPriceCoverage
    },
    statusCounts,
    topWallets,
    livePaperSignals,
    decision: decisionText(mode, statusCounts, livePaperSignals.length, workSummary.pending)
  };
  progress("report-finished", {
    wallets: coverageSummary.walletsSeen,
    processedWallets,
    failedWallets: queueResult.failedWallets,
    oversizedWallets: queueResult.oversizedWallets,
    pendingWallets: workSummary.pending,
    signals: livePaperSignals.length
  });
  return report;
}

export async function processWalletAlphaQueue(
  repository: WalletAlphaRepository,
  strategyVersion: string,
  now = new Date().toISOString(),
  sourceWindowDays = 30,
  options: WalletAlphaReportOptions = {}
): Promise<WalletAlphaQueueResult> {
  const startedAt = Date.now();
  const effectiveSourceWindowDays = Math.max(90, sourceWindowDays);
  const progress = (stage: string, details?: Record<string, number | string>) =>
    options.onProgress?.({
      stage,
      elapsedMs: Date.now() - startedAt,
      ...(details ? { details } : {})
    });
  const minimumObservedAt = new Date(
    new Date(now).getTime() - effectiveSourceWindowDays * 24 * 60 * 60 * 1_000
  ).toISOString();
  let materializedHistoricalTrades = 0;
  if (options.materializeHistorical === false) {
    progress("materialize-historical-skipped");
  } else {
    progress("materialize-historical-start");
    materializedHistoricalTrades =
      await repository.materializeHistoricalWalletTrades(strategyVersion);
    progress("materialize-historical-finished", { materializedHistoricalTrades });
  }
  const workerId =
    options.workerId ?? `wallet-alpha:${process.pid}:${new Date(now).getTime().toString(36)}`;
  const workBatchSize = boundedInt(options.workBatchSize, 100, 1, 1_000);
  const maxWorkBatches = boundedInt(options.maxWorkBatches, 5, 1, 100);
  const workLeaseSeconds = boundedInt(options.workLeaseSeconds, 300, 30, 3_600);
  const persistenceConcurrency = boundedInt(options.persistenceConcurrency, 4, 1, 16);
  const maximumTradeEventsPerWallet = boundedInt(
    options.maximumTradeEventsPerWallet,
    10_000,
    100,
    100_000
  );
  const maximumEntriesPerWallet = boundedInt(options.maximumEntriesPerWallet, 2_000, 100, 50_000);
  const maximumOutcomesPerWallet = boundedInt(
    options.maximumOutcomesPerWallet,
    4_000,
    100,
    100_000
  );
  const oversizedRetrySeconds = boundedInt(options.oversizedRetrySeconds, 86_400, 300, 86_400);
  const maximumRunSeconds = boundedInt(options.maximumRunSeconds, 240, 30, 3_300);
  const minimumTradeEvents = boundedInt(options.minimumTradeEvents, 1, 1, 100);
  const minimumEntries = boundedInt(options.minimumEntries, 1, 1, 100);
  const minimumObservedAtMs = new Date(minimumObservedAt).getTime();
  let processedWallets = 0;
  let skippedLowEvidenceWallets = 0;
  let failedWallets = 0;
  let oversizedWallets = 0;
  const maximumWorkItems = workBatchSize * maxWorkBatches;

  for (let workIndex = 0; workIndex < maximumWorkItems; workIndex += 1) {
    if (Date.now() - startedAt >= maximumRunSeconds * 1_000) {
      progress("wallet-run-time-limit", {
        processedWallets,
        skippedLowEvidenceWallets,
        failedWallets,
        oversizedWallets,
        maximumRunSeconds
      });
      break;
    }
    const claimed = await repository.claimWalletAlphaWork({
      strategyVersion,
      workerId,
      // One lease at a time prevents a process-level failure from pinning an entire batch.
      limit: 1,
      leaseSeconds: workLeaseSeconds
    });
    if (claimed.length === 0) break;
    const item = claimed[0]!;
    const walletAddresses = [item.walletAddress];
    if (workIndex === 0 || (workIndex + 1) % 25 === 0) {
      progress("wallet-load-start", {
        workItem: workIndex + 1,
        processedWallets,
        failedWallets
      });
    }

    try {
      const [admissionTrades, admissionEntries] = await Promise.all([
        repository.listWalletTradeEventsForWallets(
          walletAddresses,
          strategyVersion,
          undefined,
          minimumTradeEvents
        ),
        repository.listWalletEntrySignalsForWallets(
          walletAddresses,
          strategyVersion,
          minimumObservedAt,
          minimumEntries
        )
      ]);
      if (
        admissionTrades.length < minimumTradeEvents &&
        admissionEntries.length < minimumEntries
      ) {
        if (!(await repository.completeWalletAlphaWork(item))) {
          throw new Error(`Wallet-alpha lease was lost for ${item.walletAddress}.`);
        }
        skippedLowEvidenceWallets += 1;
        if ((workIndex + 1) % 25 === 0) {
          progress("wallet-progress", {
            processedWallets,
            skippedLowEvidenceWallets,
            failedWallets,
            oversizedWallets
          });
        }
        continue;
      }

      const [ledgerTrades, entries, outcomes, matchingCreators] = await Promise.all([
        repository.listWalletTradeEventsForWallets(
          walletAddresses,
          strategyVersion,
          undefined,
          maximumTradeEventsPerWallet + 1
        ),
        repository.listWalletEntrySignalsForWallets(
          walletAddresses,
          strategyVersion,
          minimumObservedAt,
          maximumEntriesPerWallet + 1
        ),
        repository.listWalletSignalOutcomesForWallets(
          walletAddresses,
          strategyVersion,
          minimumObservedAt,
          maximumOutcomesPerWallet + 1
        ),
        repository.listMatchingTokenCreatorAddresses(walletAddresses)
      ]);
      assertEvidenceWithinLimit(
        item.walletAddress,
        "trade-events",
        ledgerTrades.length,
        maximumTradeEventsPerWallet
      );
      assertEvidenceWithinLimit(
        item.walletAddress,
        "entries",
        entries.length,
        maximumEntriesPerWallet
      );
      assertEvidenceWithinLimit(
        item.walletAddress,
        "outcomes",
        outcomes.length,
        maximumOutcomesPerWallet
      );
      const trades = ledgerTrades.filter(
        (trade) => new Date(trade.observedAt).getTime() >= minimumObservedAtMs
      );
      const ledger = buildWalletLedger(ledgerTrades);
      const prebuiltLedgers = partitionWalletLedger(ledger, walletAddresses);
      if (
        ledgerTrades.length >= maximumTradeEventsPerWallet / 2 ||
        workIndex === 0 ||
        (workIndex + 1) % 25 === 0
      ) {
        progress("wallet-loaded", {
          workItem: workIndex + 1,
          trades: trades.length,
          ledgerTrades: ledgerTrades.length,
          entries: entries.length,
          outcomes: outcomes.length,
          episodes: ledger.positionEpisodes.length,
          lots: ledger.positionLots.length
        });
      }

      await repository.replaceWalletPositionLedger(
        ledgerSnapshot(ledger, item.chain, strategyVersion, now, walletAddresses)
      );

      const scores = buildWalletAlphaScores({
        trades,
        entries,
        outcomes,
        strategyVersion,
        calculatedAt: now,
        creatorWallets: new Set(matchingCreators),
        prebuiltLedgers
      });
      await runWithConcurrency(scores, persistenceConcurrency, (score) =>
        repository.saveWalletAlphaScore(score)
      );
      if (!(await repository.completeWalletAlphaWork(item))) {
        throw new Error(`Wallet-alpha lease was lost for ${item.walletAddress}.`);
      }
      processedWallets += 1;
      if ((workIndex + 1) % 25 === 0) {
        progress("wallet-progress", {
          processedWallets,
          skippedLowEvidenceWallets,
          failedWallets,
          oversizedWallets
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const oversized = error instanceof WalletAlphaEvidenceLimitError;
      if (
        !(await repository.failWalletAlphaWork(
          item,
          message,
          oversized ? oversizedRetrySeconds : 300
        ))
      ) {
        throw new Error(
          `Wallet-alpha failure lease was lost for ${item.walletAddress}: ${message}`
        );
      }
      failedWallets += 1;
      if (oversized) oversizedWallets += 1;
      progress("wallet-failed", {
        workItem: workIndex + 1,
        wallet: item.walletAddress,
        reason: message,
        retrySeconds: oversized ? oversizedRetrySeconds : 300
      });
    }
  }

  return {
    materializedHistoricalTrades,
    processedWallets,
    skippedLowEvidenceWallets,
    failedWallets,
    oversizedWallets,
    minimumObservedAt
  };
}

export async function refreshWalletAlphaSignals(
  repository: WalletAlphaRepository,
  strategyVersion: string,
  now = new Date().toISOString(),
  persistenceConcurrency = 4
): Promise<WalletAlphaSignalEvidence[]> {
  const qualifiedScores = await repository.listWalletAlphaRankings({
    strategyVersion,
    statuses: ["watch", "candidate", "validated-paper"],
    limit: 1_000
  });
  const qualifiedWallets = [...new Set(qualifiedScores.map((score) => score.walletAddress))];
  const minimumSignalObservedAt = new Date(
    new Date(now).getTime() - 6 * 60 * 60 * 1_000
  ).toISOString();
  const signalEntries = await repository.listWalletEntrySignalsForWallets(
    qualifiedWallets,
    strategyVersion,
    minimumSignalObservedAt,
    10_001
  );
  if (signalEntries.length > 10_000) {
    throw new Error("Wallet-alpha signal refresh exceeded the 10000-entry safety limit.");
  }
  const livePaperSignals = buildWalletAlphaSignals({
    scores: qualifiedScores,
    entries: signalEntries,
    strategyVersion,
    now
  });
  await runWithConcurrency(
    livePaperSignals,
    boundedInt(persistenceConcurrency, 4, 1, 16),
    (signal) => repository.saveWalletAlphaSignal(signal)
  );
  return livePaperSignals;
}

class WalletAlphaEvidenceLimitError extends Error {}

function assertEvidenceWithinLimit(
  walletAddress: string,
  evidence: string,
  rows: number,
  limit: number
): void {
  if (rows <= limit) return;
  throw new WalletAlphaEvidenceLimitError(
    `Wallet ${walletAddress} exceeded ${evidence} safety limit ${limit}.`
  );
}

export function renderWalletAlphaMarkdown(report: WalletAlphaReport): string {
  const lines = [
    "# Wallet Alpha Signal Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Strategy version: ${report.strategyVersion}`,
    `Mode: ${report.mode}`,
    `Source window: ${report.sourceWindowDays} days`,
    `Wallet work processed: ${report.workQueue.processed}`,
    `Wallet work pending: ${report.workQueue.pending} (${report.workQueue.processing} leased, ${report.workQueue.failed} retrying)`,
    "",
    "Research and paper mode only. This is not financial advice.",
    "",
    "## Decision",
    "",
    report.decision,
    "",
    "## Evidence Coverage",
    "",
    `Wallet trade events: ${report.coverage.tradeEvents}`,
    `- Buys: ${report.coverage.buyEvents}`,
    `- Sells: ${report.coverage.sellEvents}`,
    `- Priced events: ${report.coverage.pricedEvents}`,
    `- High-quality priced events: ${report.coverage.highQualityPricedEvents} (${round(report.coverage.highQualityPriceCoverage * 100)}%)`,
    `Wallets seen: ${report.coverage.walletsSeen}`,
    `Completed wallet positions: ${report.coverage.completedPositions}`,
    `Open wallet inventories: ${report.coverage.openInventories}`,
    `Source-linked follower entries: ${report.coverage.sourceLinkedFollowerEntries}`,
    `- Eligible controlled-flow entries: ${report.coverage.eligibleSourceLinkedFollowerEntries}`,
    `- Excluded uncontrolled-flow baseline entries: ${report.coverage.excludedUncontrolledFlowEntries}`,
    `Mature follower outcomes: ${report.coverage.matureFollowerOutcomes}`,
    `- Eligible mature follower outcomes: ${report.coverage.eligibleMatureFollowerOutcomes}`,
    `Eligible risk-passed entries: ${report.coverage.riskPassedEntries}`,
    `Eligible entries blocked by unknown risk: ${report.coverage.unknownRiskBlockedEntries}`,
    `Eligible entries blocked by failed risk: ${report.coverage.failedRiskBlockedEntries}`,
    "",
    "## Wallet Status",
    "",
    `Observed: ${report.statusCounts.observed}`,
    `Watch: ${report.statusCounts.watch}`,
    `Candidate: ${report.statusCounts.candidate}`,
    `Validated paper: ${report.statusCounts["validated-paper"]}`,
    `Excluded: ${report.statusCounts.excluded}`,
    "",
    "## Top Wallets",
    "",
    "| Wallet | Status | Realized | Open | Days | HQ price | Reliability | Profit median | Profit hit | PF | Follow median | Follow hit | Profit score | Follow score | Overall |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.topWallets.map((score) =>
      [
        score.walletAddress,
        score.status,
        score.completedPositions,
        score.metrics.openInventoryCount ?? 0,
        score.activeDays,
        `${round((score.metrics.highQualityExecutionCoverage ?? 0) * 100)}%`,
        score.metrics.reliabilityScore ?? 0,
        `${round(score.metrics.profitability.medianReturnPct)}%`,
        `${round(score.metrics.profitability.hitRate * 100)}%`,
        round(score.metrics.profitability.profitFactor),
        `${round(score.metrics.followability.medianReturnPct)}%`,
        `${round(score.metrics.followability.hitRate * 100)}%`,
        score.profitabilityScore,
        score.followabilityScore,
        score.overallScore
      ]
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |")
    ),
    "",
    "## Live Paper Signals",
    "",
    "| Token | Status | Qualified wallets | Confidence | Entry price | Liquidity | Detected |",
    "|---|---|---:|---:|---:|---:|---|",
    ...report.livePaperSignals.map(
      (signal) =>
        `| ${signal.tokenAddress} | ${signal.status} | ${signal.walletAddresses.length} | ${signal.confidence} | ${signal.observedPriceUsd} | ${round(signal.observedLiquidityUsd)} | ${signal.detectedAt} |`
    )
  ];
  if (report.topWallets.length === 0) {
    lines.splice(lines.indexOf("## Top Wallets") + 4, 0, "No wallet has passed the watch gates.");
  }
  if (report.livePaperSignals.length === 0) {
    lines.push("", "No qualified wallet produced a current paper signal.");
  }
  return `${lines.join("\n")}\n`;
}

function partitionWalletLedger(
  ledger: WalletLedger,
  walletAddresses: string[]
): Map<string, WalletLedger> {
  const partitions = new Map<string, WalletLedger>();
  for (const walletAddress of walletAddresses) {
    partitions.set(walletAddress, {
      realizedEpisodes: [],
      openInventory: [],
      positionEpisodes: [],
      positionLots: []
    });
  }
  for (const episode of ledger.realizedEpisodes) {
    partitions.get(episode.walletAddress)?.realizedEpisodes.push(episode);
  }
  for (const inventory of ledger.openInventory) {
    partitions.get(inventory.walletAddress)?.openInventory.push(inventory);
  }
  const episodeWallets = new Map<string, string>();
  for (const episode of ledger.positionEpisodes) {
    partitions.get(episode.walletAddress)?.positionEpisodes.push(episode);
    episodeWallets.set(episode.episodeId, episode.walletAddress);
  }
  for (const lot of ledger.positionLots) {
    const walletAddress = episodeWallets.get(lot.episodeId);
    if (walletAddress) partitions.get(walletAddress)?.positionLots.push(lot);
  }
  return partitions;
}

function ledgerSnapshot(
  ledger: WalletLedger,
  chain: WalletPositionLedgerSnapshot["chain"],
  strategyVersion: string,
  generatedAt: string,
  walletAddresses: string[]
): WalletPositionLedgerSnapshot {
  const walletScope = new Set(walletAddresses);
  const episodes = ledger.positionEpisodes
    .filter((episode) => episode.chain === chain && walletScope.has(episode.walletAddress))
    .map((episode) => ({
      id: episode.episodeId,
      chain: episode.chain,
      walletAddress: episode.walletAddress,
      tokenAddress: episode.tokenAddress,
      strategyVersion: episode.strategyVersion,
      episodeIndex: episode.roundTripIndex,
      status: episode.status,
      openedAt: episode.openedAt,
      ...(episode.closedAt ? { closedAt: episode.closedAt } : {}),
      costBasisUsd: episode.costBasisUsd,
      proceedsUsd: episode.proceedsUsd,
      realizedPnlUsd: episode.realizedPnlUsd,
      ...(episode.returnPct !== undefined ? { returnPct: episode.returnPct } : {}),
      remainingRawAmount: episode.remainingBaseAmount.rawAmount,
      tokenDecimals: episode.remainingBaseAmount.decimals,
      realizedLotCount: episode.realizedLotCount,
      highQualityPriceCoverage: episode.highQualityPriceCoverage,
      metadata: episode.metadata
    }));
  const episodeIds = new Set(episodes.map((episode) => episode.id));
  const lots = ledger.positionLots
    .filter((lot) => episodeIds.has(lot.episodeId))
    .map((lot) => ({
      id: lot.lotId,
      episodeId: lot.episodeId,
      sourceEventIdempotencyKey: lot.sourceEventIdempotencyKey,
      lotSequence: lot.lotSequence,
      rawAmount: lot.rawAmount.rawAmount,
      remainingRawAmount: lot.remainingBaseAmount.rawAmount,
      tokenDecimals: lot.rawAmount.decimals,
      quoteCostUsd: lot.quoteCostUsd,
      feesUsd: lot.feesUsd,
      slippageUsd: lot.slippageUsd,
      openedAt: lot.openedAt,
      ...(lot.closedAt ? { closedAt: lot.closedAt } : {}),
      status: lot.status,
      metadata: lot.metadata
    }));
  return {
    chain,
    strategyVersion,
    generatedAt,
    walletAddresses,
    episodes,
    lots
  };
}

function decisionText(
  mode: WalletAlphaMode,
  statusCounts: Record<WalletAlphaScoreSnapshot["status"], number>,
  signalCount: number,
  pendingWallets: number
): string {
  const catchUp =
    pendingWallets > 0
      ? ` Incremental scoring catch-up still has ${pendingWallets} wallet(s) pending; this report is not yet a complete ranking snapshot.`
      : "";
  if (mode === "paper-validate candidate") {
    return `${statusCounts["validated-paper"]} wallet(s) passed realized-profitability, followability, sample, time and chronological holdout gates. ${signalCount} current paper signal(s) are available.${catchUp}`;
  }
  if (mode === "paper-watch") {
    return `${statusCounts.watch + statusCounts.candidate} wallet(s) passed at least the watch gate, but none has completed all paper-validation gates. ${signalCount} current paper signal(s) are being measured.${catchUp}`;
  }
  return `No wallet has both sufficient completed-trade profitability and bot-observed followability. Continue collecting buy/sell ledger evidence; do not treat token outcomes alone as wallet profit.${catchUp}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function boundedInt(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Math.trunc(value ?? fallback);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<unknown>
): Promise<void> {
  const batchSize = Math.max(1, Math.floor(concurrency));
  for (let index = 0; index < items.length; index += batchSize) {
    await Promise.all(items.slice(index, index + batchSize).map(task));
  }
}
