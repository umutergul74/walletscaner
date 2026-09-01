import { createHash } from "node:crypto";
import { fetchJson } from "./http";
import { createLogsSubscribeRequest } from "./solana-ws";

const LOGS_NOTIFICATION_METHOD_PATTERN = /"method"\s*:\s*"logsNotification"/;

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface SolanaCursor {
  signature: string;
  slot: number;
  /** Durable cursor write time when the backing store can provide it. */
  updatedAt?: string;
  /** Chain occurrence time of the durably admitted cursor event. */
  occurredAt?: string;
}

/**
 * The event was fetched successfully but the downstream durable-admission
 * boundary was closed (for example by the disk storage gate). Sources must not
 * mark the signature seen or advance a cursor when this error is raised.
 */
export class SolanaEventNotAcceptedError extends Error {
  readonly code = "SOLANA_EVENT_NOT_ACCEPTED";

  constructor(message = "Solana event was not accepted by the durable handler.") {
    super(message);
    this.name = "SolanaEventNotAcceptedError";
  }
}

export interface SolanaCursorStore {
  get(address: string): Promise<SolanaCursor | undefined>;
  save(address: string, cursor: SolanaCursor): Promise<void>;
}

export interface DurableSolanaSignatureItem {
  provider: string;
  address: string;
  signature: string;
  slot: number;
  notifiedAt: string;
  attemptCount?: number;
  nextAttemptAt?: string;
}

export interface DurableSolanaSignatureFailureOptions {
  error: string;
  failedAt: string;
  retryAt: string;
  maxAttempts: number;
}

export interface DurableSolanaSignatureFailureResult {
  status: "retry" | "dead_letter";
  attemptCount: number;
  retryAt?: string;
}

/**
 * Durable admission boundary for live WebSocket signatures. `admit` returns
 * true when the row is pending (new or replayable), and false only when that
 * exact provider/address/signature has already completed.
 */
export interface DurableSolanaSignatureStore {
  admitSolanaSignature(item: DurableSolanaSignatureItem): Promise<boolean>;
  listPendingSolanaSignatures(
    provider: string,
    address: string,
    limit: number
  ): Promise<DurableSolanaSignatureItem[]>;
  completeSolanaSignature(
    provider: string,
    address: string,
    signature: string,
    completedAt?: string
  ): Promise<boolean>;
  deferSolanaSignature(
    provider: string,
    address: string,
    signature: string,
    options: DurableSolanaSignatureFailureOptions
  ): Promise<DurableSolanaSignatureFailureResult | undefined>;
}

export interface SolanaGapRepairSession {
  repairId: string;
  incidentId: string;
  provider: string;
  programAddress: string;
  cursorSignature: string;
  cursorSlot: number;
  cursorOccurredAt?: string;
  boundarySource: "unsafe_legacy_current_cursor" | "truncation_cursor";
  targetSignature?: string;
  targetSlot?: number;
  beforeSignature?: string;
  status: "collecting" | "replaying" | "completed" | "failed";
  boundaryReached: boolean;
  fetchedSignatureCount: number;
  completedSignatureCount: number;
  collectionAttemptCount: number;
  replayAttemptCount: number;
  lastError?: string;
  coveredThroughSignature?: string;
  coveredThroughSlot?: number;
}

export interface SolanaGapRepairSignatureItem {
  repairId: string;
  signature: string;
  slot: number;
  positionFromHead: number;
}

export interface DurableSolanaGapRepairStore {
  getOrCreateIngestionGapRepair(input: {
    repairId: string;
    incidentId: string;
    provider: string;
    programAddress: string;
    cursorSignature: string;
    cursorSlot: number;
    cursorOccurredAt?: string;
    boundarySource: "unsafe_legacy_current_cursor" | "truncation_cursor";
  }): Promise<SolanaGapRepairSession>;
  stageIngestionGapRepairPage(input: {
    repairId: string;
    signatures: Array<{ signature: string; slot: number; positionFromHead: number }>;
    beforeSignature?: string;
    boundaryReached: boolean;
    targetSignature?: string;
    targetSlot?: number;
  }): Promise<SolanaGapRepairSession>;
  listPendingIngestionGapRepairSignatures(
    repairId: string,
    limit: number
  ): Promise<SolanaGapRepairSignatureItem[]>;
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
}

export interface SolanaGapRepairResult {
  repairId: string;
  status: "collecting" | "replaying" | "completed" | "blocked" | "unavailable";
  fetchedSignatureCount: number;
  completedSignatureCount: number;
  coveredThroughSignature?: string;
  coveredThroughSlot?: number;
  error?: string;
}

export interface SolanaGapRepairBoundary {
  signature: string;
  slot: number;
  occurredAt?: string;
  source: "truncation_cursor";
}

export interface SolanaRpcTransaction {
  blockTime?: number | null;
  meta?: Record<string, unknown> | null;
  transaction?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SolanaChainEvent {
  address: string;
  matchedAddresses?: string[];
  signature: string;
  slot: number;
  transactionIndex?: number;
  occurredAt?: string;
  observedAt: string;
  commitment?: "processed" | "confirmed" | "finalized";
  source?: string;
  providerTiming?: SolanaProviderTimingMetadata;
  transaction: SolanaRpcTransaction;
}

/** Compact, secret-free transport timing persisted with the canonical payload. */
export interface SolanaProviderTimingMetadata {
  origin: "live" | "backfill";
  fetchStartedAtMs: number;
  fetchCompletedAtMs: number;
  fetchCycleDurationMs: number;
  transactionHttpDurationMs: number;
  fetchAttempts: number;
  notificationReceivedAtMs?: number;
  queueDelayMs?: number;
}

export interface SolanaEventSourceDiagnostics {
  provider: string;
  status: "ok" | "degraded" | "down";
  connectionState?: "idle" | "connecting" | "open" | "backoff" | "reconnecting" | "stopped";
  reconnectAttempt?: number;
  nextReconnectDelayMs?: number | null;
  lastConnectedAt?: string | null;
  reconnectCount: number;
  duplicateSignatureCount: number;
  backfillEventCount: number;
  backfillTruncatedCount?: number;
  backfillTruncatedAddressCount?: number;
  lastBackfillTruncatedAt?: string | null;
  lastBackfillTruncatedCursorAt?: string | null;
  lastBackfillTruncatedCursorSlot?: number | null;
  lastBackfillTruncatedCursorSignature?: string | null;
  missingSlotCount: number;
  unresolvedTransactionCount: number;
  lastProviderLatencyMs: number | null;
  lastEventOrigin?: "live" | "backfill" | null;
  lastLiveProviderLatencyMs?: number | null;
  maxLiveProviderLatencyMs?: number | null;
  lastBackfillProviderLatencyMs?: number | null;
  lastLiveNotificationAt?: string | null;
  lastWebsocketMessageAt?: string | null;
  lastWebsocketContextSlot?: number | null;
  lastWebsocketSignature?: string | null;
  websocketNotificationCount?: number;
  lastWebsocketNotificationAgeMs?: number | null;
  maxWebsocketNotificationAgeMs?: number | null;
  lastNotificationToObservedMs?: number | null;
  maxNotificationToObservedMs?: number | null;
  lastTransactionQueueDelayMs?: number | null;
  maxTransactionQueueDelayMs?: number | null;
  lastTransactionFetchCycleDurationMs?: number | null;
  maxTransactionFetchCycleDurationMs?: number | null;
  lastTransactionHttpDurationMs?: number | null;
  maxTransactionHttpDurationMs?: number | null;
  lastTransactionFetchAttempts?: number;
  transactionNullResponseCount?: number;
  transactionRequestErrorCount?: number;
  transactionRequestTimeoutCount?: number;
  transactionRequestTimeoutMs?: number;
  transactionRequestRetryLimit?: number;
  providerLatencyWarningMs?: number;
  liveEventCount?: number;
  slowLiveEventCount?: number;
  lastSlowLiveEventAt?: string | null;
  websocketMessageCount?: number;
  websocketMessageBytes?: number;
  prefilteredWebsocketMessageCount?: number;
  prefilteredWebsocketMessageBytes?: number;
  postfetchFilteredTransactionCount?: number;
  seenSignatureCount?: number;
  seenSignatureLimit?: number;
  inFlightSignatureCount?: number;
  queuedSignatureCount?: number;
  activeTransactionWorkerCount?: number;
  maxConcurrentTransactionFetches?: number;
  maxQueuedSignatures?: number;
  maximumLiveQueueDelayMs?: number | null;
  droppedSignatureCount?: number;
  purgedSignatureCount?: number;
  durableSignatureAdmissionCount?: number;
  durableSignatureAdmissionErrorCount?: number;
  durableSignatureCompletionErrorCount?: number;
  durableSignatureReloadCount?: number;
  durablyDeferredSignatureCount?: number;
  durableSignatureRetryCount?: number;
  durableSignatureDeadLetterCount?: number;
  durableSignatureLastRetryAt?: string | null;
  durableSignatureLastDeadLetterAt?: string | null;
  transactionFallbackRequestCount?: number;
  transactionFallbackRecoveredCount?: number;
  transactionFallbackErrorCount?: number;
  transactionFallbackTimeoutCount?: number;
  queuePressureCount?: number;
  queuePressureAddressCount?: number;
  lastQueuePressureAt?: string | null;
  lastQueuePressureReason?: "stale" | "high-water" | "full" | null;
  lastQueuePressureDelayMs?: number | null;
  queueHighWatermark?: number;
  transactionRequestCount?: number;
  transactionRetryCount?: number;
  recoveredTransactionCount?: number;
  pendingSubscriptionRequestCount?: number;
  configuredAddressCount?: number;
  subscribedAddressCount?: number;
  successfulSubscriptionAckCount?: number;
  successfulSubscriptionAckAddressCount?: number;
  lastSubscriptionRequestAt?: string | null;
  lastSubscriptionAckAt?: string | null;
  subscriptionAckTimeoutCount?: number;
  subscriptionAckTimedOutAddressCount?: number;
  lastSubscriptionAckTimeoutAt?: string | null;
  handlerRejectedEventCount?: number;
  handlerAdmissionRetryCount?: number;
  lastHandlerRejectedEventAt?: string | null;
  heartbeatTimeoutCount?: number;
  lastPingAt?: string | null;
  lastPongAt?: string | null;
  gapRepairCollectionCount?: number;
  gapRepairCompletionCount?: number;
  gapRepairStagedSignatureCount?: number;
  gapRepairReplayedSignatureCount?: number;
  lastGapRepairAt?: string | null;
  lastGapRepairCompletedAt?: string | null;
  lastGapRepairId?: string | null;
  lastGapRepairError?: string | null;
  lastGapRepairCoveredThroughSignature?: string | null;
  lastGapRepairCoveredThroughSlot?: number | null;
}

export interface WebSocketMessage {
  data: string | ArrayBuffer | Blob;
}

export interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: WebSocketMessage) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onpong?: (() => void) | null;
  ping?(): void;
  on?(event: "pong", listener: () => void): void;
  send(data: string): void;
  close(): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface SolanaBackfillTruncation {
  address: string;
  reason: "cursor-boundary-not-reached" | "cursorless-initial-limit";
  fetchedSignatureCount: number;
  limit: number;
}

export interface StandardSolanaEventSourceOptions {
  rpcUrl: string;
  /** Optional bounded archival fallback used only after the primary RPC cannot resolve a tx. */
  transactionFallbackRpcUrl?: string;
  wsUrl: string;
  addresses: string[];
  cursorStore: SolanaCursorStore;
  liveSignatureStore?: DurableSolanaSignatureStore;
  gapRepairStore?: DurableSolanaGapRepairStore;
  /** Discovery-only escape hatch; durable admission is mandatory when true. */
  allowConcurrentLiveSignaturesPerAddress?: boolean;
  logIncludesByAddress?: Record<string, string[]>;
  provider?: string;
  commitment?: "processed" | "confirmed" | "finalized";
  fetchImpl?: typeof fetch;
  webSocketFactory?: WebSocketFactory;
  /** Initial reconnect delay. Rapid failures back off exponentially from this value. */
  reconnectDelayMs?: number;
  reconnectMaxDelayMs?: number;
  /** A socket must stay open this long before the reconnect attempt counter resets. */
  reconnectStableAfterMs?: number;
  reconnectJitterRatio?: number;
  /** Test seam for reconnect jitter. */
  random?: () => number;
  initialBackfillLimit?: number;
  backfillPageLimit?: number;
  maxBackfillPages?: number;
  minTransactionRequestIntervalMs?: number;
  transactionFetchDelayMs?: number;
  transactionFetchMaxAttempts?: number;
  transactionFetchRetryDelayMs?: number;
  transactionFetchRetryMaxDelayMs?: number;
  transactionRequestTimeoutMs?: number;
  transactionRequestRetries?: number;
  transactionFallbackRequestTimeoutMs?: number;
  transactionFallbackMinRequestIntervalMs?: number;
  durableSignatureRetryBaseDelayMs?: number;
  durableSignatureRetryMaxDelayMs?: number;
  durableSignatureMaxAttempts?: number;
  providerLatencyWarningMs?: number;
  subscriptionAckTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  gapRepairReplayLimit?: number;
  gapRepairMaxSignatures?: number;
  handlerRejectionRetryDelayMs?: number;
  maxConcurrentTransactionFetches?: number;
  maxQueuedSignatures?: number;
  /**
   * Optional live queue-age circuit breaker. The admitted head is still processed,
   * while the owner may fail closed and unsubscribe the saturated address.
   */
  maximumLiveQueueDelayMs?: number;
  seenSignatureLimit?: number;
  queuePressureRatio?: number;
  onQueuePressure?: (pressure: {
    address: string;
    reason: "stale" | "high-water" | "full";
    queuedSignatures: number;
    maxQueuedSignatures: number;
    oldestQueueDelayMs?: number;
  }) => void;
  onDurableSignatureDeadLetter?: (item: {
    provider: string;
    address: string;
    signature: string;
    slot: number;
    notifiedAt: string;
    failedAt: string;
    attemptCount: number;
    error: string;
  }) => Promise<void> | void;
  onBackfillTruncated?: (truncation: SolanaBackfillTruncation) => Promise<void> | void;
  now?: () => Date;
}

export interface SolanaEventSource {
  start(onEvent: (event: SolanaChainEvent) => Promise<void> | void): Promise<void>;
  stop(): Promise<void>;
  subscribeAddress(address: string, logIncludes?: string[], backfill?: boolean): Promise<void>;
  unsubscribeAddress(address: string): void;
  backfill(
    address: string,
    onEvent: (event: SolanaChainEvent) => Promise<void> | void
  ): Promise<number>;
  repairGap?(
    address: string,
    incidentId: string,
    onEvent: (event: SolanaChainEvent) => Promise<void> | void,
    boundary?: SolanaGapRepairBoundary
  ): Promise<SolanaGapRepairResult>;
  acknowledgeUnreconciledGap?(address: string): void;
  getDiagnostics(): SolanaEventSourceDiagnostics;
}

interface RpcResponse<T> {
  result: T;
}

interface SignatureInfo {
  signature: string;
  slot: number;
  err?: unknown;
}

interface LogsNotification {
  method?: string;
  params?: {
    subscription?: number;
    result?: {
      context?: { slot?: number };
      value?: { signature?: string; err?: unknown; logs?: string[] };
    };
  };
}

interface SubscriptionResponse {
  id?: number;
  result?: number;
}

interface QueuedLiveSignature {
  address: string;
  signature: string;
  slot: number;
  notifiedAtMs: number;
  attemptCount?: number;
}

type SignatureOrigin = "live" | "backfill";

interface SignatureTimingContext {
  origin: SignatureOrigin;
  notifiedAtMs?: number;
}

export class StandardSolanaEventSource implements SolanaEventSource {
  private readonly provider: string;
  private readonly commitment: "processed" | "confirmed" | "finalized";
  private readonly reconnectDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly reconnectStableAfterMs: number;
  private readonly reconnectJitterRatio: number;
  private readonly random: () => number;
  private readonly initialBackfillLimit: number;
  private readonly backfillPageLimit: number;
  private readonly maxBackfillPages: number;
  private readonly minTransactionRequestIntervalMs: number;
  private readonly transactionFetchDelayMs: number;
  private readonly transactionFetchMaxAttempts: number;
  private readonly transactionFetchRetryDelayMs: number;
  private readonly transactionFetchRetryMaxDelayMs: number;
  private readonly transactionRequestTimeoutMs: number;
  private readonly transactionRequestRetries: number;
  private readonly transactionFallbackRequestTimeoutMs: number;
  private readonly transactionFallbackMinRequestIntervalMs: number;
  private readonly durableSignatureRetryBaseDelayMs: number;
  private readonly durableSignatureRetryMaxDelayMs: number;
  private readonly durableSignatureMaxAttempts: number;
  private readonly providerLatencyWarningMs: number;
  private readonly subscriptionAckTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly gapRepairReplayLimit: number;
  private readonly gapRepairMaxSignatures: number;
  private readonly handlerRejectionRetryDelayMs: number;
  private readonly maxConcurrentTransactionFetches: number;
  private readonly maxQueuedSignatures: number;
  private readonly maximumLiveQueueDelayMs: number | null;
  private readonly seenSignatureLimit: number;
  private readonly queuePressureThreshold: number;
  private readonly allowConcurrentLiveSignaturesPerAddress: boolean;
  private readonly now: () => Date;
  private readonly socketFactory: WebSocketFactory;
  private readonly seenSignatures = new Set<string>();
  private readonly inFlightSignatures = new Set<string>();
  private readonly queuedSignatures = new Set<string>();
  private readonly liveSignatureQueue: QueuedLiveSignature[] = [];
  private readonly requestAddress = new Map<number, string>();
  private readonly subscriptionAckTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly timedOutSubscriptionRequests = new Set<number>();
  private readonly successfulSubscriptionAddresses = new Set<string>();
  private readonly subscriptionAddress = new Map<number, string>();
  private readonly subscriptionByAddress = new Map<string, number>();
  private readonly addressLogIncludes = new Map<string, string[]>();
  private readonly backfillAddresses = new Set<string>();
  private readonly automaticBackfillAddresses = new Set<string>();
  private readonly automaticBackfillRerunAddresses = new Set<string>();
  private readonly truncatedBackfillAddresses = new Set<string>();
  private readonly queuePressureByAddress = new Map<string, "stale" | "high-water" | "full">();
  private readonly staleQueueTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly addressTaskTails = new Map<string, Promise<void>>();
  private readonly activeTransactionAddresses = new Set<string>();
  private readonly durableRefillAddresses = new Set<string>();
  private readonly durableRefillRequestedAddresses = new Set<string>();
  private readonly durableRefillTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; dueAtMs: number }
  >();
  private readonly retryWaiters = new Set<() => void>();
  private encodedLogIncludePattern: RegExp | null = null;
  private fastLogPrefilterEnabled = false;
  private nextRequestId = 1;
  private socketGeneration = 0;
  private socket: WebSocketLike | null = null;
  private socketOpen = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectStabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatRequestId: number | null = null;
  private heartbeatSentAtMs: number | null = null;
  private transactionRequestGate: Promise<void> = Promise.resolve();
  private lastTransactionRequestAtMs = 0;
  private transactionFallbackRequestGate: Promise<void> = Promise.resolve();
  private lastTransactionFallbackRequestAtMs = 0;
  private activeTransactionWorkers = 0;
  private stopped = true;
  private handler: ((event: SolanaChainEvent) => Promise<void> | void) | null = null;
  private diagnostics: SolanaEventSourceDiagnostics;

  constructor(private readonly options: StandardSolanaEventSourceOptions) {
    this.provider = options.provider ?? "solana-rpc";
    this.commitment = options.commitment ?? "confirmed";
    this.reconnectDelayMs = positiveInteger(options.reconnectDelayMs ?? 1_000, "reconnectDelayMs");
    this.reconnectMaxDelayMs = positiveInteger(
      options.reconnectMaxDelayMs ?? 30_000,
      "reconnectMaxDelayMs"
    );
    if (this.reconnectMaxDelayMs < this.reconnectDelayMs) {
      throw new Error("reconnectMaxDelayMs must be greater than or equal to reconnectDelayMs.");
    }
    this.reconnectStableAfterMs = positiveInteger(
      options.reconnectStableAfterMs ?? 60_000,
      "reconnectStableAfterMs"
    );
    this.reconnectJitterRatio = options.reconnectJitterRatio ?? 0.2;
    if (
      !Number.isFinite(this.reconnectJitterRatio) ||
      this.reconnectJitterRatio < 0 ||
      this.reconnectJitterRatio > 0.5
    ) {
      throw new Error("reconnectJitterRatio must be between 0 and 0.5.");
    }
    this.random = options.random ?? Math.random;
    this.initialBackfillLimit = options.initialBackfillLimit ?? 100;
    this.backfillPageLimit = options.backfillPageLimit ?? 1_000;
    this.maxBackfillPages = options.maxBackfillPages ?? 10;
    this.minTransactionRequestIntervalMs = options.minTransactionRequestIntervalMs ?? 0;
    this.transactionFetchDelayMs = options.transactionFetchDelayMs ?? 0;
    this.transactionFetchMaxAttempts = positiveInteger(
      options.transactionFetchMaxAttempts ?? (this.transactionFetchDelayMs > 0 ? 2 : 1),
      "transactionFetchMaxAttempts"
    );
    this.transactionFetchRetryDelayMs = positiveInteger(
      options.transactionFetchRetryDelayMs ?? Math.max(250, this.transactionFetchDelayMs || 1_000),
      "transactionFetchRetryDelayMs"
    );
    this.transactionFetchRetryMaxDelayMs = positiveInteger(
      options.transactionFetchRetryMaxDelayMs ?? 8_000,
      "transactionFetchRetryMaxDelayMs"
    );
    this.transactionRequestTimeoutMs = positiveInteger(
      options.transactionRequestTimeoutMs ?? 10_000,
      "transactionRequestTimeoutMs"
    );
    this.transactionRequestRetries = nonNegativeInteger(
      options.transactionRequestRetries ?? 2,
      "transactionRequestRetries"
    );
    this.transactionFallbackRequestTimeoutMs = positiveInteger(
      options.transactionFallbackRequestTimeoutMs ?? this.transactionRequestTimeoutMs,
      "transactionFallbackRequestTimeoutMs"
    );
    this.transactionFallbackMinRequestIntervalMs = positiveInteger(
      options.transactionFallbackMinRequestIntervalMs ?? 1_000,
      "transactionFallbackMinRequestIntervalMs"
    );
    this.durableSignatureRetryBaseDelayMs = positiveInteger(
      options.durableSignatureRetryBaseDelayMs ?? 30_000,
      "durableSignatureRetryBaseDelayMs"
    );
    this.durableSignatureRetryMaxDelayMs = positiveInteger(
      options.durableSignatureRetryMaxDelayMs ?? 900_000,
      "durableSignatureRetryMaxDelayMs"
    );
    if (this.durableSignatureRetryMaxDelayMs < this.durableSignatureRetryBaseDelayMs) {
      throw new Error(
        "durableSignatureRetryMaxDelayMs must be greater than or equal to durableSignatureRetryBaseDelayMs."
      );
    }
    this.durableSignatureMaxAttempts = positiveInteger(
      options.durableSignatureMaxAttempts ?? 6,
      "durableSignatureMaxAttempts"
    );
    this.providerLatencyWarningMs = positiveInteger(
      options.providerLatencyWarningMs ?? 30_000,
      "providerLatencyWarningMs"
    );
    this.subscriptionAckTimeoutMs = positiveInteger(
      options.subscriptionAckTimeoutMs ?? 15_000,
      "subscriptionAckTimeoutMs"
    );
    this.heartbeatIntervalMs = positiveInteger(
      options.heartbeatIntervalMs ?? 30_000,
      "heartbeatIntervalMs"
    );
    this.heartbeatTimeoutMs = positiveInteger(
      options.heartbeatTimeoutMs ?? 10_000,
      "heartbeatTimeoutMs"
    );
    this.gapRepairReplayLimit = positiveInteger(
      options.gapRepairReplayLimit ?? 25,
      "gapRepairReplayLimit"
    );
    this.gapRepairMaxSignatures = positiveInteger(
      options.gapRepairMaxSignatures ?? 20_000,
      "gapRepairMaxSignatures"
    );
    this.handlerRejectionRetryDelayMs = positiveInteger(
      options.handlerRejectionRetryDelayMs ?? 1_000,
      "handlerRejectionRetryDelayMs"
    );
    this.maxConcurrentTransactionFetches = positiveInteger(
      options.maxConcurrentTransactionFetches ?? 128,
      "maxConcurrentTransactionFetches"
    );
    this.maxQueuedSignatures = positiveInteger(
      options.maxQueuedSignatures ?? 2_000,
      "maxQueuedSignatures"
    );
    this.maximumLiveQueueDelayMs =
      options.maximumLiveQueueDelayMs === undefined
        ? null
        : positiveInteger(options.maximumLiveQueueDelayMs, "maximumLiveQueueDelayMs");
    this.allowConcurrentLiveSignaturesPerAddress =
      options.allowConcurrentLiveSignaturesPerAddress ?? false;
    if (this.allowConcurrentLiveSignaturesPerAddress && !options.liveSignatureStore) {
      throw new Error(
        "Concurrent live signatures per address require a durable liveSignatureStore."
      );
    }
    this.seenSignatureLimit = positiveInteger(
      options.seenSignatureLimit ?? 100_000,
      "seenSignatureLimit"
    );
    const queuePressureRatio = options.queuePressureRatio ?? 0.8;
    if (
      !Number.isFinite(queuePressureRatio) ||
      queuePressureRatio < 0.5 ||
      queuePressureRatio > 1
    ) {
      throw new Error("queuePressureRatio must be between 0.5 and 1.");
    }
    this.queuePressureThreshold = Math.max(
      1,
      Math.ceil(this.maxQueuedSignatures * queuePressureRatio)
    );
    for (const address of options.addresses) {
      this.addressLogIncludes.set(address, options.logIncludesByAddress?.[address] ?? []);
      this.backfillAddresses.add(address);
    }
    this.refreshFastLogPrefilter();
    this.now = options.now ?? (() => new Date());
    this.socketFactory =
      options.webSocketFactory ??
      ((url) => {
        if (typeof WebSocket === "undefined") {
          throw new Error("A WebSocket implementation is required by this Node.js runtime.");
        }
        return new WebSocket(url) as unknown as WebSocketLike;
      });
    this.diagnostics = {
      provider: this.provider,
      status: isPublicSolanaEndpoint(options.rpcUrl) ? "degraded" : "ok",
      connectionState: "stopped",
      reconnectAttempt: 0,
      nextReconnectDelayMs: null,
      lastConnectedAt: null,
      reconnectCount: 0,
      duplicateSignatureCount: 0,
      backfillEventCount: 0,
      backfillTruncatedCount: 0,
      lastBackfillTruncatedAt: null,
      lastBackfillTruncatedCursorAt: null,
      lastBackfillTruncatedCursorSlot: null,
      lastBackfillTruncatedCursorSignature: null,
      missingSlotCount: 0,
      unresolvedTransactionCount: 0,
      lastProviderLatencyMs: null,
      lastEventOrigin: null,
      lastLiveProviderLatencyMs: null,
      maxLiveProviderLatencyMs: null,
      lastBackfillProviderLatencyMs: null,
      lastLiveNotificationAt: null,
      lastWebsocketMessageAt: null,
      lastWebsocketContextSlot: null,
      lastWebsocketSignature: null,
      websocketNotificationCount: 0,
      lastWebsocketNotificationAgeMs: null,
      maxWebsocketNotificationAgeMs: null,
      lastNotificationToObservedMs: null,
      maxNotificationToObservedMs: null,
      lastTransactionQueueDelayMs: null,
      maxTransactionQueueDelayMs: null,
      lastTransactionFetchCycleDurationMs: null,
      maxTransactionFetchCycleDurationMs: null,
      lastTransactionHttpDurationMs: null,
      maxTransactionHttpDurationMs: null,
      lastTransactionFetchAttempts: 0,
      transactionNullResponseCount: 0,
      transactionRequestErrorCount: 0,
      transactionRequestTimeoutCount: 0,
      transactionRequestTimeoutMs: this.transactionRequestTimeoutMs,
      transactionRequestRetryLimit: this.transactionRequestRetries,
      providerLatencyWarningMs: this.providerLatencyWarningMs,
      liveEventCount: 0,
      slowLiveEventCount: 0,
      lastSlowLiveEventAt: null,
      websocketMessageCount: 0,
      websocketMessageBytes: 0,
      prefilteredWebsocketMessageCount: 0,
      prefilteredWebsocketMessageBytes: 0,
      postfetchFilteredTransactionCount: 0,
      transactionRequestCount: 0,
      transactionRetryCount: 0,
      recoveredTransactionCount: 0,
      droppedSignatureCount: 0,
      purgedSignatureCount: 0,
      durableSignatureAdmissionCount: 0,
      durableSignatureAdmissionErrorCount: 0,
      durableSignatureCompletionErrorCount: 0,
      durableSignatureReloadCount: 0,
      durablyDeferredSignatureCount: 0,
      durableSignatureRetryCount: 0,
      durableSignatureDeadLetterCount: 0,
      durableSignatureLastRetryAt: null,
      durableSignatureLastDeadLetterAt: null,
      transactionFallbackRequestCount: 0,
      transactionFallbackRecoveredCount: 0,
      transactionFallbackErrorCount: 0,
      transactionFallbackTimeoutCount: 0,
      queuePressureCount: 0,
      lastQueuePressureAt: null,
      lastQueuePressureReason: null,
      lastQueuePressureDelayMs: null,
      queueHighWatermark: 0,
      successfulSubscriptionAckCount: 0,
      lastSubscriptionRequestAt: null,
      lastSubscriptionAckAt: null,
      subscriptionAckTimeoutCount: 0,
      lastSubscriptionAckTimeoutAt: null,
      handlerRejectedEventCount: 0,
      handlerAdmissionRetryCount: 0,
      lastHandlerRejectedEventAt: null,
      heartbeatTimeoutCount: 0,
      lastPingAt: null,
      lastPongAt: null,
      gapRepairCollectionCount: 0,
      gapRepairCompletionCount: 0,
      gapRepairStagedSignatureCount: 0,
      gapRepairReplayedSignatureCount: 0,
      lastGapRepairAt: null,
      lastGapRepairCompletedAt: null,
      lastGapRepairId: null,
      lastGapRepairError: null,
      lastGapRepairCoveredThroughSignature: null,
      lastGapRepairCoveredThroughSlot: null
    };
  }

  async start(onEvent: (event: SolanaChainEvent) => Promise<void> | void): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.diagnostics.connectionState = "connecting";
    this.handler = onEvent;
    if (this.options.liveSignatureStore) {
      await Promise.all(
        [...this.addressLogIncludes.keys()].map((address) =>
          this.refillDurableSignatureQueue(address, onEvent)
        )
      );
    }
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wakeRetryWaiters();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearReconnectStabilityTimer();
    this.reconnectAttempt = 0;
    this.diagnostics.connectionState = "stopped";
    this.diagnostics.reconnectAttempt = 0;
    this.diagnostics.nextReconnectDelayMs = null;
    this.clearHeartbeat();
    this.clearSubscriptionState();
    for (const timer of this.staleQueueTimers.values()) clearTimeout(timer);
    this.staleQueueTimers.clear();
    for (const entry of this.durableRefillTimers.values()) clearTimeout(entry.timer);
    this.durableRefillTimers.clear();
    this.liveSignatureQueue.length = 0;
    this.queuedSignatures.clear();
    const socket = this.socket;
    this.socket = null;
    this.socketOpen = false;
    socket?.close();
  }

  async subscribeAddress(
    address: string,
    logIncludes: string[] = [],
    backfill = false
  ): Promise<void> {
    this.addressLogIncludes.set(address, logIncludes);
    this.refreshFastLogPrefilter();
    if (backfill) this.backfillAddresses.add(address);
    if (this.socket && !this.subscriptionByAddress.has(address)) {
      this.sendSubscribeRequest(this.socket, address);
    }
    if (backfill && this.handler) {
      await this.backfill(address, this.handler);
    }
  }

  unsubscribeAddress(address: string): void {
    this.addressLogIncludes.delete(address);
    this.refreshFastLogPrefilter();
    this.backfillAddresses.delete(address);
    this.truncatedBackfillAddresses.delete(address);
    const staleQueueTimer = this.staleQueueTimers.get(address);
    if (staleQueueTimer) clearTimeout(staleQueueTimer);
    this.staleQueueTimers.delete(address);
    const durableRefillTimer = this.durableRefillTimers.get(address);
    if (durableRefillTimer) clearTimeout(durableRefillTimer.timer);
    this.durableRefillTimers.delete(address);
    let purged = 0;
    for (let index = this.liveSignatureQueue.length - 1; index >= 0; index -= 1) {
      const queued = this.liveSignatureQueue[index];
      if (queued?.address !== address) continue;
      this.liveSignatureQueue.splice(index, 1);
      this.queuedSignatures.delete(queued.signature);
      purged += 1;
    }
    if (purged > 0) {
      // Once an address is explicitly unsubscribed its partial trade window is
      // fail-closed by the caller. Retaining those notifications would spend
      // RPC/CPU on evidence that cannot be admitted and could starve healthy
      // pools behind the per-address ordering barrier.
      this.diagnostics.purgedSignatureCount = (this.diagnostics.purgedSignatureCount ?? 0) + purged;
    }
    this.queuePressureByAddress.delete(address);
    const subscriptionId = this.subscriptionByAddress.get(address);
    if (subscriptionId === undefined) return;
    this.subscriptionByAddress.delete(address);
    this.subscriptionAddress.delete(subscriptionId);
    this.socket?.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextRequestId++,
        method: "logsUnsubscribe",
        params: [subscriptionId]
      })
    );
  }

  acknowledgeUnreconciledGap(address: string): void {
    this.truncatedBackfillAddresses.delete(address);
    if (
      this.requestAddress.size === 0 &&
      this.timedOutSubscriptionRequests.size === 0 &&
      this.truncatedBackfillAddresses.size === 0
    ) {
      this.diagnostics.status = "ok";
    }
  }

  async backfill(
    address: string,
    onEvent: (event: SolanaChainEvent) => Promise<void> | void
  ): Promise<number> {
    return this.runAddressTask(address, () => this.backfillAddress(address, onEvent));
  }

  async repairGap(
    address: string,
    incidentId: string,
    onEvent: (event: SolanaChainEvent) => Promise<void> | void,
    boundary?: SolanaGapRepairBoundary
  ): Promise<SolanaGapRepairResult> {
    // Signature collection is cursor-neutral. Each replay item joins the
    // normal per-address task tail separately so live admission can interleave
    // between bounded repair items instead of waiting behind an entire batch.
    return this.repairGapAddress(address, incidentId, onEvent, boundary);
  }

  private async repairGapAddress(
    address: string,
    incidentId: string,
    onEvent: (event: SolanaChainEvent) => Promise<void> | void,
    boundary?: SolanaGapRepairBoundary
  ): Promise<SolanaGapRepairResult> {
    const store = this.options.gapRepairStore;
    if (!store || !boundary) {
      return {
        repairId: incidentId,
        status: "unavailable",
        fetchedSignatureCount: 0,
        completedSignatureCount: 0,
        error: store
          ? "safe-truncation-cursor-boundary-unavailable"
          : "durable-gap-repair-store-unavailable"
      };
    }
    const repairId = createHash("sha256")
      .update(["solana-discovery-gap-repair", incidentId, address, boundary.signature].join(":"))
      .digest("hex");
    this.diagnostics.lastGapRepairAt = this.now().toISOString();
    this.diagnostics.lastGapRepairId = repairId;
    let repair = await store.getOrCreateIngestionGapRepair({
      repairId,
      incidentId,
      provider: this.provider,
      programAddress: address,
      cursorSignature: boundary.signature,
      cursorSlot: boundary.slot,
      ...(boundary.occurredAt ? { cursorOccurredAt: boundary.occurredAt } : {}),
      boundarySource: boundary.source
    });
    if (repair.status === "failed") {
      return {
        repairId: repair.repairId,
        status: "blocked",
        fetchedSignatureCount: repair.fetchedSignatureCount,
        completedSignatureCount: repair.completedSignatureCount,
        error: repair.lastError ?? "gap-repair-failed"
      };
    }
    if (repair.status === "completed") {
      if (!repair.targetSignature || repair.targetSlot === undefined) {
        return {
          repairId: repair.repairId,
          status: "blocked",
          fetchedSignatureCount: repair.fetchedSignatureCount,
          completedSignatureCount: repair.completedSignatureCount,
          error: "completed-repair-missing-immutable-target"
        };
      }
      return {
        repairId: repair.repairId,
        status: "completed",
        fetchedSignatureCount: repair.fetchedSignatureCount,
        completedSignatureCount: repair.completedSignatureCount,
        coveredThroughSignature: repair.targetSignature,
        coveredThroughSlot: repair.targetSlot
      };
    }

    // A reviewed repair cap may be lowered after an incident has already
    // staged signatures. Re-check the durable total before either collection
    // or replay so a restarted worker cannot bypass the active bound and keep
    // an infeasible historical scan consuming RPC/database capacity forever.
    if (repair.fetchedSignatureCount > this.gapRepairMaxSignatures) {
      const error = `gap-repair-signature-cap-${this.gapRepairMaxSignatures}`;
      await store.recordIngestionGapRepairError(
        repair.repairId,
        repair.status === "replaying" ? "replay" : "collection",
        error
      );
      this.diagnostics.lastGapRepairError = error;
      return {
        repairId: repair.repairId,
        status: "blocked",
        fetchedSignatureCount: repair.fetchedSignatureCount,
        completedSignatureCount: repair.completedSignatureCount,
        error
      };
    }

    if (repair.status === "collecting") {
      const staged: Array<{ signature: string; slot: number; positionFromHead: number }> = [];
      let before = repair.beforeSignature;
      let boundaryReached = false;
      let targetSignature = repair.targetSignature;
      let targetSlot = repair.targetSlot;
      try {
        for (let page = 0; page < this.maxBackfillPages; page += 1) {
          const pageItems = await this.rpc<SignatureInfo[]>("getSignaturesForAddress", [
            address,
            {
              limit: this.backfillPageLimit,
              until: repair.cursorSignature,
              ...(before ? { before } : {}),
              commitment: this.commitment
            }
          ]);
          if (!targetSignature && pageItems[0]) {
            targetSignature = pageItems[0].signature;
            targetSlot = pageItems[0].slot;
          }
          if (
            repair.fetchedSignatureCount + staged.length + pageItems.length >
            this.gapRepairMaxSignatures
          ) {
            const error = `gap-repair-signature-cap-${this.gapRepairMaxSignatures}`;
            await store.recordIngestionGapRepairError(repair.repairId, "collection", error);
            this.diagnostics.lastGapRepairError = error;
            return {
              repairId: repair.repairId,
              status: "blocked",
              fetchedSignatureCount: repair.fetchedSignatureCount,
              completedSignatureCount: repair.completedSignatureCount,
              error
            };
          }
          for (let index = 0; index < pageItems.length; index += 1) {
            const item = pageItems[index]!;
            staged.push({
              signature: item.signature,
              slot: item.slot,
              positionFromHead: repair.fetchedSignatureCount + staged.length
            });
          }
          if (pageItems.length < this.backfillPageLimit) {
            boundaryReached = true;
            break;
          }
          before = pageItems[pageItems.length - 1]?.signature;
          if (!before) {
            boundaryReached = true;
            break;
          }
        }
        if (!boundaryReached && before) {
          const boundary = await this.rpc<SignatureInfo[]>("getSignaturesForAddress", [
            address,
            {
              limit: 1,
              until: repair.cursorSignature,
              before,
              commitment: this.commitment
            }
          ]);
          boundaryReached = boundary.length === 0;
        }
        repair = await store.stageIngestionGapRepairPage({
          repairId: repair.repairId,
          signatures: staged,
          ...(before ? { beforeSignature: before } : {}),
          boundaryReached,
          ...(targetSignature ? { targetSignature } : {}),
          ...(targetSlot !== undefined ? { targetSlot } : {})
        });
        this.diagnostics.gapRepairCollectionCount =
          (this.diagnostics.gapRepairCollectionCount ?? 0) + 1;
        this.diagnostics.gapRepairStagedSignatureCount = repair.fetchedSignatureCount;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await store.recordIngestionGapRepairError(repair.repairId, "collection", message);
        this.diagnostics.lastGapRepairError = message.slice(0, 300);
        return {
          repairId: repair.repairId,
          status: "blocked",
          fetchedSignatureCount: repair.fetchedSignatureCount,
          completedSignatureCount: repair.completedSignatureCount,
          error: message
        };
      }
      if (!repair.boundaryReached) {
        return {
          repairId: repair.repairId,
          status: "collecting",
          fetchedSignatureCount: repair.fetchedSignatureCount,
          completedSignatureCount: repair.completedSignatureCount
        };
      }
    }

    const pending = await store.listPendingIngestionGapRepairSignatures(
      repair.repairId,
      this.gapRepairReplayLimit
    );
    for (const item of pending) {
      if (!this.seenSignatures.has(item.signature)) {
        const processed = await this.runAddressTask(address, () =>
          this.processSignatureUnlocked(address, item.signature, item.slot, onEvent, {
            origin: "backfill"
          })
        );
        if (!processed && !this.seenSignatures.has(item.signature)) {
          const error = `unresolved-repair-signature:${item.signature}`;
          await store.recordIngestionGapRepairError(repair.repairId, "replay", error);
          this.diagnostics.lastGapRepairError = error;
          return {
            repairId: repair.repairId,
            status: "blocked",
            fetchedSignatureCount: repair.fetchedSignatureCount,
            completedSignatureCount: repair.completedSignatureCount,
            error
          };
        }
      }
      if (await store.completeIngestionGapRepairSignature(repair.repairId, item.signature)) {
        repair = {
          ...repair,
          completedSignatureCount: repair.completedSignatureCount + 1
        };
        this.diagnostics.gapRepairReplayedSignatureCount =
          (this.diagnostics.gapRepairReplayedSignatureCount ?? 0) + 1;
      }
    }
    const remaining = await store.listPendingIngestionGapRepairSignatures(repair.repairId, 1);
    if (remaining.length > 0) {
      return {
        repairId: repair.repairId,
        status: "replaying",
        fetchedSignatureCount: repair.fetchedSignatureCount,
        completedSignatureCount: repair.completedSignatureCount
      };
    }
    if (!repair.targetSignature || repair.targetSlot === undefined) {
      const error = "repair-completed-without-immutable-target";
      await store.recordIngestionGapRepairError(repair.repairId, "replay", error);
      this.diagnostics.lastGapRepairError = error;
      return {
        repairId: repair.repairId,
        status: "blocked",
        fetchedSignatureCount: repair.fetchedSignatureCount,
        completedSignatureCount: repair.completedSignatureCount,
        error
      };
    }
    const completedAt = this.now().toISOString();
    const completed = await store.completeIngestionGapRepair(repair.repairId, {
      signature: repair.targetSignature,
      slot: repair.targetSlot,
      completedAt
    });
    if (!completed) {
      const error = "repair-completion-state-conflict";
      this.diagnostics.lastGapRepairError = error;
      return {
        repairId: repair.repairId,
        status: "blocked",
        fetchedSignatureCount: repair.fetchedSignatureCount,
        completedSignatureCount: repair.completedSignatureCount,
        error
      };
    }
    this.truncatedBackfillAddresses.delete(address);
    this.diagnostics.gapRepairCompletionCount =
      (this.diagnostics.gapRepairCompletionCount ?? 0) + 1;
    this.diagnostics.lastGapRepairCompletedAt = completedAt;
    this.diagnostics.lastGapRepairError = null;
    this.diagnostics.lastGapRepairCoveredThroughSignature = repair.targetSignature;
    this.diagnostics.lastGapRepairCoveredThroughSlot = repair.targetSlot;
    return {
      repairId: repair.repairId,
      status: "completed",
      fetchedSignatureCount: repair.fetchedSignatureCount,
      completedSignatureCount: repair.completedSignatureCount,
      coveredThroughSignature: repair.targetSignature,
      coveredThroughSlot: repair.targetSlot
    };
  }

  private async backfillAddress(
    address: string,
    onEvent: (event: SolanaChainEvent) => Promise<void> | void
  ): Promise<number> {
    const cursor = await this.options.cursorStore.get(address);
    const signatures: SignatureInfo[] = [];
    let before: string | undefined;
    let reachedCursorBoundary = !cursor;
    let fetchedSignatureCount = 0;
    let cursorlessInitialPageSaturated = false;

    for (let page = 0; page < this.maxBackfillPages; page += 1) {
      const pageLimit = cursor ? this.backfillPageLimit : this.initialBackfillLimit;
      const pageItems = await this.rpc<SignatureInfo[]>("getSignaturesForAddress", [
        address,
        {
          limit: pageLimit,
          ...(cursor ? { until: cursor.signature } : {}),
          ...(before ? { before } : {}),
          commitment: this.commitment
        }
      ]);
      fetchedSignatureCount += pageItems.length;
      signatures.push(...pageItems.filter((item) => !item.err));
      if (pageItems.length < pageLimit) {
        reachedCursorBoundary = true;
        break;
      }
      if (!cursor) {
        cursorlessInitialPageSaturated = true;
        break;
      }
      before = pageItems[pageItems.length - 1]?.signature;
      if (!before) {
        reachedCursorBoundary = true;
        break;
      }
    }

    if (cursor && !reachedCursorBoundary && before) {
      // A full final page is ambiguous: it may contain exactly the complete
      // gap. One signature-only boundary probe distinguishes that case without
      // fetching or processing an unbounded history window.
      const boundary = await this.rpc<SignatureInfo[]>("getSignaturesForAddress", [
        address,
        {
          limit: 1,
          until: cursor.signature,
          before,
          commitment: this.commitment
        }
      ]);
      reachedCursorBoundary = boundary.length === 0;
    }

    const truncationReason = cursorlessInitialPageSaturated
      ? "cursorless-initial-limit"
      : cursor && !reachedCursorBoundary
        ? "cursor-boundary-not-reached"
        : null;

    if (truncationReason) {
      // Never advance a durable cursor across an RPC window that exhausted its
      // bounded page budget. A saturated first page without a cursor is equally
      // ambiguous: older signatures may exist, so emitting any part of that
      // window would manufacture a false completeness boundary.
      this.truncatedBackfillAddresses.add(address);
      this.diagnostics.backfillTruncatedCount = (this.diagnostics.backfillTruncatedCount ?? 0) + 1;
      this.diagnostics.lastBackfillTruncatedAt = this.now().toISOString();
      this.diagnostics.lastBackfillTruncatedCursorAt =
        cursor?.occurredAt ?? cursor?.updatedAt ?? null;
      this.diagnostics.lastBackfillTruncatedCursorSlot = cursor?.slot ?? null;
      this.diagnostics.lastBackfillTruncatedCursorSignature = cursor?.signature ?? null;
      this.diagnostics.status = "degraded";
      await this.options.onBackfillTruncated?.({
        address,
        reason: truncationReason,
        fetchedSignatureCount,
        limit: cursor ? this.backfillPageLimit * this.maxBackfillPages : this.initialBackfillLimit
      });
      return 0;
    }
    this.truncatedBackfillAddresses.delete(address);

    let emitted = 0;
    for (const item of signatures.reverse()) {
      if (
        await this.processSignatureUntilResolved(address, item.signature, item.slot, onEvent, {
          origin: "backfill"
        })
      ) {
        emitted += 1;
      } else if (!this.seenSignatures.has(item.signature)) {
        // Do not advance past an unresolved older signature. A later backfill can
        // retry it without the cursor having skipped over the gap.
        break;
      }
    }
    this.diagnostics.backfillEventCount += emitted;
    return emitted;
  }

  getDiagnostics(): SolanaEventSourceDiagnostics {
    return {
      ...this.diagnostics,
      status:
        this.timedOutSubscriptionRequests.size > 0 || this.truncatedBackfillAddresses.size > 0
          ? "degraded"
          : this.diagnostics.status,
      seenSignatureCount: this.seenSignatures.size,
      seenSignatureLimit: this.seenSignatureLimit,
      inFlightSignatureCount: this.inFlightSignatures.size,
      queuedSignatureCount: this.liveSignatureQueue.length,
      activeTransactionWorkerCount: this.activeTransactionWorkers,
      maxConcurrentTransactionFetches: this.maxConcurrentTransactionFetches,
      maxQueuedSignatures: this.maxQueuedSignatures,
      maximumLiveQueueDelayMs: this.maximumLiveQueueDelayMs,
      pendingSubscriptionRequestCount: this.requestAddress.size,
      configuredAddressCount: this.addressLogIncludes.size,
      subscribedAddressCount: this.subscriptionByAddress.size,
      successfulSubscriptionAckAddressCount: this.successfulSubscriptionAddresses.size,
      subscriptionAckTimedOutAddressCount: this.timedOutSubscriptionRequests.size,
      backfillTruncatedAddressCount: this.truncatedBackfillAddresses.size,
      queuePressureAddressCount: this.queuePressureByAddress.size
    };
  }

  private connect() {
    if (this.stopped) return;
    this.diagnostics.connectionState = "connecting";
    this.diagnostics.nextReconnectDelayMs = null;
    let socket: WebSocketLike;
    try {
      socket = this.socketFactory(this.options.wsUrl);
    } catch {
      this.diagnostics.status = "down";
      this.scheduleReconnect();
      return;
    }
    const generation = ++this.socketGeneration;
    this.socket = socket;
    this.socketOpen = false;
    socket.onopen = () => {
      if (socket !== this.socket || generation !== this.socketGeneration || this.stopped) return;
      this.socketOpen = true;
      this.diagnostics.status = "ok";
      this.diagnostics.connectionState = "open";
      this.diagnostics.lastConnectedAt = this.now().toISOString();
      this.scheduleReconnectStabilityReset(socket, generation);
      this.clearSubscriptionState();
      this.nextRequestId = 1;
      for (const address of this.addressLogIncludes.keys()) {
        this.sendSubscribeRequest(socket, address);
      }
      if (this.handler) {
        for (const address of this.backfillAddresses) {
          this.requestAutomaticBackfill(address, this.handler);
        }
      }
      this.startHeartbeat(socket, generation);
    };
    socket.onmessage = (message) => {
      if (socket !== this.socket || generation !== this.socketGeneration || this.stopped) return;
      void this.handleSocketMessage(socket, generation, message);
    };
    socket.onerror = () => {
      if (socket !== this.socket || generation !== this.socketGeneration || this.stopped) return;
      this.diagnostics.status = "degraded";
      this.handleSocketClose(socket, generation);
      try {
        socket.close();
      } catch {
        // The reconnect path is already scheduled.
      }
    };
    socket.onclose = () => this.handleSocketClose(socket, generation);
    const acknowledgePong = () => {
      if (socket !== this.socket || generation !== this.socketGeneration || this.stopped) return;
      this.acknowledgeHeartbeat();
    };
    if (typeof socket.on === "function") socket.on("pong", acknowledgePong);
    else socket.onpong = acknowledgePong;
  }

  private handleSocketClose(socket: WebSocketLike, generation: number): void {
    if (socket !== this.socket || generation !== this.socketGeneration) return;
    this.socket = null;
    this.socketOpen = false;
    this.clearReconnectStabilityTimer();
    this.clearHeartbeat();
    this.clearSubscriptionState();
    if (this.stopped) return;
    this.diagnostics.reconnectCount += 1;
    this.diagnostics.status = "degraded";
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const exponentialDelay = Math.min(
      this.reconnectMaxDelayMs,
      this.reconnectDelayMs * 2 ** Math.min(this.reconnectAttempt, 30)
    );
    const jitterMultiplier = 1 + (this.random() * 2 - 1) * this.reconnectJitterRatio;
    const delayMs = Math.max(1, Math.round(exponentialDelay * jitterMultiplier));
    this.reconnectAttempt += 1;
    this.diagnostics.connectionState = "backoff";
    this.diagnostics.reconnectAttempt = this.reconnectAttempt;
    this.diagnostics.nextReconnectDelayMs = delayMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  private scheduleReconnectStabilityReset(socket: WebSocketLike, generation: number): void {
    this.clearReconnectStabilityTimer();
    this.reconnectStabilityTimer = setTimeout(() => {
      this.reconnectStabilityTimer = null;
      if (this.stopped || socket !== this.socket || generation !== this.socketGeneration) return;
      this.reconnectAttempt = 0;
      this.diagnostics.reconnectAttempt = 0;
      this.diagnostics.nextReconnectDelayMs = null;
    }, this.reconnectStableAfterMs);
  }

  private clearReconnectStabilityTimer(): void {
    if (this.reconnectStabilityTimer) clearTimeout(this.reconnectStabilityTimer);
    this.reconnectStabilityTimer = null;
  }

  private requestAutomaticBackfill(
    address: string,
    onEvent: (event: SolanaChainEvent) => Promise<void> | void
  ): void {
    if (this.automaticBackfillAddresses.has(address)) {
      this.automaticBackfillRerunAddresses.add(address);
      return;
    }
    this.automaticBackfillAddresses.add(address);
    void (async () => {
      try {
        do {
          this.automaticBackfillRerunAddresses.delete(address);
          await this.backfill(address, onEvent);
        } while (
          !this.stopped &&
          this.backfillAddresses.has(address) &&
          this.automaticBackfillRerunAddresses.delete(address)
        );
      } catch {
        this.diagnostics.status = "degraded";
      } finally {
        this.automaticBackfillAddresses.delete(address);
        this.automaticBackfillRerunAddresses.delete(address);
      }
    })();
  }

  private async handleSocketMessage(
    socket: WebSocketLike,
    generation: number,
    message: WebSocketMessage
  ): Promise<void> {
    if (this.stopped || socket !== this.socket || generation !== this.socketGeneration) return;
    const receivedAtMs = this.now().getTime();
    const text =
      typeof message.data === "string"
        ? message.data
        : message.data instanceof ArrayBuffer
          ? new TextDecoder().decode(message.data)
          : await message.data.text();
    if (this.stopped || socket !== this.socket || generation !== this.socketGeneration) return;
    if (this.heartbeatSentAtMs !== null) this.acknowledgeHeartbeat();
    this.diagnostics.websocketMessageCount = (this.diagnostics.websocketMessageCount ?? 0) + 1;
    const messageBytes = Buffer.byteLength(text);
    this.diagnostics.websocketMessageBytes =
      (this.diagnostics.websocketMessageBytes ?? 0) + messageBytes;
    const isLogsNotification =
      text.includes('"method":"logsNotification"') || LOGS_NOTIFICATION_METHOD_PATTERN.test(text);
    if (isLogsNotification) {
      this.diagnostics.websocketNotificationCount =
        (this.diagnostics.websocketNotificationCount ?? 0) + 1;
      this.diagnostics.lastWebsocketMessageAt = new Date(receivedAtMs).toISOString();
      const contextSlot = extractLogsNotificationContextSlot(text);
      if (contextSlot !== null) this.diagnostics.lastWebsocketContextSlot = contextSlot;
      const signature = extractLogsNotificationSignature(text);
      if (signature !== null) this.diagnostics.lastWebsocketSignature = signature;
    }
    if (
      this.fastLogPrefilterEnabled &&
      isLogsNotification &&
      this.encodedLogIncludePattern &&
      !this.encodedLogIncludePattern.test(text)
    ) {
      this.diagnostics.prefilteredWebsocketMessageCount =
        (this.diagnostics.prefilteredWebsocketMessageCount ?? 0) + 1;
      this.diagnostics.prefilteredWebsocketMessageBytes =
        (this.diagnostics.prefilteredWebsocketMessageBytes ?? 0) + messageBytes;
      return;
    }
    const payload = JSON.parse(text) as LogsNotification & SubscriptionResponse;

    if (payload.id !== undefined && payload.result !== undefined) {
      if (payload.id === this.heartbeatRequestId) {
        this.acknowledgeHeartbeat();
        return;
      }
      const address = this.requestAddress.get(payload.id);
      this.clearSubscriptionAckTimer(payload.id);
      this.requestAddress.delete(payload.id);
      this.timedOutSubscriptionRequests.delete(payload.id);
      if (address && this.addressLogIncludes.has(address)) {
        this.subscriptionAddress.set(payload.result, address);
        this.subscriptionByAddress.set(address, payload.result);
        this.successfulSubscriptionAddresses.add(address);
        this.diagnostics.successfulSubscriptionAckCount =
          (this.diagnostics.successfulSubscriptionAckCount ?? 0) + 1;
        this.diagnostics.lastSubscriptionAckAt = new Date(receivedAtMs).toISOString();
        if (this.requestAddress.size === 0 && this.timedOutSubscriptionRequests.size === 0) {
          this.diagnostics.status = "ok";
        }
      }
      return;
    }

    const result = payload.params?.result;
    const signature = result?.value?.signature;
    if (payload.method !== "logsNotification" || !signature || result.value?.err) return;
    const slot = result.context?.slot ?? 0;
    const address = this.subscriptionAddress.get(payload.params?.subscription ?? -1);
    if (!address || !this.handler) return;
    const logIncludes = this.addressLogIncludes.get(address);
    if (
      logIncludes?.length &&
      !result.value?.logs?.some((log) => logIncludes.some((message) => log === message))
    ) {
      return;
    }
    this.diagnostics.lastLiveNotificationAt = new Date(receivedAtMs).toISOString();
    await this.enqueueLiveSignature(address, signature, slot, receivedAtMs, this.handler);
  }

  private refreshFastLogPrefilter(): void {
    const configuredFilters = [...this.addressLogIncludes.values()];
    this.fastLogPrefilterEnabled =
      configuredFilters.length > 0 && configuredFilters.every((filters) => filters.length > 0);
    const encodedNeedles = this.fastLogPrefilterEnabled
      ? [...new Set(configuredFilters.flat().map((filter) => JSON.stringify(filter)))]
      : [];
    // Each escaped alternative still includes its JSON string quotes, preserving
    // exact log equality while letting V8 scan a negative notification once.
    this.encodedLogIncludePattern =
      encodedNeedles.length > 0
        ? new RegExp(encodedNeedles.map(escapeRegExpLiteral).join("|"))
        : null;
  }

  private async enqueueLiveSignature(
    address: string,
    signature: string,
    slot: number,
    notifiedAtMs: number,
    onEvent: (event: SolanaChainEvent) => Promise<void> | void
  ): Promise<void> {
    if (
      this.seenSignatures.has(signature) ||
      this.inFlightSignatures.has(signature) ||
      this.queuedSignatures.has(signature)
    ) {
      this.diagnostics.duplicateSignatureCount += 1;
      return;
    }
    if (this.options.liveSignatureStore) {
      try {
        const pending = await this.options.liveSignatureStore.admitSolanaSignature({
          provider: this.provider,
          address,
          signature,
          slot,
          notifiedAt: new Date(notifiedAtMs).toISOString()
        });
        if (!pending) {
          this.diagnostics.duplicateSignatureCount += 1;
          return;
        }
        this.diagnostics.durableSignatureAdmissionCount =
          (this.diagnostics.durableSignatureAdmissionCount ?? 0) + 1;
      } catch {
        // This is the only true live-signature drop in durable mode: the
        // notification never crossed the PostgreSQL admission boundary.
        this.diagnostics.durableSignatureAdmissionErrorCount =
          (this.diagnostics.durableSignatureAdmissionErrorCount ?? 0) + 1;
        this.diagnostics.droppedSignatureCount = (this.diagnostics.droppedSignatureCount ?? 0) + 1;
        this.diagnostics.status = "degraded";
        this.notifyQueuePressure(address, "full");
        return;
      }
      if (this.liveSignatureQueue.length >= this.maxQueuedSignatures) {
        this.diagnostics.durablyDeferredSignatureCount =
          (this.diagnostics.durablyDeferredSignatureCount ?? 0) + 1;
      }
      await this.refillDurableSignatureQueue(address, onEvent);
      return;
    }
    if (this.liveSignatureQueue.length >= this.maxQueuedSignatures) {
      this.diagnostics.droppedSignatureCount = (this.diagnostics.droppedSignatureCount ?? 0) + 1;
      this.diagnostics.status = "degraded";
      this.notifyQueuePressure(address, "full");
      return;
    }
    this.queuedSignatures.add(signature);
    this.liveSignatureQueue.push({ address, signature, slot, notifiedAtMs });
    this.scheduleStaleQueueCheck(address);
    this.diagnostics.queueHighWatermark = Math.max(
      this.diagnostics.queueHighWatermark ?? 0,
      this.liveSignatureQueue.length
    );
    if (this.liveSignatureQueue.length >= this.queuePressureThreshold) {
      this.notifyQueuePressure(address, "high-water");
    }
    this.drainLiveSignatureQueue(onEvent);
  }

  private async refillDurableSignatureQueue(
    address: string,
    onEvent: (event: SolanaChainEvent) => Promise<void> | void
  ): Promise<void> {
    const store = this.options.liveSignatureStore;
    if (!store || this.stopped) return;
    if (this.durableRefillAddresses.has(address)) {
      this.durableRefillRequestedAddresses.add(address);
      return;
    }
    const capacity = this.maxQueuedSignatures - this.liveSignatureQueue.length;
    if (capacity <= 0) return;
    this.durableRefillAddresses.add(address);
    try {
      const pending = await store.listPendingSolanaSignatures(
        this.provider,
        address,
        Math.min(5_000, Math.max(capacity * 2, capacity))
      );
      let loaded = 0;
      for (const item of pending) {
        if (this.liveSignatureQueue.length >= this.maxQueuedSignatures) break;
        const nextAttemptAtMs = Date.parse(item.nextAttemptAt ?? item.notifiedAt);
        if (Number.isFinite(nextAttemptAtMs) && nextAttemptAtMs > this.now().getTime()) {
          this.scheduleDurableRefill(address, onEvent, nextAttemptAtMs);
          continue;
        }
        if (this.seenSignatures.has(item.signature)) {
          await this.completeDurableSignature(item.address, item.signature);
          continue;
        }
        if (
          this.inFlightSignatures.has(item.signature) ||
          this.queuedSignatures.has(item.signature)
        ) {
          continue;
        }
        this.queuedSignatures.add(item.signature);
        this.liveSignatureQueue.push({
          address: item.address,
          signature: item.signature,
          slot: item.slot,
          notifiedAtMs: Date.parse(item.notifiedAt),
          attemptCount: item.attemptCount ?? 0
        });
        this.scheduleStaleQueueCheck(item.address);
        loaded += 1;
      }
      this.diagnostics.durableSignatureReloadCount =
        (this.diagnostics.durableSignatureReloadCount ?? 0) + loaded;
      this.diagnostics.queueHighWatermark = Math.max(
        this.diagnostics.queueHighWatermark ?? 0,
        this.liveSignatureQueue.length
      );
      this.drainLiveSignatureQueue(onEvent);
    } catch {
      this.diagnostics.durableSignatureAdmissionErrorCount =
        (this.diagnostics.durableSignatureAdmissionErrorCount ?? 0) + 1;
      this.diagnostics.status = "degraded";
    } finally {
      this.durableRefillAddresses.delete(address);
      if (this.durableRefillRequestedAddresses.delete(address) && !this.stopped) {
        void this.refillDurableSignatureQueue(address, onEvent);
      }
    }
  }

  private async completeDurableSignature(address: string, signature: string): Promise<void> {
    try {
      await this.options.liveSignatureStore?.completeSolanaSignature(
        this.provider,
        address,
        signature,
        this.now().toISOString()
      );
    } catch {
      this.diagnostics.durableSignatureCompletionErrorCount =
        (this.diagnostics.durableSignatureCompletionErrorCount ?? 0) + 1;
      this.diagnostics.status = "degraded";
    }
  }

  private async deferDurableSignature(
    item: QueuedLiveSignature,
    onEvent: (event: SolanaChainEvent) => Promise<void> | void
  ): Promise<boolean> {
    const store = this.options.liveSignatureStore;
    if (!store || this.stopped) return true;
    const failedAt = this.now();
    const priorAttempts = Math.max(0, item.attemptCount ?? 0);
    const retryDelayMs = Math.min(
      this.durableSignatureRetryBaseDelayMs * 2 ** Math.min(priorAttempts, 20),
      this.durableSignatureRetryMaxDelayMs
    );
    const retryAt = new Date(failedAt.getTime() + retryDelayMs).toISOString();
    const error = "transaction_or_processing_unresolved";
    try {
      const result = await store.deferSolanaSignature(
        this.provider,
        item.address,
        item.signature,
        {
          error,
          failedAt: failedAt.toISOString(),
          retryAt,
          maxAttempts: this.durableSignatureMaxAttempts
        }
      );
      if (!result) return true;
      if (result.status === "retry") {
        this.diagnostics.durableSignatureRetryCount =
          (this.diagnostics.durableSignatureRetryCount ?? 0) + 1;
        this.diagnostics.durableSignatureLastRetryAt = failedAt.toISOString();
        this.scheduleDurableRefill(
          item.address,
          onEvent,
          Date.parse(result.retryAt ?? retryAt)
        );
        return true;
      }
      this.diagnostics.durableSignatureDeadLetterCount =
        (this.diagnostics.durableSignatureDeadLetterCount ?? 0) + 1;
      this.diagnostics.durableSignatureLastDeadLetterAt = failedAt.toISOString();
      try {
        await this.options.onDurableSignatureDeadLetter?.({
          provider: this.provider,
          address: item.address,
          signature: item.signature,
          slot: item.slot,
          notifiedAt: new Date(item.notifiedAtMs).toISOString(),
          failedAt: failedAt.toISOString(),
          attemptCount: result.attemptCount,
          error
        });
      } catch {
        // The durable queue row is already terminal evidence. Surface the
        // coverage callback failure without reopening a hot retry loop.
        this.diagnostics.durableSignatureAdmissionErrorCount =
          (this.diagnostics.durableSignatureAdmissionErrorCount ?? 0) + 1;
        this.diagnostics.status = "degraded";
      }
      return true;
    } catch {
      this.diagnostics.durableSignatureAdmissionErrorCount =
        (this.diagnostics.durableSignatureAdmissionErrorCount ?? 0) + 1;
      this.diagnostics.status = "degraded";
      this.scheduleDurableRefill(
        item.address,
        onEvent,
        failedAt.getTime() + this.durableSignatureRetryBaseDelayMs
      );
      return false;
    }
  }

  private scheduleDurableRefill(
    address: string,
    onEvent: (event: SolanaChainEvent) => Promise<void> | void,
    dueAtMs: number
  ): void {
    if (this.stopped) return;
    const boundedDueAtMs = Math.max(Date.now() + 1, dueAtMs);
    const existing = this.durableRefillTimers.get(address);
    if (existing && existing.dueAtMs <= boundedDueAtMs) return;
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.durableRefillTimers.delete(address);
      if (!this.stopped) void this.refillDurableSignatureQueue(address, onEvent);
    }, Math.min(2_147_483_647, Math.max(1, boundedDueAtMs - Date.now())));
    this.durableRefillTimers.set(address, { timer, dueAtMs: boundedDueAtMs });
  }

  private drainLiveSignatureQueue(
    onEvent: (event: SolanaChainEvent) => Promise<void> | void
  ): void {
    while (
      !this.stopped &&
      this.activeTransactionWorkers < this.maxConcurrentTransactionFetches &&
      this.liveSignatureQueue.length > 0
    ) {
      const nextIndex = this.liveSignatureQueue.findIndex(
        (candidate) =>
          this.allowConcurrentLiveSignaturesPerAddress ||
          !this.activeTransactionAddresses.has(candidate.address)
      );
      if (nextIndex < 0) return;
      const [next] = this.liveSignatureQueue.splice(nextIndex, 1);
      if (!next) return;
      if (
        this.liveSignatureQueue.length <= Math.floor(this.queuePressureThreshold / 2) &&
        this.queuePressureByAddress.get(next.address) !== "stale"
      ) {
        this.queuePressureByAddress.delete(next.address);
      }
      this.queuedSignatures.delete(next.signature);
      if (!this.allowConcurrentLiveSignaturesPerAddress) {
        this.activeTransactionAddresses.add(next.address);
      }
      this.activeTransactionWorkers += 1;
      const process = () =>
        this.addressLogIncludes.has(next.address)
          ? this.options.liveSignatureStore
            ? this.processSignatureUnlocked(next.address, next.signature, next.slot, onEvent, {
                origin: "live",
                notifiedAtMs: next.notifiedAtMs
              })
            : this.processSignatureUntilResolved(next.address, next.signature, next.slot, onEvent, {
                origin: "live",
                notifiedAtMs: next.notifiedAtMs
              })
          : Promise.resolve(false);
      const running = this.allowConcurrentLiveSignaturesPerAddress
        ? process()
        : this.runAddressTask(next.address, process);
      let refillImmediately = true;
      void running
        .then(async (emitted) => {
          if (emitted || this.seenSignatures.has(next.signature)) {
            await this.completeDurableSignature(next.address, next.signature);
          } else if (this.options.liveSignatureStore && !this.stopped) {
            refillImmediately = await this.deferDurableSignature(next, onEvent);
          }
        })
        .catch(() => {
          this.diagnostics.unresolvedTransactionCount += 1;
          this.diagnostics.status = "degraded";
        })
        .finally(async () => {
          this.activeTransactionAddresses.delete(next.address);
          this.activeTransactionWorkers -= 1;
          if (refillImmediately) {
            await this.refillDurableSignatureQueue(next.address, onEvent);
          }
          this.drainLiveSignatureQueue(onEvent);
        });
    }
  }

  private async processSignatureUntilResolved(
    address: string,
    signature: string,
    slot: number,
    onEvent: (event: SolanaChainEvent) => Promise<void> | void,
    timing: SignatureTimingContext
  ): Promise<boolean> {
    while (true) {
      const emitted = await this.processSignatureUnlocked(
        address,
        signature,
        slot,
        onEvent,
        timing
      );
      if (emitted || this.seenSignatures.has(signature) || this.stopped) return emitted;
      if (!(await this.waitForRetryWindow())) return false;
    }
  }

  private notifyQueuePressure(
    address: string,
    reason: "stale" | "high-water" | "full",
    oldestQueueDelayMs?: number
  ): void {
    const previous = this.queuePressureByAddress.get(address);
    if (previous === "full" || previous === "stale" || previous === reason) return;
    this.queuePressureByAddress.set(address, reason);
    this.diagnostics.queuePressureCount = (this.diagnostics.queuePressureCount ?? 0) + 1;
    this.diagnostics.lastQueuePressureAt = this.now().toISOString();
    this.diagnostics.lastQueuePressureReason = reason;
    this.diagnostics.lastQueuePressureDelayMs = oldestQueueDelayMs ?? null;
    try {
      this.options.onQueuePressure?.({
        address,
        reason,
        queuedSignatures: this.liveSignatureQueue.length,
        maxQueuedSignatures: this.maxQueuedSignatures,
        ...(oldestQueueDelayMs === undefined ? {} : { oldestQueueDelayMs })
      });
    } catch {
      this.diagnostics.status = "degraded";
    }
  }

  private scheduleStaleQueueCheck(address: string): void {
    if (
      this.maximumLiveQueueDelayMs === null ||
      this.stopped ||
      this.staleQueueTimers.has(address) ||
      this.queuePressureByAddress.get(address) === "stale"
    ) {
      return;
    }
    const oldest = this.oldestQueuedSignature(address);
    if (!oldest || !Number.isFinite(oldest.notifiedAtMs)) return;
    const remainingMs = Math.max(
      0,
      oldest.notifiedAtMs + this.maximumLiveQueueDelayMs - this.now().getTime()
    );
    const timer = setTimeout(
      () => {
        this.staleQueueTimers.delete(address);
        if (this.stopped || this.maximumLiveQueueDelayMs === null) return;
        const queued = this.oldestQueuedSignature(address);
        if (!queued || !Number.isFinite(queued.notifiedAtMs)) return;
        const queueDelayMs = Math.max(0, this.now().getTime() - queued.notifiedAtMs);
        if (queueDelayMs >= this.maximumLiveQueueDelayMs) {
          this.diagnostics.status = "degraded";
          this.notifyQueuePressure(address, "stale", queueDelayMs);
          return;
        }
        this.scheduleStaleQueueCheck(address);
      },
      Math.min(2_147_483_647, Math.max(1, remainingMs))
    );
    this.staleQueueTimers.set(address, timer);
  }

  private oldestQueuedSignature(address: string): QueuedLiveSignature | undefined {
    let oldest: QueuedLiveSignature | undefined;
    for (const candidate of this.liveSignatureQueue) {
      if (candidate.address !== address) continue;
      if (oldest === undefined || candidate.notifiedAtMs < oldest.notifiedAtMs) {
        oldest = candidate;
      }
    }
    return oldest;
  }

  private async processSignatureUnlocked(
    address: string,
    signature: string,
    slot: number,
    onEvent: (event: SolanaChainEvent) => Promise<void> | void,
    timing: SignatureTimingContext
  ): Promise<boolean> {
    if (this.seenSignatures.has(signature) || this.inFlightSignatures.has(signature)) {
      this.diagnostics.duplicateSignatureCount += 1;
      return false;
    }
    this.inFlightSignatures.add(signature);
    if (slot <= 0) this.diagnostics.missingSlotCount += 1;
    const processingStartedAtMs = this.now().getTime();
    let queueDelayMs: number | undefined;
    if (timing.origin === "live" && timing.notifiedAtMs !== undefined) {
      queueDelayMs = Math.max(0, processingStartedAtMs - timing.notifiedAtMs);
      this.diagnostics.lastTransactionQueueDelayMs = queueDelayMs;
      this.diagnostics.maxTransactionQueueDelayMs = Math.max(
        this.diagnostics.maxTransactionQueueDelayMs ?? 0,
        queueDelayMs
      );
      if (
        this.maximumLiveQueueDelayMs !== null &&
        queueDelayMs >= this.maximumLiveQueueDelayMs
      ) {
        this.diagnostics.status = "degraded";
        this.notifyQueuePressure(address, "stale", queueDelayMs);
      } else if (this.queuePressureByAddress.get(address) === "stale") {
        this.queuePressureByAddress.delete(address);
      }
    }

    try {
      if (this.transactionFetchDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.transactionFetchDelayMs));
      }
      let transaction: SolanaRpcTransaction | null = null;
      let attempts = 0;
      let transactionHttpDurationMs = 0;
      const transactionParams = [
        signature,
        {
          commitment: this.commitment,
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0
        }
      ];
      for (let attempt = 1; attempt <= this.transactionFetchMaxAttempts; attempt += 1) {
        attempts = attempt;
        if (attempt > 1) {
          this.diagnostics.transactionRetryCount =
            (this.diagnostics.transactionRetryCount ?? 0) + 1;
          const retryDelayMs = Math.min(
            this.transactionFetchRetryDelayMs * 2 ** (attempt - 2),
            this.transactionFetchRetryMaxDelayMs
          );
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }
        await this.waitForTransactionRequestSlot();
        this.diagnostics.transactionRequestCount =
          (this.diagnostics.transactionRequestCount ?? 0) + 1;
        const requestStartedAtMs = this.now().getTime();
        try {
          transaction = await this.rpc<SolanaRpcTransaction | null>(
            "getTransaction",
            transactionParams,
            {
              timeoutMs: this.transactionRequestTimeoutMs,
              retries: this.transactionRequestRetries
            }
          );
          if (!transaction) {
            this.diagnostics.transactionNullResponseCount =
              (this.diagnostics.transactionNullResponseCount ?? 0) + 1;
          }
        } catch (error) {
          this.diagnostics.transactionRequestErrorCount =
            (this.diagnostics.transactionRequestErrorCount ?? 0) + 1;
          if (isAbortError(error)) {
            this.diagnostics.transactionRequestTimeoutCount =
              (this.diagnostics.transactionRequestTimeoutCount ?? 0) + 1;
          }
          transaction = null;
        } finally {
          const requestDurationMs = Math.max(0, this.now().getTime() - requestStartedAtMs);
          transactionHttpDurationMs += requestDurationMs;
          this.diagnostics.lastTransactionHttpDurationMs = requestDurationMs;
          this.diagnostics.maxTransactionHttpDurationMs = Math.max(
            this.diagnostics.maxTransactionHttpDurationMs ?? 0,
            requestDurationMs
          );
        }
        if (transaction) {
          if (attempt > 1) {
            this.diagnostics.recoveredTransactionCount =
              (this.diagnostics.recoveredTransactionCount ?? 0) + 1;
          }
          break;
        }
      }
      if (!transaction && this.options.transactionFallbackRpcUrl) {
        await this.waitForTransactionFallbackRequestSlot();
        this.diagnostics.transactionFallbackRequestCount =
          (this.diagnostics.transactionFallbackRequestCount ?? 0) + 1;
        attempts += 1;
        const requestStartedAtMs = this.now().getTime();
        try {
          transaction = await this.rpcAt<SolanaRpcTransaction | null>(
            this.options.transactionFallbackRpcUrl,
            "getTransaction",
            transactionParams,
            { timeoutMs: this.transactionFallbackRequestTimeoutMs, retries: 0 },
            `${this.provider}-transaction-fallback`
          );
          if (transaction) {
            this.diagnostics.transactionFallbackRecoveredCount =
              (this.diagnostics.transactionFallbackRecoveredCount ?? 0) + 1;
            this.diagnostics.recoveredTransactionCount =
              (this.diagnostics.recoveredTransactionCount ?? 0) + 1;
          } else {
            this.diagnostics.transactionNullResponseCount =
              (this.diagnostics.transactionNullResponseCount ?? 0) + 1;
          }
        } catch (error) {
          this.diagnostics.transactionFallbackErrorCount =
            (this.diagnostics.transactionFallbackErrorCount ?? 0) + 1;
          if (isAbortError(error)) {
            this.diagnostics.transactionFallbackTimeoutCount =
              (this.diagnostics.transactionFallbackTimeoutCount ?? 0) + 1;
          }
          transaction = null;
        } finally {
          const requestDurationMs = Math.max(0, this.now().getTime() - requestStartedAtMs);
          transactionHttpDurationMs += requestDurationMs;
          this.diagnostics.lastTransactionHttpDurationMs = requestDurationMs;
          this.diagnostics.maxTransactionHttpDurationMs = Math.max(
            this.diagnostics.maxTransactionHttpDurationMs ?? 0,
            requestDurationMs
          );
        }
      }
      const fetchCycleDurationMs = Math.max(0, this.now().getTime() - processingStartedAtMs);
      this.diagnostics.lastTransactionFetchCycleDurationMs = fetchCycleDurationMs;
      this.diagnostics.maxTransactionFetchCycleDurationMs = Math.max(
        this.diagnostics.maxTransactionFetchCycleDurationMs ?? 0,
        fetchCycleDurationMs
      );
      this.diagnostics.lastTransactionFetchAttempts = attempts;
      if (!transaction) {
        this.diagnostics.unresolvedTransactionCount += 1;
        this.diagnostics.status = "degraded";
        return false;
      }
      const blockTime = finiteInteger(transaction.blockTime);
      if (blockTime === null) {
        this.diagnostics.unresolvedTransactionCount += 1;
        this.diagnostics.status = "degraded";
        return false;
      }
      const observedAtMs = this.now().getTime();
      const providerLatencyMs = Math.max(0, observedAtMs - blockTime * 1_000);
      this.diagnostics.lastProviderLatencyMs = providerLatencyMs;
      this.diagnostics.lastEventOrigin = timing.origin;
      if (timing.origin === "live") {
        this.diagnostics.liveEventCount = (this.diagnostics.liveEventCount ?? 0) + 1;
        this.diagnostics.lastLiveProviderLatencyMs = providerLatencyMs;
        this.diagnostics.maxLiveProviderLatencyMs = Math.max(
          this.diagnostics.maxLiveProviderLatencyMs ?? 0,
          providerLatencyMs
        );
        if (timing.notifiedAtMs !== undefined) {
          const notificationAgeMs = Math.max(0, timing.notifiedAtMs - blockTime * 1_000);
          const notificationToObservedMs = Math.max(0, observedAtMs - timing.notifiedAtMs);
          this.diagnostics.lastWebsocketNotificationAgeMs = notificationAgeMs;
          this.diagnostics.maxWebsocketNotificationAgeMs = Math.max(
            this.diagnostics.maxWebsocketNotificationAgeMs ?? 0,
            notificationAgeMs
          );
          this.diagnostics.lastNotificationToObservedMs = notificationToObservedMs;
          this.diagnostics.maxNotificationToObservedMs = Math.max(
            this.diagnostics.maxNotificationToObservedMs ?? 0,
            notificationToObservedMs
          );
        }
        if (providerLatencyMs >= this.providerLatencyWarningMs) {
          this.diagnostics.slowLiveEventCount = (this.diagnostics.slowLiveEventCount ?? 0) + 1;
          this.diagnostics.lastSlowLiveEventAt = new Date(observedAtMs).toISOString();
          this.diagnostics.status = "degraded";
        } else {
          this.diagnostics.status = "ok";
        }
      } else {
        this.diagnostics.lastBackfillProviderLatencyMs = providerLatencyMs;
      }
      const occurredAt = new Date(blockTime * 1_000).toISOString();
      const logIncludes = this.addressLogIncludes.get(address) ?? [];
      if (
        logIncludes.length > 0 &&
        !transactionHasProgramScopedLog(transaction, address, logIncludes)
      ) {
        // getSignaturesForAddress cannot apply a log-message predicate. Reapply the
        // same exact filter within the configured program's invocation context
        // after fetching so reconnect/initial backfill traffic and cross-program
        // log-name collisions cannot become false discovery candidates. The
        // transaction is resolved and intentionally irrelevant, so advancing the
        // cursor is safe.
        this.diagnostics.postfetchFilteredTransactionCount =
          (this.diagnostics.postfetchFilteredTransactionCount ?? 0) + 1;
        await this.options.cursorStore.save(address, { signature, slot, occurredAt });
        rememberBounded(this.seenSignatures, signature, this.seenSignatureLimit);
        return false;
      }
      const event = {
        address,
        signature,
        slot,
        occurredAt,
        observedAt: new Date(observedAtMs).toISOString(),
        commitment: this.commitment,
        source: this.provider,
        providerTiming: {
          origin: timing.origin,
          fetchStartedAtMs: processingStartedAtMs,
          fetchCompletedAtMs: observedAtMs,
          fetchCycleDurationMs,
          transactionHttpDurationMs,
          fetchAttempts: attempts,
          ...(timing.notifiedAtMs !== undefined
            ? { notificationReceivedAtMs: timing.notifiedAtMs }
            : {}),
          ...(queueDelayMs !== undefined ? { queueDelayMs } : {})
        },
        transaction
      };
      if (!(await this.deliverWithAdmissionRetry(event, onEvent))) return false;
      await this.options.cursorStore.save(address, { signature, slot, occurredAt });
      rememberBounded(this.seenSignatures, signature, this.seenSignatureLimit);
      return true;
    } catch (error) {
      if (isSolanaEventNotAcceptedError(error)) {
        this.diagnostics.handlerRejectedEventCount =
          (this.diagnostics.handlerRejectedEventCount ?? 0) + 1;
        this.diagnostics.lastHandlerRejectedEventAt = this.now().toISOString();
        this.diagnostics.status = "degraded";
        return false;
      }
      this.diagnostics.status = "degraded";
      this.diagnostics.unresolvedTransactionCount += 1;
      return false;
    } finally {
      this.inFlightSignatures.delete(signature);
    }
  }

  private runAddressTask<T>(address: string, task: () => Promise<T>): Promise<T> {
    const previous = this.addressTaskTails.get(address) ?? Promise.resolve();
    const running = previous.catch(() => undefined).then(task);
    const tail = running.then(
      () => undefined,
      () => undefined
    );
    this.addressTaskTails.set(address, tail);
    return running.finally(() => {
      if (this.addressTaskTails.get(address) === tail) {
        this.addressTaskTails.delete(address);
      }
    });
  }

  private async deliverWithAdmissionRetry(
    event: SolanaChainEvent,
    onEvent: (event: SolanaChainEvent) => Promise<void> | void
  ): Promise<boolean> {
    let admissionRejected = false;
    let handlerFailureRecorded = false;
    while (true) {
      try {
        await onEvent(event);
        return true;
      } catch (error) {
        if (isSolanaEventNotAcceptedError(error)) {
          if (!admissionRejected) {
            admissionRejected = true;
            this.diagnostics.handlerRejectedEventCount =
              (this.diagnostics.handlerRejectedEventCount ?? 0) + 1;
            this.diagnostics.lastHandlerRejectedEventAt = this.now().toISOString();
          } else {
            this.diagnostics.handlerAdmissionRetryCount =
              (this.diagnostics.handlerAdmissionRetryCount ?? 0) + 1;
          }
        } else {
          if (!handlerFailureRecorded) {
            handlerFailureRecorded = true;
            this.diagnostics.unresolvedTransactionCount += 1;
          }
        }
        this.diagnostics.status = "degraded";
        if (!(await this.waitForRetryWindow())) return false;
      }
    }
  }

  private waitForRetryWindow(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        this.retryWaiters.delete(finish);
        resolve(!this.stopped);
      };
      this.retryWaiters.add(finish);
      timer = setTimeout(finish, this.handlerRejectionRetryDelayMs);
    });
  }

  private wakeRetryWaiters(): void {
    for (const finish of [...this.retryWaiters]) finish();
  }

  private startHeartbeat(socket: WebSocketLike, generation: number): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (
        this.stopped ||
        !this.socketOpen ||
        socket !== this.socket ||
        generation !== this.socketGeneration
      ) {
        return;
      }
      if (this.heartbeatSentAtMs !== null) return;
      this.heartbeatSentAtMs = this.now().getTime();
      this.diagnostics.lastPingAt = new Date(this.heartbeatSentAtMs).toISOString();
      if (typeof socket.ping === "function") {
        socket.ping();
      } else {
        const id = this.nextRequestId++;
        this.heartbeatRequestId = id;
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method: "getHealth" }));
      }
      if (this.heartbeatDeadlineTimer) clearTimeout(this.heartbeatDeadlineTimer);
      const sentAt = this.heartbeatSentAtMs;
      this.heartbeatDeadlineTimer = setTimeout(() => {
        if (
          socket !== this.socket ||
          generation !== this.socketGeneration ||
          this.heartbeatSentAtMs !== sentAt
        ) {
          return;
        }
        this.diagnostics.heartbeatTimeoutCount = (this.diagnostics.heartbeatTimeoutCount ?? 0) + 1;
        this.diagnostics.status = "degraded";
        this.handleSocketClose(socket, generation);
        try {
          socket.close();
        } catch {
          // The generation was already fenced and reconnect is scheduled.
        }
      }, this.heartbeatTimeoutMs);
    }, this.heartbeatIntervalMs);
  }

  private acknowledgeHeartbeat(): void {
    if (this.heartbeatSentAtMs !== null) {
      this.diagnostics.lastPongAt = this.now().toISOString();
    }
    this.heartbeatSentAtMs = null;
    this.heartbeatRequestId = null;
    if (this.heartbeatDeadlineTimer) clearTimeout(this.heartbeatDeadlineTimer);
    this.heartbeatDeadlineTimer = null;
    if (
      this.requestAddress.size === 0 &&
      this.timedOutSubscriptionRequests.size === 0 &&
      this.truncatedBackfillAddresses.size === 0
    ) {
      this.diagnostics.status = "ok";
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.heartbeatDeadlineTimer) clearTimeout(this.heartbeatDeadlineTimer);
    this.heartbeatTimer = null;
    this.heartbeatDeadlineTimer = null;
    this.heartbeatRequestId = null;
    this.heartbeatSentAtMs = null;
  }

  private sendSubscribeRequest(socket: WebSocketLike, address: string): void {
    const id = this.nextRequestId++;
    this.requestAddress.set(id, address);
    this.diagnostics.lastSubscriptionRequestAt = this.now().toISOString();
    const timer = setTimeout(() => {
      this.subscriptionAckTimers.delete(id);
      if (this.stopped || socket !== this.socket || !this.requestAddress.has(id)) return;
      this.timedOutSubscriptionRequests.add(id);
      this.diagnostics.subscriptionAckTimeoutCount =
        (this.diagnostics.subscriptionAckTimeoutCount ?? 0) + 1;
      this.diagnostics.lastSubscriptionAckTimeoutAt = this.now().toISOString();
      this.diagnostics.status = "degraded";
    }, this.subscriptionAckTimeoutMs);
    this.subscriptionAckTimers.set(id, timer);
    socket.send(JSON.stringify(createLogsSubscribeRequest(id, address, this.commitment)));
  }

  private clearSubscriptionAckTimer(id: number): void {
    const timer = this.subscriptionAckTimers.get(id);
    if (timer) clearTimeout(timer);
    this.subscriptionAckTimers.delete(id);
  }

  private clearSubscriptionState(): void {
    for (const timer of this.subscriptionAckTimers.values()) clearTimeout(timer);
    this.subscriptionAckTimers.clear();
    this.requestAddress.clear();
    this.subscriptionAddress.clear();
    this.subscriptionByAddress.clear();
    this.timedOutSubscriptionRequests.clear();
    this.successfulSubscriptionAddresses.clear();
  }

  private async rpc<T>(
    method: string,
    params: unknown[],
    requestOptions: { timeoutMs?: number; retries?: number } = {}
  ): Promise<T> {
    return this.rpcAt(this.options.rpcUrl, method, params, requestOptions, this.provider);
  }

  private async rpcAt<T>(
    rpcUrl: string,
    method: string,
    params: unknown[],
    requestOptions: { timeoutMs?: number; retries?: number },
    provider: string
  ): Promise<T> {
    const response = await fetchJson<RpcResponse<T>>(provider, rpcUrl, {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: 1,
        method,
        params
      },
      ...requestOptions,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {})
    });
    return response.result;
  }

  private async waitForTransactionRequestSlot(): Promise<void> {
    if (this.minTransactionRequestIntervalMs <= 0) return;
    const previous = this.transactionRequestGate;
    let release: () => void = () => {};
    this.transactionRequestGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const waitMs = Math.max(
        0,
        this.lastTransactionRequestAtMs + this.minTransactionRequestIntervalMs - Date.now()
      );
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      this.lastTransactionRequestAtMs = Date.now();
    } finally {
      release();
    }
  }

  private async waitForTransactionFallbackRequestSlot(): Promise<void> {
    const previous = this.transactionFallbackRequestGate;
    let release: () => void = () => {};
    this.transactionFallbackRequestGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const waitMs = Math.max(
        0,
        this.lastTransactionFallbackRequestAtMs +
          this.transactionFallbackMinRequestIntervalMs -
          Date.now()
      );
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.lastTransactionFallbackRequestAtMs = Date.now();
    } finally {
      release();
    }
  }
}

/**
 * Reads the numeric context slot directly from a logs notification string.
 * The hot negative-prefilter path calls this before JSON.parse, so keep it
 * allocation-free apart from the already materialized WebSocket string.
 */
function extractLogsNotificationContextSlot(text: string): number | null {
  const contextIndex = text.indexOf('"context"');
  if (contextIndex < 0) return null;
  const slotIndex = text.indexOf('"slot"', contextIndex + 9);
  if (slotIndex < 0) return null;
  const colonIndex = text.indexOf(":", slotIndex + 6);
  if (colonIndex < 0) return null;
  let cursor = colonIndex + 1;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
    cursor += 1;
  }
  let value = 0;
  let digitCount = 0;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (code < 48 || code > 57) break;
    value = value * 10 + code - 48;
    digitCount += 1;
    cursor += 1;
  }
  return digitCount > 0 && Number.isSafeInteger(value) ? value : null;
}

/**
 * Reads the raw notification signature without parsing the full payload. This
 * must run before the negative log prefilter and before failed notifications
 * return so the activity sentinel compares like-for-like raw program traffic.
 */
function extractLogsNotificationSignature(text: string): string | null {
  const signatureIndex = text.indexOf('"signature"');
  if (signatureIndex < 0) return null;
  const colonIndex = text.indexOf(":", signatureIndex + 11);
  if (colonIndex < 0) return null;
  let cursor = colonIndex + 1;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
    cursor += 1;
  }
  if (text.charCodeAt(cursor) !== 34) return null;
  const start = cursor + 1;
  cursor = start;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (code === 34) return cursor > start ? text.slice(start, cursor) : null;
    // Solana base58 signatures cannot contain escapes or control characters.
    if (code === 92 || code < 32) return null;
    cursor += 1;
  }
  return null;
}

export interface HeliusTransactionEventSourceOptions {
  rpcUrl: string;
  wsUrl: string;
  addresses: string[];
  cursorStore: SolanaCursorStore;
  logIncludesByAddress?: Record<string, string[]>;
  provider?: string;
  commitment?: "processed" | "confirmed" | "finalized";
  tokenAccounts?: "none" | "balanceChanged" | "all";
  fetchImpl?: typeof fetch;
  webSocketFactory?: WebSocketFactory;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  reconnectJitterRatio?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  subscriptionRefreshDebounceMs?: number;
  accountIncludeChunkSize?: number;
  initialBackfillLimit?: number;
  backfillPageLimit?: number;
  maxBackfillPages?: number;
  seenEventLimit?: number;
  blockTimeCacheSize?: number;
  handlerRejectionRetryDelayMs?: number;
  now?: () => Date;
  random?: () => number;
}

export interface HeliusTransactionEventSourceDiagnostics extends SolanaEventSourceDiagnostics {
  transport: "transaction-subscribe";
  connectionState: "idle" | "connecting" | "open" | "reconnecting" | "stopped";
  subscribedAddressCount: number;
  activeSubscriptionCount: number;
  pendingSubscriptionCount: number;
  subscriptionRefreshCount: number;
  subscriptionErrorCount: number;
  subscriptionUnavailableReason: string | null;
  lastSubscriptionErrorCode: number | null;
  lastSubscriptionErrorMessage: string | null;
  reconnectAttempt: number;
  nextReconnectDelayMs: number | null;
  heartbeatTimeoutCount: number;
  unmatchedNotificationCount: number;
  unresolvedBlockTimeCount: number;
  lastConnectedAt: string | null;
  lastMessageAt: string | null;
  lastPingAt: string | null;
  lastPongAt: string | null;
  lastEventAt: string | null;
  lastEventSlot: number | null;
}

interface HeliusSubscriptionGroup {
  generation: number;
  addresses: string[];
}

type HeliusRequestContext =
  ({ kind: "subscribe" } & HeliusSubscriptionGroup) | { kind: "heartbeat" };

interface HeliusTransactionNotification {
  method?: string;
  id?: number;
  result?: number | boolean | string;
  error?: { code?: number; message?: string };
  params?: {
    subscription?: number;
    result?: {
      transaction?: SolanaRpcTransaction;
      signature?: string;
      slot?: number;
      transactionIndex?: number;
      blockTime?: number | null;
    };
  };
}

/**
 * Helius' full-transaction stream. Unlike StandardSolanaEventSource, live
 * notifications already contain the transaction and therefore do not require
 * a serial getTransaction call. Standard RPC is retained for gap backfills and
 * getBlockTime when the stream omits chain time.
 */
export class HeliusTransactionEventSource implements SolanaEventSource {
  private readonly provider: string;
  private readonly commitment: "processed" | "confirmed" | "finalized";
  private readonly reconnectInitialDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly reconnectJitterRatio: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly subscriptionRefreshDebounceMs: number;
  private readonly accountIncludeChunkSize: number;
  private readonly initialBackfillLimit: number;
  private readonly backfillPageLimit: number;
  private readonly maxBackfillPages: number;
  private readonly seenEventLimit: number;
  private readonly blockTimeCacheSize: number;
  private readonly handlerRejectionRetryDelayMs: number;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly socketFactory: WebSocketFactory;
  private readonly addressLogIncludes = new Map<string, string[]>();
  private readonly backfillAddresses = new Set<string>();
  private readonly backfillQueue: string[] = [];
  private readonly queuedBackfillAddresses = new Set<string>();
  private readonly truncatedBackfillAddresses = new Set<string>();
  private readonly subscriptions = new Map<number, HeliusSubscriptionGroup>();
  private readonly requests = new Map<number, HeliusRequestContext>();
  private readonly seenEventKeys = new Set<string>();
  private readonly inFlightEventKeys = new Set<string>();
  private readonly blockTimeCache = new Map<number, Promise<number | null>>();
  private readonly addressTaskTails = new Map<string, Promise<void>>();
  private readonly retryWaiters = new Set<() => void>();
  private socket: WebSocketLike | null = null;
  private socketOpen = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatSentAtMs: number | null = null;
  private reconnectAttempt = 0;
  private generation = 0;
  private socketGeneration = 0;
  private nextRequestId = 1;
  private stopped = true;
  private backfillDrainRunning = false;
  private subscriptionUnavailableReason: string | null = null;
  private handler: ((event: SolanaChainEvent) => Promise<void> | void) | null = null;
  private diagnostics: HeliusTransactionEventSourceDiagnostics;

  constructor(private readonly options: HeliusTransactionEventSourceOptions) {
    this.provider = options.provider ?? "helius-transaction-subscribe";
    this.commitment = options.commitment ?? "confirmed";
    this.reconnectInitialDelayMs = positiveInteger(
      options.reconnectInitialDelayMs ?? 1_000,
      "reconnectInitialDelayMs"
    );
    this.reconnectMaxDelayMs = positiveInteger(
      options.reconnectMaxDelayMs ?? 30_000,
      "reconnectMaxDelayMs"
    );
    this.reconnectJitterRatio = options.reconnectJitterRatio ?? 0.2;
    if (this.reconnectJitterRatio < 0 || this.reconnectJitterRatio > 1) {
      throw new Error("reconnectJitterRatio must be between 0 and 1.");
    }
    this.heartbeatIntervalMs = positiveInteger(
      options.heartbeatIntervalMs ?? 30_000,
      "heartbeatIntervalMs"
    );
    this.heartbeatTimeoutMs = positiveInteger(
      options.heartbeatTimeoutMs ?? 10_000,
      "heartbeatTimeoutMs"
    );
    this.subscriptionRefreshDebounceMs = nonNegativeInteger(
      options.subscriptionRefreshDebounceMs ?? 250,
      "subscriptionRefreshDebounceMs"
    );
    this.accountIncludeChunkSize = positiveInteger(
      options.accountIncludeChunkSize ?? 50_000,
      "accountIncludeChunkSize"
    );
    if (this.accountIncludeChunkSize > 50_000) {
      throw new Error(
        "Helius transactionSubscribe accepts at most 50,000 accountInclude addresses."
      );
    }
    this.initialBackfillLimit = positiveInteger(
      options.initialBackfillLimit ?? 100,
      "initialBackfillLimit"
    );
    this.backfillPageLimit = positiveInteger(
      options.backfillPageLimit ?? 1_000,
      "backfillPageLimit"
    );
    this.maxBackfillPages = positiveInteger(options.maxBackfillPages ?? 10, "maxBackfillPages");
    this.seenEventLimit = positiveInteger(options.seenEventLimit ?? 100_000, "seenEventLimit");
    this.blockTimeCacheSize = positiveInteger(
      options.blockTimeCacheSize ?? 2_048,
      "blockTimeCacheSize"
    );
    this.handlerRejectionRetryDelayMs = positiveInteger(
      options.handlerRejectionRetryDelayMs ?? 1_000,
      "handlerRejectionRetryDelayMs"
    );
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.socketFactory =
      options.webSocketFactory ??
      ((url) => {
        if (typeof WebSocket === "undefined") {
          throw new Error("A WebSocket implementation is required by this Node.js runtime.");
        }
        return new WebSocket(url) as unknown as WebSocketLike;
      });
    for (const address of uniqueNonEmpty(options.addresses)) {
      this.addressLogIncludes.set(address, options.logIncludesByAddress?.[address] ?? []);
      this.backfillAddresses.add(address);
    }
    this.diagnostics = {
      provider: this.provider,
      status: "down",
      reconnectCount: 0,
      duplicateSignatureCount: 0,
      backfillEventCount: 0,
      backfillTruncatedCount: 0,
      backfillTruncatedAddressCount: 0,
      lastBackfillTruncatedAt: null,
      lastBackfillTruncatedCursorAt: null,
      lastBackfillTruncatedCursorSlot: null,
      lastBackfillTruncatedCursorSignature: null,
      missingSlotCount: 0,
      unresolvedTransactionCount: 0,
      lastProviderLatencyMs: null,
      lastWebsocketSignature: null,
      handlerRejectedEventCount: 0,
      handlerAdmissionRetryCount: 0,
      lastHandlerRejectedEventAt: null,
      transport: "transaction-subscribe",
      connectionState: "idle",
      subscribedAddressCount: this.addressLogIncludes.size,
      activeSubscriptionCount: 0,
      pendingSubscriptionCount: 0,
      subscriptionRefreshCount: 0,
      subscriptionErrorCount: 0,
      subscriptionUnavailableReason: null,
      lastSubscriptionErrorCode: null,
      lastSubscriptionErrorMessage: null,
      reconnectAttempt: 0,
      nextReconnectDelayMs: null,
      heartbeatTimeoutCount: 0,
      unmatchedNotificationCount: 0,
      unresolvedBlockTimeCount: 0,
      lastConnectedAt: null,
      lastMessageAt: null,
      lastPingAt: null,
      lastPongAt: null,
      lastEventAt: null,
      lastEventSlot: null
    };
  }

  async start(onEvent: (event: SolanaChainEvent) => Promise<void> | void): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.handler = onEvent;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wakeRetryWaiters();
    this.clearReconnectTimer();
    this.clearHeartbeat();
    this.clearSubscriptionRefreshTimer();
    const socket = this.socket;
    this.socket = null;
    this.socketOpen = false;
    socket?.close();
    this.requests.clear();
    this.subscriptions.clear();
    this.backfillQueue.length = 0;
    this.queuedBackfillAddresses.clear();
    this.updateSubscriptionDiagnostics();
    this.diagnostics.connectionState = "stopped";
    this.diagnostics.status = "down";
  }

  async subscribeAddress(
    address: string,
    logIncludes: string[] = [],
    backfill = false
  ): Promise<void> {
    const normalized = address.trim();
    if (!normalized) throw new Error("A non-empty accountInclude address is required.");
    const previous = this.addressLogIncludes.get(normalized);
    this.addressLogIncludes.set(normalized, [...logIncludes]);
    if (backfill) this.backfillAddresses.add(normalized);
    this.diagnostics.subscribedAddressCount = this.addressLogIncludes.size;
    if (!previous || !sameStrings(previous, logIncludes)) this.scheduleSubscriptionRefresh();
    if (backfill && this.handler) this.scheduleBackfill(normalized);
  }

  unsubscribeAddress(address: string): void {
    if (!this.addressLogIncludes.delete(address)) return;
    this.backfillAddresses.delete(address);
    this.queuedBackfillAddresses.delete(address);
    this.truncatedBackfillAddresses.delete(address);
    this.diagnostics.backfillTruncatedAddressCount = this.truncatedBackfillAddresses.size;
    this.diagnostics.subscribedAddressCount = this.addressLogIncludes.size;
    this.scheduleSubscriptionRefresh();
  }

  async backfill(
    address: string,
    onEvent: (event: SolanaChainEvent) => Promise<void> | void
  ): Promise<number> {
    return this.runAddressTask(address, () => this.backfillAddress(address, onEvent));
  }

  private async backfillAddress(
    address: string,
    onEvent: (event: SolanaChainEvent) => Promise<void> | void
  ): Promise<number> {
    const cursor = await this.options.cursorStore.get(address);
    const signatures: SignatureInfo[] = [];
    let before: string | undefined;
    let reachedCursorBoundary = !cursor;

    for (let page = 0; page < this.maxBackfillPages; page += 1) {
      const pageLimit = cursor ? this.backfillPageLimit : this.initialBackfillLimit;
      const pageItems = await this.rpc<SignatureInfo[]>("getSignaturesForAddress", [
        address,
        {
          limit: pageLimit,
          ...(cursor ? { until: cursor.signature } : {}),
          ...(before ? { before } : {}),
          commitment: this.commitment
        }
      ]);
      signatures.push(...pageItems.filter((item) => !item.err));
      if (pageItems.length < pageLimit) {
        reachedCursorBoundary = true;
        break;
      }
      if (!cursor) break;
      before = pageItems[pageItems.length - 1]?.signature;
      if (!before) {
        reachedCursorBoundary = true;
        break;
      }
    }

    if (cursor && !reachedCursorBoundary && before) {
      const boundary = await this.rpc<SignatureInfo[]>("getSignaturesForAddress", [
        address,
        {
          limit: 1,
          until: cursor.signature,
          before,
          commitment: this.commitment
        }
      ]);
      reachedCursorBoundary = boundary.length === 0;
    }

    if (cursor && !reachedCursorBoundary) {
      this.truncatedBackfillAddresses.add(address);
      this.diagnostics.backfillTruncatedCount = (this.diagnostics.backfillTruncatedCount ?? 0) + 1;
      this.diagnostics.backfillTruncatedAddressCount = this.truncatedBackfillAddresses.size;
      this.diagnostics.lastBackfillTruncatedAt = this.now().toISOString();
      this.diagnostics.lastBackfillTruncatedCursorAt =
        cursor.occurredAt ?? cursor.updatedAt ?? null;
      this.diagnostics.lastBackfillTruncatedCursorSlot = cursor.slot;
      this.diagnostics.lastBackfillTruncatedCursorSignature = cursor.signature;
      this.diagnostics.status = "degraded";
      return 0;
    }
    this.truncatedBackfillAddresses.delete(address);
    this.diagnostics.backfillTruncatedAddressCount = this.truncatedBackfillAddresses.size;

    let emitted = 0;
    for (const item of signatures.reverse()) {
      let outcome: "emitted" | "duplicate" | "unresolved" = "unresolved";
      while (true) {
        const transaction = await this.fetchBackfillTransaction(item.signature);
        outcome = transaction
          ? await this.emitTransaction(
              address,
              item.signature,
              item.slot,
              undefined,
              transaction,
              onEvent
            )
          : "unresolved";
        if (outcome !== "unresolved" || this.stopped) break;
        if (!(await this.waitForRetryWindow())) break;
      }
      if (outcome === "emitted") emitted += 1;
      if (outcome === "unresolved") break;
    }
    this.diagnostics.backfillEventCount += emitted;
    return emitted;
  }

  getDiagnostics(): HeliusTransactionEventSourceDiagnostics {
    return {
      ...this.diagnostics,
      status: this.truncatedBackfillAddresses.size > 0 ? "degraded" : this.diagnostics.status
    };
  }

  private scheduleBackfill(address: string): void {
    if (
      this.stopped ||
      !this.handler ||
      this.subscriptionUnavailableReason !== null ||
      !this.backfillAddresses.has(address) ||
      this.queuedBackfillAddresses.has(address)
    ) {
      return;
    }
    this.queuedBackfillAddresses.add(address);
    this.backfillQueue.push(address);
    void this.drainBackfillQueue();
  }

  private async drainBackfillQueue(): Promise<void> {
    if (this.backfillDrainRunning) return;
    this.backfillDrainRunning = true;
    try {
      while (!this.stopped && this.handler) {
        const address = this.backfillQueue.shift();
        if (!address) break;
        this.queuedBackfillAddresses.delete(address);
        if (!this.backfillAddresses.has(address)) continue;
        try {
          await this.backfill(address, this.handler);
        } catch {
          this.diagnostics.status = "degraded";
        }
      }
    } finally {
      this.backfillDrainRunning = false;
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.diagnostics.connectionState = "connecting";
    this.diagnostics.nextReconnectDelayMs = null;
    let socket: WebSocketLike;
    try {
      socket = this.socketFactory(this.options.wsUrl);
    } catch {
      this.diagnostics.status = "down";
      this.scheduleReconnect();
      return;
    }
    const socketGeneration = ++this.socketGeneration;
    this.socket = socket;
    this.socketOpen = false;
    socket.onopen = () => this.handleSocketOpen(socket, socketGeneration);
    socket.onmessage = (message) => {
      void this.handleSocketMessage(socket, socketGeneration, message);
    };
    socket.onerror = () => {
      if (this.socket !== socket || this.socketGeneration !== socketGeneration) return;
      this.diagnostics.status = "degraded";
      this.handleSocketClose(socket, socketGeneration);
      try {
        socket.close();
      } catch {
        // The reconnect path is already scheduled.
      }
    };
    socket.onclose = () => this.handleSocketClose(socket, socketGeneration);
    const acknowledgePong = () => {
      if (this.socket !== socket || this.socketGeneration !== socketGeneration) return;
      this.acknowledgeHeartbeat();
    };
    if (typeof socket.on === "function") socket.on("pong", acknowledgePong);
    else socket.onpong = acknowledgePong;
  }

  private handleSocketOpen(socket: WebSocketLike, socketGeneration: number): void {
    if (this.socket !== socket || this.socketGeneration !== socketGeneration || this.stopped) {
      return;
    }
    this.socketOpen = true;
    this.requests.clear();
    this.subscriptions.clear();
    this.nextRequestId = 1;
    this.diagnostics.status = "ok";
    this.diagnostics.connectionState = "open";
    this.diagnostics.lastConnectedAt = this.now().toISOString();
    this.updateSubscriptionDiagnostics();
    this.refreshSubscriptions();
    this.startHeartbeat(socket);
    if (this.handler) {
      for (const address of this.backfillAddresses) {
        this.scheduleBackfill(address);
      }
    }
  }

  private handleSocketClose(socket: WebSocketLike, socketGeneration: number): void {
    if (this.socket !== socket || this.socketGeneration !== socketGeneration) return;
    this.socket = null;
    this.socketOpen = false;
    this.clearHeartbeat();
    this.clearSubscriptionRefreshTimer();
    this.requests.clear();
    this.subscriptions.clear();
    this.updateSubscriptionDiagnostics();
    if (this.stopped) return;
    this.diagnostics.status = "degraded";
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const exponential = Math.min(
      this.reconnectMaxDelayMs,
      this.reconnectInitialDelayMs * 2 ** this.reconnectAttempt
    );
    const jitter = 1 + (this.random() * 2 - 1) * this.reconnectJitterRatio;
    const delay = Math.max(0, Math.round(exponential * jitter));
    this.reconnectAttempt += 1;
    this.diagnostics.reconnectCount += 1;
    this.diagnostics.reconnectAttempt = this.reconnectAttempt;
    this.diagnostics.nextReconnectDelayMs = delay;
    this.diagnostics.connectionState = "reconnecting";
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private refreshSubscriptions(): void {
    const socket = this.socket;
    if (!socket || !this.socketOpen || this.stopped) return;
    this.generation += 1;
    const generation = this.generation;
    for (const subscriptionId of this.subscriptions.keys()) {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: this.nextRequestId++,
          method: "transactionUnsubscribe",
          params: [subscriptionId]
        })
      );
    }
    this.subscriptions.clear();

    const addresses = [...this.addressLogIncludes.keys()];
    for (let offset = 0; offset < addresses.length; offset += this.accountIncludeChunkSize) {
      const chunk = addresses.slice(offset, offset + this.accountIncludeChunkSize);
      const id = this.nextRequestId++;
      this.requests.set(id, { kind: "subscribe", generation, addresses: chunk });
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "transactionSubscribe",
          params: [
            {
              vote: false,
              failed: false,
              accountInclude: chunk,
              ...(this.options.tokenAccounts && this.options.tokenAccounts !== "none"
                ? { tokenAccounts: this.options.tokenAccounts }
                : {})
            },
            {
              commitment: this.commitment,
              encoding: "jsonParsed",
              transactionDetails: "full",
              showRewards: false,
              maxSupportedTransactionVersion: 0
            }
          ]
        })
      );
    }
    this.diagnostics.subscriptionRefreshCount += 1;
    this.updateSubscriptionDiagnostics();
  }

  private scheduleSubscriptionRefresh(): void {
    if (!this.socketOpen || this.stopped || this.subscriptionRefreshTimer) return;
    if (this.subscriptionRefreshDebounceMs === 0) {
      this.refreshSubscriptions();
      return;
    }
    this.subscriptionRefreshTimer = setTimeout(() => {
      this.subscriptionRefreshTimer = null;
      this.refreshSubscriptions();
    }, this.subscriptionRefreshDebounceMs);
  }

  private clearSubscriptionRefreshTimer(): void {
    if (this.subscriptionRefreshTimer) clearTimeout(this.subscriptionRefreshTimer);
    this.subscriptionRefreshTimer = null;
  }

  private async handleSocketMessage(
    socket: WebSocketLike,
    socketGeneration: number,
    message: WebSocketMessage
  ): Promise<void> {
    if (this.socket !== socket || this.socketGeneration !== socketGeneration) return;
    this.diagnostics.lastMessageAt = this.now().toISOString();
    this.acknowledgeHeartbeat();
    let payload: HeliusTransactionNotification;
    try {
      payload = JSON.parse(await webSocketMessageText(message)) as HeliusTransactionNotification;
    } catch {
      if (this.socket !== socket || this.socketGeneration !== socketGeneration) return;
      this.diagnostics.status = "degraded";
      return;
    }
    if (this.socket !== socket || this.socketGeneration !== socketGeneration) return;

    if (payload.id !== undefined) {
      const request = this.requests.get(payload.id);
      this.requests.delete(payload.id);
      if (!request) return;
      if (payload.error) {
        if (request.kind === "subscribe") {
          this.diagnostics.subscriptionErrorCount += 1;
          this.diagnostics.status = "degraded";
          this.diagnostics.lastSubscriptionErrorCode = payload.error.code ?? null;
          this.diagnostics.lastSubscriptionErrorMessage = payload.error.message ?? "Unknown error";
          if (/not available on the free plan/i.test(payload.error.message ?? "")) {
            this.subscriptionUnavailableReason = payload.error.message ?? "Unavailable";
            this.diagnostics.subscriptionUnavailableReason = this.subscriptionUnavailableReason;
            this.backfillQueue.length = 0;
            this.queuedBackfillAddresses.clear();
          }
        }
        this.updateSubscriptionDiagnostics();
        return;
      }
      if (request.kind === "heartbeat") return;
      if (typeof payload.result !== "number") {
        this.diagnostics.subscriptionErrorCount += 1;
        this.diagnostics.status = "degraded";
        this.updateSubscriptionDiagnostics();
        return;
      }
      if (request.generation !== this.generation) {
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: this.nextRequestId++,
            method: "transactionUnsubscribe",
            params: [payload.result]
          })
        );
        return;
      }
      this.subscriptions.set(payload.result, request);
      this.reconnectAttempt = 0;
      this.diagnostics.reconnectAttempt = 0;
      this.diagnostics.nextReconnectDelayMs = null;
      this.diagnostics.status = "ok";
      this.updateSubscriptionDiagnostics();
      return;
    }

    const result = payload.params?.result;
    const subscriptionId = payload.params?.subscription;
    if (
      payload.method !== "transactionNotification" ||
      subscriptionId === undefined ||
      !result?.transaction ||
      !this.handler
    ) {
      return;
    }
    const group = this.subscriptions.get(subscriptionId);
    if (!group || group.generation !== this.generation) return;
    const signature = result.signature ?? transactionSignature(result.transaction);
    if (!signature) {
      this.diagnostics.unresolvedTransactionCount += 1;
      return;
    }
    this.diagnostics.lastWebsocketSignature = signature;
    const slot = finiteInteger(result.slot) ?? 0;
    const transactionIndex = finiteInteger(result.transactionIndex) ?? undefined;
    const matchedAddresses = matchingSubscribedAddresses(result.transaction, group.addresses);
    if (matchedAddresses.length === 0 && group.addresses.length === 1) {
      // tokenAccounts expansion can match a wallet without placing its owner
      // pubkey directly in the account-key list.
      matchedAddresses.push(group.addresses[0]!);
    }
    if (matchedAddresses.length === 0) {
      this.diagnostics.unmatchedNotificationCount += 1;
      this.diagnostics.status = "degraded";
      return;
    }

    const embeddedBlockTime =
      finiteInteger(result.blockTime) ?? finiteInteger(result.transaction.blockTime);
    const logs = transactionLogMessages(result.transaction);
    await Promise.all(
      matchedAddresses.map((address) => {
        const includes = this.addressLogIncludes.get(address) ?? [];
        if (includes.length && !logs.some((log) => includes.includes(log))) {
          return Promise.resolve();
        }
        // Queue the notification before resolving a missing block time. Otherwise
        // a later notification whose block time is already present can overtake it
        // and advance this address' cursor across an unresolved predecessor.
        return this.runAddressTask(address, async () => {
          while (true) {
            const blockTime =
              embeddedBlockTime ?? (slot > 0 ? await this.resolveBlockTime(slot) : null);
            const transaction: SolanaRpcTransaction = {
              ...result.transaction,
              ...(blockTime !== null ? { blockTime } : {})
            };
            const outcome = await this.emitTransaction(
              address,
              signature,
              slot,
              transactionIndex,
              transaction,
              this.handler!,
              matchedAddresses
            );
            if (outcome !== "unresolved" || this.stopped) return;
            if (embeddedBlockTime === null && slot > 0) this.blockTimeCache.delete(slot);
            if (!(await this.waitForRetryWindow())) return;
          }
        });
      })
    );
  }

  private async fetchBackfillTransaction(signature: string): Promise<SolanaRpcTransaction | null> {
    try {
      const transaction = await this.rpc<SolanaRpcTransaction | null>("getTransaction", [
        signature,
        {
          commitment: this.commitment,
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0
        }
      ]);
      if (!transaction) this.diagnostics.unresolvedTransactionCount += 1;
      return transaction;
    } catch {
      this.diagnostics.status = "degraded";
      this.diagnostics.unresolvedTransactionCount += 1;
      return null;
    }
  }

  private async emitTransaction(
    address: string,
    signature: string,
    slot: number,
    transactionIndex: number | undefined,
    transaction: SolanaRpcTransaction,
    onEvent: (event: SolanaChainEvent) => Promise<void> | void,
    matchedAddresses: string[] = [address]
  ): Promise<"emitted" | "duplicate" | "unresolved"> {
    const eventKey = `${signature}:${address}`;
    if (this.seenEventKeys.has(eventKey) || this.inFlightEventKeys.has(eventKey)) {
      this.diagnostics.duplicateSignatureCount += 1;
      return "duplicate";
    }
    this.inFlightEventKeys.add(eventKey);
    if (slot <= 0) this.diagnostics.missingSlotCount += 1;
    try {
      const blockTime = finiteInteger(transaction.blockTime);
      if (blockTime === null) {
        this.diagnostics.unresolvedBlockTimeCount += 1;
        this.diagnostics.unresolvedTransactionCount += 1;
        this.diagnostics.status = "degraded";
        return "unresolved";
      }
      const occurredAt = new Date(blockTime * 1_000).toISOString();
      this.diagnostics.lastProviderLatencyMs = Math.max(
        0,
        this.now().getTime() - blockTime * 1_000
      );
      const event: SolanaChainEvent = {
        address,
        matchedAddresses: [...matchedAddresses],
        signature,
        slot,
        ...(transactionIndex !== undefined ? { transactionIndex } : {}),
        occurredAt,
        observedAt: this.now().toISOString(),
        commitment: this.commitment,
        source: this.provider,
        transaction
      };
      if (!(await this.deliverWithAdmissionRetry(event, onEvent))) return "unresolved";
      await this.saveCursorIfNewer(address, { signature, slot, occurredAt });
      rememberBounded(this.seenEventKeys, eventKey, this.seenEventLimit);
      this.diagnostics.lastEventAt = event.observedAt;
      this.diagnostics.lastEventSlot = slot;
      this.diagnostics.status = "ok";
      return "emitted";
    } catch (error) {
      if (isSolanaEventNotAcceptedError(error)) {
        this.diagnostics.handlerRejectedEventCount =
          (this.diagnostics.handlerRejectedEventCount ?? 0) + 1;
        this.diagnostics.lastHandlerRejectedEventAt = this.now().toISOString();
        this.diagnostics.status = "degraded";
        return "unresolved";
      }
      this.diagnostics.status = "degraded";
      this.diagnostics.unresolvedTransactionCount += 1;
      return "unresolved";
    } finally {
      this.inFlightEventKeys.delete(eventKey);
    }
  }

  private runAddressTask<T>(address: string, task: () => Promise<T>): Promise<T> {
    const previous = this.addressTaskTails.get(address) ?? Promise.resolve();
    const running = previous.catch(() => undefined).then(task);
    const tail = running.then(
      () => undefined,
      () => undefined
    );
    this.addressTaskTails.set(address, tail);
    return running.finally(() => {
      if (this.addressTaskTails.get(address) === tail) {
        this.addressTaskTails.delete(address);
      }
    });
  }

  private async deliverWithAdmissionRetry(
    event: SolanaChainEvent,
    onEvent: (event: SolanaChainEvent) => Promise<void> | void
  ): Promise<boolean> {
    let admissionRejected = false;
    let handlerFailureRecorded = false;
    while (true) {
      try {
        await onEvent(event);
        return true;
      } catch (error) {
        if (isSolanaEventNotAcceptedError(error)) {
          if (!admissionRejected) {
            admissionRejected = true;
            this.diagnostics.handlerRejectedEventCount =
              (this.diagnostics.handlerRejectedEventCount ?? 0) + 1;
            this.diagnostics.lastHandlerRejectedEventAt = this.now().toISOString();
          } else {
            this.diagnostics.handlerAdmissionRetryCount =
              (this.diagnostics.handlerAdmissionRetryCount ?? 0) + 1;
          }
        } else {
          if (!handlerFailureRecorded) {
            handlerFailureRecorded = true;
            this.diagnostics.unresolvedTransactionCount += 1;
          }
        }
        this.diagnostics.status = "degraded";
        if (!(await this.waitForRetryWindow())) return false;
      }
    }
  }

  private waitForRetryWindow(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        this.retryWaiters.delete(finish);
        resolve(!this.stopped);
      };
      this.retryWaiters.add(finish);
      timer = setTimeout(finish, this.handlerRejectionRetryDelayMs);
    });
  }

  private wakeRetryWaiters(): void {
    for (const finish of [...this.retryWaiters]) finish();
  }

  private async saveCursorIfNewer(address: string, cursor: SolanaCursor): Promise<void> {
    const current = await this.options.cursorStore.get(address);
    if (
      !current ||
      cursor.slot > current.slot ||
      (cursor.slot === current.slot && cursor.signature !== current.signature)
    ) {
      await this.options.cursorStore.save(address, cursor);
    }
  }

  private resolveBlockTime(slot: number): Promise<number | null> {
    const cached = this.blockTimeCache.get(slot);
    if (cached) return cached;
    const request = this.rpc<number | null>("getBlockTime", [slot]).catch(() => {
      this.diagnostics.unresolvedBlockTimeCount += 1;
      this.diagnostics.status = "degraded";
      return null;
    });
    this.blockTimeCache.set(slot, request);
    while (this.blockTimeCache.size > this.blockTimeCacheSize) {
      const oldest = this.blockTimeCache.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.blockTimeCache.delete(oldest);
    }
    return request;
  }

  private startHeartbeat(socket: WebSocketLike): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket || !this.socketOpen) return;
      this.heartbeatSentAtMs = Date.now();
      this.diagnostics.lastPingAt = this.now().toISOString();
      if (typeof socket.ping === "function") {
        socket.ping();
      } else {
        const id = this.nextRequestId++;
        this.requests.set(id, { kind: "heartbeat" });
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, method: "getHealth" }));
        this.updateSubscriptionDiagnostics();
      }
      if (this.heartbeatDeadlineTimer) clearTimeout(this.heartbeatDeadlineTimer);
      const sentAt = this.heartbeatSentAtMs;
      this.heartbeatDeadlineTimer = setTimeout(() => {
        if (this.socket !== socket || this.heartbeatSentAtMs !== sentAt) return;
        this.diagnostics.heartbeatTimeoutCount += 1;
        this.diagnostics.status = "degraded";
        this.handleSocketClose(socket, this.socketGeneration);
        try {
          socket.close();
        } catch {
          // Reconnect was already scheduled.
        }
      }, this.heartbeatTimeoutMs);
    }, this.heartbeatIntervalMs);
  }

  private acknowledgeHeartbeat(): void {
    if (this.heartbeatSentAtMs !== null) {
      this.diagnostics.lastPongAt = this.now().toISOString();
    }
    this.heartbeatSentAtMs = null;
    if (this.heartbeatDeadlineTimer) clearTimeout(this.heartbeatDeadlineTimer);
    this.heartbeatDeadlineTimer = null;
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.heartbeatDeadlineTimer) clearTimeout(this.heartbeatDeadlineTimer);
    this.heartbeatTimer = null;
    this.heartbeatDeadlineTimer = null;
    this.heartbeatSentAtMs = null;
  }

  private updateSubscriptionDiagnostics(): void {
    this.diagnostics.activeSubscriptionCount = this.subscriptions.size;
    this.diagnostics.pendingSubscriptionCount = [...this.requests.values()].filter(
      (request) => request.kind === "subscribe"
    ).length;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetchJson<RpcResponse<T>>(this.provider, this.options.rpcUrl, {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method, params },
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {})
    });
    return response.result;
  }
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return value;
}

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

function isSolanaEventNotAcceptedError(error: unknown): boolean {
  return (
    error instanceof SolanaEventNotAcceptedError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "SOLANA_EVENT_NOT_ACCEPTED")
  );
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function webSocketMessageText(message: WebSocketMessage): Promise<string> {
  if (typeof message.data === "string") return message.data;
  if (message.data instanceof ArrayBuffer) return new TextDecoder().decode(message.data);
  return message.data.text();
}

function transactionSignature(transaction: SolanaRpcTransaction): string | undefined {
  const signatures = transaction.transaction?.signatures;
  return Array.isArray(signatures) && typeof signatures[0] === "string" ? signatures[0] : undefined;
}

function matchingSubscribedAddresses(
  transaction: SolanaRpcTransaction,
  subscribedAddresses: string[]
): string[] {
  const available = new Set<string>();
  const message = transaction.transaction?.message as
    { accountKeys?: Array<string | { pubkey?: string }> } | undefined;
  for (const account of message?.accountKeys ?? []) {
    const address = typeof account === "string" ? account : account.pubkey;
    if (address) available.add(address);
  }
  const meta = transaction.meta as
    | {
        loadedAddresses?: { writable?: unknown[]; readonly?: unknown[] };
        preTokenBalances?: Array<{ owner?: unknown }>;
        postTokenBalances?: Array<{ owner?: unknown }>;
      }
    | undefined;
  for (const address of [
    ...(meta?.loadedAddresses?.writable ?? []),
    ...(meta?.loadedAddresses?.readonly ?? [])
  ]) {
    if (typeof address === "string") available.add(address);
  }
  for (const row of [...(meta?.preTokenBalances ?? []), ...(meta?.postTokenBalances ?? [])]) {
    if (typeof row.owner === "string") available.add(row.owner);
  }
  return subscribedAddresses.filter((address) => available.has(address));
}

function transactionLogMessages(transaction: SolanaRpcTransaction): string[] {
  const logs = (transaction.meta as { logMessages?: unknown } | null | undefined)?.logMessages;
  return Array.isArray(logs) ? logs.filter((log): log is string => typeof log === "string") : [];
}

function transactionHasProgramScopedLog(
  transaction: SolanaRpcTransaction,
  programAddress: string,
  expectedLogs: readonly string[]
): boolean {
  const invocationStack: Array<{ programAddress: string; matchedExpectedLog: boolean }> = [];
  const expected = new Set(expectedLogs);

  for (const log of transactionLogMessages(transaction)) {
    const invocation = /^Program (\S+) invoke \[(\d+)\]$/.exec(log);
    if (invocation) {
      const depth = Number(invocation[2]);
      if (!Number.isSafeInteger(depth) || depth !== invocationStack.length + 1) return false;
      invocationStack.push({ programAddress: invocation[1]!, matchedExpectedLog: false });
      continue;
    }

    const completion = /^Program (\S+) (success|failed(?::.*)?)$/.exec(log);
    if (completion) {
      const completedFrame = invocationStack.at(-1);
      if (!completedFrame || completedFrame.programAddress !== completion[1]) return false;
      invocationStack.pop();
      if (
        completedFrame.programAddress === programAddress &&
        completedFrame.matchedExpectedLog &&
        completion[2] === "success"
      ) {
        // Once the target invocation that emitted the exact instruction log has
        // completed successfully, a later unrelated truncated log suffix cannot
        // invalidate that already-proven program context.
        return true;
      }
      continue;
    }

    const activeFrame = invocationStack.at(-1);
    if (activeFrame?.programAddress === programAddress && expected.has(log)) {
      activeFrame.matchedExpectedLog = true;
    }
  }

  // The target invocation never completed successfully after emitting the
  // expected log, so the stream cannot prove a successful discovery instruction.
  return false;
}

function rememberBounded(values: Set<string>, value: string, limit: number): void {
  values.add(value);
  while (values.size > limit) {
    const oldest = values.values().next().value as string | undefined;
    if (oldest === undefined) break;
    values.delete(oldest);
  }
}

function isPublicSolanaEndpoint(url: string): boolean {
  return /api\.(mainnet-beta|devnet|testnet)\.solana\.com/i.test(url);
}
