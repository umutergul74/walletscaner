import { fetchJson } from "./http";
import { createLogsSubscribeRequest } from "./solana-ws";

export interface SolanaCursor {
  signature: string;
  slot: number;
}

export interface SolanaCursorStore {
  get(address: string): Promise<SolanaCursor | undefined>;
  save(address: string, cursor: SolanaCursor): Promise<void>;
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
  transaction: SolanaRpcTransaction;
}

export interface SolanaEventSourceDiagnostics {
  provider: string;
  status: "ok" | "degraded" | "down";
  reconnectCount: number;
  duplicateSignatureCount: number;
  backfillEventCount: number;
  missingSlotCount: number;
  unresolvedTransactionCount: number;
  lastProviderLatencyMs: number | null;
  websocketMessageCount?: number;
  websocketMessageBytes?: number;
  seenSignatureCount?: number;
  seenSignatureLimit?: number;
  inFlightSignatureCount?: number;
  queuedSignatureCount?: number;
  activeTransactionWorkerCount?: number;
  maxConcurrentTransactionFetches?: number;
  maxQueuedSignatures?: number;
  droppedSignatureCount?: number;
  queuePressureCount?: number;
  queuePressureAddressCount?: number;
  queueHighWatermark?: number;
  transactionRequestCount?: number;
  transactionRetryCount?: number;
  recoveredTransactionCount?: number;
  pendingSubscriptionRequestCount?: number;
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

export interface StandardSolanaEventSourceOptions {
  rpcUrl: string;
  wsUrl: string;
  addresses: string[];
  cursorStore: SolanaCursorStore;
  logIncludesByAddress?: Record<string, string[]>;
  provider?: string;
  commitment?: "processed" | "confirmed" | "finalized";
  fetchImpl?: typeof fetch;
  webSocketFactory?: WebSocketFactory;
  reconnectDelayMs?: number;
  initialBackfillLimit?: number;
  backfillPageLimit?: number;
  maxBackfillPages?: number;
  minTransactionRequestIntervalMs?: number;
  transactionFetchDelayMs?: number;
  transactionFetchMaxAttempts?: number;
  transactionFetchRetryDelayMs?: number;
  transactionFetchRetryMaxDelayMs?: number;
  maxConcurrentTransactionFetches?: number;
  maxQueuedSignatures?: number;
  seenSignatureLimit?: number;
  queuePressureRatio?: number;
  onQueuePressure?: (pressure: {
    address: string;
    reason: "high-water" | "full";
    queuedSignatures: number;
    maxQueuedSignatures: number;
  }) => void;
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
}

export class StandardSolanaEventSource implements SolanaEventSource {
  private readonly provider: string;
  private readonly commitment: "processed" | "confirmed" | "finalized";
  private readonly reconnectDelayMs: number;
  private readonly initialBackfillLimit: number;
  private readonly backfillPageLimit: number;
  private readonly maxBackfillPages: number;
  private readonly minTransactionRequestIntervalMs: number;
  private readonly transactionFetchDelayMs: number;
  private readonly transactionFetchMaxAttempts: number;
  private readonly transactionFetchRetryDelayMs: number;
  private readonly transactionFetchRetryMaxDelayMs: number;
  private readonly maxConcurrentTransactionFetches: number;
  private readonly maxQueuedSignatures: number;
  private readonly seenSignatureLimit: number;
  private readonly queuePressureThreshold: number;
  private readonly now: () => Date;
  private readonly socketFactory: WebSocketFactory;
  private readonly seenSignatures = new Set<string>();
  private readonly inFlightSignatures = new Set<string>();
  private readonly queuedSignatures = new Set<string>();
  private readonly liveSignatureQueue: QueuedLiveSignature[] = [];
  private readonly requestAddress = new Map<number, string>();
  private readonly subscriptionAddress = new Map<number, string>();
  private readonly subscriptionByAddress = new Map<string, number>();
  private readonly addressLogIncludes = new Map<string, string[]>();
  private readonly backfillAddresses = new Set<string>();
  private readonly queuePressureByAddress = new Map<string, "high-water" | "full">();
  private nextRequestId = 1;
  private socket: WebSocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private transactionRequestGate: Promise<void> = Promise.resolve();
  private lastTransactionRequestAtMs = 0;
  private activeTransactionWorkers = 0;
  private stopped = true;
  private handler: ((event: SolanaChainEvent) => Promise<void> | void) | null = null;
  private diagnostics: SolanaEventSourceDiagnostics;

  constructor(private readonly options: StandardSolanaEventSourceOptions) {
    this.provider = options.provider ?? "solana-rpc";
    this.commitment = options.commitment ?? "confirmed";
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
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
    this.maxConcurrentTransactionFetches = positiveInteger(
      options.maxConcurrentTransactionFetches ?? 128,
      "maxConcurrentTransactionFetches"
    );
    this.maxQueuedSignatures = positiveInteger(
      options.maxQueuedSignatures ?? 2_000,
      "maxQueuedSignatures"
    );
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
      reconnectCount: 0,
      duplicateSignatureCount: 0,
      backfillEventCount: 0,
      missingSlotCount: 0,
      unresolvedTransactionCount: 0,
      lastProviderLatencyMs: null,
      websocketMessageCount: 0,
      websocketMessageBytes: 0,
      transactionRequestCount: 0,
      transactionRetryCount: 0,
      recoveredTransactionCount: 0,
      droppedSignatureCount: 0,
      queuePressureCount: 0,
      queueHighWatermark: 0
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.liveSignatureQueue.length = 0;
    this.queuedSignatures.clear();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  async subscribeAddress(
    address: string,
    logIncludes: string[] = [],
    backfill = false
  ): Promise<void> {
    this.addressLogIncludes.set(address, logIncludes);
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
    this.backfillAddresses.delete(address);
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

  async backfill(
    address: string,
    onEvent: (event: SolanaChainEvent) => Promise<void> | void
  ): Promise<number> {
    const cursor = await this.options.cursorStore.get(address);
    const signatures: SignatureInfo[] = [];
    let before: string | undefined;

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
      if (pageItems.length < pageLimit || !cursor) break;
      before = pageItems[pageItems.length - 1]?.signature;
      if (!before) break;
    }

    let emitted = 0;
    for (const item of signatures.reverse()) {
      if (await this.processSignature(address, item.signature, item.slot, onEvent)) {
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
      seenSignatureCount: this.seenSignatures.size,
      seenSignatureLimit: this.seenSignatureLimit,
      inFlightSignatureCount: this.inFlightSignatures.size,
      queuedSignatureCount: this.liveSignatureQueue.length,
      activeTransactionWorkerCount: this.activeTransactionWorkers,
      maxConcurrentTransactionFetches: this.maxConcurrentTransactionFetches,
      maxQueuedSignatures: this.maxQueuedSignatures,
      pendingSubscriptionRequestCount: this.requestAddress.size,
      queuePressureAddressCount: this.queuePressureByAddress.size
    };
  }

  private connect() {
    if (this.stopped) return;
    let socket: WebSocketLike;
    try {
      socket = this.socketFactory(this.options.wsUrl);
    } catch {
      this.diagnostics.status = "down";
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.diagnostics.status = "ok";
      this.requestAddress.clear();
      this.subscriptionAddress.clear();
      this.subscriptionByAddress.clear();
      this.nextRequestId = 1;
      for (const address of this.addressLogIncludes.keys()) {
        this.sendSubscribeRequest(socket, address);
      }
      if (this.handler) {
        for (const address of this.backfillAddresses) {
          void this.backfill(address, this.handler).catch(() => {
            this.diagnostics.status = "degraded";
          });
        }
      }
    };
    socket.onmessage = (message) => {
      void this.handleSocketMessage(message);
    };
    socket.onerror = () => {
      this.diagnostics.status = "degraded";
    };
    socket.onclose = () => {
      if (this.stopped) return;
      this.diagnostics.reconnectCount += 1;
      this.diagnostics.status = "degraded";
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelayMs);
  }

  private async handleSocketMessage(message: WebSocketMessage): Promise<void> {
    const text =
      typeof message.data === "string"
        ? message.data
        : message.data instanceof ArrayBuffer
          ? new TextDecoder().decode(message.data)
          : await message.data.text();
    this.diagnostics.websocketMessageCount = (this.diagnostics.websocketMessageCount ?? 0) + 1;
    this.diagnostics.websocketMessageBytes =
      (this.diagnostics.websocketMessageBytes ?? 0) + Buffer.byteLength(text);
    const payload = JSON.parse(text) as LogsNotification & SubscriptionResponse;

    if (payload.id !== undefined && payload.result !== undefined) {
      const address = this.requestAddress.get(payload.id);
      this.requestAddress.delete(payload.id);
      if (address && this.addressLogIncludes.has(address)) {
        this.subscriptionAddress.set(payload.result, address);
        this.subscriptionByAddress.set(address, payload.result);
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
    this.enqueueLiveSignature(address, signature, slot, this.handler);
  }

  private enqueueLiveSignature(
    address: string,
    signature: string,
    slot: number,
    onEvent: (event: SolanaChainEvent) => Promise<void> | void
  ): void {
    if (
      this.seenSignatures.has(signature) ||
      this.inFlightSignatures.has(signature) ||
      this.queuedSignatures.has(signature)
    ) {
      this.diagnostics.duplicateSignatureCount += 1;
      return;
    }
    if (this.liveSignatureQueue.length >= this.maxQueuedSignatures) {
      this.diagnostics.droppedSignatureCount = (this.diagnostics.droppedSignatureCount ?? 0) + 1;
      this.diagnostics.status = "degraded";
      this.notifyQueuePressure(address, "full");
      return;
    }
    this.queuedSignatures.add(signature);
    this.liveSignatureQueue.push({ address, signature, slot });
    this.diagnostics.queueHighWatermark = Math.max(
      this.diagnostics.queueHighWatermark ?? 0,
      this.liveSignatureQueue.length
    );
    if (this.liveSignatureQueue.length >= this.queuePressureThreshold) {
      this.notifyQueuePressure(address, "high-water");
    }
    this.drainLiveSignatureQueue(onEvent);
  }

  private drainLiveSignatureQueue(
    onEvent: (event: SolanaChainEvent) => Promise<void> | void
  ): void {
    while (
      !this.stopped &&
      this.activeTransactionWorkers < this.maxConcurrentTransactionFetches &&
      this.liveSignatureQueue.length > 0
    ) {
      const next = this.liveSignatureQueue.shift();
      if (!next) return;
      if (this.liveSignatureQueue.length <= Math.floor(this.queuePressureThreshold / 2)) {
        this.queuePressureByAddress.clear();
      }
      this.queuedSignatures.delete(next.signature);
      this.activeTransactionWorkers += 1;
      void this.processSignature(next.address, next.signature, next.slot, onEvent).finally(() => {
        this.activeTransactionWorkers -= 1;
        this.drainLiveSignatureQueue(onEvent);
      });
    }
  }

  private notifyQueuePressure(address: string, reason: "high-water" | "full"): void {
    const previous = this.queuePressureByAddress.get(address);
    if (previous === "full" || previous === reason) return;
    this.queuePressureByAddress.set(address, reason);
    this.diagnostics.queuePressureCount = (this.diagnostics.queuePressureCount ?? 0) + 1;
    try {
      this.options.onQueuePressure?.({
        address,
        reason,
        queuedSignatures: this.liveSignatureQueue.length,
        maxQueuedSignatures: this.maxQueuedSignatures
      });
    } catch {
      this.diagnostics.status = "degraded";
    }
  }

  private async processSignature(
    address: string,
    signature: string,
    slot: number,
    onEvent: (event: SolanaChainEvent) => Promise<void> | void
  ): Promise<boolean> {
    if (this.seenSignatures.has(signature) || this.inFlightSignatures.has(signature)) {
      this.diagnostics.duplicateSignatureCount += 1;
      return false;
    }
    this.inFlightSignatures.add(signature);
    if (slot <= 0) this.diagnostics.missingSlotCount += 1;

    try {
      if (this.transactionFetchDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.transactionFetchDelayMs));
      }
      let transaction: SolanaRpcTransaction | null = null;
      for (let attempt = 1; attempt <= this.transactionFetchMaxAttempts; attempt += 1) {
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
        try {
          transaction = await this.rpc<SolanaRpcTransaction | null>("getTransaction", [
            signature,
            {
              commitment: this.commitment,
              encoding: "jsonParsed",
              maxSupportedTransactionVersion: 0
            }
          ]);
        } catch {
          transaction = null;
        }
        if (transaction) {
          if (attempt > 1) {
            this.diagnostics.recoveredTransactionCount =
              (this.diagnostics.recoveredTransactionCount ?? 0) + 1;
          }
          break;
        }
      }
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
      this.diagnostics.lastProviderLatencyMs = Math.max(
        0,
        this.now().getTime() - blockTime * 1_000
      );
      this.diagnostics.status = "ok";
      const occurredAt = new Date(blockTime * 1_000).toISOString();
      const event = {
        address,
        signature,
        slot,
        occurredAt,
        observedAt: this.now().toISOString(),
        commitment: this.commitment,
        source: this.provider,
        transaction
      };
      await onEvent(event);
      await this.options.cursorStore.save(address, { signature, slot });
      rememberBounded(this.seenSignatures, signature, this.seenSignatureLimit);
      return true;
    } catch {
      this.diagnostics.status = "degraded";
      this.diagnostics.unresolvedTransactionCount += 1;
      return false;
    } finally {
      this.inFlightSignatures.delete(signature);
    }
  }

  private sendSubscribeRequest(socket: WebSocketLike, address: string): void {
    const id = this.nextRequestId++;
    this.requestAddress.set(id, address);
    socket.send(JSON.stringify(createLogsSubscribeRequest(id, address, this.commitment)));
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const response = await fetchJson<RpcResponse<T>>(this.provider, this.options.rpcUrl, {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: 1,
        method,
        params
      },
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
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly socketFactory: WebSocketFactory;
  private readonly addressLogIncludes = new Map<string, string[]>();
  private readonly backfillAddresses = new Set<string>();
  private readonly backfillQueue: string[] = [];
  private readonly queuedBackfillAddresses = new Set<string>();
  private readonly subscriptions = new Map<number, HeliusSubscriptionGroup>();
  private readonly requests = new Map<number, HeliusRequestContext>();
  private readonly seenEventKeys = new Set<string>();
  private readonly inFlightEventKeys = new Set<string>();
  private readonly blockTimeCache = new Map<number, Promise<number | null>>();
  private socket: WebSocketLike | null = null;
  private socketOpen = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatSentAtMs: number | null = null;
  private reconnectAttempt = 0;
  private generation = 0;
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
      missingSlotCount: 0,
      unresolvedTransactionCount: 0,
      lastProviderLatencyMs: null,
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
    this.diagnostics.subscribedAddressCount = this.addressLogIncludes.size;
    this.scheduleSubscriptionRefresh();
  }

  async backfill(
    address: string,
    onEvent: (event: SolanaChainEvent) => Promise<void> | void
  ): Promise<number> {
    const cursor = await this.options.cursorStore.get(address);
    const signatures: SignatureInfo[] = [];
    let before: string | undefined;

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
      if (pageItems.length < pageLimit || !cursor) break;
      before = pageItems[pageItems.length - 1]?.signature;
      if (!before) break;
    }

    let emitted = 0;
    for (const item of signatures.reverse()) {
      const transaction = await this.fetchBackfillTransaction(item.signature);
      if (!transaction) break;
      const outcome = await this.emitTransaction(
        address,
        item.signature,
        item.slot,
        undefined,
        transaction,
        onEvent
      );
      if (outcome === "emitted") emitted += 1;
      if (outcome === "unresolved") break;
    }
    this.diagnostics.backfillEventCount += emitted;
    return emitted;
  }

  getDiagnostics(): HeliusTransactionEventSourceDiagnostics {
    return { ...this.diagnostics };
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
    this.socket = socket;
    this.socketOpen = false;
    socket.onopen = () => this.handleSocketOpen(socket);
    socket.onmessage = (message) => {
      void this.handleSocketMessage(socket, message);
    };
    socket.onerror = () => {
      this.diagnostics.status = "degraded";
      this.handleSocketClose(socket);
      try {
        socket.close();
      } catch {
        // The reconnect path is already scheduled.
      }
    };
    socket.onclose = () => this.handleSocketClose(socket);
    const acknowledgePong = () => this.acknowledgeHeartbeat();
    if (typeof socket.on === "function") socket.on("pong", acknowledgePong);
    else socket.onpong = acknowledgePong;
  }

  private handleSocketOpen(socket: WebSocketLike): void {
    if (this.socket !== socket || this.stopped) return;
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

  private handleSocketClose(socket: WebSocketLike): void {
    if (this.socket !== socket) return;
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
    message: WebSocketMessage
  ): Promise<void> {
    if (this.socket !== socket) return;
    this.diagnostics.lastMessageAt = this.now().toISOString();
    this.acknowledgeHeartbeat();
    let payload: HeliusTransactionNotification;
    try {
      payload = JSON.parse(await webSocketMessageText(message)) as HeliusTransactionNotification;
    } catch {
      this.diagnostics.status = "degraded";
      return;
    }

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

    const blockTime =
      finiteInteger(result.blockTime) ??
      finiteInteger(result.transaction.blockTime) ??
      (slot > 0 ? await this.resolveBlockTime(slot) : null);
    const transaction: SolanaRpcTransaction = {
      ...result.transaction,
      ...(blockTime !== null ? { blockTime } : {})
    };
    for (const address of matchedAddresses) {
      const includes = this.addressLogIncludes.get(address) ?? [];
      const logs = transactionLogMessages(transaction);
      if (includes.length && !logs.some((log) => includes.includes(log))) continue;
      await this.emitTransaction(
        address,
        signature,
        slot,
        transactionIndex,
        transaction,
        this.handler,
        matchedAddresses
      );
    }
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
      await onEvent(event);
      await this.saveCursorIfNewer(address, { signature, slot });
      rememberBounded(this.seenEventKeys, eventKey, this.seenEventLimit);
      this.diagnostics.lastEventAt = event.observedAt;
      this.diagnostics.lastEventSlot = slot;
      this.diagnostics.status = "ok";
      return "emitted";
    } catch {
      this.diagnostics.status = "degraded";
      this.diagnostics.unresolvedTransactionCount += 1;
      return "unresolved";
    } finally {
      this.inFlightEventKeys.delete(eventKey);
    }
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
        this.handleSocketClose(socket);
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
