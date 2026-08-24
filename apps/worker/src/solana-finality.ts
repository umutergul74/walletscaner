import type {
  CanonicalRepository,
  SolanaFinalityBatchResult,
  SolanaFinalityResult,
  SolanaFinalityWorkItem
} from "@memecoin-alpha/db";

type FinalityRepository = Pick<
  CanonicalRepository,
  | "listPendingSolanaFinalities"
  | "reconcileTerminalSolanaFinalityEvents"
  | "recordSolanaFinalities"
>;

interface SignatureStatus {
  slot?: number;
  confirmations?: number | null;
  err?: unknown;
  confirmationStatus?: "processed" | "confirmed" | "finalized";
}

interface SignatureStatusesResult {
  context?: { slot?: number };
  value: Array<SignatureStatus | null>;
}

interface RpcEnvelope<T> {
  result?: T;
  error?: { code?: number; message?: string };
}

export interface SolanaFinalityDiagnostics {
  cycleCount: number;
  errorCount: number;
  checkedSignatureCount: number;
  finalizedSignatureCount: number;
  failedSignatureCount: number;
  unresolvedSignatureCount: number;
  pendingSignatureCount: number;
  terminalFinalizedEventCount: number;
  terminalRolledBackEventCount: number;
  finalizedEventCount: number;
  rolledBackEventCount: number;
  lastDurationMs: number;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export interface SolanaFinalityCycleOptions {
  repository: FinalityRepository;
  rpcUrl: string;
  batchSize?: number;
  minimumAgeSeconds?: number;
  unresolvedAfterSeconds?: number;
  minimumRootDistanceSlots?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export function createSolanaFinalityDiagnostics(): SolanaFinalityDiagnostics {
  return {
    cycleCount: 0,
    errorCount: 0,
    checkedSignatureCount: 0,
    finalizedSignatureCount: 0,
    failedSignatureCount: 0,
    unresolvedSignatureCount: 0,
    pendingSignatureCount: 0,
    terminalFinalizedEventCount: 0,
    terminalRolledBackEventCount: 0,
    finalizedEventCount: 0,
    rolledBackEventCount: 0,
    lastDurationMs: 0,
    lastCheckedAt: null,
    lastError: null
  };
}

export async function reconcileSolanaFinalityCycle(
  options: SolanaFinalityCycleOptions,
  diagnostics: SolanaFinalityDiagnostics = createSolanaFinalityDiagnostics()
): Promise<SolanaFinalityBatchResult> {
  const startedAt = Date.now();
  const now = options.now?.() ?? new Date();
  const batchSize = boundedInteger(options.batchSize ?? 256, 1, 256);
  const minimumAgeSeconds = boundedInteger(options.minimumAgeSeconds ?? 8, 1, 120);
  const unresolvedAfterSeconds = boundedInteger(
    options.unresolvedAfterSeconds ?? 300,
    minimumAgeSeconds,
    3_600
  );
  const minimumRootDistanceSlots = boundedInteger(
    options.minimumRootDistanceSlots ?? 150,
    32,
    10_000
  );
  const timeoutMs = boundedInteger(options.requestTimeoutMs ?? 4_000, 500, 30_000);
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const terminal = await options.repository.reconcileTerminalSolanaFinalityEvents(batchSize);
    diagnostics.terminalFinalizedEventCount += terminal.finalizedEvents;
    diagnostics.terminalRolledBackEventCount += terminal.rolledBackEvents;
    diagnostics.finalizedEventCount += terminal.finalizedEvents;
    diagnostics.rolledBackEventCount += terminal.rolledBackEvents;
    const work = await options.repository.listPendingSolanaFinalities(
      batchSize,
      minimumAgeSeconds
    );
    if (work.length === 0) {
      diagnostics.cycleCount += 1;
      diagnostics.lastDurationMs = Date.now() - startedAt;
      diagnostics.lastCheckedAt = now.toISOString();
      diagnostics.lastError = null;
      return terminal;
    }

    const statusResponse = await rpc<SignatureStatusesResult>(
      fetchImpl,
      options.rpcUrl,
      "getSignatureStatuses",
      [
        work.map((item) => item.signature),
        { searchTransactionHistory: true }
      ],
      timeoutMs
    );
    const statuses = statusResponse.value;
    if (!Array.isArray(statuses) || statuses.length !== work.length) {
      throw new Error("Solana finality response length did not match the requested batch.");
    }
    const needsRoot = work.some(
      (item, index) =>
        !statuses[index] && ageSeconds(item, now) >= unresolvedAfterSeconds
    );
    const rootSlot = needsRoot
      ? await rpc<number>(
          fetchImpl,
          options.rpcUrl,
          "getSlot",
          [{ commitment: "finalized" }],
          timeoutMs
        )
      : undefined;
    const results = work.map((item, index) => ({
      signature: item.signature,
      result: classifyFinality(
        item,
        statuses[index] ?? null,
        now,
        rootSlot,
        unresolvedAfterSeconds,
        minimumRootDistanceSlots
      )
    }));
    const persisted = await options.repository.recordSolanaFinalities(results);
    diagnostics.cycleCount += 1;
    diagnostics.checkedSignatureCount += persisted.checkedSignatures;
    diagnostics.finalizedSignatureCount += results.filter(
      ({ result }) => result.status === "finalized"
    ).length;
    diagnostics.failedSignatureCount += results.filter(
      ({ result }) => result.status === "failed"
    ).length;
    diagnostics.unresolvedSignatureCount += results.filter(
      ({ result }) => result.status === "unresolved"
    ).length;
    diagnostics.pendingSignatureCount += results.filter(
      ({ result }) => result.status === "pending"
    ).length;
    diagnostics.finalizedEventCount += persisted.finalizedEvents;
    diagnostics.rolledBackEventCount += persisted.rolledBackEvents;
    diagnostics.lastDurationMs = Date.now() - startedAt;
    diagnostics.lastCheckedAt = now.toISOString();
    diagnostics.lastError = null;
    return {
      checkedSignatures: persisted.checkedSignatures,
      finalizedEvents: terminal.finalizedEvents + persisted.finalizedEvents,
      rolledBackEvents: terminal.rolledBackEvents + persisted.rolledBackEvents
    };
  } catch (error) {
    diagnostics.cycleCount += 1;
    diagnostics.errorCount += 1;
    diagnostics.lastDurationMs = Date.now() - startedAt;
    diagnostics.lastCheckedAt = now.toISOString();
    diagnostics.lastError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

function classifyFinality(
  item: SolanaFinalityWorkItem,
  status: SignatureStatus | null,
  checkedAt: Date,
  rootSlot: number | undefined,
  unresolvedAfterSeconds: number,
  minimumRootDistanceSlots: number
): SolanaFinalityResult {
  if (status?.err !== undefined && status.err !== null) {
    return {
      status: "failed",
      checkedAt: checkedAt.toISOString(),
      ...(status.confirmationStatus ? { confirmationStatus: status.confirmationStatus } : {}),
      ...(rootSlot !== undefined ? { rootSlot } : {}),
      error: `Solana transaction failed: ${compactError(status.err)}`
    };
  }
  if (status?.confirmationStatus === "finalized") {
    return {
      status: "finalized",
      checkedAt: checkedAt.toISOString(),
      confirmationStatus: "finalized",
      ...(rootSlot !== undefined ? { rootSlot } : {})
    };
  }
  if (
    !status &&
    rootSlot !== undefined &&
    ageSeconds(item, checkedAt) >= unresolvedAfterSeconds &&
    rootSlot - item.slot >= minimumRootDistanceSlots
  ) {
    return {
      status: "unresolved",
      checkedAt: checkedAt.toISOString(),
      rootSlot,
      error: "Signature remained absent after the finalized root passed the bounded safety window."
    };
  }
  return {
    status: "pending",
    checkedAt: checkedAt.toISOString(),
    ...(status?.confirmationStatus ? { confirmationStatus: status.confirmationStatus } : {}),
    ...(rootSlot !== undefined ? { rootSlot } : {})
  };
}

function ageSeconds(item: SolanaFinalityWorkItem, now: Date): number {
  return Math.max(0, (now.getTime() - Date.parse(item.firstSeenAt)) / 1_000);
}

function compactError(error: unknown): string {
  const serialized = typeof error === "string" ? error : JSON.stringify(error);
  return (serialized || "unknown error").slice(0, 500);
}

async function rpc<T>(
  fetchImpl: typeof fetch,
  rpcUrl: string,
  method: string,
  params: unknown[],
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Solana finality RPC returned HTTP ${response.status}.`);
    const payload = (await response.json()) as RpcEnvelope<T>;
    if (payload.error) {
      throw new Error(
        `Solana finality RPC ${payload.error.code ?? "error"}: ${payload.error.message ?? "unknown"}`
      );
    }
    if (payload.result === undefined) {
      throw new Error("Solana finality RPC response omitted result.");
    }
    return payload.result;
  } finally {
    clearTimeout(timeout);
  }
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  const parsed = Math.trunc(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : minimum;
}
