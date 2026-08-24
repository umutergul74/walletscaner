import {
  SAMPLE_POOL,
  SAMPLE_TOKEN,
  SAMPLE_WALLET_FEATURES,
  type BacktestRun,
  type ChainId,
  type HistoricalBackfillWindow,
  type HistoricalMarketObservation,
  type HypothesisRunEvidence,
  type IngestionCursorEvidence,
  type OnchainSwapEvidence,
  type PaperTrade,
  type PoolSnapshot,
  type PriceObservationEvidence,
  type ProviderStatus,
  type RuntimeThresholds,
  type Signal,
  type TokenSnapshot,
  type WalletEntrySignalEvidence,
  type WalletAlphaScoreSnapshot,
  type WalletAlphaSignalEvidence,
  type WalletSignalOutcomeEvidence,
  type WalletTradeEvidence,
  type WalletScore,
  nowIso
} from "@memecoin-alpha/shared";
import { buildSampleSignal } from "@memecoin-alpha/core";
import { scoreWallet } from "@memecoin-alpha/scoring";
import { runHistoricalReplay } from "@memecoin-alpha/backtesting";
import {
  createPaperPortfolio,
  markToMarketAndClose,
  tryOpenPaperTrade
} from "@memecoin-alpha/paper-trading";
import type {
  CanonicalChainEvent,
  CanonicalChainEventInput,
  CanonicalEventClaimOptions,
  CanonicalEventFailureOptions,
  CanonicalEventFailureResult,
  CanonicalEventStatus,
  CanonicalRepository,
  DurableSolanaSignature,
  DurableSolanaSignatureQueueSummary,
  EvidenceRepository,
  IngestionGapRepair,
  IngestionGapRepairCreateInput,
  IngestionGapRepairPageInput,
  IngestionGapRepairSignature,
  IngestionCoverageIncident,
  IngestionCoverageIncidentCloseInput,
  IngestionCoverageIncidentOpenInput,
  IntelligenceRepository,
  PipelineHealthSummary,
  PipelineWatermark,
  QuotePriceObservation,
  SignalOutboxClaimOptions,
  SignalOutboxFailureOptions,
  SignalOutboxMessage,
  SolanaFinalityBatchResult,
  SolanaFinalityResult,
  SolanaFinalityWorkItem,
  TokenRiskReport,
  WalletAlphaCoverageSummary,
  WalletAlphaAdmissionProbe,
  WalletAlphaDetail,
  WalletAlphaRankingQuery,
  WalletAlphaSignalQuery,
  WalletAlphaStatusCounts,
  WalletAlphaWorkClaimOptions,
  WalletAlphaWorkCandidate,
  WalletAlphaWorkItem,
  WalletAlphaWorkPriority,
  WalletAlphaWorkSummary,
  WalletPositionEpisode,
  WalletPositionLedgerSnapshot,
  WalletPositionLedgerWriteResult,
  WalletPositionLot
} from "./repository";
import { assertWalletPositionLedgerSnapshot, classifyWalletAlphaEntryWork } from "./repository";

interface MemoryWalletAlphaWork {
  chain: ChainId;
  walletAddress: string;
  strategyVersion: string;
  revision: number;
  completedRevision: number;
  updatedAt: string;
  notBefore: string;
  attemptCount: number;
  priority: WalletAlphaWorkPriority;
  priorityReason: string;
  pendingSince: string;
  lockedBy?: string;
  lockExpiresAt?: string;
  lastError?: string;
}

const COVERAGE_INCIDENT_REASONS = new Set([
  "head_slot_lag",
  "raw_websocket_silence",
  "subscription_ack_timeout",
  "stale_live_notification",
  "backfill_truncated",
  "source_start_failed",
  "combined"
]);

function coverageTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid timestamp.`);
  return parsed;
}

function assertCoverageIncidentOpenInput(input: IngestionCoverageIncidentOpenInput): void {
  if (input.chain !== "solana") throw new Error("Coverage incident chain must be solana.");
  if (!input.idempotencyKey.trim()) throw new Error("Coverage incident id must not be empty.");
  if (!input.provider.trim()) throw new Error("Coverage incident provider must not be empty.");
  if (!input.programAddress.trim()) {
    throw new Error("Coverage incident program address must not be empty.");
  }
  if (!COVERAGE_INCIDENT_REASONS.has(input.reason)) {
    throw new Error("Coverage incident reason is not supported.");
  }
  const gapStartedAt = coverageTimestamp(input.gapStartedAt, "Coverage gap start");
  const openedAt = coverageTimestamp(input.openedAt, "Coverage incident open time");
  if (gapStartedAt > openedAt) {
    throw new Error("Coverage incident cannot open before its gap starts.");
  }
  for (const [label, value] of [
    ["slot lag", input.slotLag],
    ["silence", input.silenceMs],
    ["subscription ACK timeout count", input.subscriptionAckTimeoutCount],
    ["successful subscription ACK count", input.successfulSubscriptionAckCount]
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`Coverage incident ${label} must be a non-negative safe integer.`);
    }
  }
  if (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata)) {
    throw new Error("Coverage incident metadata must be an object.");
  }
}

export class MemoryRepository
  implements IntelligenceRepository, EvidenceRepository, CanonicalRepository
{
  private readonly tokens = new Map<string, TokenSnapshot>();
  private readonly pools = new Map<string, PoolSnapshot>();
  private readonly signals = new Map<string, Signal>();
  private readonly walletScores = new Map<string, WalletScore>();
  private readonly tokenRisks = new Map<string, TokenRiskReport>();
  private readonly paperTrades = new Map<string, PaperTrade>();
  private readonly backtests = new Map<string, BacktestRun>();
  private readonly priceObservations = new Map<string, PriceObservationEvidence>();
  private readonly quotePriceObservations = new Map<string, QuotePriceObservation>();
  private readonly onchainSwaps = new Map<string, OnchainSwapEvidence>();
  private readonly historicalMarketObservations = new Map<string, HistoricalMarketObservation>();
  private readonly historicalBackfillWindows = new Map<string, HistoricalBackfillWindow>();
  private readonly walletEntrySignals = new Map<string, WalletEntrySignalEvidence>();
  private readonly walletTradeEvents = new Map<string, WalletTradeEvidence>();
  private readonly walletAlphaScores = new Map<string, WalletAlphaScoreSnapshot>();
  private readonly walletAlphaSignals = new Map<string, WalletAlphaSignalEvidence>();
  private readonly walletSignalOutcomes = new Map<string, WalletSignalOutcomeEvidence>();
  private readonly hypothesisRuns = new Map<string, HypothesisRunEvidence>();
  private readonly ingestionCursors = new Map<string, IngestionCursorEvidence>();
  private readonly canonicalEvents = new Map<string, CanonicalChainEvent>();
  private readonly solanaSignatureQueue = new Map<
    string,
    DurableSolanaSignature & { status: "pending" | "completed"; completedAt?: string }
  >();
  private readonly solanaFinalities = new Map<
    string,
    SolanaFinalityWorkItem & {
      status: SolanaFinalityResult["status"];
      finalizedAt?: string;
      lastError?: string;
    }
  >();
  private readonly pipelineWatermarks = new Map<string, PipelineWatermark>();
  private readonly ingestionCoverageIncidents = new Map<string, IngestionCoverageIncident>();
  private readonly ingestionGapRepairs = new Map<string, IngestionGapRepair>();
  private readonly ingestionGapRepairSignatures = new Map<
    string,
    IngestionGapRepairSignature & { status: "pending" | "completed"; completedAt?: string }
  >();
  private readonly walletPositionEpisodes = new Map<string, WalletPositionEpisode>();
  private readonly walletPositionLots = new Map<string, WalletPositionLot>();
  private readonly signalOutbox = new Map<string, SignalOutboxMessage>();
  private readonly walletAlphaWork = new Map<string, MemoryWalletAlphaWork>();
  private readonly processingResults: Array<"succeeded" | "retry" | "dead_letter"> = [];
  private providerStatus: ProviderStatus[] = [];

  private enqueueWalletAlpha(
    chain: ChainId,
    walletAddress: string,
    strategyVersion: string,
    priority: WalletAlphaWorkPriority,
    priorityReason: string
  ): void {
    const key = `${chain}:${walletAddress}:${strategyVersion}`;
    const now = nowIso();
    const existing = this.walletAlphaWork.get(key);
    const wasPending = Boolean(existing && existing.revision > existing.completedRevision);
    const nextPriority = (
      wasPending ? Math.max(existing?.priority ?? 0, priority) : priority
    ) as WalletAlphaWorkPriority;
    const nextPriorityReason =
      wasPending && existing && priority < existing.priority
        ? existing.priorityReason
        : priorityReason;
    this.walletAlphaWork.set(key, {
      chain,
      walletAddress,
      strategyVersion,
      revision: (existing?.revision ?? 0) + 1,
      completedRevision: existing?.completedRevision ?? 0,
      updatedAt: now,
      notBefore: now,
      attemptCount: existing?.attemptCount ?? 0,
      priority: nextPriority,
      priorityReason: nextPriorityReason,
      pendingSince: wasPending ? (existing?.pendingSince ?? now) : now,
      ...(existing?.lockedBy ? { lockedBy: existing.lockedBy } : {}),
      ...(existing?.lockExpiresAt ? { lockExpiresAt: existing.lockExpiresAt } : {}),
      ...(existing?.lastError ? { lastError: existing.lastError } : {})
    });
  }

  static seeded(thresholds: RuntimeThresholds): MemoryRepository {
    const repo = new MemoryRepository();
    const signal = buildSampleSignal(thresholds);
    const walletScores = SAMPLE_WALLET_FEATURES.map((features) => scoreWallet(features));

    repo.tokens.set(tokenKey(SAMPLE_TOKEN.chain, SAMPLE_TOKEN.address), SAMPLE_TOKEN);
    repo.pools.set(poolKey(SAMPLE_POOL.chain, SAMPLE_POOL.poolAddress), SAMPLE_POOL);
    repo.signals.set(signal.id, signal);
    for (const wallet of walletScores) {
      repo.walletScores.set(wallet.walletAddress, wallet);
    }
    const paperSignal = { ...signal, actionCategory: "paper-trade candidate" as const };
    const portfolio = createPaperPortfolio(10_000, signal.strategyVersion);
    const opened = tryOpenPaperTrade(
      portfolio,
      { signal: paperSignal, priceUsd: 0.00042 },
      thresholds
    );
    if (opened.status === "open") {
      const closed = markToMarketAndClose(portfolio, opened.id, 0.00088, thresholds);
      if (closed) repo.paperTrades.set(closed.id, closed);
    }

    const baseTime = new Date(signal.detectedAt).getTime();
    const backtest = runHistoricalReplay(
      [paperSignal],
      [
        {
          tokenAddress: signal.tokenAddress,
          observedAt: new Date(baseTime + 1_000).toISOString(),
          priceUsd: 0.00042,
          liquidityUsd: 48_250
        },
        {
          tokenAddress: signal.tokenAddress,
          observedAt: new Date(baseTime + 75_000).toISOString(),
          priceUsd: 0.00092,
          liquidityUsd: 69_000
        }
      ],
      {
        strategyVersion: signal.strategyVersion,
        startingBalanceUsd: 10_000,
        positionSizeUsd: thresholds.paperPositionSizeUsd,
        maxOpenPositions: thresholds.maxOpenPaperPositions,
        feeBps: 30,
        slippageBps: 100,
        providerLatencyMs: 1_000,
        failedFillRate: 0,
        stopLossPercent: thresholds.stopLossPercent,
        takeProfitPercent: thresholds.takeProfitPercent,
        timeExitMinutes: thresholds.timeExitMinutes,
        minimumLiquidityUsd: thresholds.minimumLiquidityUsd
      }
    );
    repo.backtests.set(backtest.id, backtest);

    repo.providerStatus = [
      {
        provider: "dexscreener",
        chain: "solana",
        status: "ok",
        checkedAt: nowIso(),
        latencyMs: 0,
        message: "Sample mode ready; public polling can be enabled from the worker."
      },
      {
        provider: "helius",
        chain: "solana",
        status: "not_configured",
        checkedAt: nowIso(),
        message: "Set HELIUS_API_KEY and a public HTTPS webhook URL for enhanced live events."
      }
    ];

    return repo;
  }

  async upsertToken(token: TokenSnapshot): Promise<void> {
    this.tokens.set(tokenKey(token.chain, token.address), token);
  }

  async upsertPool(pool: PoolSnapshot): Promise<void> {
    this.pools.set(poolKey(pool.chain, pool.poolAddress), pool);
  }

  async saveSignal(signal: Signal): Promise<void> {
    this.signals.set(signal.id, signal);
  }

  async saveWalletScore(score: WalletScore): Promise<void> {
    this.walletScores.set(score.walletAddress, score);
  }

  async saveTokenRisk(report: TokenRiskReport): Promise<void> {
    this.tokenRisks.set(tokenKey(report.chain, report.tokenAddress), report);
  }

  async savePaperTrade(trade: PaperTrade): Promise<void> {
    this.paperTrades.set(trade.id, trade);
  }

  async saveBacktestRun(run: BacktestRun): Promise<void> {
    this.backtests.set(run.id, run);
  }

  async listRecentTokens(limit = 50): Promise<TokenSnapshot[]> {
    return [...this.tokens.values()]
      .sort((a, b) => new Date(b.firstSeenAt).getTime() - new Date(a.firstSeenAt).getTime())
      .slice(0, limit);
  }

  async listTokenCreatorAddresses(): Promise<string[]> {
    return [
      ...new Set(
        [...this.tokens.values()]
          .map((token) => token.creatorAddress)
          .filter((address): address is string => Boolean(address?.trim()))
      )
    ];
  }

  async listMatchingTokenCreatorAddresses(walletAddresses: string[]): Promise<string[]> {
    if (walletAddresses.length === 0) return [];
    const requested = new Set(walletAddresses);
    return (await this.listTokenCreatorAddresses()).filter((address) => requested.has(address));
  }

  async listRecentPools(limit = 1_000): Promise<PoolSnapshot[]> {
    return [...this.pools.values()]
      .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime())
      .slice(0, limit);
  }

  async getPool(chain: ChainId, poolAddress: string): Promise<PoolSnapshot | undefined> {
    return this.pools.get(poolKey(chain, poolAddress));
  }

  async getToken(chain: ChainId, address: string): Promise<TokenSnapshot | undefined> {
    return this.tokens.get(tokenKey(chain, address));
  }

  async getTokenRisk(chain: ChainId, address: string): Promise<TokenRiskReport | undefined> {
    return this.tokenRisks.get(tokenKey(chain, address));
  }

  async listSignals(limit = 100): Promise<Signal[]> {
    return [...this.signals.values()]
      .sort((a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime())
      .slice(0, limit);
  }

  async listWalletRankings(limit = 100): Promise<WalletScore[]> {
    return [...this.walletScores.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async getWallet(address: string): Promise<WalletScore | undefined> {
    return this.walletScores.get(address);
  }

  async listPaperTrades(limit = 100): Promise<PaperTrade[]> {
    return [...this.paperTrades.values()]
      .sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime())
      .slice(0, limit);
  }

  async listBacktestRuns(limit = 25): Promise<BacktestRun[]> {
    return [...this.backtests.values()]
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .slice(0, limit);
  }

  async listProviderStatus(): Promise<ProviderStatus[]> {
    return this.providerStatus;
  }

  async savePriceObservation(observation: PriceObservationEvidence): Promise<boolean> {
    if (this.priceObservations.has(observation.idempotencyKey)) return false;
    this.priceObservations.set(observation.idempotencyKey, observation);
    return true;
  }

  async saveQuotePriceObservation(observation: QuotePriceObservation): Promise<boolean> {
    const conflicts = [...this.quotePriceObservations.values()].filter(
      (stored) =>
        stored.idempotencyKey === observation.idempotencyKey ||
        (stored.source === observation.source &&
          stored.quoteTokenAddress === observation.quoteTokenAddress &&
          new Date(stored.publishTime).getTime() === new Date(observation.publishTime).getTime())
    );
    if (conflicts.length > 0) {
      if (conflicts.length === 1 && quotePriceEvidenceMatches(conflicts[0]!, observation)) {
        return false;
      }
      throw new Error("Quote price observation conflicts with stored immutable evidence.");
    }
    this.quotePriceObservations.set(observation.idempotencyKey, observation);
    return true;
  }

  async findQuotePriceObservationNear(
    chain: QuotePriceObservation["chain"],
    quoteTokenAddress: string,
    publishTime: string,
    maxDistanceSeconds = 60
  ): Promise<QuotePriceObservation | undefined> {
    const targetMs = new Date(publishTime).getTime();
    const maxDistanceMs = Math.max(1, maxDistanceSeconds) * 1_000;
    return [...this.quotePriceObservations.values()]
      .filter(
        (observation) =>
          observation.chain === chain && observation.quoteTokenAddress === quoteTokenAddress
      )
      .map((observation) => ({
        observation,
        distanceMs: Math.abs(new Date(observation.publishTime).getTime() - targetMs)
      }))
      .filter(({ distanceMs }) => distanceMs <= maxDistanceMs)
      .sort(
        (a, b) =>
          a.distanceMs - b.distanceMs ||
          new Date(b.observation.publishTime).getTime() -
            new Date(a.observation.publishTime).getTime()
      )[0]?.observation;
  }

  async saveOnchainSwap(swap: OnchainSwapEvidence): Promise<boolean> {
    if (this.onchainSwaps.has(swap.idempotencyKey)) return false;
    this.onchainSwaps.set(swap.idempotencyKey, swap);
    return true;
  }

  async saveHistoricalMarketObservation(
    observation: HistoricalMarketObservation
  ): Promise<boolean> {
    if (this.historicalMarketObservations.has(observation.idempotencyKey)) return false;
    this.historicalMarketObservations.set(observation.idempotencyKey, observation);
    return true;
  }

  async getHistoricalBackfillWindow(
    runId: string,
    stage: HistoricalBackfillWindow["stage"],
    address: string,
    windowStartUnix: number,
    windowEndUnix: number
  ): Promise<HistoricalBackfillWindow | undefined> {
    return this.historicalBackfillWindows.get(
      historicalWindowKey(runId, stage, address, windowStartUnix, windowEndUnix)
    );
  }

  async upsertHistoricalBackfillWindow(window: HistoricalBackfillWindow): Promise<void> {
    this.historicalBackfillWindows.set(
      historicalWindowKey(
        window.runId,
        window.stage,
        window.address,
        window.windowStartUnix,
        window.windowEndUnix
      ),
      window
    );
  }

  async getHistoricalBackfillWindowSummary(runId: string): Promise<{
    completed: number;
    saturated: number;
    running: number;
    error: number;
  }> {
    const statuses = [...this.historicalBackfillWindows.values()]
      .filter((window) => window.runId === runId)
      .map((window) => window.status);
    return {
      completed: statuses.filter((status) => status === "completed").length,
      saturated: statuses.filter((status) => status === "saturated").length,
      running: statuses.filter((status) => status === "running").length,
      error: statuses.filter((status) => status === "error").length
    };
  }

  async getHistoricalBackfillRequestCount(runId: string): Promise<number> {
    return [...this.historicalBackfillWindows.values()]
      .filter((window) => window.runId === runId)
      .reduce((sum, window) => sum + window.pagesFetched, 0);
  }

  async materializeHistoricalMarketBuckets(): Promise<number> {
    return this.historicalMarketObservations.size;
  }

  async materializeHistoricalWalletFlowEvidence(): Promise<number> {
    return 0;
  }

  async saveWalletEntrySignal(signal: WalletEntrySignalEvidence): Promise<boolean> {
    const existingEntry = [...this.walletEntrySignals.values()].find(
      (existing) =>
        existing.chain === signal.chain &&
        existing.walletAddress === signal.walletAddress &&
        existing.tokenAddress === signal.tokenAddress &&
        existing.strategyVersion === signal.strategyVersion
    );
    if (existingEntry) {
      const promotesExploratoryEntry =
        !existingEntry.sourceSwapIdempotencyKey?.trim() &&
        Boolean(signal.sourceSwapIdempotencyKey?.trim());
      if (!promotesExploratoryEntry) return false;

      for (const [key, outcome] of this.walletSignalOutcomes) {
        if (outcome.entryIdempotencyKey === existingEntry.idempotencyKey) {
          this.walletSignalOutcomes.delete(key);
        }
      }
      this.walletEntrySignals.set(existingEntry.idempotencyKey, {
        ...signal,
        idempotencyKey: existingEntry.idempotencyKey
      });
      const work = classifyWalletAlphaEntryWork(signal);
      this.enqueueWalletAlpha(
        signal.chain,
        signal.walletAddress,
        signal.strategyVersion,
        work.priority,
        work.reason
      );
      return true;
    }
    if (this.walletEntrySignals.has(signal.idempotencyKey)) return false;
    this.walletEntrySignals.set(signal.idempotencyKey, signal);
    const work = classifyWalletAlphaEntryWork(signal);
    this.enqueueWalletAlpha(
      signal.chain,
      signal.walletAddress,
      signal.strategyVersion,
      work.priority,
      work.reason
    );
    return true;
  }

  async saveWalletTradeEvent(trade: WalletTradeEvidence): Promise<boolean> {
    const existing = this.walletTradeEvents.get(trade.idempotencyKey);
    if (existing) {
      if (!existing.executionPriceUsd && trade.executionPriceUsd) {
        this.walletTradeEvents.set(trade.idempotencyKey, { ...existing, ...trade });
        this.enqueueWalletAlpha(
          trade.chain,
          trade.walletAddress,
          trade.strategyVersion,
          trade.side === "sell" ? 1 : 0,
          trade.side === "sell" ? "sell-trade" : "buy-trade"
        );
        return true;
      }
      return false;
    }
    this.walletTradeEvents.set(trade.idempotencyKey, trade);
    this.enqueueWalletAlpha(
      trade.chain,
      trade.walletAddress,
      trade.strategyVersion,
      trade.side === "sell" ? 1 : 0,
      trade.side === "sell" ? "sell-trade" : "buy-trade"
    );
    return true;
  }

  async enrichWalletTradePrices(observation: PriceObservationEvidence): Promise<number> {
    let updated = 0;
    const observedAt = new Date(observation.observedAt).getTime();
    for (const [key, trade] of this.walletTradeEvents) {
      const tradeAt = new Date(trade.observedAt).getTime();
      if (
        trade.tokenAddress !== observation.tokenAddress ||
        trade.executionPriceUsd ||
        tradeAt > observedAt ||
        observedAt - tradeAt > 5 * 60_000
      ) {
        continue;
      }
      this.walletTradeEvents.set(key, {
        ...trade,
        executionPriceUsd: observation.priceUsd,
        quoteValueUsd: trade.baseAmount * observation.priceUsd,
        dataQuality: "price-proxy",
        raw: {
          ...trade.raw,
          priceEvidence: {
            quality: "market-proxy",
            contextKey: observation.idempotencyKey,
            provider: observation.provider,
            signature: observation.signature,
            observedAt: observation.observedAt,
            poolAddress: observation.poolAddress,
            priceUsd: observation.priceUsd,
            liquidityUsd: observation.liquidityUsd
          }
        }
      });
      this.enqueueWalletAlpha(
        trade.chain,
        trade.walletAddress,
        trade.strategyVersion,
        0,
        "price-enrichment"
      );
      updated += 1;
    }
    return updated;
  }

  async materializeHistoricalWalletTrades(): Promise<number> {
    return 0;
  }

  async saveWalletAlphaScore(score: WalletAlphaScoreSnapshot): Promise<void> {
    const key = `${score.chain}:${score.walletAddress}:${score.strategyVersion}:${score.calculatedAt}`;
    this.walletAlphaScores.set(key, score);
  }

  async replaceWalletPositionLedger(
    snapshot: WalletPositionLedgerSnapshot
  ): Promise<WalletPositionLedgerWriteResult> {
    assertWalletPositionLedgerSnapshot(snapshot);
    const nextEpisodes = new Map(this.walletPositionEpisodes);
    const nextLots = new Map(this.walletPositionLots);
    const walletScope = snapshot.walletAddresses ? new Set(snapshot.walletAddresses) : undefined;
    const inScopeEpisodeIds = new Set(
      [...nextEpisodes.values()]
        .filter(
          (episode) =>
            episode.chain === snapshot.chain &&
            episode.strategyVersion === snapshot.strategyVersion &&
            (!walletScope || walletScope.has(episode.walletAddress))
        )
        .map((episode) => episode.id)
    );
    for (const [id, lot] of nextLots) {
      if (inScopeEpisodeIds.has(lot.episodeId)) nextLots.delete(id);
    }
    for (const id of inScopeEpisodeIds) nextEpisodes.delete(id);
    for (const episode of snapshot.episodes) nextEpisodes.set(episode.id, structuredClone(episode));
    for (const lot of snapshot.lots) nextLots.set(lot.id, structuredClone(lot));
    this.walletPositionEpisodes.clear();
    this.walletPositionLots.clear();
    for (const [id, episode] of nextEpisodes) this.walletPositionEpisodes.set(id, episode);
    for (const [id, lot] of nextLots) this.walletPositionLots.set(id, lot);
    return { episodeCount: snapshot.episodes.length, lotCount: snapshot.lots.length };
  }

  async claimWalletAlphaWork(options: WalletAlphaWorkClaimOptions): Promise<WalletAlphaWorkItem[]> {
    const now = Date.now();
    const limit = clampLimit(options.limit, 100, 1_000);
    const leaseSeconds = clampLimit(options.leaseSeconds, 300, 3_600);
    return [...this.walletAlphaWork.values()]
      .filter((work) => work.strategyVersion === options.strategyVersion)
      .filter((work) => work.revision > work.completedRevision)
      .filter((work) => work.priority >= (options.minimumPriority ?? 0))
      .filter((work) => work.priority <= (options.maximumPriority ?? 2))
      .filter((work) => new Date(work.notBefore).getTime() <= now)
      .filter((work) => !work.lockExpiresAt || new Date(work.lockExpiresAt).getTime() <= now)
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          new Date(a.notBefore).getTime() - new Date(b.notBefore).getTime() ||
          new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime() ||
          a.walletAddress.localeCompare(b.walletAddress)
      )
      .slice(0, limit)
      .map((work) => {
        work.lockedBy = options.workerId;
        work.lockExpiresAt = new Date(now + leaseSeconds * 1_000).toISOString();
        work.attemptCount += 1;
        return {
          chain: work.chain,
          walletAddress: work.walletAddress,
          strategyVersion: work.strategyVersion,
          revision: work.revision,
          attemptCount: work.attemptCount,
          lockedBy: options.workerId,
          lockExpiresAt: work.lockExpiresAt,
          priority: work.priority,
          priorityReason: work.priorityReason,
          pendingSince: work.pendingSince
        };
      });
  }

  async listWalletAlphaWorkCandidates(
    strategyVersion: string,
    limit = 100,
    priorities: Pick<WalletAlphaWorkClaimOptions, "minimumPriority" | "maximumPriority"> = {}
  ): Promise<WalletAlphaWorkCandidate[]> {
    const now = Date.now();
    return [...this.walletAlphaWork.values()]
      .filter((work) => work.strategyVersion === strategyVersion)
      .filter((work) => work.revision > work.completedRevision)
      .filter((work) => work.priority >= (priorities.minimumPriority ?? 0))
      .filter((work) => work.priority <= (priorities.maximumPriority ?? 2))
      .filter((work) => new Date(work.notBefore).getTime() <= now)
      .filter((work) => !work.lockExpiresAt || new Date(work.lockExpiresAt).getTime() <= now)
      .sort(
        (a, b) =>
          b.priority - a.priority ||
          new Date(a.notBefore).getTime() - new Date(b.notBefore).getTime() ||
          new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime() ||
          a.walletAddress.localeCompare(b.walletAddress)
      )
      .slice(0, clampLimit(limit, 100, 100))
      .map(
        ({
          chain,
          walletAddress,
          strategyVersion: workStrategyVersion,
          revision,
          priority,
          pendingSince
        }) => ({
          chain,
          walletAddress,
          strategyVersion: workStrategyVersion,
          revision,
          priority,
          pendingSince
        })
      );
  }

  async probeWalletAlphaAdmission(
    candidates: WalletAlphaWorkCandidate[],
    minEntryObservedAt: string,
    minimumTradeEvents: number,
    minimumEntries: number
  ): Promise<WalletAlphaAdmissionProbe[]> {
    if (candidates.length > 100) {
      throw new Error("Wallet-alpha admission probe exceeds the 100-wallet ceiling.");
    }
    const tradeThreshold = clampLimit(minimumTradeEvents, 1, 100);
    const entryThreshold = clampLimit(minimumEntries, 1, 100);
    const minimumEntryTime = new Date(minEntryObservedAt).getTime();
    return candidates.map((candidate) => ({
      ...candidate,
      tradeEventCount: Math.min(
        tradeThreshold,
        [...this.walletTradeEvents.values()].filter(
          (trade) =>
            trade.walletAddress === candidate.walletAddress &&
            trade.strategyVersion === candidate.strategyVersion
        ).length
      ),
      entryCount: Math.min(
        entryThreshold,
        [...this.walletEntrySignals.values()].filter(
          (entry) =>
            entry.walletAddress === candidate.walletAddress &&
            entry.strategyVersion === candidate.strategyVersion &&
            new Date(entry.observedAt).getTime() >= minimumEntryTime
        ).length
      )
    }));
  }

  async completeWalletAlphaWork(item: WalletAlphaWorkItem): Promise<boolean> {
    const work = this.walletAlphaWork.get(
      `${item.chain}:${item.walletAddress}:${item.strategyVersion}`
    );
    if (!work || work.lockedBy !== item.lockedBy) return false;
    work.completedRevision = Math.max(work.completedRevision, item.revision);
    if (work.revision <= item.revision) {
      work.priority = 0;
      work.priorityReason = "completed";
      work.pendingSince = nowIso();
    }
    work.attemptCount = 0;
    delete work.lockedBy;
    delete work.lockExpiresAt;
    delete work.lastError;
    return true;
  }

  async failWalletAlphaWork(
    item: WalletAlphaWorkItem,
    error: string,
    retrySeconds = 300
  ): Promise<boolean> {
    const work = this.walletAlphaWork.get(
      `${item.chain}:${item.walletAddress}:${item.strategyVersion}`
    );
    if (!work || work.lockedBy !== item.lockedBy) return false;
    work.notBefore = new Date(Date.now() + Math.max(1, retrySeconds) * 1_000).toISOString();
    work.lastError = error.slice(0, 4_000);
    delete work.lockedBy;
    delete work.lockExpiresAt;
    return true;
  }

  async getWalletAlphaWorkSummary(strategyVersion: string): Promise<WalletAlphaWorkSummary> {
    const now = Date.now();
    const pending = [...this.walletAlphaWork.values()].filter(
      (work) => work.strategyVersion === strategyVersion && work.revision > work.completedRevision
    );
    const signalPending = pending.filter((work) => work.priority === 2);
    const oldestPendingAt = earliestIso(pending.map((work) => work.pendingSince));
    const oldestSignalPendingAt = earliestIso(signalPending.map((work) => work.pendingSince));
    return {
      pending: pending.length,
      processing: pending.filter(
        (work) => work.lockExpiresAt && new Date(work.lockExpiresAt).getTime() > now
      ).length,
      failed: pending.filter((work) => Boolean(work.lastError)).length,
      backgroundPending: pending.filter((work) => work.priority === 0).length,
      elevatedPending: pending.filter((work) => work.priority === 1).length,
      signalPending: signalPending.length,
      ...(oldestPendingAt ? { oldestPendingAt } : {}),
      ...(oldestSignalPendingAt ? { oldestSignalPendingAt } : {})
    };
  }

  async getWalletAlphaStatusCounts(strategyVersion: string): Promise<WalletAlphaStatusCounts> {
    const scores = latestWalletAlphaScores(this.walletAlphaScores.values(), strategyVersion);
    return {
      insufficient: scores.filter((score) => score.status === "insufficient").length,
      observed: scores.filter((score) => score.status === "observed").length,
      watch: scores.filter((score) => score.status === "watch").length,
      candidate: scores.filter((score) => score.status === "candidate").length,
      "validated-paper": scores.filter((score) => score.status === "validated-paper").length,
      excluded: scores.filter((score) => score.status === "excluded").length
    };
  }

  async getWalletAlphaCoverageSummary(
    strategyVersion: string,
    minObservedAt: string
  ): Promise<WalletAlphaCoverageSummary> {
    const minimum = new Date(minObservedAt).getTime();
    const trades = [...this.walletTradeEvents.values()].filter(
      (trade) =>
        trade.strategyVersion === strategyVersion && new Date(trade.observedAt).getTime() >= minimum
    );
    const entries = [...this.walletEntrySignals.values()].filter(
      (entry) =>
        entry.strategyVersion === strategyVersion && new Date(entry.observedAt).getTime() >= minimum
    );
    const outcomes = [...this.walletSignalOutcomes.values()].filter(
      (outcome) =>
        outcome.strategyVersion === strategyVersion &&
        new Date(outcome.observedAt).getTime() >= minimum
    );
    const sourceLinked = entries.filter((entry) => Boolean(entry.sourceSwapIdempotencyKey?.trim()));
    const eligible = sourceLinked.filter((entry) => entry.cohort !== "excluded-uncontrolled-flow");
    const sourceLinkedKeys = new Set(sourceLinked.map((entry) => entry.idempotencyKey));
    const eligibleKeys = new Set(eligible.map((entry) => entry.idempotencyKey));
    const mature = outcomes.filter(
      (outcome) =>
        outcome.status === "mature" &&
        outcome.exitStrategy === "fixed-horizon" &&
        sourceLinkedKeys.has(outcome.entryIdempotencyKey)
    );
    const latestScores = latestWalletAlphaScores(this.walletAlphaScores.values(), strategyVersion);
    const priced = trades.filter(
      (trade) => Number(trade.executionPriceUsd ?? trade.quoteValueUsd ?? 0) > 0
    );
    return {
      tradeEvents: trades.length,
      buyEvents: trades.filter((trade) => trade.side === "buy").length,
      sellEvents: trades.filter((trade) => trade.side === "sell").length,
      pricedEvents: priced.length,
      highQualityPricedEvents: priced.filter((trade) =>
        ["observed-execution", "oracle-converted", "historical-observed"].includes(
          trade.priceQuality ?? trade.dataQuality
        )
      ).length,
      walletsSeen: new Set([
        ...trades.map((trade) => trade.walletAddress),
        ...entries.map((entry) => entry.walletAddress)
      ]).size,
      completedPositions: latestScores.reduce((sum, score) => sum + score.completedPositions, 0),
      openInventories: latestScores.reduce(
        (sum, score) => sum + (score.metrics.openInventoryCount ?? 0),
        0
      ),
      sourceLinkedFollowerEntries: sourceLinked.length,
      eligibleSourceLinkedFollowerEntries: eligible.length,
      excludedUncontrolledFlowEntries: sourceLinked.length - eligible.length,
      matureFollowerOutcomes: mature.length,
      eligibleMatureFollowerOutcomes: mature.filter((outcome) =>
        eligibleKeys.has(outcome.entryIdempotencyKey)
      ).length,
      riskPassedEntries: eligible.filter(
        (entry) =>
          entry.flowEvidence.tokenRiskKnown === true && entry.flowEvidence.tokenRiskPassed === true
      ).length,
      unknownRiskBlockedEntries: eligible.filter(
        (entry) => entry.flowEvidence.tokenRiskKnown !== true
      ).length,
      failedRiskBlockedEntries: eligible.filter(
        (entry) =>
          entry.flowEvidence.tokenRiskKnown === true && entry.flowEvidence.tokenRiskPassed !== true
      ).length
    };
  }

  async saveWalletAlphaSignal(signal: WalletAlphaSignalEvidence): Promise<boolean> {
    const key = `${signal.strategyVersion}:${signal.tokenAddress}`;
    if (this.walletAlphaSignals.has(key)) return false;
    this.walletAlphaSignals.set(key, signal);
    const createdAt = nowIso();
    for (const destination of ["paper", "alert"] as const) {
      const id = `${signal.id}:${destination}`;
      this.signalOutbox.set(id, {
        id,
        signalId: signal.id,
        destination,
        eventType: "wallet-alpha-signal",
        payload: signal as unknown as Record<string, unknown>,
        status: "pending",
        attemptCount: 0,
        availableAt: createdAt,
        createdAt
      });
    }
    return true;
  }

  async saveWalletSignalOutcome(outcome: WalletSignalOutcomeEvidence): Promise<boolean> {
    const existingEntry = [...this.walletSignalOutcomes.entries()].find(
      ([, existing]) =>
        existing.entryIdempotencyKey === outcome.entryIdempotencyKey &&
        existing.horizonMinutes === outcome.horizonMinutes &&
        existing.exitStrategy === outcome.exitStrategy &&
        existing.strategyVersion === outcome.strategyVersion
    );
    if (existingEntry) {
      const statusOrder = { provisional: 0, unresolved: 1, mature: 2 } as const;
      if (statusOrder[outcome.status] <= statusOrder[existingEntry[1].status]) return false;
      this.walletSignalOutcomes.delete(existingEntry[0]);
    }
    this.walletSignalOutcomes.set(outcome.idempotencyKey, outcome);
    const entry = this.walletEntrySignals.get(outcome.entryIdempotencyKey);
    if (entry) {
      this.enqueueWalletAlpha(
        entry.chain,
        entry.walletAddress,
        outcome.strategyVersion,
        1,
        "signal-outcome"
      );
    }
    return true;
  }

  async saveWalletSignalOutcomes(outcomes: WalletSignalOutcomeEvidence[]): Promise<number> {
    let changed = 0;
    for (const outcome of outcomes) {
      if (await this.saveWalletSignalOutcome(outcome)) changed += 1;
    }
    return changed;
  }

  async saveHypothesisRun(run: HypothesisRunEvidence): Promise<boolean> {
    if (
      this.hypothesisRuns.has(run.idempotencyKey) ||
      [...this.hypothesisRuns.values()].some((existing) => existing.runId === run.runId)
    ) {
      return false;
    }
    this.hypothesisRuns.set(run.idempotencyKey, run);
    return true;
  }

  async upsertIngestionCursor(cursor: IngestionCursorEvidence): Promise<void> {
    const key = `${cursor.source}:${cursor.address}`;
    const existing = this.ingestionCursors.get(key);
    if (!existing || cursor.lastSlot >= existing.lastSlot) {
      this.ingestionCursors.set(key, cursor);
    }
  }

  async getIngestionCursor(
    source: string,
    address: string
  ): Promise<IngestionCursorEvidence | undefined> {
    return this.ingestionCursors.get(`${source}:${address}`);
  }

  async listPriceObservations(
    tokenAddress?: string,
    strategyVersion?: string,
    minObservedAt?: string
  ): Promise<PriceObservationEvidence[]> {
    return [...this.priceObservations.values()]
      .filter((observation) => !tokenAddress || observation.tokenAddress === tokenAddress)
      .filter((observation) => !strategyVersion || observation.strategyVersion === strategyVersion)
      .filter(
        (observation) =>
          !minObservedAt ||
          new Date(observation.observedAt).getTime() >= new Date(minObservedAt).getTime()
      )
      .sort(compareObservedAt);
  }

  async listPendingOnchainBuySwaps(
    tokenAddress?: string,
    limit = 250
  ): Promise<OnchainSwapEvidence[]> {
    const materializedWalletTokens = new Set(
      [...this.walletEntrySignals.values()]
        .filter((signal) => Boolean(signal.sourceSwapIdempotencyKey))
        .map((signal) =>
          walletTokenStrategyKey(
            signal.chain,
            signal.walletAddress,
            signal.tokenAddress,
            signal.strategyVersion
          )
        )
    );
    const firstPendingByWalletToken = new Map<string, OnchainSwapEvidence>();
    for (const swap of [...this.onchainSwaps.values()].sort(compareObservedAt)) {
      if (tokenAddress && swap.outputTokenAddress !== tokenAddress) continue;
      const key = walletTokenStrategyKey(
        swap.chain,
        swap.traderAddress,
        swap.outputTokenAddress,
        swap.strategyVersion
      );
      if (materializedWalletTokens.has(key) || firstPendingByWalletToken.has(key)) continue;
      firstPendingByWalletToken.set(key, swap);
    }
    return [...firstPendingByWalletToken.values()].slice(0, clampLimit(limit, 250, 1_000));
  }

  async countPriorWalletEntryTokens(
    walletAddress: string,
    beforeObservedAt: string,
    strategyVersion: string
  ): Promise<number> {
    const beforeTime = new Date(beforeObservedAt).getTime();
    return new Set(
      [...this.walletEntrySignals.values()]
        .filter(
          (signal) =>
            signal.walletAddress === walletAddress &&
            signal.strategyVersion === strategyVersion &&
            new Date(signal.observedAt).getTime() < beforeTime
        )
        .map((signal) => signal.tokenAddress)
    ).size;
  }

  async listWalletEntrySignals(
    walletAddress?: string,
    strategyVersion?: string,
    minObservedAt?: string
  ): Promise<WalletEntrySignalEvidence[]> {
    return [...this.walletEntrySignals.values()]
      .filter((signal) => !walletAddress || signal.walletAddress === walletAddress)
      .filter((signal) => !strategyVersion || signal.strategyVersion === strategyVersion)
      .filter(
        (signal) =>
          !minObservedAt ||
          new Date(signal.observedAt).getTime() >= new Date(minObservedAt).getTime()
      )
      .sort(compareObservedAt);
  }

  async listWalletEntrySignalsForWallets(
    walletAddresses: string[],
    strategyVersion: string,
    minObservedAt?: string,
    maxRows?: number
  ): Promise<WalletEntrySignalEvidence[]> {
    const wallets = new Set(walletAddresses);
    const minimum = minObservedAt ? new Date(minObservedAt).getTime() : Number.NEGATIVE_INFINITY;
    return [...this.walletEntrySignals.values()]
      .filter(
        (entry) =>
          wallets.has(entry.walletAddress) &&
          entry.strategyVersion === strategyVersion &&
          new Date(entry.observedAt).getTime() >= minimum
      )
      .sort(compareObservedAt)
      .slice(0, maxRows ?? Number.POSITIVE_INFINITY);
  }

  async listWalletTradeEvents(
    walletAddress?: string,
    strategyVersion?: string,
    minObservedAt?: string
  ): Promise<WalletTradeEvidence[]> {
    const minimum = minObservedAt ? new Date(minObservedAt).getTime() : Number.NEGATIVE_INFINITY;
    return [...this.walletTradeEvents.values()]
      .filter((trade) => !walletAddress || trade.walletAddress === walletAddress)
      .filter((trade) => !strategyVersion || trade.strategyVersion === strategyVersion)
      .filter((trade) => new Date(trade.observedAt).getTime() >= minimum)
      .sort((a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime());
  }

  async listWalletTradeEventsForWallets(
    walletAddresses: string[],
    strategyVersion: string,
    minObservedAt?: string,
    maxRows?: number
  ): Promise<WalletTradeEvidence[]> {
    const wallets = new Set(walletAddresses);
    const minimum = minObservedAt ? new Date(minObservedAt).getTime() : Number.NEGATIVE_INFINITY;
    return [...this.walletTradeEvents.values()]
      .filter(
        (trade) =>
          wallets.has(trade.walletAddress) &&
          trade.strategyVersion === strategyVersion &&
          new Date(trade.observedAt).getTime() >= minimum
      )
      .sort(compareObservedAt)
      .slice(0, maxRows ?? Number.POSITIVE_INFINITY);
  }

  async listWalletAlphaScores(
    strategyVersion?: string,
    limit = 100
  ): Promise<WalletAlphaScoreSnapshot[]> {
    return latestWalletAlphaScores(this.walletAlphaScores.values(), strategyVersion)
      .sort(
        (a, b) =>
          walletAlphaStatusRank(b.status) - walletAlphaStatusRank(a.status) ||
          b.overallScore - a.overallScore ||
          b.completedPositions - a.completedPositions ||
          a.walletAddress.localeCompare(b.walletAddress)
      )
      .slice(0, limit);
  }

  async listWalletAlphaSignals(
    strategyVersion?: string,
    limit = 100
  ): Promise<WalletAlphaSignalEvidence[]> {
    return [...this.walletAlphaSignals.values()]
      .filter((signal) => !strategyVersion || signal.strategyVersion === strategyVersion)
      .sort((a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime())
      .slice(0, limit);
  }

  async listWalletSignalOutcomes(
    status?: WalletSignalOutcomeEvidence["status"],
    strategyVersion?: string,
    minObservedAt?: string
  ): Promise<WalletSignalOutcomeEvidence[]> {
    return [...this.walletSignalOutcomes.values()]
      .filter((outcome) => !status || outcome.status === status)
      .filter((outcome) => !strategyVersion || outcome.strategyVersion === strategyVersion)
      .filter(
        (outcome) =>
          !minObservedAt ||
          new Date(outcome.observedAt).getTime() >= new Date(minObservedAt).getTime()
      )
      .sort(compareObservedAt);
  }

  async listWalletSignalOutcomesForWallets(
    walletAddresses: string[],
    strategyVersion: string,
    minObservedAt?: string,
    maxRows?: number
  ): Promise<WalletSignalOutcomeEvidence[]> {
    const wallets = new Set(walletAddresses);
    const entryKeys = new Set(
      [...this.walletEntrySignals.values()]
        .filter(
          (entry) => wallets.has(entry.walletAddress) && entry.strategyVersion === strategyVersion
        )
        .map((entry) => entry.idempotencyKey)
    );
    const minimum = minObservedAt ? new Date(minObservedAt).getTime() : Number.NEGATIVE_INFINITY;
    return [...this.walletSignalOutcomes.values()]
      .filter(
        (outcome) =>
          entryKeys.has(outcome.entryIdempotencyKey) &&
          outcome.strategyVersion === strategyVersion &&
          new Date(outcome.observedAt).getTime() >= minimum
      )
      .sort(compareObservedAt)
      .slice(0, maxRows ?? Number.POSITIVE_INFINITY);
  }

  async listHypothesisRuns(hypothesisKey?: string): Promise<HypothesisRunEvidence[]> {
    return [...this.hypothesisRuns.values()]
      .filter((run) => !hypothesisKey || run.hypothesisKey === hypothesisKey)
      .sort(compareObservedAt);
  }

  async assertReady(): Promise<void> {
    // The in-memory repository is deliberately available only when explicitly injected in tests/demo.
  }

  async admitSolanaSignature(item: DurableSolanaSignature): Promise<boolean> {
    const key = `${item.provider}:${item.address}:${item.signature}`;
    const existing = this.solanaSignatureQueue.get(key);
    if (existing) return existing.status === "pending";
    this.solanaSignatureQueue.set(key, { ...item, status: "pending" });
    return true;
  }

  async listPendingSolanaSignatures(
    provider: string,
    address: string,
    limit: number
  ): Promise<DurableSolanaSignature[]> {
    return [...this.solanaSignatureQueue.values()]
      .filter(
        (item) =>
          item.provider === provider && item.address === address && item.status === "pending"
      )
      .sort(
        (left, right) =>
          left.slot - right.slot ||
          left.notifiedAt.localeCompare(right.notifiedAt) ||
          left.signature.localeCompare(right.signature)
      )
      .slice(0, Math.max(0, limit))
      .map(({ status: _status, completedAt: _completedAt, ...item }) => item);
  }

  async completeSolanaSignature(
    provider: string,
    address: string,
    signature: string,
    completedAt = nowIso()
  ): Promise<boolean> {
    const key = `${provider}:${address}:${signature}`;
    const item = this.solanaSignatureQueue.get(key);
    if (!item || item.status !== "pending") return false;
    this.solanaSignatureQueue.set(key, { ...item, status: "completed", completedAt });
    return true;
  }

  async getSolanaSignatureQueueSummary(
    provider?: string
  ): Promise<DurableSolanaSignatureQueueSummary> {
    const items = [...this.solanaSignatureQueue.values()].filter(
      (item) => !provider || item.provider === provider
    );
    const pending = items.filter((item) => item.status === "pending");
    return {
      pendingCount: pending.length,
      completedCount: items.length - pending.length,
      ...(pending.length > 0
        ? { oldestPendingAt: pending.map((item) => item.notifiedAt).sort()[0] }
        : {})
    };
  }

  async listPendingSolanaFinalities(
    limit: number,
    minimumAgeSeconds: number
  ): Promise<SolanaFinalityWorkItem[]> {
    const cutoff = Date.now() - Math.max(0, minimumAgeSeconds) * 1_000;
    return [...this.solanaFinalities.values()]
      .filter((item) => item.status === "pending" && Date.parse(item.firstSeenAt) <= cutoff)
      .sort(
        (left, right) => left.slot - right.slot || left.signature.localeCompare(right.signature)
      )
      .slice(0, Math.max(0, limit))
      .map(({ status: _status, ...item }) => item);
  }

  async reconcileTerminalSolanaFinalityEvents(limit: number): Promise<SolanaFinalityBatchResult> {
    let finalizedEvents = 0;
    let rolledBackEvents = 0;
    const candidates = [...this.canonicalEvents.entries()]
      .filter(([, event]) => {
        if (
          !event.requiresFinality ||
          !event.signature ||
          (event.status !== "pending" && event.status !== "retry")
        ) {
          return false;
        }
        const finality = this.solanaFinalities.get(event.signature);
        return Boolean(
          finality &&
          finality.status !== "pending" &&
          (finality.status !== "finalized" || event.commitment !== "finalized")
        );
      })
      .sort(
        ([leftKey, left], [rightKey, right]) =>
          left.receivedAt.localeCompare(right.receivedAt) || leftKey.localeCompare(rightKey)
      )
      .slice(0, Math.max(0, limit));

    for (const [key, event] of candidates) {
      const finality = this.solanaFinalities.get(event.signature!);
      if (!finality || finality.status === "pending") continue;
      if (finality.status === "finalized") {
        this.canonicalEvents.set(key, {
          ...event,
          commitment: "finalized",
          finalizedAt: finality.finalizedAt ?? finality.firstSeenAt
        });
        finalizedEvents += 1;
      } else {
        this.canonicalEvents.set(key, {
          ...event,
          status: "rolled_back",
          lastError: finality.lastError ?? `Solana finality ${finality.status}.`
        });
        rolledBackEvents += 1;
      }
    }
    return { checkedSignatures: 0, finalizedEvents, rolledBackEvents };
  }

  async recordSolanaFinalities(
    results: Array<{ signature: string; result: SolanaFinalityResult }>
  ): Promise<SolanaFinalityBatchResult> {
    let checkedSignatures = 0;
    let finalizedEvents = 0;
    let rolledBackEvents = 0;
    for (const { signature, result } of results) {
      const finality = this.solanaFinalities.get(signature);
      if (!finality || finality.status !== "pending") continue;
      checkedSignatures += 1;
      this.solanaFinalities.set(signature, {
        ...finality,
        status: result.status,
        attemptCount: finality.attemptCount + 1,
        ...(result.status === "finalized" ? { finalizedAt: result.checkedAt } : {}),
        ...(result.error ? { lastError: result.error } : {})
      });
      for (const [key, event] of this.canonicalEvents) {
        if (event.signature !== signature || !event.requiresFinality) continue;
        if (result.status === "finalized") {
          this.canonicalEvents.set(key, {
            ...event,
            commitment: "finalized",
            finalizedAt: result.checkedAt
          });
          finalizedEvents += 1;
        } else if (
          (result.status === "failed" || result.status === "unresolved") &&
          (event.status === "pending" || event.status === "retry")
        ) {
          this.canonicalEvents.set(key, {
            ...event,
            status: "rolled_back",
            lastError: result.error ?? `Solana finality ${result.status}.`
          });
          rolledBackEvents += 1;
        }
      }
    }
    return { checkedSignatures, finalizedEvents, rolledBackEvents };
  }

  async insertChainEvent(event: CanonicalChainEventInput): Promise<boolean> {
    if (this.canonicalEvents.has(event.idempotencyKey)) return false;
    this.canonicalEvents.set(event.idempotencyKey, {
      ...event,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: event.receivedAt
    });
    if (event.requiresFinality && event.signature && event.slot !== undefined) {
      if (!this.solanaFinalities.has(event.signature)) {
        this.solanaFinalities.set(event.signature, {
          chain: "solana",
          signature: event.signature,
          slot: event.slot,
          firstSeenAt: event.receivedAt,
          attemptCount: 0,
          status: "pending"
        });
      }
    }
    return true;
  }

  async insertChainEvents(
    events: CanonicalChainEventInput[]
  ): Promise<{ inserted: number; duplicates: number }> {
    let inserted = 0;
    for (const event of events) {
      if (await this.insertChainEvent(event)) inserted += 1;
    }
    return { inserted, duplicates: events.length - inserted };
  }

  async claimChainEvents(options: CanonicalEventClaimOptions): Promise<CanonicalChainEvent[]> {
    const now = Date.now();
    const leaseSeconds = Math.max(1, options.leaseSeconds ?? 30);
    const limit = clampLimit(options.limit, 100, 1_000);
    const unresolved = [...this.canonicalEvents.values()]
      .filter((event) => event.status !== "processed" && event.status !== "rolled_back")
      .sort(compareCanonicalEvents);
    const partitionHeads = new Map<string, CanonicalChainEvent>();
    for (const event of unresolved) {
      const partition = canonicalEventPartition(event);
      if (!partitionHeads.has(partition)) partitionHeads.set(partition, event);
    }
    const candidates = [...partitionHeads.values()]
      .filter(
        (event) =>
          canonicalEventIsClaimable(event, now) &&
          (!event.requiresFinality || event.commitment === "finalized")
      )
      .sort(compareCanonicalEvents)
      .slice(0, limit);

    return candidates.map((event) => {
      const claimed: CanonicalChainEvent = {
        ...event,
        status: "processing",
        attemptCount: event.attemptCount + 1,
        lockedBy: options.workerId,
        lockedAt: new Date(now).toISOString(),
        lockExpiresAt: new Date(now + leaseSeconds * 1_000).toISOString()
      };
      this.canonicalEvents.set(event.idempotencyKey, claimed);
      return claimed;
    });
  }

  async completeChainEvent(
    idempotencyKey: string,
    workerId: string,
    processedAt = nowIso()
  ): Promise<boolean> {
    const event = this.canonicalEvents.get(idempotencyKey);
    if (!event || event.status !== "processing" || event.lockedBy !== workerId) return false;
    const rest = { ...event };
    delete rest.lockedBy;
    delete rest.lockedAt;
    delete rest.lockExpiresAt;
    this.canonicalEvents.set(idempotencyKey, {
      ...rest,
      status: "processed",
      processedAt,
      ...(event.commitment === "finalized" ? { finalizedAt: processedAt } : {})
    });
    this.processingResults.push("succeeded");
    return true;
  }

  async failChainEvent(
    idempotencyKey: string,
    workerId: string,
    error: string,
    options: CanonicalEventFailureOptions = {}
  ): Promise<CanonicalEventFailureResult | undefined> {
    const event = this.canonicalEvents.get(idempotencyKey);
    if (!event || event.status !== "processing" || event.lockedBy !== workerId) return undefined;
    const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
    const status = event.attemptCount >= maxAttempts ? "dead_letter" : "retry";
    const retryAt = options.retryAt ?? new Date(Date.now() + 5_000).toISOString();
    const rest = { ...event };
    delete rest.lockedBy;
    delete rest.lockedAt;
    delete rest.lockExpiresAt;
    this.canonicalEvents.set(idempotencyKey, {
      ...rest,
      status,
      nextAttemptAt: retryAt,
      lastError: error
    });
    this.processingResults.push(status);
    return { idempotencyKey, status, attemptCount: event.attemptCount };
  }

  async upsertPipelineWatermark(watermark: PipelineWatermark): Promise<boolean> {
    const key = `${watermark.pipeline}:${watermark.partitionKey}`;
    const current = this.pipelineWatermarks.get(key);
    if (current && watermark.lastContiguousSlot < current.lastContiguousSlot) return false;
    this.pipelineWatermarks.set(key, watermark);
    return true;
  }

  async getPipelineWatermark(
    pipeline: string,
    partitionKey = "global"
  ): Promise<PipelineWatermark | undefined> {
    return this.pipelineWatermarks.get(`${pipeline}:${partitionKey}`);
  }

  async openIngestionCoverageIncident(
    input: IngestionCoverageIncidentOpenInput
  ): Promise<IngestionCoverageIncident> {
    assertCoverageIncidentOpenInput(input);
    const existingById = this.ingestionCoverageIncidents.get(input.idempotencyKey);
    if (existingById) return existingById;
    const existingOpen = [...this.ingestionCoverageIncidents.values()].find(
      (incident) =>
        incident.provider === input.provider &&
        incident.programAddress === input.programAddress &&
        !incident.closedAt
    );
    if (existingOpen) return existingOpen;
    const incident: IngestionCoverageIncident = {
      ...input,
      restartAttemptCount: 0,
      createdAt: input.openedAt
    };
    this.ingestionCoverageIncidents.set(input.idempotencyKey, incident);
    return incident;
  }

  async listOpenIngestionCoverageIncidents(
    provider?: string
  ): Promise<IngestionCoverageIncident[]> {
    return [...this.ingestionCoverageIncidents.values()]
      .filter((incident) => !incident.closedAt && (!provider || incident.provider === provider))
      .sort(
        (left, right) =>
          left.openedAt.localeCompare(right.openedAt) ||
          left.programAddress.localeCompare(right.programAddress)
      );
  }

  async markIngestionCoverageIncidentRestart(
    idempotencyKey: string,
    phase: "attempted" | "completed" | "failed",
    at: string,
    error?: string
  ): Promise<boolean> {
    const incident = this.ingestionCoverageIncidents.get(idempotencyKey);
    if (!incident || incident.closedAt) return false;
    const atTime = coverageTimestamp(at, "Coverage restart time");
    const updated = { ...incident };
    if (phase === "attempted") {
      if (
        updated.lastRestartAttemptedAt &&
        atTime < coverageTimestamp(updated.lastRestartAttemptedAt, "Last coverage restart attempt")
      ) {
        throw new Error("Coverage incident restart attempt cannot move backward.");
      }
      updated.restartAttemptedAt ??= at;
      updated.restartAttemptCount += 1;
      updated.lastRestartAttemptedAt = at;
      delete updated.lastRestartError;
    } else if (phase === "completed") {
      if (!updated.restartAttemptedAt) {
        throw new Error("Coverage incident restart cannot complete before an attempt.");
      }
      if (
        atTime < coverageTimestamp(updated.restartAttemptedAt, "First coverage restart attempt")
      ) {
        throw new Error("Coverage incident restart cannot complete before its first attempt.");
      }
      if (
        updated.lastRestartCompletedAt &&
        atTime <
          coverageTimestamp(updated.lastRestartCompletedAt, "Last coverage restart completion")
      ) {
        throw new Error("Coverage incident restart completion cannot move backward.");
      }
      updated.restartCompletedAt ??= at;
      updated.lastRestartCompletedAt = at;
      delete updated.lastRestartError;
    } else {
      updated.lastRestartAttemptedAt ??= at;
      updated.lastRestartError = error?.slice(0, 500) ?? "unknown error";
    }
    this.ingestionCoverageIncidents.set(idempotencyKey, updated);
    return true;
  }

  async closeIngestionCoverageIncident(
    idempotencyKey: string,
    input: IngestionCoverageIncidentCloseInput
  ): Promise<boolean> {
    const incident = this.ingestionCoverageIncidents.get(idempotencyKey);
    if (!incident || incident.closedAt) return false;
    if (Boolean(input.coverageReconciledAt) !== Boolean(input.coverageRepairId)) return false;
    if (input.coverageRepairId) {
      const repair = this.ingestionGapRepairs.get(input.coverageRepairId);
      if (!repair || repair.incidentId !== idempotencyKey || repair.status !== "completed") {
        return false;
      }
      if (repair.boundarySource !== "truncation_cursor") return false;
      if (
        !repair.targetVerifiedAt ||
        repair.targetConfirmationStatus !== "finalized" ||
        repair.targetVerifiedSlot !== repair.targetSlot
      ) {
        return false;
      }
    }
    if (
      coverageTimestamp(input.closedAt, "Coverage incident close time") <
      coverageTimestamp(incident.openedAt, "Coverage incident open time")
    ) {
      throw new Error("Coverage incident cannot close before it opened.");
    }
    if (!input.metadata || typeof input.metadata !== "object" || Array.isArray(input.metadata)) {
      throw new Error("Coverage incident close metadata must be an object.");
    }
    this.ingestionCoverageIncidents.set(idempotencyKey, {
      ...incident,
      closedAt: input.closedAt,
      ...(input.clusterSlot !== undefined ? { closeClusterSlot: input.clusterSlot } : {}),
      ...(input.sourceSlot !== undefined ? { closeSourceSlot: input.sourceSlot } : {}),
      ...(input.coverageReconciledAt ? { coverageReconciledAt: input.coverageReconciledAt } : {}),
      ...(input.coverageRepairId ? { coverageRepairId: input.coverageRepairId } : {}),
      resolution: "transport_recovered_gap_unreconciled",
      closeMetadata: input.metadata
    });
    return true;
  }

  async getOrCreateIngestionGapRepair(
    input: IngestionGapRepairCreateInput
  ): Promise<IngestionGapRepair> {
    const active = [...this.ingestionGapRepairs.values()].find(
      (repair) =>
        repair.incidentId === input.incidentId &&
        (repair.status === "collecting" || repair.status === "replaying")
    );
    if (active) return { ...active };
    const existing = this.ingestionGapRepairs.get(input.repairId);
    if (existing) return { ...existing };
    const now = nowIso();
    const created: IngestionGapRepair = {
      ...input,
      status: "collecting",
      boundaryReached: false,
      fetchedSignatureCount: 0,
      completedSignatureCount: 0,
      collectionAttemptCount: 0,
      replayAttemptCount: 0,
      createdAt: now,
      updatedAt: now
    };
    this.ingestionGapRepairs.set(input.repairId, created);
    return { ...created };
  }

  async stageIngestionGapRepairPage(
    input: IngestionGapRepairPageInput
  ): Promise<IngestionGapRepair> {
    const repair = this.ingestionGapRepairs.get(input.repairId);
    if (!repair || repair.status !== "collecting") {
      throw new Error("Gap repair is not collecting signatures.");
    }
    for (const item of input.signatures) {
      const key = `${input.repairId}:${item.signature}`;
      if (!this.ingestionGapRepairSignatures.has(key)) {
        this.ingestionGapRepairSignatures.set(key, {
          repairId: input.repairId,
          signature: item.signature,
          slot: item.slot,
          positionFromHead: item.positionFromHead,
          status: "pending"
        });
      }
    }
    const fetchedSignatureCount = [...this.ingestionGapRepairSignatures.values()].filter(
      (item) => item.repairId === input.repairId
    ).length;
    const updated: IngestionGapRepair = {
      ...repair,
      ...(repair.targetSignature
        ? {}
        : input.targetSignature && input.targetSlot !== undefined
          ? { targetSignature: input.targetSignature, targetSlot: input.targetSlot }
          : {}),
      ...(input.beforeSignature ? { beforeSignature: input.beforeSignature } : {}),
      status: input.boundaryReached ? "replaying" : "collecting",
      boundaryReached: input.boundaryReached,
      fetchedSignatureCount,
      collectionAttemptCount: repair.collectionAttemptCount + 1,
      updatedAt: nowIso()
    };
    this.ingestionGapRepairs.set(input.repairId, updated);
    return { ...updated };
  }

  async listPendingIngestionGapRepairSignatures(
    repairId: string,
    limit: number
  ): Promise<IngestionGapRepairSignature[]> {
    return [...this.ingestionGapRepairSignatures.values()]
      .filter((item) => item.repairId === repairId && item.status === "pending")
      .sort((left, right) => right.positionFromHead - left.positionFromHead)
      .slice(0, Math.max(0, limit))
      .map(({ status: _status, completedAt: _completedAt, ...item }) => item);
  }

  async completeIngestionGapRepairSignature(
    repairId: string,
    signature: string,
    completedAt = nowIso()
  ): Promise<boolean> {
    const key = `${repairId}:${signature}`;
    const item = this.ingestionGapRepairSignatures.get(key);
    const repair = this.ingestionGapRepairs.get(repairId);
    if (!item || item.status !== "pending" || !repair) return false;
    this.ingestionGapRepairSignatures.set(key, { ...item, status: "completed", completedAt });
    const repairWithoutError = { ...repair };
    delete repairWithoutError.lastError;
    this.ingestionGapRepairs.set(repairId, {
      ...repairWithoutError,
      completedSignatureCount: repair.completedSignatureCount + 1,
      replayAttemptCount: repair.replayAttemptCount + 1,
      updatedAt: completedAt
    });
    return true;
  }

  async recordIngestionGapRepairError(
    repairId: string,
    phase: "collection" | "replay",
    error: string
  ): Promise<boolean> {
    const repair = this.ingestionGapRepairs.get(repairId);
    if (!repair || repair.status === "completed") return false;
    this.ingestionGapRepairs.set(repairId, {
      ...repair,
      ...(error.startsWith("gap-repair-signature-cap-") ? { status: "failed" as const } : {}),
      collectionAttemptCount:
        phase === "collection" ? repair.collectionAttemptCount + 1 : repair.collectionAttemptCount,
      replayAttemptCount:
        phase === "replay" ? repair.replayAttemptCount + 1 : repair.replayAttemptCount,
      lastError: error.slice(0, 500),
      updatedAt: nowIso()
    });
    return true;
  }

  async completeIngestionGapRepair(
    repairId: string,
    coveredThrough: { signature: string; slot: number; completedAt?: string }
  ): Promise<boolean> {
    const repair = this.ingestionGapRepairs.get(repairId);
    if (!repair || repair.status !== "replaying") return false;
    if (repair.boundarySource !== "truncation_cursor") return false;
    if (
      !repair.targetSignature ||
      repair.targetSlot === undefined ||
      coveredThrough.signature !== repair.targetSignature ||
      coveredThrough.slot !== repair.targetSlot
    ) {
      return false;
    }
    const pending = [...this.ingestionGapRepairSignatures.values()].some(
      (item) => item.repairId === repairId && item.status === "pending"
    );
    if (pending) return false;
    const completedAt = coveredThrough.completedAt ?? nowIso();
    const repairWithoutError = { ...repair };
    delete repairWithoutError.lastError;
    this.ingestionGapRepairs.set(repairId, {
      ...repairWithoutError,
      status: "completed",
      coveredThroughSignature: coveredThrough.signature,
      coveredThroughSlot: coveredThrough.slot,
      completedAt,
      updatedAt: completedAt
    });
    return true;
  }

  async verifyIngestionGapRepairTarget(
    repairId: string,
    proof: {
      signature: string;
      slot: number;
      confirmationStatus: "finalized";
      verifiedAt?: string;
    }
  ): Promise<boolean> {
    const repair = this.ingestionGapRepairs.get(repairId);
    if (
      !repair ||
      repair.status !== "completed" ||
      repair.boundarySource !== "truncation_cursor" ||
      repair.targetSignature !== proof.signature ||
      repair.targetSlot !== proof.slot ||
      repair.coveredThroughSignature !== proof.signature ||
      repair.coveredThroughSlot !== proof.slot ||
      proof.confirmationStatus !== "finalized"
    ) {
      return false;
    }
    const verifiedAt = proof.verifiedAt ?? nowIso();
    this.ingestionGapRepairs.set(repairId, {
      ...repair,
      targetVerifiedAt: verifiedAt,
      targetVerifiedSlot: proof.slot,
      targetConfirmationStatus: "finalized",
      updatedAt: verifiedAt
    });
    return true;
  }

  async getPipelineHealth(): Promise<PipelineHealthSummary> {
    const checkedAt = nowIso();
    const events = [...this.canonicalEvents.values()];
    const inbox = emptyInboxCounts();
    for (const event of events) inbox[event.status] += 1;
    const latestReceivedSlot = maxDefined(events.map((event) => event.slot));
    const latestProcessedSlot = maxDefined(
      events.filter((event) => event.status === "processed").map((event) => event.slot)
    );
    const pending = events.filter((event) =>
      ["pending", "retry", "processing"].includes(event.status)
    );
    const oldestPending = pending
      .map((event) => new Date(event.receivedAt).getTime())
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    const finished = this.processingResults.length;
    const successes = this.processingResults.filter((result) => result === "succeeded").length;
    const allTrades = [...this.walletTradeEvents.values()];
    const highQuality = allTrades.filter(
      (trade) =>
        trade.executionPriceUsd !== undefined &&
        (trade.dataQuality === "observed-execution" || trade.dataQuality === "oracle-converted")
    );
    const lastPoolAt = latestEventTime(events, "pool_created");
    const lastSwapAt = latestEventTime(events, "swap");
    const lastWalletTradeAt = latestIso(
      [...this.walletTradeEvents.values()].map((trade) => trade.observedAt)
    );

    return {
      database: "ok",
      checkedAt,
      inbox,
      backlog: inbox.pending + inbox.retry + inbox.processing,
      deadLetterCount: inbox.dead_letter,
      parserSuccessRate: finished === 0 ? 1 : successes / finished,
      ...(latestReceivedSlot !== undefined ? { latestReceivedSlot } : {}),
      ...(latestProcessedSlot !== undefined ? { latestProcessedSlot } : {}),
      ...(latestReceivedSlot !== undefined && latestProcessedSlot !== undefined
        ? { processingLagSlots: Math.max(0, latestReceivedSlot - latestProcessedSlot) }
        : {}),
      ...(oldestPending !== undefined
        ? { oldestPendingAgeSeconds: Math.max(0, (Date.now() - oldestPending) / 1_000) }
        : {}),
      ...(lastPoolAt ? { lastPoolAt } : {}),
      ...(lastSwapAt ? { lastSwapAt } : {}),
      ...(lastWalletTradeAt ? { lastWalletTradeAt } : {}),
      highQualityPriceCoverage: allTrades.length === 0 ? 0 : highQuality.length / allTrades.length,
      watermarkCount: this.pipelineWatermarks.size,
      watermarks: [...this.pipelineWatermarks.values()]
        .sort((a, b) =>
          `${a.pipeline}:${a.partitionKey}`.localeCompare(`${b.pipeline}:${b.partitionKey}`)
        )
        .slice(0, 25)
    };
  }

  async listWalletAlphaRankings(
    query: WalletAlphaRankingQuery = {}
  ): Promise<WalletAlphaScoreSnapshot[]> {
    const latest = new Map<string, WalletAlphaScoreSnapshot>();
    for (const score of this.walletAlphaScores.values()) {
      if (query.strategyVersion && score.strategyVersion !== query.strategyVersion) continue;
      const key = `${score.chain}:${score.walletAddress}:${score.strategyVersion}`;
      const current = latest.get(key);
      if (
        !current ||
        new Date(score.calculatedAt).getTime() > new Date(current.calculatedAt).getTime()
      ) {
        latest.set(key, score);
      }
    }
    const statuses = query.statuses ? new Set(query.statuses) : undefined;
    const offset = Math.max(0, query.offset ?? 0);
    return [...latest.values()]
      .filter((score) => !statuses || statuses.has(score.status))
      .sort((a, b) => b.overallScore - a.overallScore)
      .slice(offset, offset + clampLimit(query.limit, 100, 500));
  }

  async getWalletAlphaDetail(
    walletAddress: string,
    strategyVersion?: string
  ): Promise<WalletAlphaDetail | undefined> {
    const scoreHistory = [...this.walletAlphaScores.values()]
      .filter((score) => score.walletAddress === walletAddress)
      .filter((score) => !strategyVersion || score.strategyVersion === strategyVersion)
      .sort((a, b) => new Date(b.calculatedAt).getTime() - new Date(a.calculatedAt).getTime())
      .slice(0, 90);
    const latestScore = scoreHistory[0];
    if (!latestScore) return undefined;
    const selectedVersion = strategyVersion ?? latestScore.strategyVersion;
    const episodes = [...this.walletPositionEpisodes.values()]
      .filter(
        (episode) =>
          episode.walletAddress === walletAddress && episode.strategyVersion === selectedVersion
      )
      .sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime())
      .slice(0, 100);
    const episodeIds = new Set(episodes.map((episode) => episode.id));
    return {
      walletAddress,
      latestScore,
      scoreHistory: scoreHistory.filter((score) => score.strategyVersion === selectedVersion),
      recentTrades: [...this.walletTradeEvents.values()]
        .filter(
          (trade) =>
            trade.walletAddress === walletAddress && trade.strategyVersion === selectedVersion
        )
        .sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime())
        .slice(0, 100),
      episodes,
      lots: [...this.walletPositionLots.values()]
        .filter((lot) => episodeIds.has(lot.episodeId))
        .sort((a, b) => a.episodeId.localeCompare(b.episodeId) || a.lotSequence - b.lotSequence)
    };
  }

  async listWalletAlphaSignalFeed(
    query: WalletAlphaSignalQuery = {}
  ): Promise<WalletAlphaSignalEvidence[]> {
    const statuses = query.statuses ? new Set(query.statuses) : undefined;
    const offset = Math.max(0, query.offset ?? 0);
    return [...this.walletAlphaSignals.values()]
      .filter(
        (signal) => !query.strategyVersion || signal.strategyVersion === query.strategyVersion
      )
      .filter((signal) => !statuses || statuses.has(signal.status))
      .sort((a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime())
      .slice(offset, offset + clampLimit(query.limit, 100, 500));
  }

  async claimSignalOutbox(options: SignalOutboxClaimOptions): Promise<SignalOutboxMessage[]> {
    const now = Date.now();
    const leaseSeconds = Math.max(1, options.leaseSeconds ?? 30);
    const messages = [...this.signalOutbox.values()]
      .filter((message) => message.destination === options.destination)
      .filter(
        (message) =>
          ((message.status === "pending" || message.status === "retry") &&
            new Date(message.availableAt).getTime() <= now) ||
          (message.status === "processing" &&
            Boolean(message.lockExpiresAt) &&
            new Date(message.lockExpiresAt ?? 0).getTime() <= now)
      )
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
      .slice(0, clampLimit(options.limit, 100, 500));
    return messages.map((message) => {
      const claimed: SignalOutboxMessage = {
        ...message,
        status: "processing",
        attemptCount: message.attemptCount + 1,
        lockedBy: options.workerId,
        lockedAt: new Date(now).toISOString(),
        lockExpiresAt: new Date(now + leaseSeconds * 1_000).toISOString()
      };
      this.signalOutbox.set(message.id, claimed);
      return claimed;
    });
  }

  async completeSignalOutbox(
    id: string,
    workerId: string,
    deliveredAt = nowIso()
  ): Promise<boolean> {
    const message = this.signalOutbox.get(id);
    if (!message || message.status !== "processing" || message.lockedBy !== workerId) return false;
    const rest = { ...message };
    delete rest.lockedBy;
    delete rest.lockedAt;
    delete rest.lockExpiresAt;
    this.signalOutbox.set(id, { ...rest, status: "delivered", deliveredAt });
    return true;
  }

  async failSignalOutbox(
    id: string,
    workerId: string,
    error: string,
    options: SignalOutboxFailureOptions = {}
  ): Promise<SignalOutboxMessage | undefined> {
    const message = this.signalOutbox.get(id);
    if (!message || message.status !== "processing" || message.lockedBy !== workerId) {
      return undefined;
    }
    const status =
      message.attemptCount >= Math.max(1, options.maxAttempts ?? 5) ? "dead_letter" : "retry";
    const rest = { ...message };
    delete rest.lockedBy;
    delete rest.lockedAt;
    delete rest.lockExpiresAt;
    const failed: SignalOutboxMessage = {
      ...rest,
      status,
      availableAt: options.retryAt ?? new Date(Date.now() + 5_000).toISOString(),
      lastError: error
    };
    this.signalOutbox.set(id, failed);
    return failed;
  }
}

const tokenKey = (chain: ChainId, address: string) => `${chain}:${address}`;
const poolKey = (chain: ChainId, address: string) => `${chain}:${address}`;
const walletTokenStrategyKey = (
  chain: ChainId,
  walletAddress: string,
  tokenAddress: string,
  strategyVersion: string
) => [chain, walletAddress, tokenAddress, strategyVersion].join("\u0000");
const historicalWindowKey = (
  runId: string,
  stage: HistoricalBackfillWindow["stage"],
  address: string,
  start: number,
  end: number
) => `${runId}:${stage}:${address}:${start}:${end}`;
const compareObservedAt = (a: { observedAt: string }, b: { observedAt: string }) =>
  new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime();

function quotePriceEvidenceMatches(
  stored: QuotePriceObservation,
  observation: QuotePriceObservation
): boolean {
  return (
    stored.chain === observation.chain &&
    stored.quoteTokenAddress === observation.quoteTokenAddress &&
    stored.priceUsd === observation.priceUsd &&
    stored.confidenceUsd === observation.confidenceUsd &&
    stored.source === observation.source &&
    stored.quality === observation.quality &&
    new Date(stored.publishTime).getTime() === new Date(observation.publishTime).getTime()
  );
}

const canonicalStatuses: CanonicalEventStatus[] = [
  "pending",
  "processing",
  "retry",
  "processed",
  "dead_letter",
  "rolled_back"
];

function emptyInboxCounts(): Record<CanonicalEventStatus, number> {
  return Object.fromEntries(canonicalStatuses.map((status) => [status, 0])) as Record<
    CanonicalEventStatus,
    number
  >;
}

function clampLimit(value: number | undefined, defaultValue: number, maximum: number): number {
  return Math.min(maximum, Math.max(1, Math.trunc(value ?? defaultValue)));
}

function compareCanonicalEvents(a: CanonicalChainEvent, b: CanonicalChainEvent): number {
  const slotA = a.slot ?? Number.MAX_SAFE_INTEGER;
  const slotB = b.slot ?? Number.MAX_SAFE_INTEGER;
  return (
    slotA - slotB ||
    (a.transactionIndex ?? Number.MAX_SAFE_INTEGER) -
      (b.transactionIndex ?? Number.MAX_SAFE_INTEGER) ||
    (a.instructionIndex ?? Number.MAX_SAFE_INTEGER) -
      (b.instructionIndex ?? Number.MAX_SAFE_INTEGER) ||
    new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime() ||
    a.idempotencyKey.localeCompare(b.idempotencyKey)
  );
}

function canonicalEventPartition(event: CanonicalChainEvent): string {
  const address = event.payload.address;
  return `${event.chain}:${typeof address === "string" && address.trim() ? address : event.source}`;
}

function canonicalEventIsClaimable(event: CanonicalChainEvent, now: number): boolean {
  if (event.status === "pending" || event.status === "retry") {
    return new Date(event.nextAttemptAt).getTime() <= now;
  }
  return (
    event.status === "processing" &&
    Boolean(event.lockExpiresAt) &&
    new Date(event.lockExpiresAt ?? 0).getTime() <= now
  );
}

function maxDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length > 0 ? Math.max(...defined) : undefined;
}

function latestIso(values: string[]): string | undefined {
  return values.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
}

function earliestIso(values: string[]): string | undefined {
  return values.sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0];
}

function latestEventTime(events: CanonicalChainEvent[], eventType: string): string | undefined {
  return latestIso(
    events.filter((event) => event.eventType === eventType).map((event) => event.occurredAt)
  );
}

function latestWalletAlphaScores(
  values: Iterable<WalletAlphaScoreSnapshot>,
  strategyVersion?: string
): WalletAlphaScoreSnapshot[] {
  const latest = new Map<string, WalletAlphaScoreSnapshot>();
  for (const score of values) {
    if (strategyVersion && score.strategyVersion !== strategyVersion) continue;
    const key = `${score.chain}:${score.walletAddress}:${score.strategyVersion}`;
    const existing = latest.get(key);
    if (
      !existing ||
      new Date(score.calculatedAt).getTime() > new Date(existing.calculatedAt).getTime()
    ) {
      latest.set(key, score);
    }
  }
  return [...latest.values()];
}

function walletAlphaStatusRank(status: WalletAlphaScoreSnapshot["status"]): number {
  return {
    excluded: -1,
    insufficient: 0,
    observed: 1,
    watch: 2,
    candidate: 3,
    "validated-paper": 4
  }[status];
}
