export type ChainId = "solana" | "ethereum" | "base" | "bnb" | "arbitrum" | "polygon";

export type SignalActionCategory =
  "ignore" | "high-risk warning" | "watchlist" | "research candidate" | "paper-trade candidate";

export type WalletCategory =
  | "alpha_wallet"
  | "copyable_smart_wallet"
  | "insider_dev_linked"
  | "sniper_bot"
  | "bundler_cluster"
  | "market_maker"
  | "noise_wallet"
  | "high_risk_wallet";

export type NormalizedEventType =
  | "token_profile"
  | "token_created"
  | "pool_created"
  | "swap"
  | "liquidity_added"
  | "liquidity_removed"
  | "authority_changed"
  | "holder_snapshot"
  | "risk_assessed"
  | "signal_generated";

export interface TokenSnapshot {
  chain: ChainId;
  address: string;
  symbol: string;
  name: string;
  decimals?: number;
  creatorAddress?: string;
  firstSeenAt: string;
  metadata: Record<string, unknown>;
}

export interface PoolSnapshot {
  chain: ChainId;
  poolAddress: string;
  dex: string;
  baseTokenAddress: string;
  quoteTokenAddress?: string;
  createdAt?: string;
  liquidityUsd: number;
  tokenSymbol?: string;
  tokenName?: string;
  priceUsd?: number;
  marketCapUsd?: number;
  volume5mUsd: number;
  volume1hUsd: number;
  txns5m: {
    buys: number;
    sells: number;
  };
  raw?: Record<string, unknown>;
}

export interface QualifiedPoolNotification {
  /**
   * Missing on the legacy broad-alert cohort. A present value identifies the
   * immutable admission policy that produced this future-only notification.
   */
  qualificationVersion?: string;
  tokenAddress: string;
  poolAddress: string;
  tokenSymbol: string;
  tokenName: string;
  dex: string;
  createdAt: string;
  liquidityUsd: number;
  volume5mUsd: number;
  priceUsd?: number;
  marketCapUsd?: number;
  riskScore: number;
  riskConfidence: number;
  riskAssessedAt?: string;
  poolAgeMinutes?: number;
  buys5m?: number;
  sells5m?: number;
  transactions5m?: number;
  buyShare5m?: number;
  volumeLiquidityRatio?: number;
  top10HolderPercent?: number;
  tradeCoverageComplete?: boolean;
  researchMode?: "notify" | "shadow";
  parentQualificationVersion?: string;
}

export const STRICT_QUALIFIED_POOL_NOTIFICATION_VERSION = "strict-flow-v2-20260817";
export const CAUSAL_WALLET_SHADOW_QUALIFICATION_VERSION = "strict-flow-v4-causal-shadow-20260822";

/**
 * Frozen prospective alert policy. Changing any threshold requires a new
 * version and activation boundary; do not silently tune this cohort in place.
 */
export const strictQualifiedPoolNotificationPolicy = {
  version: STRICT_QUALIFIED_POOL_NOTIFICATION_VERSION,
  minimumPoolAgeMinutes: 5,
  minimumTransactions5m: 20,
  minimumBuyShare5m: 0.5,
  maximumBuyShare5mExclusive: 0.6,
  maximumVolumeLiquidityRatioExclusive: 0.5,
  maximumTop10HolderPercentExclusive: 20,
  minimumRiskConfidence: 90,
  requireZeroRiskScore: true,
  requireCompleteTradeCoverage: true
} as const;

export interface PipelineStatusNotification {
  checkedAt: string;
  pipelineStatus: "ok" | "degraded";
  inboxBacklog: number;
  deadLetters: number;
  alphaQueuePending: number;
  alphaQueueReady?: number;
  alphaQueueFailed?: number;
  alphaQueueQuarantined?: number;
  alphaQueueBackgroundPending?: number;
  alphaQueueElevatedPending?: number;
  alphaQueueSignalPending?: number;
  alphaQueueOldestReadyAgeSeconds?: number;
  alphaQueueOldestSignalReadyAgeSeconds?: number;
  signals24h: number;
  qualifiedPools24h: number;
  lastPoolAgeSeconds?: number;
  lastWalletTradeAgeSeconds?: number;
  databaseBytes: number;
  openCoverageIncidentCount?: number;
  openCoverageIncidents?: IngestionCoverageIncidentStatus[];
  coverageTransition?: IngestionCoverageIncidentTransition;
  operationalHealth?: {
    checkedAt: string;
    status: "ok" | "degraded" | "down" | "unavailable";
    reasons: string[];
    diskAvailableBytes?: number;
    diskUsedPercent?: number;
    databaseBytes?: number;
    chainPayloadCompactionLagSeconds?: number;
    backupAgeSeconds?: number;
    backupOffsiteAcknowledged?: boolean;
  };
}

export interface IngestionCoverageIncidentStatus {
  incidentId: string;
  programAddress: string;
  provider: string;
  reason: string;
  gapStartedAt: string;
  openedAt: string;
  clusterSlot?: number;
  sourceSlot?: number;
  slotLag?: number;
  silenceMs?: number;
  coverageDisposition: "alpha_excluded_unreconciled" | "reconciled";
}

export interface IngestionCoverageIncidentTransition extends IngestionCoverageIncidentStatus {
  transition: "opened" | "transport-recovered" | "coverage-reconciled";
  transitionAt: string;
}

export type PaperTradeNotificationAction =
  "portfolio-started" | "opened" | "partial-exit" | "closed" | "rugged";

export interface PaperTradeNotification {
  action: PaperTradeNotificationAction;
  strategyVersion: string;
  occurredAt: string;
  balanceUsd: number;
  startingBalanceUsd: number;
  openPositionCount: number;
  reason: string;
  tokenAddress?: string;
  tokenSymbol?: string;
  poolAddress?: string;
  tradeId?: string;
  priceUsd?: number;
  quantity?: number;
  notionalUsd?: number;
  proceedsUsd?: number;
  pnlUsd?: number;
  returnPercent?: number;
  liquidityUsd?: number;
}

export interface HolderSnapshot {
  holderCount: number;
  topHolderPercent: number;
  top10HolderPercent: number;
  capturedAt: string;
}

export interface LiquiditySnapshot {
  liquidityUsd: number;
  fdvUsd?: number;
  marketCapUsd?: number;
  poolAgeMinutes?: number;
}

export interface VolumeSnapshot {
  volume5mUsd: number;
  volume1hUsd: number;
  buys5m: number;
  sells5m: number;
}

export interface NormalizedEvent<TPayload = Record<string, unknown>> {
  idempotencyKey: string;
  chain: ChainId;
  provider: string;
  type: NormalizedEventType;
  tokenAddress?: string;
  poolAddress?: string;
  signature?: string;
  slot?: number;
  blockNumber?: number;
  observedAt: string;
  payload: TPayload;
}

export interface TokenFeatures {
  tokenAgeMinutes: number;
  liquidityUsd: number;
  volume5mUsd: number;
  volume1hUsd: number;
  uniqueBuyers5m: number;
  buys5m: number;
  sells5m: number;
  topHolderPercent: number;
  top10HolderPercent: number;
  smartWalletCount: number;
  averageSmartWalletScore: number;
  creatorReputationScore: number;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  metadataComplete: boolean;
  duplicateBrandingSuspected: boolean;
  liquidityRemovedRecently: boolean;
  insiderClusterPercent: number;
  washTradingSuspicion: number;
  botActivityPercent: number;
  featureEvidence?: {
    uniqueBuyers5m?: "observed" | "estimated";
    top10HolderPercent?: "observed" | "estimated";
  };
}

export interface WalletFeatures {
  walletAddress: string;
  chain: ChainId;
  earlyEntries: number;
  winnersEnteredEarly: number;
  medianRoiPercent: number;
  meanRoiPercent: number;
  winRate: number;
  profitFactor: number;
  averageHoldMinutes: number;
  exitDisciplineScore: number;
  rugAvoidanceRate: number;
  ruggedTokenCount: number;
  copyabilityScore: number;
  clusterCorrelation: number;
  deployerOverlap: number;
  sniperTimingScore: number;
  recentDecayFactor: number;
}

export interface ScoreBreakdown {
  score: number;
  riskScore: number;
  confidence: number;
  subScores: Record<string, number>;
  reasons: string[];
  warnings: string[];
}

export interface WalletScore {
  chain: ChainId;
  walletAddress: string;
  score: number;
  category: WalletCategory;
  calculatedAt: string;
  reasons: string[];
  features: WalletFeatures;
}

export interface Signal {
  id: string;
  strategyVersion: string;
  chain: ChainId;
  tokenAddress: string;
  tokenSymbol: string;
  poolAddress?: string;
  signalType: string;
  confidence: number;
  riskScore: number;
  tokenScore: number;
  detectedAt: string;
  keyReasons: string[];
  wallets: WalletScore[];
  liquiditySnapshot: LiquiditySnapshot;
  volumeSnapshot: VolumeSnapshot;
  holderSnapshot: HolderSnapshot;
  actionCategory: SignalActionCategory;
  noFinancialAdvice: true;
}

export interface PaperTrade {
  id: string;
  strategyVersion: string;
  signalId: string;
  chain: ChainId;
  tokenAddress: string;
  side: "buy" | "sell";
  status: "open" | "closed" | "rejected";
  quantity: number;
  priceUsd: number;
  notionalUsd: number;
  feesUsd: number;
  slippageBps: number;
  openedAt: string;
  closedAt?: string;
  pnlUsd?: number;
  reason: string;
  raw?: Record<string, unknown>;
}

export interface BacktestMetrics {
  totalPnlUsd: number;
  finalBalanceUsd: number;
  executedTradeCount: number;
  rejectedSignalCount: number;
  capitalRejectedCount: number;
  positionLimitRejectedCount: number;
  failedFillCount: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownUsd: number;
  maxDrawdownPercent: number;
  medianReturnPercent: number;
  averageReturnPercent: number;
  tailLossPercent: number;
  averageTimeInTradeMinutes: number;
  rugExposureRate: number;
  liquidityFailureRate: number;
  signalPrecisionByConfidence: Record<string, number>;
}

export interface BacktestRun {
  id: string;
  strategyVersion: string;
  startedAt: string;
  finishedAt: string;
  dateStart: string;
  dateEnd: string;
  config: Record<string, unknown>;
  metrics: BacktestMetrics;
  reportMarkdown: string;
}

export interface ProviderStatus {
  provider: string;
  chain?: ChainId;
  status: "ok" | "degraded" | "down" | "not_configured";
  checkedAt: string;
  latencyMs?: number;
  message: string;
}

export interface EvidenceMetadata {
  idempotencyKey: string;
  chain: ChainId;
  signature: string;
  slot: number;
  provider: string;
  observedAt: string;
  strategyVersion: string;
}

export interface PriceObservationEvidence extends EvidenceMetadata {
  tokenAddress: string;
  poolAddress?: string;
  priceUsd: number;
  liquidityUsd: number;
  rugged: boolean;
  raw: Record<string, unknown>;
}

export interface OnchainSwapEvidence extends EvidenceMetadata {
  poolAddress: string;
  traderAddress: string;
  inputTokenAddress: string;
  outputTokenAddress: string;
  inputAmount?: number;
  outputAmount?: number;
  priceUsd?: number;
  volumeUsd?: number;
  raw: Record<string, unknown>;
}

export type WalletTradeSide = "buy" | "sell";

/**
 * Lossless token quantity for ledger and persistence boundaries. `rawAmount`
 * is an unsigned base-unit integer; presentation code may derive a decimal
 * value using `decimals` without making the raw integer pass through a JS
 * `number`.
 */
export interface TokenAmount {
  rawAmount: string;
  decimals: number;
}

export type WalletTradePriceQuality =
  "observed-execution" | "oracle-converted" | "market-proxy" | "historical-estimate";

export type WalletTradeDataQuality =
  | "observed-execution"
  | "oracle-converted"
  | "observed-balance"
  | "price-proxy"
  | "market-proxy"
  | "historical-observed"
  | "historical-estimate";

/** Canonical, fixed-point-friendly swap leg emitted by venue decoders. */
export interface WalletTradeLeg {
  idempotencyKey: string;
  chain: ChainId;
  signature: string;
  slot: number;
  transactionIndex?: number;
  instructionIndex: number;
  innerInstructionIndex?: number;
  occurredAt: string;
  walletAddress: string;
  tokenAddress: string;
  quoteTokenAddress?: string;
  poolAddress?: string;
  side: WalletTradeSide;
  baseAmount: TokenAmount;
  quoteAmount?: TokenAmount;
  executionPriceUsd?: string;
  quoteValueUsd?: string;
  priceQuality: WalletTradePriceQuality;
  decoderVersion: string;
}

export interface WalletTradeEvidence extends EvidenceMetadata {
  walletAddress: string;
  tokenAddress: string;
  quoteTokenAddress?: string;
  poolAddress?: string;
  side: WalletTradeSide;
  /** Legacy display quantity. Prefer `baseTokenAmount` for new writes. */
  baseAmount: number;
  baseTokenAmount?: TokenAmount;
  quoteAmount?: number;
  quoteTokenAmount?: TokenAmount;
  executionPriceUsd?: number;
  executionPriceUsdDecimal?: string;
  quoteValueUsd?: number;
  quoteValueUsdDecimal?: string;
  poolCreatedAt?: string;
  poolAgeMinutes?: number;
  dataQuality: WalletTradeDataQuality;
  priceQuality?: WalletTradePriceQuality;
  transactionIndex?: number;
  instructionIndex?: number;
  innerInstructionIndex?: number;
  decoderVersion?: string;
  raw: Record<string, unknown>;
}

export type WalletAlphaStatus =
  "insufficient" | "observed" | "watch" | "candidate" | "validated-paper" | "excluded";

export interface WalletAlphaReturnMetrics {
  sampleCount: number;
  averageReturnPct: number;
  medianReturnPct: number;
  averageReturnExBestPct: number;
  bestWinnerShare: number;
  hitRate: number;
  profitFactor: number;
  worstReturnPct: number;
  maxDrawdownPct: number;
  /** Conservative 95% Wilson lower bound for the observed hit rate. */
  hitRateWilsonLowerBound?: number;
  /** Beta-prior shrinkage toward a neutral 50% hit rate. */
  shrunkHitRate?: number;
  /** Sample-size reliability in [0, 1], using n / (n + 10). */
  sampleReliability?: number;
  /** Explicit terminal-rug outcomes in this return series. */
  ruggedOutcomeCount?: number;
  /** Terminal-rug frequency in [0, 1]. */
  ruggedOutcomeRate?: number;
  /** Outcomes at or below the policy's catastrophic-loss boundary. */
  catastrophicLossCount?: number;
  /** Catastrophic-loss frequency in [0, 1]. */
  catastrophicLossRate?: number;
  /** Mean of the worst 10% of outcomes (at least one observation). */
  lowerTailAverageReturnPct?: number;
  /** Longest chronological run of negative outcomes. */
  maximumConsecutiveLosses?: number;
}

export interface WalletAlphaMetrics {
  completedPositions: number;
  eligibleEarlyPositions: number;
  uniqueTokens: number;
  activeDays: number;
  exactPositionCount: number;
  estimatedPositionCount: number;
  highQualityPositionCount?: number;
  highQualityExecutionCoverage?: number;
  openInventoryCount?: number;
  openInventoryCostUsd?: number;
  profitability: WalletAlphaReturnMetrics;
  followability: WalletAlphaReturnMetrics;
  profitability30d?: WalletAlphaReturnMetrics;
  profitability90d?: WalletAlphaReturnMetrics;
  followability30d?: WalletAlphaReturnMetrics;
  followability90d?: WalletAlphaReturnMetrics;
  /** Scoring policy is explicit so persisted snapshots never silently mix models. */
  scoringPolicy?: "fixed-horizon-v1" | "managed-exit-v2";
  /** Canonical evidence namespace used to derive this score. */
  evidenceStrategyVersion?: string;
  /** Exit model used for the followability axis. */
  followabilityExitStrategy?: WalletSignalOutcomeEvidence["exitStrategy"];
  reliabilityScore?: number;
  recencyDecayFactor?: number;
  profitabilityHoldoutsPassed: boolean;
  followabilityHoldoutsPassed: boolean;
  directCreator: boolean;
}

export interface WalletAlphaGates {
  observed: boolean;
  watch: boolean;
  candidate: boolean;
  validatedPaper: boolean;
}

export interface WalletAlphaScoreSnapshot {
  chain: ChainId;
  walletAddress: string;
  strategyVersion: string;
  calculatedAt: string;
  status: WalletAlphaStatus;
  profitabilityScore: number;
  followabilityScore: number;
  overallScore: number;
  completedPositions: number;
  uniqueTokens: number;
  activeDays: number;
  metrics: WalletAlphaMetrics;
  gates: WalletAlphaGates;
  reasons: string[];
}

export interface WalletAlphaSignalEvidence {
  id: string;
  chain: ChainId;
  tokenAddress: string;
  poolAddress?: string;
  strategyVersion: string;
  detectedAt: string;
  observedPriceUsd: number;
  observedLiquidityUsd: number;
  confidence: number;
  status: "paper-watch" | "paper-candidate";
  walletAddresses: string[];
  evidence: Record<string, unknown>;
}

export interface HistoricalMarketObservation extends EvidenceMetadata {
  tokenAddress: string;
  quoteTokenAddress: string;
  poolAddress?: string;
  traderAddress?: string;
  side: "buy" | "sell";
  baseAmount: number;
  quoteAmount: number;
  priceQuote: number;
  priceUsdEstimate: number;
  volumeUsdEstimate: number;
  priceSource: string;
  confidence: number;
  raw: Record<string, unknown>;
}

export type HistoricalBackfillWindowStatus = "running" | "completed" | "saturated" | "error";

export interface HistoricalBackfillWindow {
  runId: string;
  stage: "program" | "pool" | "mint";
  address: string;
  windowStartUnix: number;
  windowEndUnix: number;
  status: HistoricalBackfillWindowStatus;
  pagesFetched: number;
  transactionsFetched: number;
  lastSignature?: string;
  lastSlot?: number;
  provider: string;
  strategyVersion: string;
  updatedAt: string;
  raw: Record<string, unknown>;
}

export interface WalletEntrySignalEvidence extends EvidenceMetadata {
  walletAddress: string;
  tokenAddress: string;
  poolAddress?: string;
  sourceSwapIdempotencyKey?: string;
  observedEntryPriceUsd: number;
  observedLiquidityUsd: number;
  cohort: string;
  repeatWalletCount: number;
  flowEvidence: Record<string, unknown>;
}

export type WalletSignalOutcomeStatus = "mature" | "provisional" | "unresolved";

export interface WalletSignalOutcomeEvidence extends EvidenceMetadata {
  entryIdempotencyKey: string;
  horizonMinutes: number;
  status: WalletSignalOutcomeStatus;
  outcomePriceUsd?: number;
  frozenAt?: string;
  grossReturnPct?: number;
  netReturnPct?: number;
  estimatedRoundTripCostPct: number;
  exitStrategy: "fixed-horizon" | "tp15-sl20-20m";
  rugged: boolean;
  raw: Record<string, unknown>;
}

export interface HypothesisRunMetrics {
  signalCount: number;
  averageReturnPct: number;
  medianReturnPct: number;
  averageReturnExBestPct: number;
  bestWinnerShare: number;
  hitRate: number;
  averageDrawdownPct: number;
  worstReturnPct: number;
  [key: string]: number;
}

export interface HypothesisRunEvidence extends EvidenceMetadata {
  runId: string;
  hypothesisKey: string;
  cohort: string;
  verdict: "reject" | "watch" | "candidate";
  signalKeys: string[];
  metrics: HypothesisRunMetrics;
  decisionReason: string;
}

export interface IngestionCursorEvidence extends EvidenceMetadata {
  source: string;
  address: string;
  lastSignature: string;
  lastSlot: number;
  lastEventOccurredAt?: string;
}

export interface RuntimeThresholds {
  minimumLiquidityUsd: number;
  minimumVolume5mUsd: number;
  maximumTopHolderPercent: number;
  maximumRugRisk: number;
  minimumSmartWalletScore: number;
  alertMinimumConfidence: number;
  paperPositionSizeUsd: number;
  maxOpenPaperPositions: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  timeExitMinutes: number;
}

export const clamp = (value: number, min = 0, max = 100): number =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

export const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export const nowIso = (): string => new Date().toISOString();

export const SAMPLE_TOKEN: TokenSnapshot = {
  chain: "solana",
  address: "Alpha111111111111111111111111111111111111111",
  symbol: "ALPHA",
  name: "Alpha Research Token",
  firstSeenAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
  metadata: {
    source: "sample",
    description: "Deterministic demo token used when no provider key is configured."
  }
};

export const SAMPLE_POOL: PoolSnapshot = {
  chain: "solana",
  poolAddress: "Pool1111111111111111111111111111111111111111",
  dex: "raydium",
  baseTokenAddress: SAMPLE_TOKEN.address,
  quoteTokenAddress: "So11111111111111111111111111111111111111112",
  createdAt: SAMPLE_TOKEN.firstSeenAt,
  liquidityUsd: 48250,
  priceUsd: 0.00042,
  volume5mUsd: 18750,
  volume1hUsd: 81200,
  txns5m: {
    buys: 96,
    sells: 31
  }
};

export const SAMPLE_HOLDER_SNAPSHOT: HolderSnapshot = {
  holderCount: 813,
  topHolderPercent: 18.4,
  top10HolderPercent: 42.8,
  capturedAt: nowIso()
};

export const SAMPLE_WALLET_FEATURES: WalletFeatures[] = [
  {
    walletAddress: "WalletAlpha1111111111111111111111111111111111",
    chain: "solana",
    earlyEntries: 47,
    winnersEnteredEarly: 32,
    medianRoiPercent: 210,
    meanRoiPercent: 320,
    winRate: 0.68,
    profitFactor: 4.6,
    averageHoldMinutes: 118,
    exitDisciplineScore: 86,
    rugAvoidanceRate: 0.92,
    ruggedTokenCount: 2,
    copyabilityScore: 84,
    clusterCorrelation: 0.08,
    deployerOverlap: 0.01,
    sniperTimingScore: 25,
    recentDecayFactor: 0.98
  },
  {
    walletAddress: "WalletCluster22222222222222222222222222222222",
    chain: "solana",
    earlyEntries: 91,
    winnersEnteredEarly: 24,
    medianRoiPercent: 29,
    meanRoiPercent: 210,
    winRate: 0.31,
    profitFactor: 1.6,
    averageHoldMinutes: 19,
    exitDisciplineScore: 39,
    rugAvoidanceRate: 0.52,
    ruggedTokenCount: 17,
    copyabilityScore: 24,
    clusterCorrelation: 0.91,
    deployerOverlap: 0.36,
    sniperTimingScore: 88,
    recentDecayFactor: 0.8
  }
];
