import type {
  BacktestRun,
  ChainId,
  HistoricalBackfillWindow,
  HistoricalMarketObservation,
  HypothesisRunEvidence,
  IngestionCursorEvidence,
  OnchainSwapEvidence,
  PaperTrade,
  PoolSnapshot,
  PriceObservationEvidence,
  ProviderStatus,
  ScoreBreakdown,
  Signal,
  TokenSnapshot,
  WalletEntrySignalEvidence,
  WalletAlphaScoreSnapshot,
  WalletAlphaSignalEvidence,
  WalletSignalOutcomeEvidence,
  WalletTradeEvidence,
  WalletScore
} from "@memecoin-alpha/shared";

export interface TokenRiskReport {
  chain: ChainId;
  tokenAddress: string;
  calculatedAt: string;
  score: ScoreBreakdown;
}

export type CanonicalEventCommitment = "confirmed" | "finalized";
export type CanonicalEventStatus =
  "pending" | "processing" | "retry" | "processed" | "dead_letter" | "rolled_back";

/**
 * DB-local canonical event contract. The shared package intentionally stays independent from
 * persistence/lease semantics; stream and webhook producers can depend on this contract through
 * @memecoin-alpha/db.
 */
export interface CanonicalChainEventInput {
  idempotencyKey: string;
  chain: ChainId;
  signature?: string;
  slot?: number;
  transactionIndex?: number;
  instructionIndex?: number;
  innerInstructionIndex?: number;
  eventType: string;
  tokenAddress?: string;
  poolAddress?: string;
  occurredAt: string;
  receivedAt: string;
  commitment: CanonicalEventCommitment;
  /** Future-only gate: parser admission waits for durable finalized evidence. */
  requiresFinality?: boolean;
  source: string;
  decoderVersion: string;
  payload: Record<string, unknown>;
}

export interface CanonicalChainEvent extends CanonicalChainEventInput {
  status: CanonicalEventStatus;
  attemptCount: number;
  nextAttemptAt: string;
  processedAt?: string;
  finalizedAt?: string;
  lockedBy?: string;
  lockedAt?: string;
  lockExpiresAt?: string;
  lastError?: string;
}

export interface SolanaFinalityWorkItem {
  chain: "solana";
  signature: string;
  slot: number;
  firstSeenAt: string;
  attemptCount: number;
}

export interface SolanaFinalityResult {
  status: "pending" | "finalized" | "failed" | "unresolved";
  checkedAt: string;
  confirmationStatus?: "processed" | "confirmed" | "finalized";
  rootSlot?: number;
  error?: string;
}

export interface SolanaFinalityBatchResult {
  checkedSignatures: number;
  finalizedEvents: number;
  rolledBackEvents: number;
}

export interface CanonicalEventClaimOptions {
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
}

export interface CanonicalEventFailureOptions {
  maxAttempts?: number;
  retryAt?: string;
}

export interface CanonicalEventFailureResult {
  idempotencyKey: string;
  status: "retry" | "dead_letter";
  attemptCount: number;
}

export interface PipelineWatermark {
  pipeline: string;
  partitionKey: string;
  chain: ChainId;
  lastContiguousSlot: number;
  lastSignature?: string;
  status: "healthy" | "stalled" | "reconciling";
  updatedAt: string;
  metadata: Record<string, unknown>;
}

export interface DurableSolanaSignature {
  provider: string;
  address: string;
  signature: string;
  slot: number;
  notifiedAt: string;
}

export interface DurableSolanaSignatureQueueSummary {
  pendingCount: number;
  completedCount: number;
  oldestPendingAt?: string;
}

export type IngestionCoverageIncidentReason =
  | "head_slot_lag"
  | "raw_websocket_silence"
  | "subscription_ack_timeout"
  | "stale_live_notification"
  | "backfill_truncated"
  | "source_start_failed"
  | "combined";

export interface IngestionCoverageIncidentOpenInput {
  idempotencyKey: string;
  chain: "solana";
  provider: string;
  programAddress: string;
  reason: IngestionCoverageIncidentReason;
  gapStartedAt: string;
  openedAt: string;
  clusterSlot?: number;
  sourceSlot?: number;
  slotLag?: number;
  lastWebsocketMessageAt?: string;
  silenceMs?: number;
  subscriptionAckTimeoutCount: number;
  successfulSubscriptionAckCount: number;
  metadata: Record<string, unknown>;
}

export interface IngestionCoverageIncident extends IngestionCoverageIncidentOpenInput {
  restartAttemptedAt?: string;
  restartCompletedAt?: string;
  restartAttemptCount: number;
  lastRestartAttemptedAt?: string;
  lastRestartCompletedAt?: string;
  lastRestartError?: string;
  closedAt?: string;
  closeClusterSlot?: number;
  closeSourceSlot?: number;
  resolution?: "transport_recovered_gap_unreconciled";
  closeMetadata?: Record<string, unknown>;
  coverageReconciledAt?: string;
  coverageRepairId?: string;
  createdAt: string;
}

export interface IngestionCoverageIncidentCloseInput {
  closedAt: string;
  clusterSlot?: number;
  sourceSlot?: number;
  coverageReconciledAt?: string;
  coverageRepairId?: string;
  metadata: Record<string, unknown>;
}

export type IngestionGapRepairStatus = "collecting" | "replaying" | "completed" | "failed";
export type IngestionGapRepairBoundarySource = "unsafe_legacy_current_cursor" | "truncation_cursor";

export interface IngestionGapRepair {
  repairId: string;
  incidentId: string;
  provider: string;
  programAddress: string;
  cursorSignature: string;
  cursorSlot: number;
  cursorOccurredAt?: string;
  boundarySource: IngestionGapRepairBoundarySource;
  targetSignature?: string;
  targetSlot?: number;
  beforeSignature?: string;
  status: IngestionGapRepairStatus;
  boundaryReached: boolean;
  fetchedSignatureCount: number;
  completedSignatureCount: number;
  collectionAttemptCount: number;
  replayAttemptCount: number;
  lastError?: string;
  coveredThroughSignature?: string;
  coveredThroughSlot?: number;
  targetVerifiedAt?: string;
  targetVerifiedSlot?: number;
  targetConfirmationStatus?: "finalized";
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface IngestionGapRepairSignature {
  repairId: string;
  signature: string;
  slot: number;
  positionFromHead: number;
}

export interface IngestionGapRepairCreateInput {
  repairId: string;
  incidentId: string;
  provider: string;
  programAddress: string;
  cursorSignature: string;
  cursorSlot: number;
  cursorOccurredAt?: string;
  boundarySource: IngestionGapRepairBoundarySource;
}

export interface IngestionGapRepairPageInput {
  repairId: string;
  signatures: Array<{ signature: string; slot: number; positionFromHead: number }>;
  beforeSignature?: string;
  boundaryReached: boolean;
  targetSignature?: string;
  targetSlot?: number;
}

export interface PipelineHealthSummary {
  database: "ok";
  checkedAt: string;
  /** Processed history may use PostgreSQL planner statistics to keep health checks O(working set). */
  processedCountEstimated?: boolean;
  inbox: Record<CanonicalEventStatus, number>;
  backlog: number;
  deadLetterCount: number;
  parserSuccessRate: number;
  latestReceivedSlot?: number;
  latestProcessedSlot?: number;
  processingLagSlots?: number;
  oldestPendingAgeSeconds?: number;
  lastPoolAt?: string;
  lastSwapAt?: string;
  lastWalletTradeAt?: string;
  highQualityPriceCoverage: number;
  watermarkCount: number;
  watermarks: PipelineWatermark[];
}

export interface QuotePriceObservation {
  idempotencyKey: string;
  chain: ChainId;
  quoteTokenAddress: string;
  priceUsd: number;
  confidenceUsd: number;
  source: string;
  quality: "oracle-live" | "oracle-historical" | "stablecoin-peg";
  publishTime: string;
  observedAt: string;
  stalenessSeconds: number;
  raw: Record<string, unknown>;
}

export interface WalletPositionEpisode {
  id: string;
  chain: ChainId;
  walletAddress: string;
  tokenAddress: string;
  strategyVersion: string;
  episodeIndex: number;
  status: "open" | "realized" | "terminal_risk";
  openedAt: string;
  closedAt?: string;
  costBasisUsd: number;
  proceedsUsd: number;
  realizedPnlUsd: number;
  returnPct?: number;
  remainingRawAmount: string;
  tokenDecimals: number;
  realizedLotCount: number;
  highQualityPriceCoverage: number;
  terminalReason?: string;
  metadata: Record<string, unknown>;
}

export interface WalletPositionLot {
  id: string;
  episodeId: string;
  sourceEventIdempotencyKey: string;
  lotSequence: number;
  rawAmount: string;
  remainingRawAmount: string;
  tokenDecimals: number;
  quoteCostUsd: number;
  feesUsd: number;
  slippageUsd: number;
  openedAt: string;
  closedAt?: string;
  status: "open" | "partially_realized" | "realized" | "transferred";
  metadata: Record<string, unknown>;
}

/**
 * Complete, deterministic ledger projection for one chain/strategy window. Replacing the
 * projection is atomic: rows absent from the new snapshot are removed in the same transaction,
 * so a formerly-open FIFO lot cannot survive after its closing sell is observed.
 */
export interface WalletPositionLedgerSnapshot {
  chain: ChainId;
  strategyVersion: string;
  generatedAt: string;
  /**
   * When present, replacement/deletion is restricted to these wallets. This is the
   * production-safe incremental mode. Omitting it retains the legacy full projection
   * semantics for explicit offline rebuilds.
   */
  walletAddresses?: string[];
  episodes: WalletPositionEpisode[];
  lots: WalletPositionLot[];
}

export interface WalletPositionLedgerWriteResult {
  episodeCount: number;
  lotCount: number;
}

export function assertWalletPositionLedgerSnapshot(snapshot: WalletPositionLedgerSnapshot): void {
  if (!snapshot.strategyVersion.trim()) throw new Error("Ledger strategyVersion is required.");
  if (!Number.isFinite(new Date(snapshot.generatedAt).getTime())) {
    throw new Error("Ledger generatedAt must be a valid timestamp.");
  }
  const episodeIds = new Set<string>();
  const walletScope = snapshot.walletAddresses
    ? new Set(snapshot.walletAddresses.map((wallet) => wallet.trim()).filter(Boolean))
    : undefined;
  if (snapshot.walletAddresses && walletScope?.size !== snapshot.walletAddresses.length) {
    throw new Error("Ledger walletAddresses must be non-empty and unique.");
  }
  const naturalEpisodeKeys = new Set<string>();
  const episodesById = new Map<string, WalletPositionEpisode>();
  for (const episode of snapshot.episodes) {
    if (!episode.id || episodeIds.has(episode.id))
      throw new Error("Ledger episode ids must be unique.");
    if (episode.chain !== snapshot.chain || episode.strategyVersion !== snapshot.strategyVersion) {
      throw new Error(`Ledger episode ${episode.id} is outside the snapshot scope.`);
    }
    if (walletScope && !walletScope.has(episode.walletAddress)) {
      throw new Error(`Ledger episode ${episode.id} is outside the wallet scope.`);
    }
    if (!Number.isInteger(episode.episodeIndex) || episode.episodeIndex < 0) {
      throw new Error(`Ledger episode ${episode.id} has an invalid episodeIndex.`);
    }
    if (!validRawAmount(episode.remainingRawAmount)) {
      throw new Error(`Ledger episode ${episode.id} has an invalid remaining amount.`);
    }
    if (!validTokenDecimals(episode.tokenDecimals)) {
      throw new Error(`Ledger episode ${episode.id} has invalid token decimals.`);
    }
    if (episode.status === "open" ? episode.closedAt !== undefined : !episode.closedAt) {
      throw new Error(`Ledger episode ${episode.id} has an inconsistent close state.`);
    }
    for (const value of [
      episode.costBasisUsd,
      episode.proceedsUsd,
      episode.realizedPnlUsd,
      episode.highQualityPriceCoverage
    ]) {
      if (!Number.isFinite(value))
        throw new Error(`Ledger episode ${episode.id} has non-finite values.`);
    }
    if (
      episode.costBasisUsd < 0 ||
      episode.proceedsUsd < 0 ||
      episode.highQualityPriceCoverage < 0 ||
      episode.highQualityPriceCoverage > 1
    ) {
      throw new Error(`Ledger episode ${episode.id} violates numeric bounds.`);
    }
    const naturalKey = [
      episode.chain,
      episode.walletAddress,
      episode.tokenAddress,
      episode.strategyVersion,
      episode.episodeIndex
    ].join(":");
    if (naturalEpisodeKeys.has(naturalKey)) {
      throw new Error(`Ledger contains duplicate episode scope ${naturalKey}.`);
    }
    episodeIds.add(episode.id);
    naturalEpisodeKeys.add(naturalKey);
    episodesById.set(episode.id, episode);
  }

  const lotIds = new Set<string>();
  const naturalLotKeys = new Set<string>();
  const remainingByEpisode = new Map<string, bigint>();
  const lotCountByEpisode = new Map<string, number>();
  for (const lot of snapshot.lots) {
    if (!lot.id || lotIds.has(lot.id)) throw new Error("Ledger lot ids must be unique.");
    const episode = episodesById.get(lot.episodeId);
    if (!episode) throw new Error(`Ledger lot ${lot.id} references an unknown episode.`);
    if (!lot.sourceEventIdempotencyKey.trim()) {
      throw new Error(`Ledger lot ${lot.id} is missing its source event key.`);
    }
    if (!validRawAmount(lot.rawAmount, false) || !validRawAmount(lot.remainingRawAmount)) {
      throw new Error(`Ledger lot ${lot.id} has invalid raw amounts.`);
    }
    const rawAmount = BigInt(lot.rawAmount);
    const remainingRawAmount = BigInt(lot.remainingRawAmount);
    if (remainingRawAmount > rawAmount || lot.tokenDecimals !== episode.tokenDecimals) {
      throw new Error(`Ledger lot ${lot.id} is inconsistent with its episode.`);
    }
    const shouldBeClosed = lot.status === "realized" || lot.status === "transferred";
    if (
      (shouldBeClosed && (remainingRawAmount !== 0n || !lot.closedAt)) ||
      (!shouldBeClosed && (remainingRawAmount === 0n || lot.closedAt !== undefined))
    ) {
      throw new Error(`Ledger lot ${lot.id} has an inconsistent status.`);
    }
    if (!Number.isInteger(lot.lotSequence) || lot.lotSequence < 0) {
      throw new Error(`Ledger lot ${lot.id} has an invalid lotSequence.`);
    }
    for (const value of [lot.quoteCostUsd, lot.feesUsd, lot.slippageUsd]) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Ledger lot ${lot.id} violates cost bounds.`);
      }
    }
    const naturalKey = `${lot.episodeId}:${lot.sourceEventIdempotencyKey}:${lot.lotSequence}`;
    if (naturalLotKeys.has(naturalKey)) {
      throw new Error(`Ledger contains duplicate lot scope ${naturalKey}.`);
    }
    lotIds.add(lot.id);
    naturalLotKeys.add(naturalKey);
    remainingByEpisode.set(
      lot.episodeId,
      (remainingByEpisode.get(lot.episodeId) ?? 0n) + remainingRawAmount
    );
    lotCountByEpisode.set(lot.episodeId, (lotCountByEpisode.get(lot.episodeId) ?? 0) + 1);
  }

  for (const episode of snapshot.episodes) {
    if ((lotCountByEpisode.get(episode.id) ?? 0) === 0) {
      throw new Error(`Ledger episode ${episode.id} has no FIFO lots.`);
    }
    if ((remainingByEpisode.get(episode.id) ?? 0n).toString() !== episode.remainingRawAmount) {
      throw new Error(`Ledger episode ${episode.id} does not match its FIFO lot balance.`);
    }
  }
}

export interface WalletAlphaWorkItem {
  chain: ChainId;
  walletAddress: string;
  strategyVersion: string;
  revision: number;
  attemptCount: number;
  lockedBy: string;
  lockExpiresAt: string;
  priority: WalletAlphaWorkPriority;
  priorityReason?: string;
  pendingSince: string;
}

export type WalletAlphaWorkPriority = 0 | 1 | 2;

export interface WalletAlphaWorkClassification {
  priority: WalletAlphaWorkPriority;
  reason: string;
}

/**
 * Keep the latency lane fail closed. A risk-passed entry is signal-relevant only
 * when the wallet's latest persisted score is already eligible to emit a paper
 * signal. New/unqualified wallets remain durable in the research lane so wallet
 * discovery cannot crowd out an actual qualified-wallet entry.
 */
export function classifyWalletAlphaEntryWork(
  signal: WalletEntrySignalEvidence,
  currentWalletStatus?: WalletAlphaScoreSnapshot["status"]
): WalletAlphaWorkClassification {
  const riskPassed =
    Boolean(signal.sourceSwapIdempotencyKey?.trim()) &&
    signal.cohort !== "excluded-uncontrolled-flow" &&
    signal.flowEvidence.controlledFlow === true &&
    signal.flowEvidence.tokenRiskKnown === true &&
    signal.flowEvidence.tokenRiskPassed === true;
  if (!riskPassed) return { priority: 1, reason: "entry-evidence" };

  return currentWalletStatus === "watch" ||
    currentWalletStatus === "candidate" ||
    currentWalletStatus === "validated-paper"
    ? { priority: 2, reason: "risk-passed-qualified-wallet-entry" }
    : { priority: 1, reason: "risk-passed-unqualified-wallet-entry" };
}

/** Read-only queue identity used to prefetch bounded admission evidence before leasing work. */
export interface WalletAlphaWorkCandidate {
  chain: ChainId;
  walletAddress: string;
  strategyVersion: string;
  revision: number;
  priority: WalletAlphaWorkPriority;
  pendingSince: string;
}

export interface WalletAlphaAdmissionProbe extends WalletAlphaWorkCandidate {
  /** Counts are capped at the configured admission threshold. */
  tradeEventCount: number;
  /** Counts are capped at the configured admission threshold. */
  entryCount: number;
}

/**
 * Price-enrichment queue admission. Evidence is always persisted; only the redundant
 * enrichment revision is suppressed until either bounded evidence threshold is met.
 */
export interface WalletAlphaQueueAdmission {
  minimumTradeEvents: number;
  minimumEntries: number;
  sourceWindowDays: number;
}

export interface WalletAlphaEvidenceBounds {
  tradeEventsExceeded: boolean;
  entriesExceeded: boolean;
  outcomesExceeded: boolean;
}

export type WalletAlphaWorkFailureClass = "transient" | "evidence_limit";

export interface WalletAlphaWorkClaimOptions {
  strategyVersion: string;
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
  minimumPriority?: WalletAlphaWorkPriority;
  maximumPriority?: WalletAlphaWorkPriority;
}

export interface WalletAlphaWorkSummary {
  pending: number;
  processing: number;
  failed: number;
  backgroundPending: number;
  elevatedPending: number;
  signalPending: number;
  oldestPendingAt?: string;
  oldestSignalPendingAt?: string;
}

export type WalletAlphaStatusCounts = Record<WalletAlphaScoreSnapshot["status"], number>;

export interface WalletAlphaCoverageSummary {
  tradeEvents: number;
  buyEvents: number;
  sellEvents: number;
  pricedEvents: number;
  highQualityPricedEvents: number;
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
}

function validRawAmount(value: string, allowZero = true): boolean {
  return /^\d+$/.test(value) && (allowZero || BigInt(value) > 0n);
}

function validTokenDecimals(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 30;
}

export interface WalletAlphaRankingQuery {
  strategyVersion?: string;
  statuses?: WalletAlphaScoreSnapshot["status"][];
  limit?: number;
  offset?: number;
}

export interface WalletAlphaSignalQuery {
  strategyVersion?: string;
  statuses?: WalletAlphaSignalEvidence["status"][];
  limit?: number;
  offset?: number;
}

export interface WalletAlphaDetail {
  walletAddress: string;
  latestScore: WalletAlphaScoreSnapshot;
  scoreHistory: WalletAlphaScoreSnapshot[];
  recentTrades: WalletTradeEvidence[];
  episodes: WalletPositionEpisode[];
  lots: WalletPositionLot[];
}

export type SignalOutboxDestination = "paper" | "alert";
export type SignalOutboxStatus = "pending" | "processing" | "retry" | "delivered" | "dead_letter";

export interface SignalOutboxMessage {
  id: string;
  signalId: string;
  destination: SignalOutboxDestination;
  eventType: "wallet-alpha-signal";
  payload: Record<string, unknown>;
  status: SignalOutboxStatus;
  attemptCount: number;
  availableAt: string;
  createdAt: string;
  deliveredAt?: string;
  lockedBy?: string;
  lockedAt?: string;
  lockExpiresAt?: string;
  lastError?: string;
}

export interface SignalOutboxClaimOptions {
  destination: SignalOutboxDestination;
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
}

export interface SignalOutboxFailureOptions {
  maxAttempts?: number;
  retryAt?: string;
}

export interface IntelligenceRepository {
  upsertToken(token: TokenSnapshot): Promise<void>;
  upsertPool(pool: PoolSnapshot): Promise<void>;
  saveSignal(signal: Signal): Promise<void>;
  saveWalletScore(score: WalletScore): Promise<void>;
  saveTokenRisk(report: TokenRiskReport): Promise<void>;
  savePaperTrade(trade: PaperTrade): Promise<void>;
  saveBacktestRun(run: BacktestRun): Promise<void>;
  listRecentTokens(limit?: number): Promise<TokenSnapshot[]>;
  listTokenCreatorAddresses(): Promise<string[]>;
  listMatchingTokenCreatorAddresses(walletAddresses: string[]): Promise<string[]>;
  listRecentPools(limit?: number): Promise<PoolSnapshot[]>;
  getPool(chain: ChainId, poolAddress: string): Promise<PoolSnapshot | undefined>;
  getToken(chain: ChainId, address: string): Promise<TokenSnapshot | undefined>;
  getTokenRisk(chain: ChainId, address: string): Promise<TokenRiskReport | undefined>;
  listSignals(limit?: number): Promise<Signal[]>;
  listWalletRankings(limit?: number): Promise<WalletScore[]>;
  getWallet(address: string): Promise<WalletScore | undefined>;
  listPaperTrades(limit?: number): Promise<PaperTrade[]>;
  listBacktestRuns(limit?: number): Promise<BacktestRun[]>;
  listProviderStatus(): Promise<ProviderStatus[]>;
}

export interface EvidenceRepository {
  savePriceObservation(observation: PriceObservationEvidence): Promise<boolean>;
  saveQuotePriceObservation(observation: QuotePriceObservation): Promise<boolean>;
  findQuotePriceObservationNear(
    chain: ChainId,
    quoteTokenAddress: string,
    publishTime: string,
    maxDistanceSeconds?: number
  ): Promise<QuotePriceObservation | undefined>;
  saveOnchainSwap(swap: OnchainSwapEvidence): Promise<boolean>;
  saveHistoricalMarketObservation(observation: HistoricalMarketObservation): Promise<boolean>;
  getHistoricalBackfillWindow(
    runId: string,
    stage: HistoricalBackfillWindow["stage"],
    address: string,
    windowStartUnix: number,
    windowEndUnix: number
  ): Promise<HistoricalBackfillWindow | undefined>;
  upsertHistoricalBackfillWindow(window: HistoricalBackfillWindow): Promise<void>;
  getHistoricalBackfillWindowSummary(runId: string): Promise<{
    completed: number;
    saturated: number;
    running: number;
    error: number;
  }>;
  getHistoricalBackfillRequestCount(runId: string): Promise<number>;
  materializeHistoricalMarketBuckets(
    strategyVersion: string,
    intervalMinutes?: number
  ): Promise<number>;
  materializeHistoricalWalletFlowEvidence(strategyVersion: string): Promise<number>;
  saveWalletEntrySignal(signal: WalletEntrySignalEvidence): Promise<boolean>;
  saveWalletTradeEvent(trade: WalletTradeEvidence): Promise<boolean>;
  enrichWalletTradePrices(
    observation: PriceObservationEvidence,
    queueAdmission?: WalletAlphaQueueAdmission
  ): Promise<number>;
  materializeHistoricalWalletTrades(strategyVersion: string): Promise<number>;
  saveWalletAlphaScore(score: WalletAlphaScoreSnapshot): Promise<void>;
  replaceWalletPositionLedger(
    snapshot: WalletPositionLedgerSnapshot
  ): Promise<WalletPositionLedgerWriteResult>;
  claimWalletAlphaWork(options: WalletAlphaWorkClaimOptions): Promise<WalletAlphaWorkItem[]>;
  listWalletAlphaWorkCandidates(
    strategyVersion: string,
    limit?: number,
    priorities?: Pick<WalletAlphaWorkClaimOptions, "minimumPriority" | "maximumPriority">
  ): Promise<WalletAlphaWorkCandidate[]>;
  probeWalletAlphaAdmission(
    candidates: WalletAlphaWorkCandidate[],
    minEntryObservedAt: string,
    minimumTradeEvents: number,
    minimumEntries: number
  ): Promise<WalletAlphaAdmissionProbe[]>;
  probeWalletAlphaEvidenceBounds(
    item: WalletAlphaWorkItem,
    minObservedAt: string,
    maximumTradeEvents: number,
    maximumEntries: number,
    maximumOutcomes: number
  ): Promise<WalletAlphaEvidenceBounds>;
  completeWalletAlphaWork(item: WalletAlphaWorkItem): Promise<boolean>;
  failWalletAlphaWork(
    item: WalletAlphaWorkItem,
    error: string,
    retrySeconds?: number,
    failureClass?: WalletAlphaWorkFailureClass
  ): Promise<boolean>;
  getWalletAlphaWorkSummary(strategyVersion: string): Promise<WalletAlphaWorkSummary>;
  getWalletAlphaStatusCounts(strategyVersion: string): Promise<WalletAlphaStatusCounts>;
  getWalletAlphaCoverageSummary(
    strategyVersion: string,
    minObservedAt: string
  ): Promise<WalletAlphaCoverageSummary>;
  saveWalletAlphaSignal(signal: WalletAlphaSignalEvidence): Promise<boolean>;
  saveWalletSignalOutcome(outcome: WalletSignalOutcomeEvidence): Promise<boolean>;
  saveWalletSignalOutcomes(outcomes: WalletSignalOutcomeEvidence[]): Promise<number>;
  saveHypothesisRun(run: HypothesisRunEvidence): Promise<boolean>;
  upsertIngestionCursor(cursor: IngestionCursorEvidence): Promise<void>;
  getIngestionCursor(source: string, address: string): Promise<IngestionCursorEvidence | undefined>;
  listPriceObservations(
    tokenAddress?: string,
    strategyVersion?: string,
    minObservedAt?: string
  ): Promise<PriceObservationEvidence[]>;
  listPendingOnchainBuySwaps(tokenAddress?: string, limit?: number): Promise<OnchainSwapEvidence[]>;
  countPriorWalletEntryTokens(
    walletAddress: string,
    beforeObservedAt: string,
    strategyVersion: string
  ): Promise<number>;
  listWalletEntrySignals(
    walletAddress?: string,
    strategyVersion?: string,
    minObservedAt?: string
  ): Promise<WalletEntrySignalEvidence[]>;
  listWalletEntrySignalsForWallets(
    walletAddresses: string[],
    strategyVersion: string,
    minObservedAt?: string,
    maxRows?: number
  ): Promise<WalletEntrySignalEvidence[]>;
  listWalletTradeEvents(
    walletAddress?: string,
    strategyVersion?: string,
    minObservedAt?: string
  ): Promise<WalletTradeEvidence[]>;
  listWalletTradeEventsForWallets(
    walletAddresses: string[],
    strategyVersion: string,
    minObservedAt?: string,
    maxRows?: number
  ): Promise<WalletTradeEvidence[]>;
  listWalletAlphaScores(
    strategyVersion?: string,
    limit?: number
  ): Promise<WalletAlphaScoreSnapshot[]>;
  listWalletAlphaSignals(
    strategyVersion?: string,
    limit?: number
  ): Promise<WalletAlphaSignalEvidence[]>;
  listWalletSignalOutcomes(
    status?: WalletSignalOutcomeEvidence["status"],
    strategyVersion?: string,
    minObservedAt?: string
  ): Promise<WalletSignalOutcomeEvidence[]>;
  listWalletSignalOutcomesForWallets(
    walletAddresses: string[],
    strategyVersion: string,
    minObservedAt?: string,
    maxRows?: number
  ): Promise<WalletSignalOutcomeEvidence[]>;
  listHypothesisRuns(hypothesisKey?: string): Promise<HypothesisRunEvidence[]>;
}

export interface CanonicalRepository {
  assertReady(): Promise<void>;
  admitSolanaSignature(item: DurableSolanaSignature): Promise<boolean>;
  listPendingSolanaSignatures(
    provider: string,
    address: string,
    limit: number
  ): Promise<DurableSolanaSignature[]>;
  completeSolanaSignature(
    provider: string,
    address: string,
    signature: string,
    completedAt?: string
  ): Promise<boolean>;
  getSolanaSignatureQueueSummary(provider?: string): Promise<DurableSolanaSignatureQueueSummary>;
  listPendingSolanaFinalities(
    limit: number,
    minimumAgeSeconds: number
  ): Promise<SolanaFinalityWorkItem[]>;
  reconcileTerminalSolanaFinalityEvents(limit: number): Promise<SolanaFinalityBatchResult>;
  recordSolanaFinalities(
    results: Array<{ signature: string; result: SolanaFinalityResult }>
  ): Promise<SolanaFinalityBatchResult>;
  insertChainEvent(event: CanonicalChainEventInput): Promise<boolean>;
  insertChainEvents(
    events: CanonicalChainEventInput[]
  ): Promise<{ inserted: number; duplicates: number }>;
  claimChainEvents(options: CanonicalEventClaimOptions): Promise<CanonicalChainEvent[]>;
  completeChainEvent(
    idempotencyKey: string,
    workerId: string,
    processedAt?: string
  ): Promise<boolean>;
  failChainEvent(
    idempotencyKey: string,
    workerId: string,
    error: string,
    options?: CanonicalEventFailureOptions
  ): Promise<CanonicalEventFailureResult | undefined>;
  upsertPipelineWatermark(watermark: PipelineWatermark): Promise<boolean>;
  getPipelineWatermark(
    pipeline: string,
    partitionKey?: string
  ): Promise<PipelineWatermark | undefined>;
  openIngestionCoverageIncident(
    incident: IngestionCoverageIncidentOpenInput
  ): Promise<IngestionCoverageIncident>;
  listOpenIngestionCoverageIncidents(provider?: string): Promise<IngestionCoverageIncident[]>;
  markIngestionCoverageIncidentRestart(
    idempotencyKey: string,
    phase: "attempted" | "completed" | "failed",
    at: string,
    error?: string
  ): Promise<boolean>;
  closeIngestionCoverageIncident(
    idempotencyKey: string,
    input: IngestionCoverageIncidentCloseInput
  ): Promise<boolean>;
  getOrCreateIngestionGapRepair(input: IngestionGapRepairCreateInput): Promise<IngestionGapRepair>;
  stageIngestionGapRepairPage(input: IngestionGapRepairPageInput): Promise<IngestionGapRepair>;
  listPendingIngestionGapRepairSignatures(
    repairId: string,
    limit: number
  ): Promise<IngestionGapRepairSignature[]>;
  completeIngestionGapRepairSignature(
    repairId: string,
    signature: string,
    completedAt?: string
  ): Promise<boolean>;
  recordIngestionGapRepairError(
    repairId: string,
    phase: "collection" | "replay",
    error: string
  ): Promise<boolean>;
  completeIngestionGapRepair(
    repairId: string,
    coveredThrough: { signature: string; slot: number; completedAt?: string }
  ): Promise<boolean>;
  verifyIngestionGapRepairTarget(
    repairId: string,
    proof: {
      signature: string;
      slot: number;
      confirmationStatus: "finalized";
      verifiedAt?: string;
    }
  ): Promise<boolean>;
  getPipelineHealth(): Promise<PipelineHealthSummary>;
  listWalletAlphaRankings(query?: WalletAlphaRankingQuery): Promise<WalletAlphaScoreSnapshot[]>;
  getWalletAlphaDetail(
    walletAddress: string,
    strategyVersion?: string
  ): Promise<WalletAlphaDetail | undefined>;
  listWalletAlphaSignalFeed(query?: WalletAlphaSignalQuery): Promise<WalletAlphaSignalEvidence[]>;
  claimSignalOutbox(options: SignalOutboxClaimOptions): Promise<SignalOutboxMessage[]>;
  completeSignalOutbox(id: string, workerId: string, deliveredAt?: string): Promise<boolean>;
  failSignalOutbox(
    id: string,
    workerId: string,
    error: string,
    options?: SignalOutboxFailureOptions
  ): Promise<SignalOutboxMessage | undefined>;
}

export type ApplicationRepository = IntelligenceRepository &
  EvidenceRepository &
  CanonicalRepository;
