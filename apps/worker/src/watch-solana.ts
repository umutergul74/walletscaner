import "dotenv/config";
import { createHash } from "node:crypto";
import { statfs } from "node:fs/promises";
import {
  activePoolSampleDelayMs,
  createParsedInstructionPoolDecoder,
  createRawInstructionPoolDecoder,
  decodePoolDiscoveries,
  decodeRaydiumTradeInstructions,
  decodeWalletBuys,
  decodeWalletTrades,
  DexScreenerClient,
  HeliusEnhancedClient,
  HeliusWebhookAddressClient,
  HeliusTransactionEventSource,
  PythPriceClient,
  POOL_DISCOVERY_DECODER_VERSION,
  REVIEWED_SOLANA_VENUE_PROGRAMS,
  SolanaEventNotAcceptedError,
  StandardSolanaEventSource,
  type ActivePoolState,
  type DexScreenerPair,
  type PoolDiscovery,
  type PythUsdQuote,
  type RawBuyInstructionDefinition,
  type SolanaBackfillTruncation,
  type SolanaChainEvent,
  type SolanaCursorStore,
  type SolanaEventSource,
  type SolanaEventSourceDiagnostics
} from "@memecoin-alpha/providers";
import { recordFirstWalletEntry } from "@memecoin-alpha/core";
import {
  PostgresRepository,
  type CanonicalChainEvent,
  type WalletAlphaQueueAdmission
} from "@memecoin-alpha/db";
import type {
  NormalizedEvent,
  PoolSnapshot,
  PriceObservationEvidence,
  WalletTradePriceQuality
} from "@memecoin-alpha/shared";
import {
  creatorAddressFromAsset,
  fetchSolanaTokenRisk,
  passesSolanaRiskMarketGate,
  type SolanaTokenRiskAssessment
} from "./token-risk.js";
import { selectBoundedPoolSamplingBatch } from "./pool-sampling-budget.js";
import { shouldPersistPoolState } from "./pool-state-persistence.js";
import { walletEntryMaterializationDecision } from "./wallet-entry-policy.js";
import { BoundedTtlMap } from "./bounded-ttl-map.js";
import {
  isHeliusStandardWebSocket,
  resolveRpcTradeWsUrl,
  websocketProviderLabel
} from "./solana-trade-transport.js";
import { resolveDiscoveryWebSocketRoutes } from "./solana-discovery-transport.js";
import { compactDexScreenerPair } from "./evidence-sampling.js";
import {
  DiscoverySupervisor,
  fetchConfirmedSolanaSlot,
  fetchLatestSolanaAddressActivity,
  fetchSolanaSignatureStatus
} from "./discovery-supervisor.js";
import { bootstrapTradeSubscription, TradeCoverageReleaseCoordinator } from "./trade-coverage.js";
import {
  evaluateTradeObservationHealth,
  planTradeObservationAdmission
} from "./trade-observation-scheduler.js";
import {
  createSolanaFinalityDiagnostics,
  reconcileSolanaFinalityCycle
} from "./solana-finality.js";
import { discoveryBackfillProfile } from "./discovery-backfill-profile.js";
import { canonicalClaimRetryDecision } from "./postgres-retry.js";

interface ProgramConfig {
  programId: string;
  instructionTypes?: string[];
  rawInstructions?: Array<{
    name: string;
    discriminatorHex: string;
    poolAccountIndex: number;
    baseTokenAccountIndex?: number;
    quoteTokenAccountIndex?: number;
    tokenPairAccountIndexes?: [number, number];
    quoteTokenAddresses?: string[];
    creatorAccountIndex?: number;
    creatorDataEncoding?: "pump-borsh-after-3-strings";
  }>;
}

interface TrackedPool extends ActivePoolState {
  tokenAddress: string;
  quoteTokenAddress?: string;
  creatorAddress?: string;
  programId: string;
  signature: string;
  slot: number;
  previousLiquidityUsd: number | null;
  subscribedToBuys: boolean;
  everSubscribedToBuys: boolean;
  controlledFlow: boolean;
  lastPersistedMarketAtMs?: number;
  lastPersistedMarketEligible?: boolean;
  tokenRisk?: SolanaTokenRiskAssessment;
  tokenRiskAssessedAt?: string;
  tradeCoverageComplete: boolean;
  tradeCoveragePersisted: boolean;
  tradeCoverageGapAt?: string;
  tradeCoverageGapReason?: string;
  observationMarketEligible: boolean;
  observationSubscribedAtMs?: number;
}

interface FlowEvidence {
  controlledFlow: boolean;
  liquidityUsd: number;
  volume5mUsd: number;
  volume1hUsd: number;
  buys5m: number;
  sells5m: number;
  swaps5m: number;
  buyShare5m: number;
  minLiquidityUsd: number;
  minVolume5mUsd: number;
  maxSwaps5m: number;
  maxVolumeLiquidityRatio: number;
  volumeLiquidityRatio: number;
  poolAgeMinutes: number;
  tokenRiskKnown: boolean;
  tokenRiskPassed: boolean;
  tokenRiskScore: number;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  topHolderPercent: number;
  top10HolderPercent: number;
}

interface DuePoolSample {
  pool: TrackedPool;
  pair: DexScreenerPair;
  priceUsd: number;
  liquidityUsd: number;
  rugged: boolean;
  marketEligible: boolean;
}

type TradeIngestMode = "transaction-subscribe" | "webhook" | "rpc";

const databaseUrl = requiredEnv("DATABASE_URL");
const heliusApiKey = process.env.HELIUS_API_KEY?.trim();
const explicitRpcUrl = process.env.SOLANA_RPC_URL?.trim();
const explicitWsUrl = process.env.SOLANA_WS_URL?.trim();
const configuredRpcUrl = explicitRpcUrl ?? "https://api.mainnet-beta.solana.com";
const configuredWsUrl = explicitWsUrl ?? "wss://api.mainnet-beta.solana.com";
const rpcUrl = configuredRpcUrl;
const wsUrl = configuredWsUrl;
const heliusRpcUrl = heliusApiKey
  ? `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`
  : undefined;
const tokenRiskRpcUrl = process.env.SOLANA_TOKEN_RISK_RPC_URL?.trim() || rpcUrl;
const tokenRiskFallbackRpcUrl =
  process.env.SOLANA_TOKEN_RISK_FALLBACK_RPC_URL?.trim() ||
  (heliusRpcUrl && heliusRpcUrl !== tokenRiskRpcUrl ? heliusRpcUrl : undefined);
const heliusCreatorEnrichmentEnabled = parseBooleanEnv(
  process.env.HELIUS_CREATOR_ENRICHMENT_ENABLED,
  true
);
const heliusEnhancedClient =
  heliusApiKey && heliusCreatorEnrichmentEnabled
    ? new HeliusEnhancedClient(heliusApiKey)
    : undefined;
const legacyTransactionStreamEnabled = parseBooleanEnv(
  process.env.HELIUS_TRANSACTION_STREAM_ENABLED,
  false
);
const tradeIngestMode = parseTradeIngestMode(
  process.env.HELIUS_INGEST_MODE,
  legacyTransactionStreamEnabled ? "transaction-subscribe" : "rpc"
);
const heliusStandardTradeWsEnabled = parseBooleanEnv(
  process.env.HELIUS_STANDARD_TRADE_WS_ENABLED,
  false
);
const rpcTradeWsUrl = resolveRpcTradeWsUrl({
  configuredWsUrl: wsUrl,
  ...(process.env.SOLANA_TRADE_WS_URL
    ? { explicitTradeWsUrl: process.env.SOLANA_TRADE_WS_URL }
    : {}),
  ...(heliusApiKey ? { heliusApiKey } : {}),
  heliusStandardEnabled: heliusStandardTradeWsEnabled
});
const rpcTradeProvider = isHeliusStandardWebSocket(rpcTradeWsUrl)
  ? "helius-standard-ws-trade"
  : "solana-rpc-trade";
const transactionWsUrl =
  process.env.HELIUS_TRANSACTION_WS_URL?.trim() ||
  (heliusApiKey ? `wss://mainnet.helius-rpc.com/?api-key=${heliusApiKey}` : wsUrl);
if (tradeIngestMode === "transaction-subscribe" && isPublicSolanaWs(transactionWsUrl)) {
  throw new Error(
    "transaction-subscribe mode requires HELIUS_API_KEY or HELIUS_TRANSACTION_WS_URL."
  );
}
const webhookSyncIntervalMs =
  Number(process.env.HELIUS_WEBHOOK_SYNC_INTERVAL_MINUTES ?? 15) * 60_000;
const webhookManagementEnabled = parseBooleanEnv(
  process.env.HELIUS_WEBHOOK_MANAGEMENT_ENABLED,
  false
);
const strategyVersion = process.env.ALPHA_STRATEGY_VERSION ?? "evidence-v1";
const walletAlphaQueueAdmission: WalletAlphaQueueAdmission = {
  minimumTradeEvents: boundedInteger(process.env.WALLET_ALPHA_MIN_TRADE_EVENTS, 6, 1, 100),
  minimumEntries: boundedInteger(process.env.WALLET_ALPHA_MIN_ENTRIES, 3, 1, 100),
  sourceWindowDays: boundedInteger(process.env.WALLET_ALPHA_WINDOW_DAYS, 30, 1, 3_650)
};
const programs = parsePrograms(process.env.SOLANA_POOL_PROGRAMS_JSON);
const discoveryWebSocketRoutes = resolveDiscoveryWebSocketRoutes({
  configuredWsUrl: wsUrl,
  programIds: programs.map((program) => program.programId),
  ...(process.env.SOLANA_DISCOVERY_WS_SECONDARY_URL
    ? { secondaryWsUrl: process.env.SOLANA_DISCOVERY_WS_SECONDARY_URL }
    : {}),
  ...(process.env.SOLANA_DISCOVERY_WS_SECONDARY_PROGRAMS_JSON
    ? {
        secondaryProgramIdsJson: process.env.SOLANA_DISCOVERY_WS_SECONDARY_PROGRAMS_JSON
      }
    : {})
});
const discoveryWebSocketUrlByProgram = new Map(
  discoveryWebSocketRoutes.map((route) => [route.programId, route.wsUrl])
);
const minLiquidityUsd = Number(process.env.MIN_LIQUIDITY_USD ?? 10_000);
const minVolume5mUsd = Number(process.env.MIN_VOLUME_5M_USD ?? 5_000);
const maxSwaps5m = Number(process.env.MAX_SWAPS_5M ?? 300);
const maxVolumeLiquidityRatio = Number(process.env.MAX_VOLUME_LIQUIDITY_RATIO ?? 4);
const rpcTradeMaxActivePools = boundedInteger(process.env.RPC_TRADE_MAX_ACTIVE_POOLS, 3, 0, 20);
const rpcTradeMinimumObservationHoldMs =
  boundedInteger(process.env.RPC_TRADE_MINIMUM_OBSERVATION_HOLD_SECONDS, 300, 30, 3_600) * 1_000;
const rpcTradeMaximumQueueDelayMs = boundedInteger(
  process.env.RPC_TRADE_MAX_QUEUE_DELAY_MS,
  15_000,
  1_000,
  60_000
);
const heliusWebhookMaxPoolAddresses = Number(process.env.HELIUS_WEBHOOK_MAX_POOL_ADDRESSES ?? 20);
const standardSeenSignatureLimit = boundedInteger(
  process.env.SOLANA_SEEN_SIGNATURE_LIMIT,
  25_000,
  1_000,
  100_000
);
const knownPoolCacheMaxEntries = boundedInteger(
  process.env.KNOWN_POOL_CACHE_MAX_ENTRIES,
  25_000,
  1_000,
  100_000
);
const activePoolMaxEntries = boundedInteger(process.env.ACTIVE_POOL_MAX_ENTRIES, 1_000, 100, 5_000);
const poolSamplingMaxPoolsPerCycle = boundedInteger(
  process.env.POOL_SAMPLING_MAX_POOLS_PER_CYCLE,
  120,
  30,
  1_000
);
const poolStatePersistIntervalMs =
  boundedInteger(process.env.POOL_STATE_PERSIST_INTERVAL_SECONDS, 300, 60, 3_600) * 1_000;
const knownPoolRetentionMs =
  boundedInteger(process.env.KNOWN_POOL_RETENTION_HOURS, 168, 1, 720) * 60 * 60_000;
const tokenRiskCacheMaxEntries = boundedInteger(
  process.env.TOKEN_RISK_CACHE_MAX_ENTRIES,
  5_000,
  100,
  50_000
);
const maximumTopHolderPercent = Number(process.env.MAX_TOP_HOLDER_PERCENT ?? 35);
const tokenRiskUnknownTtlMs = Number(process.env.TOKEN_RISK_UNKNOWN_TTL_MINUTES ?? 10) * 60_000;
const ingestionDiskPausePercent = Number(process.env.INGESTION_DISK_PAUSE_PERCENT ?? 90);
const ingestionDiskResumePercent = Number(process.env.INGESTION_DISK_RESUME_PERCENT ?? 85);
const ingestionMinimumFreeBytes = Number(process.env.INGESTION_MINIMUM_FREE_BYTES ?? 4 * 1024 ** 3);
const walletEntryMaterializationBatchSize = Number(
  process.env.WALLET_ENTRY_MATERIALIZATION_BATCH_SIZE ?? 250
);
const dexScreenerSampleConcurrency = Number(process.env.DEXSCREENER_SAMPLE_CONCURRENCY ?? 4);
const canonicalEventProcessConcurrency = boundedInteger(
  process.env.CANONICAL_EVENT_PROCESS_CONCURRENCY,
  4,
  1,
  8
);
const canonicalEventClaimLimit = boundedInteger(
  process.env.CANONICAL_EVENT_CLAIM_LIMIT,
  canonicalEventProcessConcurrency * 2,
  canonicalEventProcessConcurrency,
  64
);
const canonicalEventLeaseSeconds = boundedInteger(
  process.env.CANONICAL_EVENT_LEASE_SECONDS,
  90,
  30,
  300
);
const historicalSolUsdBucketSeconds = boundedInteger(
  process.env.HISTORICAL_SOL_USD_BUCKET_SECONDS,
  60,
  5,
  60
);
const historicalSolUsdCacheMaxEntries = boundedInteger(
  process.env.HISTORICAL_SOL_USD_CACHE_MAX_ENTRIES,
  4_096,
  100,
  20_000
);
const historicalSolUsdProviderMinIntervalMs = boundedInteger(
  process.env.HISTORICAL_SOL_USD_PROVIDER_MIN_INTERVAL_MS,
  1_200,
  250,
  10_000
);
const repository = new PostgresRepository(databaseUrl);
const ingestionStartedAtMs = Date.now();
const finalityDiagnostics = createSolanaFinalityDiagnostics();
const finalityIntervalMs =
  boundedInteger(process.env.SOLANA_FINALITY_INTERVAL_SECONDS, 5, 2, 30) * 1_000;
const finalityBatchSize = boundedInteger(process.env.SOLANA_FINALITY_BATCH_SIZE, 256, 1, 256);
const finalityMinimumAgeSeconds = boundedInteger(
  process.env.SOLANA_FINALITY_MINIMUM_AGE_SECONDS,
  8,
  1,
  120
);
const finalityUnresolvedAfterSeconds = boundedInteger(
  process.env.SOLANA_FINALITY_UNRESOLVED_AFTER_SECONDS,
  300,
  60,
  3_600
);
const finalityMinimumRootDistanceSlots = boundedInteger(
  process.env.SOLANA_FINALITY_MINIMUM_ROOT_DISTANCE_SLOTS,
  150,
  32,
  10_000
);
const finalityRequestTimeoutMs = boundedInteger(
  process.env.SOLANA_FINALITY_REQUEST_TIMEOUT_MS,
  4_000,
  500,
  30_000
);

const tokenRiskDiagnostics = {
  primaryProvider: rpcProviderLabel(tokenRiskRpcUrl),
  fallbackProvider: tokenRiskFallbackRpcUrl ? rpcProviderLabel(tokenRiskFallbackRpcUrl) : null,
  primaryAttemptCount: 0,
  fallbackAttemptCount: 0,
  knownPassedCount: 0,
  knownFailedCount: 0,
  unknownCount: 0,
  errorCount: 0,
  creatorEnrichmentAttemptCount: 0,
  creatorEnrichmentSuccessCount: 0,
  creatorEnrichmentMissCount: 0,
  creatorEnrichmentErrorCount: 0
};
const walletEntryDiagnostics = {
  skippedUncontrolledPoolSamples: 0,
  deferredUnknownRiskPoolSamples: 0,
  skippedFailedRiskPoolSamples: 0,
  pendingSwapsConsidered: 0,
  entriesMaterialized: 0
};
const poolSamplingDiagnostics = {
  completedCycleCount: 0,
  skippedOverlappingCycleCount: 0,
  fetchErrorCount: 0,
  cycleErrorCount: 0,
  lastDurationMs: 0,
  lastDuePoolCount: 0,
  lastCandidateDuePoolCount: 0,
  lastDeferredPoolCount: 0,
  lastUniqueTokenCount: 0,
  lastBatchRequestCount: 0,
  lastSuccessfulSampleCount: 0,
  durablePriceObservationOwner: "evidence-sampler",
  durablePoolStateWriteCount: 0,
  skippedPoolStateWriteCount: 0,
  poolStatePersistIntervalSeconds: poolStatePersistIntervalMs / 1_000,
  liveMarketContextCount: 0,
  lastError: null as string | null,
  evictedActivePoolCount: 0,
  tradeQueuePressureCount: 0,
  tradeCoverageExcludedPoolCount: 0,
  tradeCoverageReleaseErrorCount: 0,
  lastTradeCoverageReleaseError: null as string | null
};
const tradeCoverageReleaseCoordinator = new TradeCoverageReleaseCoordinator();
const tradeObservationDiagnostics = {
  admissionCount: 0,
  replacementCount: 0,
  deferredCount: 0,
  lastAdmissionAt: null as string | null,
  lastReplacementAt: null as string | null,
  lastDeferredReason: null as string | null,
  minimumHoldSeconds: rpcTradeMinimumObservationHoldMs / 1_000,
  maximumActivePools: rpcTradeMaxActivePools
};
const canonicalParserDiagnostics = {
  claimCount: 0,
  claimedEventCount: 0,
  completedEventCount: 0,
  failedEventCount: 0,
  claimErrorCount: 0,
  consecutiveClaimErrorCount: 0,
  lastClaimErrorCode: null as string | null,
  lastClaimErrorAt: null as string | null,
  claimRetryAt: null as string | null,
  lastClaimDurationMs: 0,
  lastClaimedEventCount: 0
};
interface PoolDiscoveryProgramDiagnostics {
  sourceEventCount: number;
  decodedEventCount: number;
  unmatchedEventCount: number;
  decodedPoolCount: number;
  topLevelInstructionPoolCount: number;
  innerInstructionPoolCount: number;
}
const poolDiscoveryDiagnostics = {
  startedAt: new Date(ingestionStartedAtMs).toISOString(),
  sourceEventCount: 0,
  decodedEventCount: 0,
  unmatchedEventCount: 0,
  decodedPoolCount: 0,
  topLevelInstructionPoolCount: 0,
  innerInstructionPoolCount: 0,
  byProgram: new Map<string, PoolDiscoveryProgramDiagnostics>()
};
const historicalSolUsdDiagnostics = {
  memoryHitCount: 0,
  databaseHitCount: 0,
  providerRequestCount: 0,
  providerErrorCount: 0,
  providerRateLimitedCount: 0,
  sharedRequestCount: 0
};
const pythPrices = new PythPriceClient({
  ...(process.env.PYTH_HERMES_URL ? { hermesUrl: process.env.PYTH_HERMES_URL } : {}),
  ...(process.env.PYTH_BENCHMARKS_URL ? { benchmarksUrl: process.env.PYTH_BENCHMARKS_URL } : {}),
  ...(process.env.PYTH_API_KEY ? { apiKey: process.env.PYTH_API_KEY } : {}),
  maxStalenessSeconds: Number(process.env.PYTH_MAX_STALENESS_SECONDS ?? 90)
});
const solUsdFeedId =
  process.env.PYTH_SOL_USD_FEED_ID ??
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const discoveryCursorStore = createCursorStore("solana-program-discovery", "solana-rpc-discovery");
const tradeCursorStore = createCursorStore(
  tradeIngestMode === "webhook" ? "helius-webhook-trades" : "helius-pool-transactions",
  tradeIngestMode === "transaction-subscribe"
    ? "helius-transaction-subscribe"
    : tradeIngestMode === "webhook"
      ? "helius-webhook"
      : rpcTradeProvider
);
const discoveryProvider = "solana-rpc-discovery";
const discoverySourceCount = programs.length;
const discoveryBackfill = discoveryBackfillProfile();
const discoveryAggregateMaxConcurrentFetches = boundedInteger(
  process.env.SOLANA_DISCOVERY_MAX_CONCURRENT_TRANSACTION_FETCHES,
  128,
  discoverySourceCount,
  512
);
const discoveryAggregateMaxQueuedSignatures = boundedInteger(
  process.env.SOLANA_DISCOVERY_MAX_QUEUED_SIGNATURES,
  2_000,
  discoverySourceCount,
  10_000
);
const discoveryMaxConcurrentPerProgram = boundedInteger(
  process.env.SOLANA_DISCOVERY_MAX_CONCURRENT_PER_PROGRAM,
  4,
  1,
  8
);
const discoverySentinelIntervalMs =
  boundedInteger(process.env.SOLANA_DISCOVERY_SENTINEL_INTERVAL_SECONDS, 30, 15, 300) * 1_000;
const discoverySentinelTimeoutMs = boundedInteger(
  process.env.SOLANA_DISCOVERY_SENTINEL_TIMEOUT_MS,
  3_000,
  500,
  10_000
);
const discoverySentinelRetries = boundedInteger(
  process.env.SOLANA_DISCOVERY_SENTINEL_RETRIES,
  1,
  0,
  2
);
const discoveryHeartbeatIntervalMs =
  boundedInteger(process.env.SOLANA_DISCOVERY_HEARTBEAT_INTERVAL_SECONDS, 30, 10, 120) * 1_000;
const discoveryHeartbeatTimeoutMs = boundedInteger(
  process.env.SOLANA_DISCOVERY_HEARTBEAT_TIMEOUT_MS,
  10_000,
  1_000,
  30_000
);
const discoveryReconnectInitialDelayMs = boundedInteger(
  process.env.SOLANA_DISCOVERY_RECONNECT_INITIAL_MS,
  1_000,
  250,
  10_000
);
const discoveryReconnectMaxDelayMs = boundedInteger(
  process.env.SOLANA_DISCOVERY_RECONNECT_MAX_MS,
  5_000,
  discoveryReconnectInitialDelayMs,
  30_000
);
const discoveryReconnectStableAfterMs = boundedInteger(
  process.env.SOLANA_DISCOVERY_RECONNECT_STABLE_AFTER_MS,
  60_000,
  10_000,
  300_000
);
const discoveryGapRepairReplayLimit = boundedInteger(
  process.env.SOLANA_DISCOVERY_GAP_REPAIR_REPLAY_LIMIT,
  50,
  1,
  100
);
const discoveryGapRepairMaxSignatures = boundedInteger(
  process.env.SOLANA_DISCOVERY_GAP_REPAIR_MAX_SIGNATURES,
  500,
  500,
  100_000
);
const discoveryProgramSources = programs.map((program) => ({
  programId: program.programId,
  probeLatestActivity: () =>
    fetchLatestSolanaAddressActivity({
      rpcUrl,
      provider: discoveryProvider,
      address: program.programId,
      timeoutMs: discoverySentinelTimeoutMs,
      // The sentinel itself is periodic. Keep each disambiguation probe to one
      // bounded HTTP attempt so several quiet programs cannot stack retries.
      retries: 0
    }),
  probeSignatureStatus: (signature: string) =>
    fetchSolanaSignatureStatus({
      rpcUrl,
      provider: discoveryProvider,
      signature,
      timeoutMs: discoverySentinelTimeoutMs,
      retries: 0
    }),
  source: new StandardSolanaEventSource({
    rpcUrl,
    wsUrl: discoveryWebSocketUrlByProgram.get(program.programId)!,
    addresses: [program.programId],
    logIncludesByAddress: {
      [program.programId]:
        program.rawInstructions?.map(
          (instruction) => `Program log: Instruction: ${anchorLogName(instruction.name)}`
        ) ?? []
    },
    initialBackfillLimit: discoveryBackfill.initialLimit,
    backfillPageLimit: discoveryBackfill.pageLimit,
    maxBackfillPages: discoveryBackfill.maxPages,
    gapRepairStore: repository,
    reconnectDelayMs: discoveryReconnectInitialDelayMs,
    reconnectMaxDelayMs: discoveryReconnectMaxDelayMs,
    reconnectStableAfterMs: discoveryReconnectStableAfterMs,
    reconnectJitterRatio: Number(process.env.SOLANA_DISCOVERY_RECONNECT_JITTER_RATIO ?? 0.2),
    heartbeatIntervalMs: discoveryHeartbeatIntervalMs,
    heartbeatTimeoutMs: discoveryHeartbeatTimeoutMs,
    gapRepairReplayLimit: discoveryGapRepairReplayLimit,
    gapRepairMaxSignatures: discoveryGapRepairMaxSignatures,
    minTransactionRequestIntervalMs: Number(
      process.env.SOLANA_TRANSACTION_REQUEST_INTERVAL_MS ?? 0
    ),
    transactionFetchDelayMs: Number(process.env.SOLANA_DISCOVERY_TRANSACTION_FETCH_DELAY_MS ?? 0),
    transactionFetchMaxAttempts: Number(
      process.env.SOLANA_DISCOVERY_TRANSACTION_FETCH_MAX_ATTEMPTS ?? 6
    ),
    transactionFetchRetryDelayMs: Number(
      process.env.SOLANA_DISCOVERY_TRANSACTION_FETCH_RETRY_DELAY_MS ?? 250
    ),
    transactionFetchRetryMaxDelayMs: Number(
      process.env.SOLANA_DISCOVERY_TRANSACTION_FETCH_RETRY_MAX_DELAY_MS ?? 2_000
    ),
    // With inner retries disabled this profile has one visibility retry owner.
    // Six 4s outer requests plus capped backoff is bounded near 29.75s.
    transactionRequestTimeoutMs: Number(
      process.env.SOLANA_DISCOVERY_TRANSACTION_REQUEST_TIMEOUT_MS ?? 4_000
    ),
    transactionRequestRetries: Number(
      process.env.SOLANA_DISCOVERY_TRANSACTION_REQUEST_RETRIES ?? 0
    ),
    providerLatencyWarningMs: Number(process.env.SOLANA_PROVIDER_LATENCY_WARNING_MS ?? 30_000),
    subscriptionAckTimeoutMs: Number(
      process.env.SOLANA_DISCOVERY_SUBSCRIPTION_ACK_TIMEOUT_MS ?? 15_000
    ),
    maxConcurrentTransactionFetches: Math.min(
      discoveryMaxConcurrentPerProgram,
      Math.max(1, Math.floor(discoveryAggregateMaxConcurrentFetches / discoverySourceCount))
    ),
    maxQueuedSignatures: Math.max(
      1,
      Math.floor(discoveryAggregateMaxQueuedSignatures / discoverySourceCount)
    ),
    seenSignatureLimit: Math.max(
      1_000,
      Math.floor(standardSeenSignatureLimit / discoverySourceCount)
    ),
    cursorStore: discoveryCursorStore,
    liveSignatureStore: repository,
    allowConcurrentLiveSignaturesPerAddress: true,
    provider: discoveryProvider
  })
}));
const discoverySupervisor = new DiscoverySupervisor({
  provider: discoveryProvider,
  programs: discoveryProgramSources,
  repository,
  headLagThresholdSlots: boundedInteger(
    process.env.SOLANA_DISCOVERY_HEAD_LAG_SLOTS,
    150,
    1,
    10_000
  ),
  rawSilenceThresholdMs:
    boundedInteger(process.env.SOLANA_DISCOVERY_RAW_SILENCE_SECONDS, 120, 30, 3_600) * 1_000,
  restartCooldownMs:
    boundedInteger(process.env.SOLANA_DISCOVERY_RESTART_COOLDOWN_SECONDS, 300, 300, 3_600) * 1_000,
  activityProbeCooldownMs:
    boundedInteger(process.env.SOLANA_DISCOVERY_ACTIVITY_PROBE_COOLDOWN_SECONDS, 120, 60, 900) *
    1_000,
  repairCooldownMs:
    boundedInteger(process.env.SOLANA_DISCOVERY_GAP_REPAIR_COOLDOWN_SECONDS, 30, 15, 300) * 1_000,
  initialLiveNotificationMaxAgeMs: boundedInteger(
    process.env.SOLANA_DISCOVERY_INITIAL_NOTIFICATION_MAX_AGE_MS,
    30_000,
    5_000,
    300_000
  )
});
discoverySupervisor.setSentinelInterval(discoverySentinelIntervalMs);
const liveTradeSource: SolanaEventSource | null =
  tradeIngestMode === "transaction-subscribe"
    ? new HeliusTransactionEventSource({
        rpcUrl,
        wsUrl: transactionWsUrl,
        addresses: [],
        cursorStore: tradeCursorStore,
        provider: "helius-transaction-subscribe",
        commitment: "confirmed",
        tokenAccounts: "none",
        reconnectInitialDelayMs: Number(process.env.HELIUS_WS_RECONNECT_INITIAL_MS ?? 1_000),
        reconnectMaxDelayMs: Number(process.env.HELIUS_WS_RECONNECT_MAX_SECONDS ?? 30) * 1_000,
        reconnectJitterRatio: Number(process.env.HELIUS_WS_RECONNECT_JITTER_RATIO ?? 0.2),
        heartbeatIntervalMs: Number(process.env.HELIUS_WS_PING_INTERVAL_SECONDS ?? 60) * 1_000,
        heartbeatTimeoutMs: Number(process.env.HELIUS_WS_PONG_TIMEOUT_MS ?? 10_000),
        subscriptionRefreshDebounceMs: Number(
          process.env.HELIUS_SUBSCRIPTION_REFRESH_DEBOUNCE_MS ?? 250
        ),
        accountIncludeChunkSize: Number(process.env.HELIUS_MAX_ACCOUNT_FILTERS ?? 50_000),
        initialBackfillLimit: Number(process.env.HELIUS_GAP_BACKFILL_LIMIT ?? 25),
        backfillPageLimit: Number(process.env.HELIUS_GAP_BACKFILL_PAGE_LIMIT ?? 100),
        maxBackfillPages: Number(process.env.HELIUS_GAP_BACKFILL_MAX_PAGES ?? 5)
      })
    : tradeIngestMode === "rpc"
      ? new StandardSolanaEventSource({
          rpcUrl,
          wsUrl: rpcTradeWsUrl,
          addresses: [],
          cursorStore: tradeCursorStore,
          provider: rpcTradeProvider,
          commitment: "confirmed",
          initialBackfillLimit: Number(process.env.RPC_TRADE_INITIAL_BACKFILL_LIMIT ?? 5),
          backfillPageLimit: Number(process.env.RPC_TRADE_BACKFILL_PAGE_LIMIT ?? 5),
          maxBackfillPages: Number(process.env.RPC_TRADE_MAX_BACKFILL_PAGES ?? 1),
          minTransactionRequestIntervalMs: Number(
            process.env.SOLANA_TRANSACTION_REQUEST_INTERVAL_MS ?? 0
          ),
          transactionFetchDelayMs: Number(process.env.SOLANA_TRANSACTION_FETCH_DELAY_MS ?? 1_000),
          transactionRequestTimeoutMs: Number(
            process.env.SOLANA_TRANSACTION_REQUEST_TIMEOUT_MS ?? 10_000
          ),
          transactionRequestRetries: Number(process.env.SOLANA_TRANSACTION_REQUEST_RETRIES ?? 2),
          providerLatencyWarningMs: Number(
            process.env.SOLANA_PROVIDER_LATENCY_WARNING_MS ?? 30_000
          ),
          transactionFetchMaxAttempts: Number(
            process.env.RPC_TRADE_TRANSACTION_FETCH_MAX_ATTEMPTS ?? 6
          ),
          transactionFetchRetryDelayMs: Number(
            process.env.RPC_TRADE_TRANSACTION_FETCH_RETRY_DELAY_MS ?? 1_000
          ),
          transactionFetchRetryMaxDelayMs: Number(
            process.env.RPC_TRADE_TRANSACTION_FETCH_RETRY_MAX_DELAY_MS ?? 8_000
          ),
          maxConcurrentTransactionFetches: Number(
            process.env.RPC_TRADE_MAX_CONCURRENT_TRANSACTION_FETCHES ?? 128
          ),
          maxQueuedSignatures: Number(process.env.RPC_TRADE_MAX_QUEUED_SIGNATURES ?? 2_000),
          maximumLiveQueueDelayMs: rpcTradeMaximumQueueDelayMs,
          seenSignatureLimit: standardSeenSignatureLimit,
          queuePressureRatio: Number(process.env.RPC_TRADE_QUEUE_PRESSURE_RATIO ?? 0.8),
          onQueuePressure: handleTradeQueuePressure,
          onBackfillTruncated: handleTradeBackfillTruncation
        })
      : null;
const webhookAddressClient =
  tradeIngestMode === "webhook" && webhookManagementEnabled
    ? new HeliusWebhookAddressClient({
        apiKey: requiredEnv("HELIUS_API_KEY"),
        webhookId: requiredEnv("HELIUS_WEBHOOK_ID"),
        webhookUrl: requiredEnv("HELIUS_WEBHOOK_URL"),
        authHeader: requiredEnv("HELIUS_WEBHOOK_AUTH_HEADER")
      })
    : null;
const decoders = programs.flatMap((program) => [
  ...(program.instructionTypes?.length
    ? [
        createParsedInstructionPoolDecoder({
          programId: program.programId,
          instructionTypes: program.instructionTypes
        })
      ]
    : []),
  ...(program.rawInstructions?.length
    ? [
        createRawInstructionPoolDecoder({
          programId: program.programId,
          instructions: program.rawInstructions
        })
      ]
    : [])
]);
const dexScreener = new DexScreenerClient(process.env.DEXSCREENER_BASE_URL);
const activePools = new Map<string, TrackedPool>();
const knownPoolsByToken = new BoundedTtlMap<string, TrackedPool>(
  knownPoolCacheMaxEntries,
  5 * 60_000
);
const knownPoolsByAddress = new BoundedTtlMap<string, TrackedPool>(
  knownPoolCacheMaxEntries,
  5 * 60_000
);
const missingPoolAddresses = new BoundedTtlMap<string, true>(knownPoolCacheMaxEntries, 5 * 60_000);
const tokenRiskCache = new BoundedTtlMap<
  string,
  { risk: SolanaTokenRiskAssessment; assessedAt: string }
>(tokenRiskCacheMaxEntries, 60_000);
const wrappedSolMint = "So11111111111111111111111111111111111111112";
const knownQuoteMints = new Set([wrappedSolMint, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]);
const stableUsdMints = new Set(["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"]);
let latestSolUsdCache:
  { fetchedAt: number; quote: Awaited<ReturnType<PythPriceClient["latest"]>> } | undefined;
const historicalSolUsdCache = new BoundedTtlMap<string, PythUsdQuote>(
  historicalSolUsdCacheMaxEntries,
  60_000
);
const historicalSolUsdFailures = new BoundedTtlMap<string, string>(
  historicalSolUsdCacheMaxEntries,
  60_000
);
const historicalSolUsdInFlight = new Map<string, Promise<PythUsdQuote>>();
let historicalSolUsdProviderTail: Promise<void> = Promise.resolve();
let historicalSolUsdProviderNextRequestAtMs = 0;
let historicalSolUsdProviderBlockedUntilMs = 0;
let historicalSolUsdRateLimitStreak = 0;
const buyDefinitions = buildBuyDefinitions();
const canonicalWorkerId = `solana-parser:${process.pid}`;
let canonicalDrainRunning = false;
let canonicalClaimBlockedUntilMs = 0;
let finalityCycleRunning = false;
let poolSamplingRunning = false;
let webhookSyncRunning = false;
let webhookDiagnostics = {
  provider: "helius-webhook",
  status: (webhookManagementEnabled ? "down" : "ok") as "ok" | "degraded" | "down",
  managementMode: webhookManagementEnabled ? "automatic" : "external",
  webhookIdConfigured: Boolean(process.env.HELIUS_WEBHOOK_ID),
  desiredAddressCount: 0,
  syncedAddressCount: webhookManagementEnabled ? 0 : programs.length,
  syncCount: 0,
  updateCount: 0,
  syncErrorCount: 0,
  lastSyncedAt: (webhookManagementEnabled ? null : new Date().toISOString()) as string | null,
  lastError: null as string | null
};
let storageGateChecking = false;
let storageGateDiagnostics = {
  paused: false,
  diskUsedPercent: 0,
  diskAvailableBytes: 0,
  reason: null as string | null,
  checkedAt: null as string | null
};

await repository.assertReady();
await discoverySupervisor.initialize();
await restoreRecentPools();
await reconcileStorageGate();

async function processSolanaEvent(event: SolanaChainEvent) {
  const eventProvider = event.source ?? "solana-rpc";
  for (const decodedDiscovery of decodePoolDiscoveries(event, decoders)) {
    const discovery = normalizePoolDiscovery(decodedDiscovery);
    if (activePools.has(discovery.poolAddress)) continue;
    const trackedPool: TrackedPool = {
      poolAddress: discovery.poolAddress,
      createdAt: discovery.createdAt,
      tokenAddress: discovery.baseTokenAddress,
      ...(discovery.quoteTokenAddress ? { quoteTokenAddress: discovery.quoteTokenAddress } : {}),
      ...(discovery.creatorAddress ? { creatorAddress: discovery.creatorAddress } : {}),
      programId: discovery.programId,
      signature: discovery.signature,
      slot: discovery.slot,
      previousLiquidityUsd: null,
      subscribedToBuys: false,
      everSubscribedToBuys: false,
      controlledFlow: false,
      tradeCoverageComplete: true,
      tradeCoveragePersisted: true,
      observationMarketEligible: false
    };
    activePools.set(discovery.poolAddress, trackedPool);
    enforceActivePoolLimit();
    rememberPool(trackedPool);
    await repository.upsertToken({
      chain: "solana",
      address: discovery.baseTokenAddress,
      symbol: shortAddress(discovery.baseTokenAddress),
      name: "On-chain discovered token",
      ...(discovery.creatorAddress ? { creatorAddress: discovery.creatorAddress } : {}),
      firstSeenAt: discovery.createdAt,
      metadata: {
        discoveryProvider: "solana-rpc",
        discoveryProgramId: discovery.programId,
        discoverySignature: discovery.signature,
        creatorSource: discovery.creatorAddress ? "pump-create-instruction-data" : null
      }
    });
    await repository.upsertPool({
      chain: "solana",
      poolAddress: discovery.poolAddress,
      dex: discovery.programId,
      baseTokenAddress: discovery.baseTokenAddress,
      ...(discovery.quoteTokenAddress ? { quoteTokenAddress: discovery.quoteTokenAddress } : {}),
      createdAt: discovery.createdAt,
      liquidityUsd: 0,
      volume5mUsd: 0,
      volume1hUsd: 0,
      txns5m: { buys: 0, sells: 0 },
      raw: discovery.raw
    });
    if (tradeIngestMode !== "rpc") await subscribePool(trackedPool);
  }

  const candidatePools = await eventPools(event);
  const balanceTrades = candidatePools.flatMap((subscribedPool) =>
    walletTradeDecodeContexts(event, subscribedPool).flatMap((context) =>
      decodeWalletTrades(event, context)
    )
  );
  for (const trade of balanceTrades) {
    const pricing = await priceWalletTrade(trade);
    const idempotencyKey = createHash("sha256")
      .update([trade.idempotencyKey, strategyVersion].join(":"))
      .digest("hex");
    await repository.saveWalletTradeEvent({
      idempotencyKey,
      chain: "solana",
      walletAddress: trade.walletAddress,
      tokenAddress: trade.tokenAddress,
      ...(trade.quoteTokenAddress ? { quoteTokenAddress: trade.quoteTokenAddress } : {}),
      poolAddress: trade.poolAddress,
      side: trade.side,
      baseAmount: trade.baseAmount,
      ...(trade.baseTokenAmount ? { baseTokenAmount: trade.baseTokenAmount } : {}),
      ...(trade.quoteAmount ? { quoteAmount: trade.quoteAmount } : {}),
      ...(trade.quoteTokenAmount ? { quoteTokenAmount: trade.quoteTokenAmount } : {}),
      ...(pricing.executionPriceUsd !== undefined
        ? {
            executionPriceUsd: pricing.executionPriceUsd,
            executionPriceUsdDecimal: pricing.executionPriceUsd.toPrecision(15)
          }
        : {}),
      ...(pricing.quoteValueUsd !== undefined
        ? {
            quoteValueUsd: pricing.quoteValueUsd,
            quoteValueUsdDecimal: pricing.quoteValueUsd.toPrecision(15)
          }
        : {}),
      ...(trade.poolCreatedAt ? { poolCreatedAt: trade.poolCreatedAt } : {}),
      ...(trade.poolAgeMinutes !== undefined ? { poolAgeMinutes: trade.poolAgeMinutes } : {}),
      dataQuality: pricing.quality ?? "observed-balance",
      ...(pricing.quality ? { priceQuality: pricing.quality } : {}),
      ...(trade.transactionIndex !== undefined ? { transactionIndex: trade.transactionIndex } : {}),
      ...(trade.instructionIndex !== undefined ? { instructionIndex: trade.instructionIndex } : {}),
      ...(trade.innerInstructionIndex !== undefined
        ? { innerInstructionIndex: trade.innerInstructionIndex }
        : {}),
      decoderVersion: trade.decoderVersion,
      signature: trade.signature,
      slot: trade.slot,
      provider: eventProvider,
      observedAt: trade.observedAt,
      strategyVersion,
      raw: { ...trade.raw, priceEvidence: pricing.evidence ?? null }
    });
    if (trade.side === "buy") {
      await repository.saveOnchainSwap({
        idempotencyKey,
        chain: "solana",
        poolAddress: trade.poolAddress,
        traderAddress: trade.walletAddress,
        inputTokenAddress: trade.quoteTokenAddress ?? wrappedSolMint,
        outputTokenAddress: trade.tokenAddress,
        ...(trade.quoteAmount ? { inputAmount: trade.quoteAmount } : {}),
        outputAmount: trade.baseAmount,
        signature: trade.signature,
        slot: trade.slot,
        provider: eventProvider,
        observedAt: trade.observedAt,
        strategyVersion,
        ...(pricing.executionPriceUsd !== undefined ? { priceUsd: pricing.executionPriceUsd } : {}),
        ...(pricing.quoteValueUsd !== undefined ? { volumeUsd: pricing.quoteValueUsd } : {}),
        raw: { ...trade.raw, side: trade.side, priceEvidence: pricing.evidence ?? null }
      });
    }
  }

  if (balanceTrades.length === 0) {
    for (const buy of decodeWalletBuys(event, buyDefinitions)) {
      const pool = activePools.get(buy.poolAddress);
      if (!pool || buy.outputTokenAddress !== pool.tokenAddress) continue;
      const idempotencyKey = createHash("sha256")
        .update(
          [
            "onchain-buy",
            buy.signature,
            buy.poolAddress,
            buy.traderAddress,
            buy.outputTokenAddress,
            strategyVersion
          ].join(":")
        )
        .digest("hex");
      await repository.saveOnchainSwap({
        idempotencyKey,
        chain: "solana",
        poolAddress: buy.poolAddress,
        traderAddress: buy.traderAddress,
        inputTokenAddress: buy.inputTokenAddress,
        outputTokenAddress: buy.outputTokenAddress,
        signature: buy.signature,
        slot: buy.slot,
        provider: eventProvider,
        observedAt: buy.observedAt,
        strategyVersion,
        raw: buy.raw
      });
    }
  }
}

const canonicalTimer = setInterval(() => {
  void drainCanonicalInbox();
}, 250);
const finalityTimer = setInterval(() => {
  void runFinalityCycle();
}, finalityIntervalMs);
void runFinalityCycle();
const sampleTimer = setInterval(() => {
  void sampleDuePools();
}, 5_000);
const healthTimer = setInterval(() => {
  const liveTradeDiagnostics = liveTradeSource?.getDiagnostics();
  const tradeDiagnostics = liveTradeDiagnostics ?? webhookDiagnostics;
  const activePoolSubscriptions = activeBuySubscriptionCount();
  const marketEligibleTrackedPools = [...activePools.values()].filter(
    (pool) => pool.observationMarketEligible && pool.tradeCoverageComplete
  ).length;
  const tradeObservationHealth = evaluateTradeObservationHealth({
    marketEligibleTrackedPools,
    activePoolSubscriptions,
    ...(liveTradeDiagnostics?.configuredAddressCount !== undefined
      ? { configuredAddressCount: liveTradeDiagnostics.configuredAddressCount }
      : {}),
    ...(liveTradeDiagnostics?.subscribedAddressCount !== undefined
      ? { subscribedAddressCount: liveTradeDiagnostics.subscribedAddressCount }
      : {})
  });
  console.log(
    JSON.stringify({
      type: "solana-ingestion-health",
      tradeIngestMode,
      discovery: discoverySupervisor.getAggregateDiagnostics(),
      discoveryPrograms: discoverySupervisor.getProgramDiagnostics(),
      discoverySentinel: discoverySupervisor.getSentinelDiagnostics(),
      discoveryBackfill,
      discoveryGapRepair: {
        heartbeatIntervalSeconds: discoveryHeartbeatIntervalMs / 1_000,
        heartbeatTimeoutMs: discoveryHeartbeatTimeoutMs,
        replayLimit: discoveryGapRepairReplayLimit,
        maximumStagedSignatures: discoveryGapRepairMaxSignatures
      },
      discoveryTransport: {
        rpcProvider: rpcProviderLabel(rpcUrl),
        routes: discoveryWebSocketRoutes.map(({ programId, websocketProvider, route }) => ({
          programId,
          websocketProvider,
          route
        }))
      },
      trade: tradeDiagnostics,
      tradeTransport:
        tradeIngestMode === "rpc" && liveTradeDiagnostics
          ? rpcTradeTransportHealth(liveTradeDiagnostics)
          : null,
      activePoolSubscriptions,
      tradeObservation:
        tradeIngestMode === "rpc"
          ? {
              ...tradeObservationDiagnostics,
              ...tradeObservationHealth,
              marketEligibleTrackedPools,
              alphaProtectedSubscriptions: [...activePools.values()].filter(
                (pool) => pool.subscribedToBuys && pool.controlledFlow
              ).length
            }
          : null,
      runtimeCaches: {
        activePools: activePools.size,
        activePoolLimit: activePoolMaxEntries,
        knownPools: knownPoolsByToken.size,
        knownPoolAddresses: knownPoolsByAddress.size,
        missingPoolAddresses: missingPoolAddresses.size,
        knownPoolLimit: knownPoolCacheMaxEntries,
        tokenRisks: tokenRiskCache.size,
        tokenRiskLimit: tokenRiskCacheMaxEntries
      },
      tokenRisk: tokenRiskDiagnostics,
      walletEntries: walletEntryDiagnostics,
      poolSampling: poolSamplingDiagnostics,
      storageGate: storageGateDiagnostics,
      canonicalParser: {
        ...canonicalParserDiagnostics,
        claimRetryRemainingMs: Math.max(0, canonicalClaimBlockedUntilMs - Date.now()),
        processConcurrency: canonicalEventProcessConcurrency,
        claimLimit: canonicalEventClaimLimit,
        leaseSeconds: canonicalEventLeaseSeconds
      },
      finality: {
        ...finalityDiagnostics,
        intervalSeconds: finalityIntervalMs / 1_000,
        batchSize: finalityBatchSize,
        minimumAgeSeconds: finalityMinimumAgeSeconds,
        unresolvedAfterSeconds: finalityUnresolvedAfterSeconds,
        minimumRootDistanceSlots: finalityMinimumRootDistanceSlots
      },
      poolDiscoveryCoverage: poolDiscoveryCoverageHealth(),
      historicalSolUsd: {
        ...historicalSolUsdDiagnostics,
        provider: pythPrices.diagnostics(),
        cacheEntries: historicalSolUsdCache.size,
        failureEntries: historicalSolUsdFailures.size,
        cacheLimit: historicalSolUsdCacheMaxEntries,
        inFlightRequests: historicalSolUsdInFlight.size,
        bucketSeconds: historicalSolUsdBucketSeconds,
        providerMinIntervalMs: historicalSolUsdProviderMinIntervalMs,
        providerBackoffRemainingMs: Math.max(0, historicalSolUsdProviderBlockedUntilMs - Date.now())
      }
    })
  );
}, 60_000);

async function runFinalityCycle(): Promise<void> {
  if (finalityCycleRunning) return;
  finalityCycleRunning = true;
  try {
    await reconcileSolanaFinalityCycle(
      {
        repository,
        rpcUrl,
        batchSize: finalityBatchSize,
        minimumAgeSeconds: finalityMinimumAgeSeconds,
        unresolvedAfterSeconds: finalityUnresolvedAfterSeconds,
        minimumRootDistanceSlots: finalityMinimumRootDistanceSlots,
        requestTimeoutMs: finalityRequestTimeoutMs
      },
      finalityDiagnostics
    );
    void drainCanonicalInbox();
  } catch {
    // The diagnostics object records a bounded, secret-free error. Confirmed
    // events remain durably pending and cannot reach downstream evidence.
  } finally {
    finalityCycleRunning = false;
  }
}

function rpcTradeTransportHealth(diagnostics: SolanaEventSourceDiagnostics) {
  const websocketMessageBytes = diagnostics.websocketMessageBytes ?? 0;
  const elapsedHours = Math.max((Date.now() - ingestionStartedAtMs) / 3_600_000, 1 / 60);
  const estimatedHeliusWsCredits = isHeliusStandardWebSocket(rpcTradeWsUrl)
    ? (websocketMessageBytes / 100_000) * 2
    : 0;
  return {
    rpcProvider: rpcProviderLabel(rpcUrl),
    websocketProvider: websocketProviderLabel(rpcTradeWsUrl),
    maxActivePools: rpcTradeMaxActivePools,
    heliusStandardWebSocket: isHeliusStandardWebSocket(rpcTradeWsUrl),
    estimatedHeliusWsCredits: roundDiagnostic(estimatedHeliusWsCredits),
    estimatedHeliusWsCreditsPerHour: roundDiagnostic(estimatedHeliusWsCredits / elapsedHours)
  };
}

function roundDiagnostic(value: number): number {
  return Math.round(value * 100) / 100;
}
const webhookSyncTimer = webhookAddressClient
  ? setInterval(() => {
      void syncWebhookAddresses();
    }, webhookSyncIntervalMs)
  : null;
const storageGateTimer = setInterval(() => {
  void reconcileStorageGate();
}, 60_000);
let discoverySentinelRunning = false;
const discoverySentinelTimer = setInterval(() => {
  void runDiscoverySentinel();
}, discoverySentinelIntervalMs);
void runDiscoverySentinel();

async function runDiscoverySentinel(): Promise<void> {
  if (discoverySentinelRunning || storageGateDiagnostics.paused) return;
  discoverySentinelRunning = true;
  try {
    const clusterSlot = await fetchConfirmedSolanaSlot({
      rpcUrl,
      provider: discoveryProvider,
      timeoutMs: discoverySentinelTimeoutMs,
      retries: discoverySentinelRetries
    });
    await discoverySupervisor.sampleHead(clusterSlot);
  } catch (error) {
    discoverySupervisor.recordSentinelFailure(error);
  } finally {
    discoverySentinelRunning = false;
  }
}

async function reconcileStorageGate(): Promise<void> {
  if (storageGateChecking) return;
  storageGateChecking = true;
  try {
    const filesystem = await statfs("/app");
    const totalBytes = filesystem.blocks * filesystem.bsize;
    const availableBytes = filesystem.bavail * filesystem.bsize;
    const usedPercent = totalBytes <= 0 ? 0 : ((totalBytes - availableBytes) / totalBytes) * 100;
    const shouldPause = storageGateDiagnostics.paused
      ? usedPercent > ingestionDiskResumePercent || availableBytes < ingestionMinimumFreeBytes
      : usedPercent >= ingestionDiskPausePercent || availableBytes < ingestionMinimumFreeBytes;
    storageGateDiagnostics = {
      paused: shouldPause,
      diskUsedPercent: roundDiagnostic(usedPercent),
      diskAvailableBytes: availableBytes,
      reason: shouldPause
        ? `disk admission closed at ${roundDiagnostic(usedPercent)}% used and ${availableBytes} bytes free`
        : null,
      checkedAt: new Date().toISOString()
    };
    if (shouldPause) {
      await discoverySupervisor.stop();
      if (liveTradeSource) await liveTradeSource.stop();
      return;
    }
    await discoverySupervisor.start(enqueueSolanaEvent);
    if (liveTradeSource) await liveTradeSource.start(enqueueSolanaEvent);
    if (webhookAddressClient) await syncWebhookAddresses();
    void drainCanonicalInbox();
  } catch (error) {
    storageGateDiagnostics = {
      ...storageGateDiagnostics,
      paused: true,
      reason: `storage gate check failed: ${error instanceof Error ? error.message : String(error)}`,
      checkedAt: new Date().toISOString()
    };
    await discoverySupervisor.stop();
    if (liveTradeSource) await liveTradeSource.stop();
  } finally {
    storageGateChecking = false;
  }
}

async function enqueueSolanaEvent(event: SolanaChainEvent): Promise<void> {
  if (storageGateDiagnostics.paused) {
    // The source interprets a fulfilled handler as durable admission and may
    // then advance its cursor. Reject explicitly so an in-flight fetch that
    // races the disk gate remains retryable after admission reopens.
    throw new SolanaEventNotAcceptedError("Solana storage admission is paused.");
  }
  const discoveries = decodePoolDiscoveries(event, decoders);
  const discovery = discoveries[0];
  const isDiscoveryEvent = decoders.some((decoder) => decoder.programId === event.address);
  const eventType = discovery
    ? "pool_created"
    : activePools.has(event.address) || knownPoolsByAddress.has(event.address)
      ? "swap"
      : "solana_transaction";
  const inserted = await repository.insertChainEvent({
    idempotencyKey: createHash("sha256")
      .update(
        ["solana-chain-event", event.address, event.signature, event.transactionIndex ?? ""].join(
          ":"
        )
      )
      .digest("hex"),
    chain: "solana",
    signature: event.signature,
    slot: event.slot,
    ...(event.transactionIndex !== undefined ? { transactionIndex: event.transactionIndex } : {}),
    ...(discovery ? { instructionIndex: discovery.instructionIndex } : {}),
    ...(discovery?.innerInstructionIndex !== undefined
      ? { innerInstructionIndex: discovery.innerInstructionIndex }
      : {}),
    eventType,
    ...(discovery?.baseTokenAddress ? { tokenAddress: discovery.baseTokenAddress } : {}),
    ...(discovery?.poolAddress ? { poolAddress: discovery.poolAddress } : {}),
    occurredAt:
      event.occurredAt ??
      (event.transaction.blockTime !== undefined && event.transaction.blockTime !== null
        ? new Date(event.transaction.blockTime * 1_000).toISOString()
        : event.observedAt),
    receivedAt: new Date().toISOString(),
    commitment: event.commitment === "finalized" ? "finalized" : "confirmed",
    requiresFinality: event.commitment !== "finalized" && Boolean(event.signature),
    source: event.source ?? "solana-rpc",
    decoderVersion: POOL_DISCOVERY_DECODER_VERSION,
    payload: {
      address: event.address,
      ...(event.matchedAddresses ? { matchedAddresses: event.matchedAddresses } : {}),
      ...(event.transactionIndex !== undefined ? { transactionIndex: event.transactionIndex } : {}),
      observedAt: event.observedAt,
      ...(event.providerTiming ? { providerTiming: event.providerTiming } : {}),
      transaction: event.transaction
    }
  });
  if (inserted && isDiscoveryEvent) {
    recordPoolDiscoveryCoverage(event.address, discoveries);
  }
  void drainCanonicalInbox();
}

function recordPoolDiscoveryCoverage(programId: string, discoveries: PoolDiscovery[]): void {
  const current = poolDiscoveryDiagnostics.byProgram.get(programId) ?? {
    sourceEventCount: 0,
    decodedEventCount: 0,
    unmatchedEventCount: 0,
    decodedPoolCount: 0,
    topLevelInstructionPoolCount: 0,
    innerInstructionPoolCount: 0
  };
  const decodedEventCount = discoveries.length > 0 ? 1 : 0;
  const unmatchedEventCount = discoveries.length === 0 ? 1 : 0;
  const innerInstructionPoolCount = discoveries.filter(
    (candidate) => candidate.innerInstructionIndex !== undefined
  ).length;
  const topLevelInstructionPoolCount = discoveries.length - innerInstructionPoolCount;

  poolDiscoveryDiagnostics.sourceEventCount += 1;
  poolDiscoveryDiagnostics.decodedEventCount += decodedEventCount;
  poolDiscoveryDiagnostics.unmatchedEventCount += unmatchedEventCount;
  poolDiscoveryDiagnostics.decodedPoolCount += discoveries.length;
  poolDiscoveryDiagnostics.topLevelInstructionPoolCount += topLevelInstructionPoolCount;
  poolDiscoveryDiagnostics.innerInstructionPoolCount += innerInstructionPoolCount;
  poolDiscoveryDiagnostics.byProgram.set(programId, {
    sourceEventCount: current.sourceEventCount + 1,
    decodedEventCount: current.decodedEventCount + decodedEventCount,
    unmatchedEventCount: current.unmatchedEventCount + unmatchedEventCount,
    decodedPoolCount: current.decodedPoolCount + discoveries.length,
    topLevelInstructionPoolCount:
      current.topLevelInstructionPoolCount + topLevelInstructionPoolCount,
    innerInstructionPoolCount: current.innerInstructionPoolCount + innerInstructionPoolCount
  });
}

function poolDiscoveryCoverageHealth() {
  return {
    startedAt: poolDiscoveryDiagnostics.startedAt,
    sourceEventCount: poolDiscoveryDiagnostics.sourceEventCount,
    decodedEventCount: poolDiscoveryDiagnostics.decodedEventCount,
    unmatchedEventCount: poolDiscoveryDiagnostics.unmatchedEventCount,
    decodedEventRatio: ratio(
      poolDiscoveryDiagnostics.decodedEventCount,
      poolDiscoveryDiagnostics.sourceEventCount
    ),
    decodedPoolCount: poolDiscoveryDiagnostics.decodedPoolCount,
    topLevelInstructionPoolCount: poolDiscoveryDiagnostics.topLevelInstructionPoolCount,
    innerInstructionPoolCount: poolDiscoveryDiagnostics.innerInstructionPoolCount,
    programs: [...poolDiscoveryDiagnostics.byProgram.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([programId, metrics]) => ({
        programId,
        ...metrics,
        decodedEventRatio: ratio(metrics.decodedEventCount, metrics.sourceEventCount)
      }))
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Number((numerator / denominator).toFixed(6)) : null;
}

async function drainCanonicalInbox(): Promise<void> {
  if (
    canonicalDrainRunning ||
    storageGateDiagnostics.paused ||
    Date.now() < canonicalClaimBlockedUntilMs
  ) {
    return;
  }
  canonicalDrainRunning = true;
  try {
    while (true) {
      const claimStartedAt = Date.now();
      let claimed: CanonicalChainEvent[];
      try {
        claimed = await repository.claimChainEvents({
          workerId: canonicalWorkerId,
          limit: canonicalEventClaimLimit,
          leaseSeconds: canonicalEventLeaseSeconds
        });
        canonicalParserDiagnostics.consecutiveClaimErrorCount = 0;
        canonicalParserDiagnostics.lastClaimErrorCode = null;
        canonicalParserDiagnostics.claimRetryAt = null;
        canonicalClaimBlockedUntilMs = 0;
      } catch (error) {
        canonicalParserDiagnostics.claimErrorCount += 1;
        canonicalParserDiagnostics.consecutiveClaimErrorCount += 1;
        const retry = canonicalClaimRetryDecision(
          error,
          canonicalParserDiagnostics.consecutiveClaimErrorCount
        );
        canonicalClaimBlockedUntilMs = Date.now() + retry.delayMs;
        canonicalParserDiagnostics.lastClaimErrorCode = retry.code;
        canonicalParserDiagnostics.lastClaimErrorAt = new Date().toISOString();
        canonicalParserDiagnostics.claimRetryAt = new Date(
          canonicalClaimBlockedUntilMs
        ).toISOString();
        console.error(
          JSON.stringify({
            type: "canonical-claim-retry",
            postgresCode: retry.code,
            transient: retry.transient,
            consecutiveFailures: canonicalParserDiagnostics.consecutiveClaimErrorCount,
            retryDelayMs: retry.delayMs
          })
        );
        break;
      }
      canonicalParserDiagnostics.claimCount += 1;
      canonicalParserDiagnostics.claimedEventCount += claimed.length;
      canonicalParserDiagnostics.lastClaimDurationMs = Date.now() - claimStartedAt;
      canonicalParserDiagnostics.lastClaimedEventCount = claimed.length;
      if (claimed.length === 0) break;
      const ordered = [...claimed].sort(
        (a, b) => (a.slot ?? 0) - (b.slot ?? 0) || a.receivedAt.localeCompare(b.receivedAt)
      );
      await forEachConcurrent(ordered, canonicalEventProcessConcurrency, processClaimedChainEvent);
    }
  } finally {
    canonicalDrainRunning = false;
  }
}

async function processClaimedChainEvent(event: CanonicalChainEvent): Promise<void> {
  try {
    const chainEvent =
      event.source === "helius-webhook" ? undefined : canonicalToSolanaEvent(event);
    if (chainEvent) await processSolanaEvent(chainEvent);
    else await processHeliusWebhookEvent(event);
    await repository.completeChainEvent(event.idempotencyKey, canonicalWorkerId);
    await repository.upsertPipelineWatermark({
      pipeline: "solana-canonical-parser",
      partitionKey: chainEvent?.address ?? event.source,
      chain: "solana",
      lastContiguousSlot: chainEvent?.slot ?? event.slot ?? 0,
      ...((chainEvent?.signature ?? event.signature)
        ? { lastSignature: chainEvent?.signature ?? event.signature }
        : {}),
      status: "healthy",
      updatedAt: new Date().toISOString(),
      metadata: { source: event.source, decoderVersion: event.decoderVersion }
    });
    canonicalParserDiagnostics.completedEventCount += 1;
  } catch (error) {
    canonicalParserDiagnostics.failedEventCount += 1;
    await repository.failChainEvent(
      event.idempotencyKey,
      canonicalWorkerId,
      error instanceof Error ? error.message : String(error),
      {
        maxAttempts: 8,
        retryAt: new Date(Date.now() + 5_000).toISOString()
      }
    );
  }
}

function canonicalToSolanaEvent(event: CanonicalChainEvent): SolanaChainEvent {
  const address = event.payload.address;
  const transaction = event.payload.transaction;
  if (typeof address !== "string" || typeof transaction !== "object" || transaction === null) {
    throw new Error("Canonical Solana payload is missing address or transaction data.");
  }
  return {
    address,
    ...(Array.isArray(event.payload.matchedAddresses)
      ? { matchedAddresses: event.payload.matchedAddresses.map(String) }
      : {}),
    signature: event.signature ?? event.idempotencyKey,
    slot: event.slot ?? 0,
    ...(event.transactionIndex !== undefined ? { transactionIndex: event.transactionIndex } : {}),
    occurredAt: event.occurredAt,
    observedAt:
      typeof event.payload.observedAt === "string" ? event.payload.observedAt : event.receivedAt,
    commitment: event.commitment,
    source: event.source,
    ...(typeof event.payload.providerTiming === "object" && event.payload.providerTiming !== null
      ? {
          providerTiming: event.payload.providerTiming as NonNullable<
            SolanaChainEvent["providerTiming"]
          >
        }
      : {}),
    transaction: transaction as SolanaChainEvent["transaction"]
  };
}

async function processHeliusWebhookEvent(event: CanonicalChainEvent): Promise<void> {
  const normalized = event.payload.normalizedEvent as NormalizedEvent | undefined;
  if (!normalized || normalized.type !== "swap") return;
  const payload = normalized.payload as Record<string, unknown>;
  const swap = payload.swap as
    | {
        tokenInputs?: Array<{ userAccount?: string; mint?: string; tokenAmount?: number }>;
        tokenOutputs?: Array<{ userAccount?: string; mint?: string; tokenAmount?: number }>;
        nativeInput?: { account?: string; amount?: string | number };
        nativeOutput?: { account?: string; amount?: string | number };
      }
    | undefined;
  if (!swap) return;
  const tokenInputs = swap.tokenInputs ?? [];
  const tokenOutputs = swap.tokenOutputs ?? [];
  const trackedOutput = tokenOutputs.find((leg) => leg.mint && knownPoolsByToken.has(leg.mint));
  const trackedInput = tokenInputs.find((leg) => leg.mint && knownPoolsByToken.has(leg.mint));
  const trackedLeg = trackedOutput ?? trackedInput;
  if (!trackedLeg?.mint || !trackedLeg.tokenAmount) return;
  const pool = knownPoolsByToken.get(trackedLeg.mint);
  if (!pool) return;
  const side = trackedOutput ? ("buy" as const) : ("sell" as const);
  const traderAddress = trackedLeg.userAccount || String(payload.feePayer ?? "");
  if (!traderAddress || traderAddress.length < 32) return;
  const quoteTokenLeg =
    side === "buy"
      ? tokenInputs.find((leg) => leg.mint !== trackedLeg.mint)
      : tokenOutputs.find((leg) => leg.mint !== trackedLeg.mint);
  const nativeLeg = side === "buy" ? swap.nativeInput : swap.nativeOutput;
  const quoteAmount = quoteTokenLeg?.tokenAmount ?? nativeAmountSol(nativeLeg?.amount);
  const quoteTokenAddress = quoteTokenLeg?.mint ?? wrappedSolMint;
  const pricing = await priceTradeExecution({
    quoteTokenAddress,
    ...(quoteAmount !== undefined ? { quoteAmount } : {}),
    baseAmount: trackedLeg.tokenAmount,
    observedAt: event.occurredAt,
    signature: event.signature ?? event.idempotencyKey
  });
  const idempotencyKey = createHash("sha256")
    .update(
      [
        "helius-webhook-trade",
        event.signature ?? event.idempotencyKey,
        traderAddress,
        trackedLeg.mint,
        side
      ].join(":")
    )
    .digest("hex");
  await repository.saveWalletTradeEvent({
    idempotencyKey,
    chain: "solana",
    walletAddress: traderAddress,
    tokenAddress: trackedLeg.mint,
    quoteTokenAddress,
    poolAddress: pool.poolAddress,
    side,
    baseAmount: trackedLeg.tokenAmount,
    ...(quoteAmount && quoteAmount > 0 ? { quoteAmount } : {}),
    ...(pricing.executionPriceUsd !== undefined
      ? { executionPriceUsd: pricing.executionPriceUsd }
      : {}),
    ...(pricing.quoteValueUsd !== undefined ? { quoteValueUsd: pricing.quoteValueUsd } : {}),
    poolCreatedAt: pool.createdAt,
    poolAgeMinutes:
      (new Date(event.occurredAt).getTime() - new Date(pool.createdAt).getTime()) / 60_000,
    dataQuality: pricing.quality ?? "observed-balance",
    signature: event.signature ?? event.idempotencyKey,
    slot: event.slot ?? 0,
    provider: "helius-webhook",
    observedAt: event.occurredAt,
    strategyVersion,
    raw: { normalizedEvent: normalized, priceEvidence: pricing.evidence ?? null }
  });
  if (side === "buy") {
    await repository.saveOnchainSwap({
      idempotencyKey,
      chain: "solana",
      poolAddress: pool.poolAddress,
      traderAddress,
      inputTokenAddress: quoteTokenAddress,
      outputTokenAddress: trackedLeg.mint,
      ...(quoteAmount ? { inputAmount: quoteAmount } : {}),
      outputAmount: trackedLeg.tokenAmount,
      signature: event.signature ?? event.idempotencyKey,
      slot: event.slot ?? 0,
      provider: "helius-webhook",
      observedAt: event.occurredAt,
      strategyVersion,
      ...(pricing.executionPriceUsd !== undefined ? { priceUsd: pricing.executionPriceUsd } : {}),
      ...(pricing.quoteValueUsd !== undefined ? { volumeUsd: pricing.quoteValueUsd } : {}),
      raw: { normalizedEvent: normalized, side, priceEvidence: pricing.evidence ?? null }
    });
  }
}

function nativeAmountSol(value: string | number | undefined): number | undefined {
  const lamports = Number(value);
  return Number.isFinite(lamports) && lamports > 0 ? lamports / 1_000_000_000 : undefined;
}

async function sampleDuePools() {
  if (storageGateDiagnostics.paused) return;
  if (poolSamplingRunning) {
    poolSamplingDiagnostics.skippedOverlappingCycleCount += 1;
    return;
  }
  poolSamplingRunning = true;
  const startedAt = Date.now();
  try {
    await sampleDuePoolsOnce();
    poolSamplingDiagnostics.completedCycleCount += 1;
    poolSamplingDiagnostics.lastError = null;
  } catch (error) {
    poolSamplingDiagnostics.cycleErrorCount += 1;
    poolSamplingDiagnostics.lastError =
      error instanceof Error ? error.message : "pool sampling failed";
    console.error(
      JSON.stringify({
        type: "solana-pool-sampling-error",
        message: poolSamplingDiagnostics.lastError
      })
    );
  } finally {
    poolSamplingDiagnostics.lastDurationMs = Date.now() - startedAt;
    poolSamplingRunning = false;
  }
}

async function sampleDuePoolsOnce() {
  const now = new Date();
  const duePoolCandidates: TrackedPool[] = [];
  for (const pool of activePools.values()) {
    const ageMinutes = (now.getTime() - new Date(pool.createdAt).getTime()) / 60_000;
    const delay = activePoolSampleDelayMs(ageMinutes);
    if (delay === null) {
      if (pool.subscribedToBuys) {
        if (tradeIngestMode === "rpc") {
          await releaseRpcTradeObservation(pool, "rpc-trade-observation-expired", now);
        } else {
          liveTradeSource?.unsubscribeAddress(pool.poolAddress);
          pool.subscribedToBuys = false;
        }
      }
      activePools.delete(pool.poolAddress);
      continue;
    }
    if (pool.lastSampledAt && now.getTime() - new Date(pool.lastSampledAt).getTime() < delay) {
      continue;
    }
    duePoolCandidates.push(pool);
  }

  const duePools = selectBoundedPoolSamplingBatch(duePoolCandidates, poolSamplingMaxPoolsPerCycle);
  for (const pool of duePools) pool.lastSampledAt = now.toISOString();

  const uniqueTokenAddresses = [...new Set(duePools.map((pool) => pool.tokenAddress))];
  const tokenAddressBatches = chunk(uniqueTokenAddresses, 30);
  poolSamplingDiagnostics.lastCandidateDuePoolCount = duePoolCandidates.length;
  poolSamplingDiagnostics.lastDuePoolCount = duePools.length;
  poolSamplingDiagnostics.lastDeferredPoolCount = duePoolCandidates.length - duePools.length;
  poolSamplingDiagnostics.lastUniqueTokenCount = uniqueTokenAddresses.length;
  poolSamplingDiagnostics.lastBatchRequestCount = tokenAddressBatches.length;
  const tokenPairResults = await mapWithConcurrency(
    tokenAddressBatches,
    dexScreenerSampleConcurrency,
    async (tokenAddresses) => {
      try {
        return await dexScreener.fetchTokenPairsBatch("solana", tokenAddresses);
      } catch {
        poolSamplingDiagnostics.fetchErrorCount += 1;
        return [] as DexScreenerPair[];
      }
    }
  );
  const pairsByAddress = new Map(
    tokenPairResults
      .flat()
      .filter((pair) => Boolean(pair.pairAddress))
      .map((pair) => [pair.pairAddress!, pair])
  );

  const dueSamples: DuePoolSample[] = [];
  for (const pool of duePools) {
    const pair = pairsByAddress.get(pool.poolAddress);
    if (!pair) continue;
    const priceUsd = Number(pair.priceUsd ?? 0);
    const liquidityUsd = pair.liquidity?.usd ?? 0;
    if (priceUsd <= 0) continue;
    const rugged =
      pool.previousLiquidityUsd !== null && pool.previousLiquidityUsd > 0 && liquidityUsd <= 0;
    pool.previousLiquidityUsd = liquidityUsd;
    dueSamples.push({
      pool,
      pair,
      priceUsd,
      liquidityUsd,
      rugged,
      marketEligible: passesRiskMarketGate(pair)
    });
  }
  poolSamplingDiagnostics.lastSuccessfulSampleCount = dueSamples.length;

  for (const sample of dueSamples) {
    const { pool, pair, priceUsd, liquidityUsd, rugged, marketEligible } = sample;
    pool.observationMarketEligible = marketEligible;
    if (tradeIngestMode === "rpc") {
      if (rugged && pool.subscribedToBuys) {
        await releaseRpcTradeObservation(pool, "rpc-trade-observation-rugged", now);
      } else if (!rugged) {
        // Observation admission intentionally precedes token-risk provider I/O.
        // Risk remains a separate, fail-closed downstream alpha gate.
        await reconcileRpcTradeObservation(pool, marketEligible, now);
      }
    }
    const compactPair = compactDexScreenerPair(pair);
    const tokenRisk = marketEligible
      ? await refreshTokenRisk(pool, now)
      : (currentTokenRisk(pool, now) ?? unknownTokenRisk("deferred until market gate passes"));
    const flowEvidence = buildFlowEvidence(pair, pool, now, tokenRisk);
    const evidenceEligible =
      pool.tradeCoverageComplete &&
      flowEvidence.controlledFlow &&
      flowEvidence.tokenRiskKnown &&
      flowEvidence.tokenRiskPassed;
    pool.controlledFlow = evidenceEligible;
    if (
      shouldPersistPoolState({
        nowMs: now.getTime(),
        intervalMs: poolStatePersistIntervalMs,
        marketEligible,
        rugged,
        ...(pool.lastPersistedMarketAtMs !== undefined
          ? { lastPersistedAtMs: pool.lastPersistedMarketAtMs }
          : {}),
        ...(pool.lastPersistedMarketEligible !== undefined
          ? { lastPersistedMarketEligible: pool.lastPersistedMarketEligible }
          : {})
      }) ||
      !pool.tradeCoveragePersisted
    ) {
      await repository.upsertPool({
        chain: "solana",
        poolAddress: pool.poolAddress,
        dex: pool.programId,
        baseTokenAddress: pool.tokenAddress,
        ...(pool.quoteTokenAddress ? { quoteTokenAddress: pool.quoteTokenAddress } : {}),
        createdAt: pool.createdAt,
        liquidityUsd,
        ...(pair.baseToken?.symbol ? { tokenSymbol: pair.baseToken.symbol } : {}),
        ...(pair.baseToken?.name ? { tokenName: pair.baseToken.name } : {}),
        priceUsd,
        ...(pair.marketCap !== undefined || pair.fdv !== undefined
          ? { marketCapUsd: pair.marketCap ?? pair.fdv! }
          : {}),
        volume5mUsd: flowEvidence.volume5mUsd,
        volume1hUsd: flowEvidence.volume1hUsd,
        txns5m: {
          buys: flowEvidence.buys5m,
          sells: flowEvidence.sells5m
        },
        raw: {
          ...compactPair,
          ...(pool.creatorAddress ? { creatorAddress: pool.creatorAddress } : {}),
          tradeCoverage: {
            complete: pool.tradeCoverageComplete,
            ...(pool.tradeCoverageGapAt ? { gapAt: pool.tradeCoverageGapAt } : {}),
            ...(pool.tradeCoverageGapReason ? { gapReason: pool.tradeCoverageGapReason } : {})
          }
        }
      });
      pool.lastPersistedMarketAtMs = now.getTime();
      pool.lastPersistedMarketEligible = marketEligible;
      pool.tradeCoveragePersisted = true;
      poolSamplingDiagnostics.durablePoolStateWriteCount += 1;
    } else {
      poolSamplingDiagnostics.skippedPoolStateWriteCount += 1;
    }
    const observedAt = new Date().toISOString();
    const signature = `dexscreener-live-context:${pool.poolAddress}:${observedAt}`;
    const observation: PriceObservationEvidence = {
      idempotencyKey: createHash("sha256").update(signature).digest("hex"),
      chain: "solana",
      tokenAddress: pool.tokenAddress,
      poolAddress: pool.poolAddress,
      priceUsd,
      liquidityUsd,
      rugged,
      signature,
      slot: pool.slot,
      provider: "dexscreener",
      observedAt,
      strategyVersion,
      raw: compactPair
    };
    poolSamplingDiagnostics.liveMarketContextCount += 1;
    await repository.enrichWalletTradePrices(observation, walletAlphaQueueAdmission);
    await materializeWalletEntriesForToken(pool, observation, flowEvidence);
  }
}

async function restoreRecentPools() {
  const now = new Date();
  const knownProgramIds = new Set(programs.map((program) => program.programId));
  const pools = await repository.listRecentPools(1_000);
  for (const stored of pools) {
    if (stored.chain !== "solana" || !stored.createdAt || !knownProgramIds.has(stored.dex)) {
      continue;
    }
    const ageMinutes = (now.getTime() - new Date(stored.createdAt).getTime()) / 60_000;
    if (activePoolSampleDelayMs(ageMinutes) === null) continue;
    const tracked = trackedPoolFromSnapshot(stored, now);
    activePools.set(stored.poolAddress, tracked);
    enforceActivePoolLimit();
    rememberPool(tracked);
    if (tradeIngestMode === "rpc") {
      if (tracked.observationMarketEligible) {
        await reconcileRpcTradeObservation(tracked, true, now);
      }
    } else if (tracked.controlledFlow) {
      await subscribePool(tracked, true);
    }
  }
}

async function materializeWalletEntriesForToken(
  pool: TrackedPool,
  observation: PriceObservationEvidence,
  flowEvidence: FlowEvidence
) {
  const decision = walletEntryMaterializationDecision(flowEvidence);
  if (decision === "skip-uncontrolled-flow") {
    walletEntryDiagnostics.skippedUncontrolledPoolSamples += 1;
    return;
  }
  if (decision === "defer-unknown-risk") {
    walletEntryDiagnostics.deferredUnknownRiskPoolSamples += 1;
    return;
  }
  if (decision === "skip-failed-risk") {
    walletEntryDiagnostics.skippedFailedRiskPoolSamples += 1;
    return;
  }

  const pendingSwaps = await repository.listPendingOnchainBuySwaps(
    pool.tokenAddress,
    walletEntryMaterializationBatchSize
  );
  const observationTime = new Date(observation.observedAt).getTime();
  for (const swap of pendingSwaps) {
    if (swap.poolAddress !== pool.poolAddress) continue;
    if (new Date(swap.observedAt).getTime() > observationTime) continue;
    walletEntryDiagnostics.pendingSwapsConsidered += 1;
    const repeatWalletCount = await repository.countPriorWalletEntryTokens(
      swap.traderAddress,
      observation.observedAt,
      strategyVersion
    );
    const cohort = flowEvidence.controlledFlow
      ? repeatWalletCount >= 2
        ? "repeat-wallet+controlled-flow"
        : "controlled-flow-control"
      : "excluded-uncontrolled-flow";
    const result = await recordFirstWalletEntry(repository, {
      chain: "solana",
      walletAddress: swap.traderAddress,
      tokenAddress: swap.outputTokenAddress,
      poolAddress: pool.poolAddress,
      sourceSwapIdempotencyKey: swap.idempotencyKey,
      observedEntryPriceUsd: observation.priceUsd,
      observedLiquidityUsd: observation.liquidityUsd,
      cohort,
      repeatWalletCount,
      flowEvidence: {
        ...flowEvidence,
        sourceSwapIdempotencyKey: swap.idempotencyKey,
        buyObservedAt: swap.observedAt,
        buySignature: swap.signature,
        entryPriceEvidence: {
          quality: "market-proxy",
          contextKey: observation.idempotencyKey,
          provider: observation.provider,
          signature: observation.signature,
          observedAt: observation.observedAt,
          poolAddress: observation.poolAddress,
          priceUsd: observation.priceUsd,
          liquidityUsd: observation.liquidityUsd
        }
      },
      signature: observation.signature,
      slot: observation.slot,
      provider: observation.provider,
      observedAt: observation.observedAt,
      strategyVersion
    });
    if (result.inserted) walletEntryDiagnostics.entriesMaterialized += 1;
  }
}

function buildFlowEvidence(
  pair: DexScreenerPair,
  pool: TrackedPool,
  now: Date,
  tokenRisk: SolanaTokenRiskAssessment
): FlowEvidence {
  return makeFlowEvidence(
    {
      liquidityUsd: numberValue(pair.liquidity?.usd),
      volume5mUsd: numberValue(pair.volume?.m5),
      volume1hUsd: numberValue(pair.volume?.h1),
      buys5m: numberValue(pair.txns?.m5?.buys),
      sells5m: numberValue(pair.txns?.m5?.sells)
    },
    pool.createdAt,
    now,
    tokenRisk
  );
}

function passesRiskMarketGate(pair: DexScreenerPair): boolean {
  return passesSolanaRiskMarketGate({
    liquidityUsd: numberValue(pair.liquidity?.usd),
    volume5mUsd: numberValue(pair.volume?.m5),
    buys5m: numberValue(pair.txns?.m5?.buys),
    sells5m: numberValue(pair.txns?.m5?.sells),
    minimumLiquidityUsd: minLiquidityUsd,
    minimumVolume5mUsd: minVolume5mUsd,
    maximumSwaps5m: maxSwaps5m,
    maximumVolumeLiquidityRatio: maxVolumeLiquidityRatio
  });
}

function buildRestoredFlowEvidence(pool: PoolSnapshot, now: Date): FlowEvidence {
  return makeFlowEvidence(
    {
      liquidityUsd: pool.liquidityUsd,
      volume5mUsd: pool.volume5mUsd,
      volume1hUsd: pool.volume1hUsd,
      buys5m: pool.txns5m.buys,
      sells5m: pool.txns5m.sells
    },
    pool.createdAt ?? now.toISOString(),
    now,
    unknownTokenRisk("restored pool has not been reassessed")
  );
}

function makeFlowEvidence(
  values: {
    liquidityUsd: number;
    volume5mUsd: number;
    volume1hUsd: number;
    buys5m: number;
    sells5m: number;
  },
  createdAt: string,
  now: Date,
  tokenRisk: SolanaTokenRiskAssessment
): FlowEvidence {
  const swaps5m = values.buys5m + values.sells5m;
  const buyShare5m = values.buys5m / Math.max(swaps5m, 1);
  const volumeLiquidityRatio = values.volume5mUsd / Math.max(values.liquidityUsd, 1);
  const poolAgeMinutes = (now.getTime() - new Date(createdAt).getTime()) / 60_000;
  return {
    ...values,
    swaps5m,
    buyShare5m,
    minLiquidityUsd,
    minVolume5mUsd,
    maxSwaps5m,
    maxVolumeLiquidityRatio,
    volumeLiquidityRatio,
    poolAgeMinutes,
    tokenRiskKnown: tokenRisk.known,
    tokenRiskPassed: tokenRisk.passed,
    tokenRiskScore: tokenRisk.riskScore,
    mintAuthorityRevoked: tokenRisk.mintAuthorityRevoked,
    freezeAuthorityRevoked: tokenRisk.freezeAuthorityRevoked,
    topHolderPercent: tokenRisk.topHolderPercent,
    top10HolderPercent: tokenRisk.top10HolderPercent,
    controlledFlow:
      poolAgeMinutes >= 0 &&
      passesSolanaRiskMarketGate({
        liquidityUsd: values.liquidityUsd,
        volume5mUsd: values.volume5mUsd,
        buys5m: values.buys5m,
        sells5m: values.sells5m,
        minimumLiquidityUsd: minLiquidityUsd,
        minimumVolume5mUsd: minVolume5mUsd,
        maximumSwaps5m: maxSwaps5m,
        maximumVolumeLiquidityRatio: maxVolumeLiquidityRatio
      })
  };
}

async function priceWalletTrade(trade: ReturnType<typeof decodeWalletTrades>[number]): Promise<{
  executionPriceUsd?: number;
  quoteValueUsd?: number;
  quality?: WalletTradePriceQuality;
  evidence?: Record<string, unknown>;
}> {
  return priceTradeExecution({
    quoteTokenAddress: trade.quoteTokenAddress ?? wrappedSolMint,
    ...(trade.quoteAmount !== undefined ? { quoteAmount: trade.quoteAmount } : {}),
    baseAmount: trade.baseAmount,
    observedAt: trade.observedAt,
    signature: trade.signature
  });
}

async function priceTradeExecution(input: {
  quoteTokenAddress: string;
  quoteAmount?: number;
  baseAmount: number;
  observedAt: string;
  signature: string;
}): Promise<{
  executionPriceUsd?: number;
  quoteValueUsd?: number;
  quality?: WalletTradePriceQuality;
  evidence?: Record<string, unknown>;
}> {
  if (!input.quoteAmount || input.quoteAmount <= 0 || input.baseAmount <= 0) return {};
  const quoteMint = input.quoteTokenAddress;
  if (stableUsdMints.has(quoteMint)) {
    const observedAt = new Date().toISOString();
    await repository.saveQuotePriceObservation({
      idempotencyKey: createHash("sha256")
        .update(["stablecoin-peg", quoteMint, input.observedAt].join(":"))
        .digest("hex"),
      chain: "solana",
      quoteTokenAddress: quoteMint,
      priceUsd: 1,
      confidenceUsd: 0,
      source: "stablecoin-peg",
      quality: "stablecoin-peg",
      publishTime: input.observedAt,
      observedAt,
      stalenessSeconds: 0,
      raw: { tradeSignature: input.signature }
    });
    return {
      quoteValueUsd: input.quoteAmount,
      executionPriceUsd: input.quoteAmount / input.baseAmount,
      quality: "observed-execution",
      evidence: { source: "same-transaction-stablecoin-quote", quoteMint }
    };
  }
  if (quoteMint !== wrappedSolMint) return {};

  let quote: Awaited<ReturnType<typeof solUsdAt>>;
  try {
    const occurredAtSeconds = Math.floor(new Date(input.observedAt).getTime() / 1_000);
    quote = await solUsdAt(occurredAtSeconds);
  } catch (error) {
    return {
      evidence: {
        source: "pyth",
        rejected: "lookup-failed",
        message: error instanceof Error ? error.message : String(error)
      }
    };
  }
  const quoteObservedAt = new Date().toISOString();
  const quotePublishTime = new Date(quote.publishTime * 1_000).toISOString();
  await repository.saveQuotePriceObservation({
    idempotencyKey: createHash("sha256")
      .update([quote.source, wrappedSolMint, String(quote.publishTime)].join(":"))
      .digest("hex"),
    chain: "solana",
    quoteTokenAddress: wrappedSolMint,
    priceUsd: quote.priceUsd,
    confidenceUsd: quote.confidenceUsd,
    source: quote.source,
    quality: quote.source === "pyth-hermes-latest" ? "oracle-live" : "oracle-historical",
    publishTime: quotePublishTime,
    observedAt: quoteObservedAt,
    stalenessSeconds: Math.max(
      0,
      Math.floor(new Date(input.observedAt).getTime() / 1_000 - quote.publishTime)
    ),
    raw: {
      feedId: quote.feedId,
      confidenceRatio: quote.confidenceRatio,
      requestedTime: quote.requestedTime ?? null,
      slot: quote.slot ?? null,
      tradeSignature: input.signature
    }
  });
  if (quote.confidenceRatio > 0.02) {
    return {
      evidence: {
        source: quote.source,
        rejected: "confidence-ratio",
        confidenceRatio: quote.confidenceRatio,
        publishTime: quote.publishTime
      }
    };
  }
  const quoteValueUsd = input.quoteAmount * quote.priceUsd;
  return {
    quoteValueUsd,
    executionPriceUsd: quoteValueUsd / input.baseAmount,
    quality: "oracle-converted",
    evidence: {
      source: quote.source,
      feedId: quote.feedId,
      solUsd: quote.priceUsd,
      confidenceUsd: quote.confidenceUsd,
      confidenceRatio: quote.confidenceRatio,
      publishTime: quote.publishTime,
      slot: quote.slot ?? null
    }
  };
}

async function solUsdAt(timestamp: number) {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  if (nowSeconds - timestamp <= 90) {
    if (latestSolUsdCache && Date.now() - latestSolUsdCache.fetchedAt < 5_000) {
      return latestSolUsdCache.quote;
    }
    const quote = await pythPrices.latest(solUsdFeedId);
    latestSolUsdCache = { fetchedAt: Date.now(), quote };
    return quote;
  }
  const bucketStart =
    Math.floor(timestamp / historicalSolUsdBucketSeconds) * historicalSolUsdBucketSeconds;
  const cacheKey = String(bucketStart);
  const cached = historicalSolUsdCache.get(cacheKey);
  if (cached && Math.abs(cached.publishTime - timestamp) <= 60) {
    historicalSolUsdDiagnostics.memoryHitCount += 1;
    return cached;
  }
  const priorFailure = historicalSolUsdFailures.get(cacheKey);
  if (priorFailure) throw new Error(priorFailure);
  const shared = historicalSolUsdInFlight.get(cacheKey);
  if (shared) {
    historicalSolUsdDiagnostics.sharedRequestCount += 1;
    return shared;
  }
  const request = loadHistoricalSolUsd(bucketStart);
  historicalSolUsdInFlight.set(cacheKey, request);
  try {
    const quote = await request;
    historicalSolUsdCache.set(cacheKey, quote, Date.now() + 24 * 60 * 60_000);
    return quote;
  } finally {
    historicalSolUsdInFlight.delete(cacheKey);
  }
}

async function loadHistoricalSolUsd(bucketStart: number): Promise<PythUsdQuote> {
  const stored = await repository.findQuotePriceObservationNear(
    "solana",
    wrappedSolMint,
    new Date(bucketStart * 1_000).toISOString(),
    60
  );
  if (stored && isPythQuoteSource(stored.source)) {
    historicalSolUsdDiagnostics.databaseHitCount += 1;
    const feedId =
      typeof stored.raw.feedId === "string" && stored.raw.feedId ? stored.raw.feedId : solUsdFeedId;
    const slot = numberOrUndefined(stored.raw.slot);
    return {
      feedId,
      priceUsd: stored.priceUsd,
      confidenceUsd: stored.confidenceUsd,
      confidenceRatio:
        numberOrUndefined(stored.raw.confidenceRatio) ??
        stored.confidenceUsd / Math.max(stored.priceUsd, Number.EPSILON),
      publishTime: Math.floor(new Date(stored.publishTime).getTime() / 1_000),
      source: stored.source,
      requestedTime: bucketStart,
      ...(slot !== undefined ? { slot } : {})
    };
  }
  try {
    const quote = await requestHistoricalSolUsd(bucketStart);
    historicalSolUsdRateLimitStreak = 0;
    return quote;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    historicalSolUsdDiagnostics.providerErrorCount += 1;
    const rateLimited = message.includes("429") || message.includes("rate-limited");
    if (rateLimited) {
      historicalSolUsdDiagnostics.providerRateLimitedCount += 1;
      historicalSolUsdRateLimitStreak += 1;
      const backoffMs = Math.min(
        5 * 60_000,
        30_000 * 2 ** Math.min(historicalSolUsdRateLimitStreak - 1, 4)
      );
      historicalSolUsdProviderBlockedUntilMs = Math.max(
        historicalSolUsdProviderBlockedUntilMs,
        Date.now() + backoffMs
      );
    }
    const provider = pythPrices.diagnostics();
    const retryAtMs = Math.max(Date.now() + 30_000, historicalSolUsdProviderBlockedUntilMs,
      Date.now() + (provider.status === "missing-api-key" ? 15 * 60_000 : provider.backoffRemainingMs));
    historicalSolUsdFailures.set(
      String(bucketStart),
      `Historical SOL/USD lookup is temporarily unavailable: ${message}`,
      retryAtMs
    );
    throw error;
  }
}

async function requestHistoricalSolUsd(bucketStart: number): Promise<PythUsdQuote> {
  const previous = historicalSolUsdProviderTail;
  let release: (() => void) | undefined;
  historicalSolUsdProviderTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const nowMs = Date.now();
    if (nowMs < historicalSolUsdProviderBlockedUntilMs) {
      throw new Error("Pyth historical provider is in bounded rate-limit backoff.");
    }
    const delayMs = historicalSolUsdProviderNextRequestAtMs - nowMs;
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    historicalSolUsdDiagnostics.providerRequestCount += 1;
    try {
      return await pythPrices.historical(solUsdFeedId, bucketStart, 60);
    } finally {
      historicalSolUsdProviderNextRequestAtMs = Date.now() + historicalSolUsdProviderMinIntervalMs;
    }
  } finally {
    release?.();
  }
}

function isPythQuoteSource(source: string): source is PythUsdQuote["source"] {
  return source === "pyth-hermes-latest" || source === "pyth-benchmarks";
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function forEachConcurrent<T>(
  values: T[],
  concurrency: number,
  handler: (value: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), values.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const value = values[nextIndex];
        nextIndex += 1;
        if (value !== undefined) await handler(value);
      }
    })
  );
}

async function refreshTokenRisk(pool: TrackedPool, now: Date): Promise<SolanaTokenRiskAssessment> {
  const current = currentTokenRisk(pool, now);
  if (current) return current;

  try {
    let risk = await fetchTokenRiskWithFallback(pool.tokenAddress);
    if (pool.creatorAddress && !risk.creatorAddress) {
      risk = {
        ...risk,
        creatorAddress: pool.creatorAddress,
        evidence: {
          ...risk.evidence,
          creatorSource: "pump-create-instruction-data"
        }
      };
    }
    risk = await enrichPassedTokenCreator(pool.tokenAddress, risk);
    if (!risk.known) tokenRiskDiagnostics.unknownCount += 1;
    else if (risk.passed) tokenRiskDiagnostics.knownPassedCount += 1;
    else tokenRiskDiagnostics.knownFailedCount += 1;
    const assessedAt = cacheTokenRisk(pool, risk, now);
    await repository.upsertToken({
      chain: "solana",
      address: pool.tokenAddress,
      symbol: shortAddress(pool.tokenAddress),
      name: "On-chain discovered token",
      ...(risk.creatorAddress ? { creatorAddress: risk.creatorAddress } : {}),
      firstSeenAt: pool.createdAt,
      metadata: {
        mintAuthorityRevoked: risk.mintAuthorityRevoked,
        freezeAuthorityRevoked: risk.freezeAuthorityRevoked,
        topHolderPercent: risk.topHolderPercent,
        top10HolderPercent: risk.top10HolderPercent,
        tokenRiskKnown: risk.known,
        tokenRiskPassed: risk.passed,
        tokenProgram: risk.tokenProgram,
        tokenExtensionEvidenceKnown: risk.tokenExtensionEvidenceKnown,
        tokenExtensions: risk.tokenExtensions,
        blockingTokenExtensions: risk.blockingTokenExtensions,
        tokenRiskAssessedAt: assessedAt,
        raydiumIdlCommit: process.env.RAYDIUM_IDL_COMMIT ?? null
      }
    });
    await repository.saveTokenRisk({
      chain: "solana",
      tokenAddress: pool.tokenAddress,
      calculatedAt: assessedAt,
      score: {
        score: Math.max(0, 100 - risk.riskScore),
        riskScore: risk.riskScore,
        confidence: risk.known ? 90 : 0,
        subScores: {
          authoritySafety:
            (risk.mintAuthorityRevoked ? 50 : 0) + (risk.freezeAuthorityRevoked ? 50 : 0),
          holderDistribution: Math.max(0, 100 - risk.top10HolderPercent)
        },
        reasons: risk.passed ? ["Required token safety evidence passed."] : [],
        warnings: risk.warnings
      }
    });
    return risk;
  } catch (error) {
    tokenRiskDiagnostics.errorCount += 1;
    console.error(
      JSON.stringify({
        type: "solana-token-risk-error",
        tokenAddress: pool.tokenAddress,
        message: error instanceof Error ? error.message : "token risk lookup failed"
      })
    );
    const unknown = unknownTokenRisk(
      error instanceof Error ? error.message : "token risk lookup failed"
    );
    cacheTokenRisk(pool, unknown, now);
    return unknown;
  }
}

function currentTokenRisk(pool: TrackedPool, now: Date): SolanaTokenRiskAssessment | undefined {
  const localAssessedAt = pool.tokenRiskAssessedAt
    ? new Date(pool.tokenRiskAssessedAt).getTime()
    : 0;
  if (pool.tokenRisk && now.getTime() - localAssessedAt < tokenRiskTtlMs(pool.tokenRisk)) {
    return pool.tokenRisk;
  }
  const cached = tokenRiskCache.get(pool.tokenAddress);
  if (
    cached &&
    now.getTime() - new Date(cached.assessedAt).getTime() < tokenRiskTtlMs(cached.risk)
  ) {
    pool.tokenRisk = cached.risk;
    pool.tokenRiskAssessedAt = cached.assessedAt;
    return cached.risk;
  }
  return undefined;
}

function cacheTokenRisk(pool: TrackedPool, risk: SolanaTokenRiskAssessment, now: Date): string {
  const assessedAt = now.toISOString();
  pool.tokenRisk = risk;
  pool.tokenRiskAssessedAt = assessedAt;
  tokenRiskCache.set(
    pool.tokenAddress,
    { risk, assessedAt },
    now.getTime() + tokenRiskTtlMs(risk),
    now.getTime()
  );
  return assessedAt;
}

function tokenRiskTtlMs(risk: SolanaTokenRiskAssessment): number {
  return risk.known ? 6 * 60 * 60_000 : tokenRiskUnknownTtlMs;
}

async function fetchTokenRiskWithFallback(mint: string): Promise<SolanaTokenRiskAssessment> {
  tokenRiskDiagnostics.primaryAttemptCount += 1;
  try {
    return await fetchSolanaTokenRisk({
      rpcUrl: tokenRiskRpcUrl,
      mint,
      maximumTopHolderPercent
    });
  } catch (primaryError) {
    if (!tokenRiskFallbackRpcUrl) throw primaryError;
    tokenRiskDiagnostics.fallbackAttemptCount += 1;
    try {
      return await fetchSolanaTokenRisk({
        rpcUrl: tokenRiskFallbackRpcUrl,
        mint,
        maximumTopHolderPercent
      });
    } catch (fallbackError) {
      throw new AggregateError(
        [primaryError, fallbackError],
        "Primary and fallback token-risk RPC lookups failed."
      );
    }
  }
}

async function enrichPassedTokenCreator(
  mint: string,
  risk: SolanaTokenRiskAssessment
): Promise<SolanaTokenRiskAssessment> {
  if (!risk.passed || risk.creatorAddress || !heliusEnhancedClient) return risk;

  tokenRiskDiagnostics.creatorEnrichmentAttemptCount += 1;
  try {
    const asset = (await heliusEnhancedClient.getAssetBatch([mint]))[0];
    const creatorAddress = asset ? creatorAddressFromAsset(asset) : undefined;
    if (!creatorAddress) {
      tokenRiskDiagnostics.creatorEnrichmentMissCount += 1;
      return risk;
    }
    tokenRiskDiagnostics.creatorEnrichmentSuccessCount += 1;
    return {
      ...risk,
      creatorAddress,
      evidence: {
        ...risk.evidence,
        creatorSource: "helius-das-filtered-candidate"
      }
    };
  } catch {
    tokenRiskDiagnostics.creatorEnrichmentErrorCount += 1;
    return risk;
  }
}

function rpcProviderLabel(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "invalid-rpc-url";
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  requestedConcurrency: number,
  operation: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const concurrency = Math.min(items.length, Math.max(1, Math.trunc(requestedConcurrency) || 1));
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await operation(items[index]!);
      }
    })
  );
  return results;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function unknownTokenRisk(reason: string): SolanaTokenRiskAssessment {
  return {
    known: false,
    passed: false,
    riskScore: 100,
    mintAuthorityRevoked: false,
    freezeAuthorityRevoked: false,
    topHolderPercent: 100,
    top10HolderPercent: 100,
    tokenProgram: "unknown",
    tokenExtensionEvidenceKnown: false,
    tokenExtensions: [],
    blockingTokenExtensions: [],
    warnings: ["Critical token safety evidence is incomplete.", reason],
    evidence: { source: "unavailable", reason }
  };
}

function normalizePoolDiscovery(discovery: PoolDiscovery): PoolDiscovery {
  if (
    discovery.quoteTokenAddress &&
    knownQuoteMints.has(discovery.baseTokenAddress) &&
    !knownQuoteMints.has(discovery.quoteTokenAddress)
  ) {
    return {
      ...discovery,
      baseTokenAddress: discovery.quoteTokenAddress,
      quoteTokenAddress: discovery.baseTokenAddress,
      raw: { ...discovery.raw, mintOrderNormalized: true }
    };
  }
  return discovery;
}

function activeBuySubscriptionCount(): number {
  return [...activePools.values()].filter((pool) => pool.subscribedToBuys).length;
}

function enforceActivePoolLimit(): void {
  while (activePools.size > activePoolMaxEntries) {
    const oldest = [...activePools.values()]
      .filter((pool) => !pool.subscribedToBuys)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))[0];
    if (!oldest) return;
    activePools.delete(oldest.poolAddress);
    poolSamplingDiagnostics.evictedActivePoolCount += 1;
  }
}

async function subscribePool(pool: TrackedPool, backfill = false): Promise<boolean> {
  if (pool.subscribedToBuys || !pool.tradeCoverageComplete) return false;
  if (tradeIngestMode === "rpc" && rpcTradeMaxActivePools <= 0) return false;
  if (
    tradeIngestMode === "rpc" &&
    liveTradeSource &&
    activeBuySubscriptionCount() >= rpcTradeMaxActivePools
  ) {
    return false;
  }
  if (tradeIngestMode === "rpc") {
    const result = await bootstrapTradeSubscription(pool, Date.now(), {
      subscribe: async () => {
        if (!liveTradeSource) return;
        await liveTradeSource.subscribeAddress(pool.poolAddress, [], backfill);
      },
      failClosed: async () => {
        await releaseRpcTradeObservation(
          pool,
          "rpc-trade-subscription-bootstrap-failed",
          new Date()
        );
      }
    });
    return result === "activated";
  }
  if (liveTradeSource) {
    await liveTradeSource.subscribeAddress(
      pool.poolAddress,
      [],
      tradeIngestMode === "transaction-subscribe" || backfill
    );
  }
  if (!pool.tradeCoverageComplete) {
    liveTradeSource?.unsubscribeAddress(pool.poolAddress);
    return false;
  }
  pool.subscribedToBuys = true;
  pool.everSubscribedToBuys = true;
  pool.observationSubscribedAtMs ??= Date.now();
  return true;
}

async function reconcileRpcTradeObservation(
  pool: TrackedPool,
  marketEligible: boolean,
  now: Date
): Promise<void> {
  if (tradeIngestMode !== "rpc") return;
  const admission = planTradeObservationAdmission(pool, activePools.values(), {
    nowMs: now.getTime(),
    maximumActivePools: rpcTradeMaxActivePools,
    minimumHoldMs: rpcTradeMinimumObservationHoldMs,
    marketEligible
  });
  if (admission.action === "defer") {
    if (admission.reason !== "already-subscribed") {
      tradeObservationDiagnostics.deferredCount += 1;
      tradeObservationDiagnostics.lastDeferredReason = admission.reason;
    }
    return;
  }
  if (admission.action === "replace") {
    const evicted = activePools.get(admission.evictPoolAddress);
    if (!evicted?.subscribedToBuys) {
      tradeObservationDiagnostics.deferredCount += 1;
      tradeObservationDiagnostics.lastDeferredReason = "replacement-state-changed";
      return;
    }
    await releaseRpcTradeObservation(evicted, "rpc-trade-observation-capacity-rotation", now);
    tradeObservationDiagnostics.replacementCount += 1;
    tradeObservationDiagnostics.lastReplacementAt = now.toISOString();
  }
  if (await subscribePool(pool, !pool.everSubscribedToBuys)) {
    tradeObservationDiagnostics.admissionCount += 1;
    tradeObservationDiagnostics.lastAdmissionAt = now.toISOString();
  }
}

async function releaseRpcTradeObservation(
  pool: TrackedPool,
  reason: string,
  gapAt: Date,
  details: {
    queueDelayMs?: number;
    queuedSignatures?: number;
    maxQueuedSignatures?: number;
  } = {}
): Promise<void> {
  const result = await tradeCoverageReleaseCoordinator.release(
    pool.poolAddress,
    pool,
    reason,
    gapAt.toISOString(),
    {
      persist: () => persistTradeCoverageState(pool),
      unsubscribe: () => liveTradeSource?.unsubscribeAddress(pool.poolAddress)
    }
  );
  if (result === "released") {
    poolSamplingDiagnostics.tradeCoverageExcludedPoolCount += 1;
    console.warn(
      JSON.stringify({
        type: "solana-trade-coverage-excluded",
        poolAddress: pool.poolAddress,
        reason,
        disposition: "durable-before-unsubscribe",
        ...details
      })
    );
  }
}

function handleTradeQueuePressure(pressure: {
  address: string;
  reason: "stale" | "high-water" | "full";
  queuedSignatures: number;
  maxQueuedSignatures: number;
  oldestQueueDelayMs?: number;
}): void {
  const pool = activePools.get(pressure.address);
  if (
    !pool ||
    !pool.tradeCoverageComplete ||
    tradeCoverageReleaseCoordinator.isInFlight(pool.poolAddress)
  ) {
    return;
  }
  poolSamplingDiagnostics.tradeQueuePressureCount += 1;
  void releaseRpcTradeObservation(pool, `rpc-trade-queue-${pressure.reason}`, new Date(), {
    ...(pressure.oldestQueueDelayMs === undefined
      ? {}
      : { queueDelayMs: pressure.oldestQueueDelayMs }),
    queuedSignatures: pressure.queuedSignatures,
    maxQueuedSignatures: pressure.maxQueuedSignatures
  }).catch((error) => recordTradeCoverageReleaseError(pool, error, pressure));
}

async function handleTradeBackfillTruncation(truncation: SolanaBackfillTruncation): Promise<void> {
  const pool = activePools.get(truncation.address);
  if (!pool) {
    liveTradeSource?.unsubscribeAddress(truncation.address);
    throw new Error(
      `Trade backfill truncated for unknown active pool ${truncation.address}; subscription rejected.`
    );
  }
  const reason = `rpc-trade-backfill-${truncation.reason}`;
  await releaseRpcTradeObservation(pool, reason, new Date());
  console.warn(
    JSON.stringify({
      type: "solana-trade-coverage-excluded",
      poolAddress: pool.poolAddress,
      reason,
      fetchedSignatureCount: truncation.fetchedSignatureCount,
      limit: truncation.limit
    })
  );
}

function recordTradeCoverageReleaseError(
  pool: TrackedPool,
  error: unknown,
  pressure?: { queuedSignatures: number; maxQueuedSignatures: number }
): void {
  const message = error instanceof Error ? error.message : String(error);
  poolSamplingDiagnostics.tradeCoverageReleaseErrorCount += 1;
  poolSamplingDiagnostics.lastTradeCoverageReleaseError = message;
  console.error(
    JSON.stringify({
      type: "solana-trade-coverage-release-error",
      poolAddress: pool.poolAddress,
      message,
      ...(pressure
        ? {
            queuedSignatures: pressure.queuedSignatures,
            maxQueuedSignatures: pressure.maxQueuedSignatures
          }
        : {})
    })
  );
}

async function persistTradeCoverageState(pool: TrackedPool): Promise<void> {
  const stored = await repository.getPool("solana", pool.poolAddress);
  if (!stored) {
    throw new Error(`Cannot persist trade coverage for missing pool ${pool.poolAddress}.`);
  }
  await repository.upsertPool({
    ...stored,
    raw: {
      ...(stored.raw ?? {}),
      tradeCoverage: {
        complete: pool.tradeCoverageComplete,
        ...(pool.tradeCoverageGapAt ? { gapAt: pool.tradeCoverageGapAt } : {}),
        ...(pool.tradeCoverageGapReason ? { gapReason: pool.tradeCoverageGapReason } : {})
      }
    }
  });
  pool.tradeCoveragePersisted = true;
}

async function syncWebhookAddresses(): Promise<void> {
  if (!webhookAddressClient || webhookSyncRunning || storageGateDiagnostics.paused) return;
  webhookSyncRunning = true;
  try {
    // Never subscribe a paid webhook to a high-traffic program ID. Only the
    // newest pools that already passed the cheap market-data gate are eligible.
    const desiredAddresses = [...activePools.values()]
      .filter((pool) => pool.controlledFlow)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, heliusWebhookMaxPoolAddresses)
      .map((pool) => pool.poolAddress)
      .sort();
    webhookDiagnostics.desiredAddressCount = desiredAddresses.length;
    if (desiredAddresses.length === 0) {
      webhookDiagnostics.status = "degraded";
      webhookDiagnostics.lastError = "No active pool addresses are available for webhook sync.";
      return;
    }
    const result = await webhookAddressClient.syncAddresses(desiredAddresses);
    webhookDiagnostics = {
      ...webhookDiagnostics,
      status: "ok",
      syncedAddressCount: result.addressCount,
      syncCount: webhookDiagnostics.syncCount + 1,
      updateCount: webhookDiagnostics.updateCount + (result.changed ? 1 : 0),
      lastSyncedAt: new Date().toISOString(),
      lastError: null
    };
    console.log(
      JSON.stringify({
        type: "helius-webhook-sync",
        changed: result.changed,
        addressCount: result.addressCount,
        addedAddressCount: result.addedAddresses.length,
        removedAddressCount: result.removedAddressCount
      })
    );
  } catch (error) {
    webhookDiagnostics = {
      ...webhookDiagnostics,
      status: "degraded",
      syncErrorCount: webhookDiagnostics.syncErrorCount + 1,
      lastError: error instanceof Error ? error.message : String(error)
    };
    console.error(
      JSON.stringify({
        type: "helius-webhook-sync-error",
        message: webhookDiagnostics.lastError
      })
    );
  } finally {
    webhookSyncRunning = false;
  }
}

async function eventPools(event: Parameters<typeof decodeWalletTrades>[0]): Promise<TrackedPool[]> {
  const directPool = activePools.get(event.address) ?? knownPoolsByAddress.get(event.address);
  if (directPool) return [directPool];
  if (missingPoolAddresses.has(event.address)) return [];
  const stored = await repository.getPool("solana", event.address);
  if (!stored?.createdAt) {
    missingPoolAddresses.set(event.address, true, Date.now() + 5 * 60_000);
    return [];
  }
  const tracked = trackedPoolFromSnapshot(stored, new Date());
  rememberPool(tracked);
  return [tracked];
}

function walletTradeDecodeContexts(
  event: Parameters<typeof decodeWalletTrades>[0],
  pool: TrackedPool
): Array<Parameters<typeof decodeWalletTrades>[1]> {
  const common: Parameters<typeof decodeWalletTrades>[1] = {
    poolAddress: pool.poolAddress,
    tokenAddress: pool.tokenAddress,
    quoteTokenAddress: pool.quoteTokenAddress ?? wrappedSolMint,
    poolCreatedAt: pool.createdAt
  };
  const venueMatches = decodeRaydiumTradeInstructions(event).filter(
    (match) => match.poolAddress === pool.poolAddress
  );
  if (venueMatches.length === 0) return [common];
  const selectedMatchByTrader = new Map(venueMatches.map((match) => [match.traderAddress, match]));
  return [...selectedMatchByTrader.values()].map((match) => ({
    ...common,
    verifiedUserAuthorityAddresses: match.verifiedUserAuthorityAddresses,
    infrastructureAddresses: match.infrastructureAddresses,
    instructionIndex: match.instructionIndex,
    ...(match.innerInstructionIndex !== undefined
      ? { innerInstructionIndex: match.innerInstructionIndex }
      : {}),
    decoderVersion: match.decoderVersion
  }));
}

function rememberPool(pool: TrackedPool) {
  const nowMs = Date.now();
  const expiresAtMs = new Date(pool.createdAt).getTime() + knownPoolRetentionMs;
  knownPoolsByAddress.set(pool.poolAddress, pool, expiresAtMs, nowMs);
  const existing = knownPoolsByToken.get(pool.tokenAddress);
  if (!existing || new Date(pool.createdAt).getTime() < new Date(existing.createdAt).getTime()) {
    knownPoolsByToken.set(pool.tokenAddress, pool, expiresAtMs, nowMs);
  }
}

function trackedPoolFromSnapshot(stored: PoolSnapshot, now: Date): TrackedPool {
  const flowEvidence = buildRestoredFlowEvidence(stored, now);
  const tradeCoverage = storedTradeCoverage(stored.raw);
  return {
    poolAddress: stored.poolAddress,
    createdAt: stored.createdAt ?? now.toISOString(),
    tokenAddress: stored.baseTokenAddress,
    ...(stored.quoteTokenAddress ? { quoteTokenAddress: stored.quoteTokenAddress } : {}),
    ...(typeof stored.raw?.creatorAddress === "string"
      ? { creatorAddress: stored.raw.creatorAddress }
      : {}),
    programId: stored.dex,
    signature: `restored:${stored.poolAddress}`,
    slot: 0,
    previousLiquidityUsd: stored.liquidityUsd,
    subscribedToBuys: false,
    everSubscribedToBuys: false,
    controlledFlow: tradeIngestMode === "rpc" ? false : flowEvidence.controlledFlow,
    tradeCoverageComplete: tradeCoverage.complete,
    tradeCoveragePersisted: true,
    observationMarketEligible: passesStoredMarketGate(stored),
    ...(tradeCoverage.gapAt ? { tradeCoverageGapAt: tradeCoverage.gapAt } : {}),
    ...(tradeCoverage.gapReason ? { tradeCoverageGapReason: tradeCoverage.gapReason } : {}),
    lastPersistedMarketAtMs: now.getTime(),
    lastPersistedMarketEligible: passesStoredMarketGate(stored)
  };
}

function storedTradeCoverage(raw: Record<string, unknown> | undefined): {
  complete: boolean;
  gapAt?: string;
  gapReason?: string;
} {
  const value = raw?.tradeCoverage;
  if (!value || typeof value !== "object" || Array.isArray(value)) return { complete: true };
  const coverage = value as Record<string, unknown>;
  return {
    complete: coverage.complete !== false,
    ...(typeof coverage.gapAt === "string" ? { gapAt: coverage.gapAt } : {}),
    ...(typeof coverage.gapReason === "string" ? { gapReason: coverage.gapReason } : {})
  };
}

function passesStoredMarketGate(pool: PoolSnapshot): boolean {
  return passesSolanaRiskMarketGate({
    liquidityUsd: pool.liquidityUsd,
    volume5mUsd: pool.volume5mUsd,
    buys5m: pool.txns5m.buys,
    sells5m: pool.txns5m.sells,
    minimumLiquidityUsd: minLiquidityUsd,
    minimumVolume5mUsd: minVolume5mUsd,
    maximumSwaps5m: maxSwaps5m,
    maximumVolumeLiquidityRatio: maxVolumeLiquidityRatio
  });
}

function buildBuyDefinitions(): RawBuyInstructionDefinition[] {
  const pumpProgramId = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
  const pumpSwapProgramId = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
  return [
    {
      name: "pump-buy",
      programId: pumpProgramId,
      discriminatorHex: "66063d1201daebea",
      poolAccountIndex: 3,
      outputTokenAccountIndex: 2,
      traderAccountIndex: 6,
      staticInputTokenAddress: wrappedSolMint
    },
    {
      name: "pump-buy-exact-sol-in",
      programId: pumpProgramId,
      discriminatorHex: "38fc74089edfcd5f",
      poolAccountIndex: 3,
      outputTokenAccountIndex: 2,
      traderAccountIndex: 6,
      staticInputTokenAddress: wrappedSolMint
    },
    {
      name: "pump-buy-v2",
      programId: pumpProgramId,
      discriminatorHex: "b817ee6167c5d33d",
      poolAccountIndex: 10,
      outputTokenAccountIndex: 1,
      inputTokenAccountIndex: 2,
      traderAccountIndex: 13
    },
    {
      name: "pump-buy-exact-quote-in-v2",
      programId: pumpProgramId,
      discriminatorHex: "c2ab1c46684d5b2f",
      poolAccountIndex: 10,
      outputTokenAccountIndex: 1,
      inputTokenAccountIndex: 2,
      traderAccountIndex: 13
    },
    {
      name: "pumpswap-buy",
      programId: pumpSwapProgramId,
      discriminatorHex: "66063d1201daebea",
      poolAccountIndex: 0,
      traderAccountIndex: 1,
      outputTokenAccountIndex: 3,
      inputTokenAccountIndex: 4
    },
    {
      name: "pumpswap-buy-exact-quote-in",
      programId: pumpSwapProgramId,
      discriminatorHex: "c62e1552b4d9e870",
      poolAccountIndex: 0,
      traderAccountIndex: 1,
      outputTokenAccountIndex: 3,
      inputTokenAccountIndex: 4
    }
  ];
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function createCursorStore(source: string, provider: string): SolanaCursorStore {
  return {
    async get(address) {
      const cursor = await repository.getIngestionCursor(source, address);
      return cursor
        ? {
            signature: cursor.lastSignature,
            slot: cursor.lastSlot,
            updatedAt: cursor.observedAt,
            ...(cursor.lastEventOccurredAt ? { occurredAt: cursor.lastEventOccurredAt } : {})
          }
        : undefined;
    },
    async save(address, cursor) {
      const observedAt = new Date().toISOString();
      await repository.upsertIngestionCursor({
        idempotencyKey: `${source}:${address}:${cursor.signature}`,
        chain: "solana",
        source,
        address,
        lastSignature: cursor.signature,
        lastSlot: cursor.slot,
        signature: cursor.signature,
        slot: cursor.slot,
        provider,
        observedAt,
        strategyVersion,
        ...(cursor.occurredAt ? { lastEventOccurredAt: cursor.occurredAt } : {})
      });
    }
  };
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseTradeIngestMode(
  value: string | undefined,
  fallback: TradeIngestMode
): TradeIngestMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (["transaction-subscribe", "webhook", "rpc"].includes(normalized)) {
    return normalized as TradeIngestMode;
  }
  throw new Error("HELIUS_INGEST_MODE must be transaction-subscribe, webhook, or rpc.");
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Math.trunc(Number(raw ?? fallback));
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function isPublicSolanaWs(url: string): boolean {
  try {
    return new URL(url).hostname === "api.mainnet-beta.solana.com";
  } catch {
    return false;
  }
}

async function shutdown() {
  clearInterval(canonicalTimer);
  clearInterval(finalityTimer);
  clearInterval(sampleTimer);
  clearInterval(healthTimer);
  clearInterval(storageGateTimer);
  clearInterval(discoverySentinelTimer);
  if (webhookSyncTimer) clearInterval(webhookSyncTimer);
  await discoverySupervisor.stop();
  if (liveTradeSource) await liveTradeSource.stop();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

function parsePrograms(raw: string | undefined): ProgramConfig[] {
  if (!raw) {
    throw new Error(
      "SOLANA_POOL_PROGRAMS_JSON must contain verified program IDs and parsed pool instruction names."
    );
  }
  const programs = JSON.parse(raw) as ProgramConfig[];
  if (
    !Array.isArray(programs) ||
    programs.some(
      (program) =>
        !program.programId ||
        ((!Array.isArray(program.instructionTypes) || program.instructionTypes.length === 0) &&
          (!Array.isArray(program.rawInstructions) || program.rawInstructions.length === 0))
    )
  ) {
    throw new Error("SOLANA_POOL_PROGRAMS_JSON has an invalid shape.");
  }
  const configured = programs.map((program) => ({
    ...program,
    ...(program.programId === "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P" &&
    program.rawInstructions
      ? {
          rawInstructions: program.rawInstructions.map((instruction) =>
            instruction.discriminatorHex === "181ec828051c0777" ||
            instruction.discriminatorHex === "d6904cec5f8b31b4"
              ? { ...instruction, creatorDataEncoding: "pump-borsh-after-3-strings" as const }
              : instruction
          )
        }
      : {})
  }));
  if (!parseBooleanEnv(process.env.SOLANA_ENABLE_EXTENDED_VENUES, false)) return configured;
  const merged = new Map(configured.map((program) => [program.programId, program]));
  for (const venue of REVIEWED_SOLANA_VENUE_PROGRAMS) {
    const existing = merged.get(venue.programId);
    const instructions = [
      ...(existing?.rawInstructions ?? []),
      ...venue.instructions.filter(
        (candidate) =>
          !existing?.rawInstructions?.some(
            (current) => current.discriminatorHex === candidate.discriminatorHex
          )
      )
    ];
    merged.set(venue.programId, {
      programId: venue.programId,
      ...(existing?.instructionTypes ? { instructionTypes: existing.instructionTypes } : {}),
      rawInstructions: instructions
    });
  }
  return [...merged.values()];
}

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function anchorLogName(name: string): string {
  return name
    .split("-")
    .slice(1)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}
