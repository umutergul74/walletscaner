import { type NormalizedEvent, nowIso } from "@memecoin-alpha/shared";
import { fetchJson } from "./http";

export interface HeliusEnhancedTransaction {
  description?: string;
  type?: string;
  source?: string;
  fee?: number;
  feePayer?: string;
  signature?: string;
  slot?: number;
  timestamp?: number;
  tokenTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    fromTokenAccount?: string;
    toTokenAccount?: string;
    tokenAmount?: number;
    rawTokenAmount?: {
      tokenAmount?: string;
      decimals?: number;
    };
    mint?: string;
  }>;
  nativeTransfers?: Array<{
    fromUserAccount?: string;
    toUserAccount?: string;
    amount?: number;
  }>;
  accountData?: Array<Record<string, unknown>>;
  instructions?: Array<Record<string, unknown>>;
  events?: {
    swap?: HeliusSwapEvent;
  };
  transactionError?: Record<string, unknown>;
}

export interface HeliusSwapTokenLeg {
  userAccount?: string;
  tokenAccount?: string;
  mint?: string;
  tokenAmount?: number;
  rawTokenAmount?: {
    tokenAmount?: string;
    decimals?: number;
  };
}

export interface HeliusSwapNativeLeg {
  account?: string;
  amount?: string | number;
}

export interface HeliusSwapInnerSwap {
  tokenInputs?: HeliusSwapTokenLeg[];
  tokenOutputs?: HeliusSwapTokenLeg[];
  nativeInputs?: HeliusSwapNativeLeg[];
  nativeOutputs?: HeliusSwapNativeLeg[];
  programInfo?: Record<string, unknown>;
}

export interface HeliusSwapEvent {
  nativeInput?: HeliusSwapNativeLeg;
  nativeOutput?: HeliusSwapNativeLeg;
  tokenInputs?: HeliusSwapTokenLeg[];
  tokenOutputs?: HeliusSwapTokenLeg[];
  innerSwaps?: HeliusSwapInnerSwap[];
}

export interface HeliusAddressTransactionOptions {
  beforeSignature?: string;
  afterSignature?: string;
  commitment?: "confirmed" | "finalized";
  tokenAccounts?: "none" | "balanceChanged" | "all";
  sortOrder?: "asc" | "desc";
  gteTime?: number;
  lteTime?: number;
  type?: string;
  source?: string;
  limit?: number;
}

export interface HeliusAsset {
  id?: string;
  interface?: string;
  content?: {
    metadata?: {
      name?: string;
      symbol?: string;
      description?: string;
    };
    json_uri?: string;
    links?: Record<string, unknown>;
  };
  authorities?: Array<{
    address?: string;
    scopes?: string[];
  }>;
  creators?: Array<{
    address?: string;
    share?: number;
    verified?: boolean;
  }>;
  mutable?: boolean;
  burnt?: boolean;
  token_info?: {
    symbol?: string;
    supply?: number | string;
    decimals?: number;
    token_program?: string;
    mint_authority?: string | null;
    freeze_authority?: string | null;
    price_info?: {
      price_per_token?: number;
      currency?: string;
    };
  };
  [key: string]: unknown;
}

interface HeliusJsonRpcResponse<T> {
  result?: T;
  error?: {
    code?: number;
    message?: string;
  };
}

export class HeliusEnhancedClient {
  constructor(
    private readonly apiKey: string,
    private readonly endpoint = "https://mainnet.helius-rpc.com",
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async getTransactions(
    signatures: string[],
    commitment: "confirmed" | "finalized" = "finalized"
  ): Promise<HeliusEnhancedTransaction[]> {
    if (signatures.length > 100) {
      throw new Error("Helius enhanced transactions accepts at most 100 signatures per request.");
    }

    return fetchJson<HeliusEnhancedTransaction[]>(
      "helius",
      `${this.endpoint}/v0/transactions?api-key=${this.apiKey}&commitment=${commitment}`,
      {
        method: "POST",
        body: { transactions: signatures },
        fetchImpl: this.fetchImpl,
        retries: 2
      }
    );
  }

  async getTransactionsByAddress(
    address: string,
    options: HeliusAddressTransactionOptions = {}
  ): Promise<HeliusEnhancedTransaction[]> {
    const url = new URL(`${this.endpoint}/v0/addresses/${address}/transactions`);
    url.searchParams.set("api-key", this.apiKey);
    url.searchParams.set("commitment", options.commitment ?? "finalized");
    if (options.beforeSignature) {
      url.searchParams.set("before-signature", options.beforeSignature);
    }
    if (options.afterSignature) {
      url.searchParams.set("after-signature", options.afterSignature);
    }
    if (options.tokenAccounts) {
      url.searchParams.set("token-accounts", options.tokenAccounts);
    }
    if (options.sortOrder) url.searchParams.set("sort-order", options.sortOrder);
    if (options.gteTime !== undefined) url.searchParams.set("gte-time", String(options.gteTime));
    if (options.lteTime !== undefined) url.searchParams.set("lte-time", String(options.lteTime));
    if (options.type) url.searchParams.set("type", options.type);
    if (options.source) url.searchParams.set("source", options.source);
    if (options.limit !== undefined) url.searchParams.set("limit", String(options.limit));

    return fetchJson<HeliusEnhancedTransaction[]>("helius", url.toString(), {
      fetchImpl: this.fetchImpl,
      retries: 3,
      timeoutMs: 20_000
    });
  }

  async getAssetBatch(ids: string[]): Promise<HeliusAsset[]> {
    if (ids.length === 0) return [];
    if (ids.length > 1_000) {
      throw new Error("Helius getAssetBatch accepts at most 1,000 asset IDs per request.");
    }

    const response = await fetchJson<HeliusJsonRpcResponse<HeliusAsset[]>>(
      "helius",
      `${this.endpoint}/?api-key=${this.apiKey}`,
      {
        method: "POST",
        body: {
          jsonrpc: "2.0",
          id: "memecoin-alpha-asset-batch",
          method: "getAssetBatch",
          params: {
            ids
          }
        },
        fetchImpl: this.fetchImpl,
        retries: 3,
        timeoutMs: 30_000
      }
    );
    if (response.error) {
      throw new Error(
        `Helius getAssetBatch failed (${response.error.code ?? "unknown"}): ${
          response.error.message ?? "unknown error"
        }`
      );
    }
    return response.result ?? [];
  }
}

export interface HeliusEnhancedTransactionBatcherOptions {
  maxBatchSize?: number;
  flushIntervalMs?: number;
  commitment?: "confirmed" | "finalized";
  recentResultLimit?: number;
}

export interface HeliusEnhancedTransactionBatcherDiagnostics {
  queuedSignatureCount: number;
  inFlightSignatureCount: number;
  batchRequestCount: number;
  resolvedTransactionCount: number;
  unresolvedSignatureCount: number;
  duplicateSignatureCount: number;
  failedBatchCount: number;
  lastBatchSize: number;
}

interface HeliusTransactionBatchClient {
  getTransactions(
    signatures: string[],
    commitment?: "confirmed" | "finalized"
  ): Promise<HeliusEnhancedTransaction[]>;
}

interface DeferredTransaction {
  promise: Promise<HeliusEnhancedTransaction | undefined>;
  resolve: (transaction: HeliusEnhancedTransaction | undefined) => void;
  reject: (error: unknown) => void;
}

/**
 * Briefly buffers discovery signatures and resolves them through Helius'
 * Enhanced Transactions endpoint in idempotent chunks of at most 100.
 */
export class HeliusEnhancedTransactionBatcher {
  private readonly maxBatchSize: number;
  private readonly flushIntervalMs: number;
  private readonly commitment: "confirmed" | "finalized";
  private readonly recentResultLimit: number;
  private readonly queue: string[] = [];
  private readonly pending = new Map<string, DeferredTransaction>();
  private readonly recent = new Map<string, HeliusEnhancedTransaction | undefined>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushChain: Promise<void> = Promise.resolve();
  private stopped = false;
  private diagnostics: HeliusEnhancedTransactionBatcherDiagnostics = {
    queuedSignatureCount: 0,
    inFlightSignatureCount: 0,
    batchRequestCount: 0,
    resolvedTransactionCount: 0,
    unresolvedSignatureCount: 0,
    duplicateSignatureCount: 0,
    failedBatchCount: 0,
    lastBatchSize: 0
  };

  constructor(
    private readonly client: HeliusTransactionBatchClient,
    options: HeliusEnhancedTransactionBatcherOptions = {}
  ) {
    this.maxBatchSize = options.maxBatchSize ?? 100;
    if (!Number.isSafeInteger(this.maxBatchSize) || this.maxBatchSize < 1 || this.maxBatchSize > 100) {
      throw new Error("maxBatchSize must be an integer between 1 and 100.");
    }
    this.flushIntervalMs = options.flushIntervalMs ?? 25;
    if (!Number.isSafeInteger(this.flushIntervalMs) || this.flushIntervalMs < 0) {
      throw new Error("flushIntervalMs must be a non-negative integer.");
    }
    this.commitment = options.commitment ?? "confirmed";
    this.recentResultLimit = options.recentResultLimit ?? 10_000;
    if (!Number.isSafeInteger(this.recentResultLimit) || this.recentResultLimit < 0) {
      throw new Error("recentResultLimit must be a non-negative integer.");
    }
  }

  resolve(signature: string): Promise<HeliusEnhancedTransaction | undefined> {
    const normalized = signature.trim();
    if (!normalized) return Promise.reject(new Error("A non-empty signature is required."));
    if (this.stopped) return Promise.reject(new Error("The Helius transaction batcher is stopped."));
    if (this.recent.has(normalized)) {
      this.diagnostics.duplicateSignatureCount += 1;
      return Promise.resolve(this.recent.get(normalized));
    }
    const existing = this.pending.get(normalized);
    if (existing) {
      this.diagnostics.duplicateSignatureCount += 1;
      return existing.promise;
    }

    let resolve: DeferredTransaction["resolve"] = () => {};
    let reject: DeferredTransaction["reject"] = () => {};
    const promise = new Promise<HeliusEnhancedTransaction | undefined>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    this.pending.set(normalized, { promise, resolve, reject });
    this.queue.push(normalized);
    this.updateQueueDiagnostics();
    if (this.queue.length >= this.maxBatchSize) {
      void this.flush().catch(() => {
        // Individual resolve promises carry the provider error.
      });
    } else {
      this.scheduleFlush();
    }
    return promise;
  }

  async resolveMany(
    signatures: string[]
  ): Promise<Array<HeliusEnhancedTransaction | undefined>> {
    return Promise.all(signatures.map((signature) => this.resolve(signature)));
  }

  flush(): Promise<void> {
    this.clearFlushTimer();
    const run = this.flushChain.then(() => this.drainQueue());
    this.flushChain = run.catch(() => undefined);
    return run;
  }

  async stop(options: { flush?: boolean } = { flush: true }): Promise<void> {
    if (options.flush !== false) await this.flush();
    this.stopped = true;
    this.clearFlushTimer();
    if (this.pending.size > 0) {
      const error = new Error("The Helius transaction batcher stopped before resolving signatures.");
      for (const deferred of this.pending.values()) deferred.reject(error);
      this.pending.clear();
      this.queue.length = 0;
      this.updateQueueDiagnostics();
    }
  }

  getDiagnostics(): HeliusEnhancedTransactionBatcherDiagnostics {
    return { ...this.diagnostics };
  }

  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const signatures = this.queue.splice(0, this.maxBatchSize);
      this.diagnostics.batchRequestCount += 1;
      this.diagnostics.lastBatchSize = signatures.length;
      this.diagnostics.inFlightSignatureCount = signatures.length;
      this.updateQueueDiagnostics();
      try {
        const transactions = await this.client.getTransactions(signatures, this.commitment);
        const bySignature = new Map(
          transactions.flatMap((transaction) =>
            transaction.signature ? [[transaction.signature, transaction] as const] : []
          )
        );
        for (const signature of signatures) {
          const transaction = bySignature.get(signature);
          if (transaction) this.diagnostics.resolvedTransactionCount += 1;
          else this.diagnostics.unresolvedSignatureCount += 1;
          this.rememberRecent(signature, transaction);
          const deferred = this.pending.get(signature);
          this.pending.delete(signature);
          deferred?.resolve(transaction);
        }
      } catch (error) {
        this.diagnostics.failedBatchCount += 1;
        for (const signature of signatures) {
          const deferred = this.pending.get(signature);
          this.pending.delete(signature);
          deferred?.reject(error);
        }
        this.diagnostics.inFlightSignatureCount = 0;
        this.updateQueueDiagnostics();
        throw error;
      }
      this.diagnostics.inFlightSignatureCount = 0;
      this.updateQueueDiagnostics();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.flushIntervalMs === 0) {
      if (this.flushIntervalMs === 0) {
        void this.flush().catch(() => undefined);
      }
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch(() => undefined);
    }, this.flushIntervalMs);
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private rememberRecent(
    signature: string,
    transaction: HeliusEnhancedTransaction | undefined
  ): void {
    if (this.recentResultLimit === 0) return;
    this.recent.set(signature, transaction);
    while (this.recent.size > this.recentResultLimit) {
      const oldest = this.recent.keys().next().value as string | undefined;
      if (!oldest) break;
      this.recent.delete(oldest);
    }
  }

  private updateQueueDiagnostics(): void {
    this.diagnostics.queuedSignatureCount = this.queue.length;
  }
}

export function verifyHeliusWebhookAuth(
  expectedHeader: string | undefined,
  providedHeader: string | undefined
): boolean {
  return Boolean(expectedHeader && providedHeader && providedHeader === expectedHeader);
}

export function normalizeHeliusWebhook(payload: unknown): NormalizedEvent[] {
  const transactions = Array.isArray(payload) ? payload : [payload];

  return transactions
    .filter(isHeliusTransaction)
    .flatMap((transaction) => normalizeHeliusTransaction(transaction));
}

function normalizeHeliusTransaction(transaction: HeliusEnhancedTransaction): NormalizedEvent[] {
  const observedAt = transaction.timestamp
    ? new Date(transaction.timestamp * 1000).toISOString()
    : nowIso();
  const signature = transaction.signature ?? `missing-signature:${observedAt}`;
  const source = transaction.source ?? "helius";
  const events: NormalizedEvent[] = [];

  if (transaction.events?.swap) {
    const tokenAddress = inferPrimaryMint(transaction);
    events.push({
      idempotencyKey: `helius:swap:${signature}`,
      chain: "solana",
      provider: "helius",
      type: "swap",
      signature,
      ...(transaction.slot !== undefined ? { slot: transaction.slot } : {}),
      ...(tokenAddress ? { tokenAddress } : {}),
      observedAt,
      payload: {
        source,
        fee: transaction.fee,
        feePayer: transaction.feePayer,
        swap: transaction.events.swap,
        tokenTransfers: transaction.tokenTransfers ?? [],
        transactionError: transaction.transactionError
      }
    });
  }

  return events;
}

function inferPrimaryMint(transaction: HeliusEnhancedTransaction): string | undefined {
  return transaction.tokenTransfers?.find((transfer) => transfer.mint)?.mint;
}

function isHeliusTransaction(value: unknown): value is HeliusEnhancedTransaction {
  return typeof value === "object" && value !== null;
}
