import { createHash } from "node:crypto";
import type {
  CanonicalRepository,
  IngestionCoverageIncident,
  IngestionCoverageIncidentOpenInput,
  IngestionCoverageIncidentReason
} from "@memecoin-alpha/db";
import {
  fetchJson,
  type SolanaChainEvent,
  type SolanaEventSource,
  type SolanaEventSourceDiagnostics,
  type SolanaGapRepairBoundary,
  type SolanaGapRepairResult
} from "@memecoin-alpha/providers";

type CoverageIncidentRepository = Pick<
  CanonicalRepository,
  | "openIngestionCoverageIncident"
  | "listOpenIngestionCoverageIncidents"
  | "markIngestionCoverageIncidentRestart"
  | "closeIngestionCoverageIncident"
  | "verifyIngestionGapRepairTarget"
>;

export interface DiscoveryProgramSource {
  programId: string;
  source: SolanaEventSource;
  probeLatestActivity?: () => Promise<DiscoveryProgramActivityHead | null>;
  probeSignatureStatus?: (signature: string) => Promise<DiscoverySignatureStatus | null>;
}

export interface DiscoveryProgramActivityHead {
  signature: string;
  slot: number;
  blockTime?: number;
}

export interface DiscoverySignatureStatus {
  slot: number;
  confirmationStatus: "processed" | "confirmed" | "finalized";
  succeeded: boolean;
}

export interface DiscoverySupervisorOptions {
  provider: string;
  programs: DiscoveryProgramSource[];
  repository: CoverageIncidentRepository;
  headLagThresholdSlots?: number;
  rawSilenceThresholdMs?: number;
  restartCooldownMs?: number;
  activityProbeCooldownMs?: number;
  initialLiveNotificationMaxAgeMs?: number;
  repairCooldownMs?: number;
  now?: () => Date;
}

export interface DiscoverySentinelDiagnostics {
  intervalSeconds?: number;
  lastCheckedAt: string | null;
  lastClusterSlot: number | null;
  consecutiveFailureCount: number;
  errorCount: number;
  lastErrorAt: string | null;
  lastError: string | null;
}

export interface DiscoveryProgramDiagnostics {
  programId: string;
  provider: string;
  status: "ok" | "degraded" | "down";
  running: boolean;
  source: SolanaEventSourceDiagnostics;
  clusterSlot: number | null;
  sourceSlot: number | null;
  slotLag: number | null;
  rawSilenceMs: number | null;
  consecutiveBreachSamples: number;
  consecutiveHealthySamples: number;
  breachReasons: IngestionCoverageIncidentReason[];
  openIncidentId: string | null;
  gapStartedAt: string | null;
  lastRestartAt: string | null;
  lastRestartError: string | null;
  sourceGeneration: number;
  freshWebsocketEvidence: boolean;
  activityProbeStatus: "not-configured" | "idle" | "quiet" | "ahead" | "error";
  lastActivityProbeAt: string | null;
  latestProgramActivitySlot: number | null;
  activityProbeErrorCount: number;
  lastActivityProbeError: string | null;
  coverageDisposition: "current_transport_healthy" | "alpha_excluded_unreconciled" | "reconciled";
  lastGapRepairAt: string | null;
  gapRepairStatus: SolanaGapRepairResult["status"] | null;
  gapRepairFetchedSignatureCount: number;
  gapRepairCompletedSignatureCount: number;
  lastGapRepairError: string | null;
}

interface ProgramState {
  programId: string;
  source: SolanaEventSource;
  probeLatestActivity?: () => Promise<DiscoveryProgramActivityHead | null>;
  probeSignatureStatus?: (signature: string) => Promise<DiscoverySignatureStatus | null>;
  running: boolean;
  startedAtMs: number | null;
  consecutiveBreachSamples: number;
  consecutiveHealthySamples: number;
  clusterSlot: number | null;
  sourceSlot: number | null;
  slotLag: number | null;
  rawSilenceMs: number | null;
  breachReasons: IngestionCoverageIncidentReason[];
  incident: IngestionCoverageIncident | null;
  lastRestartAtMs: number | null;
  lastRestartError: string | null;
  initialLiveEventBaseline: number;
  initialLiveEventEvaluated: boolean;
  websocketNotificationBaseline: number;
  observedSubscriptionAckTimeoutCount: number;
  observedBackfillTruncatedCount: number;
  observedQueuePressureCount: number;
  observedDroppedSignatureCount: number;
  queuePressureBreachActive: boolean;
  sourceGeneration: number;
  lastActivityProbeAtMs: number | null;
  latestProgramActivity: DiscoveryProgramActivityHead | null;
  activityProbeStatus: "not-configured" | "idle" | "quiet" | "ahead" | "error";
  activityProbeErrorCount: number;
  consecutiveActivityProbeFailures: number;
  lastActivityProbeError: string | null;
  lastGapRepairAtMs: number | null;
  lastGapRepairResult: SolanaGapRepairResult | null;
}

interface SlotResponse {
  result?: number;
  error?: { code?: number; message?: string };
}

interface SignatureResponse {
  result?: Array<{ signature?: string; slot?: number; blockTime?: number | null }>;
  error?: { code?: number; message?: string };
}

interface SignatureStatusResponse {
  result?: {
    value?: Array<{
      slot?: number;
      err?: unknown;
      confirmationStatus?: string | null;
    } | null>;
  };
  error?: { code?: number; message?: string };
}

export async function fetchConfirmedSolanaSlot(options: {
  rpcUrl: string;
  provider: string;
  timeoutMs: number;
  retries: number;
  fetchImpl?: typeof fetch;
}): Promise<number> {
  const response = await fetchJson<SlotResponse>(options.provider, options.rpcUrl, {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "getSlot",
      params: [{ commitment: "confirmed" }]
    },
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
  });
  if (response.error) {
    throw new Error(
      `Confirmed Solana getSlot RPC error ${response.error.code ?? "unknown"}: ${response.error.message ?? "unknown error"}`
    );
  }
  if (!Number.isSafeInteger(response.result) || (response.result ?? -1) < 0) {
    throw new Error("Confirmed Solana getSlot returned no safe numeric slot.");
  }
  return response.result!;
}

export async function fetchLatestSolanaAddressActivity(options: {
  rpcUrl: string;
  provider: string;
  address: string;
  timeoutMs: number;
  retries: number;
  fetchImpl?: typeof fetch;
}): Promise<DiscoveryProgramActivityHead | null> {
  const response = await fetchJson<SignatureResponse>(options.provider, options.rpcUrl, {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "getSignaturesForAddress",
      params: [options.address, { limit: 1, commitment: "confirmed" }]
    },
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
  });
  if (response.error) {
    throw new Error(
      `Latest Solana program activity RPC error ${response.error.code ?? "unknown"}: ${response.error.message ?? "unknown error"}`
    );
  }
  if (!Array.isArray(response.result)) {
    throw new Error("Latest Solana program activity returned no result array.");
  }
  const latest = response.result?.[0];
  if (!latest) return null;
  if (!latest.signature || !Number.isSafeInteger(latest.slot) || (latest.slot ?? -1) < 0) {
    throw new Error("Latest Solana program activity returned an invalid signature or slot.");
  }
  return {
    signature: latest.signature,
    slot: latest.slot!,
    ...(Number.isSafeInteger(latest.blockTime) && (latest.blockTime ?? -1) >= 0
      ? { blockTime: latest.blockTime! }
      : {})
  };
}

export async function fetchSolanaSignatureStatus(options: {
  rpcUrl: string;
  provider: string;
  signature: string;
  timeoutMs: number;
  retries: number;
  fetchImpl?: typeof fetch;
}): Promise<DiscoverySignatureStatus | null> {
  const response = await fetchJson<SignatureStatusResponse>(options.provider, options.rpcUrl, {
    method: "POST",
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "getSignatureStatuses",
      params: [[options.signature], { searchTransactionHistory: true }]
    },
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
  });
  if (response.error) {
    throw new Error(
      `Solana signature status RPC error ${response.error.code ?? "unknown"}: ${response.error.message ?? "unknown error"}`
    );
  }
  const values = response.result?.value;
  if (!Array.isArray(values) || values.length !== 1) {
    throw new Error("Solana signature status returned an invalid result array.");
  }
  const status = values[0];
  if (!status) return null;
  if (!Number.isSafeInteger(status.slot) || (status.slot ?? -1) < 0) {
    throw new Error("Solana signature status returned an invalid slot.");
  }
  if (!isSignatureConfirmationStatus(status.confirmationStatus)) {
    throw new Error("Solana signature status returned an invalid confirmation status.");
  }
  return {
    slot: status.slot!,
    confirmationStatus: status.confirmationStatus,
    succeeded: status.err === null || status.err === undefined
  };
}

export class DiscoverySupervisor {
  private readonly provider: string;
  private readonly repository: CoverageIncidentRepository;
  private readonly headLagThresholdSlots: number;
  private readonly rawSilenceThresholdMs: number;
  private readonly restartCooldownMs: number;
  private readonly activityProbeCooldownMs: number;
  private readonly initialLiveNotificationMaxAgeMs: number;
  private readonly repairCooldownMs: number;
  private readonly now: () => Date;
  private readonly states: ProgramState[];
  private desiredRunning = false;
  private lifecycleGeneration = 0;
  private handler: ((event: SolanaChainEvent) => Promise<void> | void) | null = null;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private sampleTail: Promise<void> = Promise.resolve();
  private sentinelDiagnostics: DiscoverySentinelDiagnostics = {
    lastCheckedAt: null,
    lastClusterSlot: null,
    consecutiveFailureCount: 0,
    errorCount: 0,
    lastErrorAt: null,
    lastError: null
  };

  constructor(options: DiscoverySupervisorOptions) {
    if (options.programs.length === 0) {
      throw new Error("DiscoverySupervisor requires at least one program source.");
    }
    const uniquePrograms = new Set(options.programs.map((program) => program.programId));
    if (uniquePrograms.size !== options.programs.length) {
      throw new Error("DiscoverySupervisor program ids must be unique.");
    }
    this.provider = options.provider;
    this.repository = options.repository;
    this.headLagThresholdSlots = positiveInteger(
      options.headLagThresholdSlots ?? 150,
      "headLagThresholdSlots"
    );
    this.rawSilenceThresholdMs = positiveInteger(
      options.rawSilenceThresholdMs ?? 120_000,
      "rawSilenceThresholdMs"
    );
    this.restartCooldownMs = positiveInteger(
      options.restartCooldownMs ?? 300_000,
      "restartCooldownMs"
    );
    this.activityProbeCooldownMs = positiveInteger(
      options.activityProbeCooldownMs ?? 120_000,
      "activityProbeCooldownMs"
    );
    this.initialLiveNotificationMaxAgeMs = positiveInteger(
      options.initialLiveNotificationMaxAgeMs ?? 30_000,
      "initialLiveNotificationMaxAgeMs"
    );
    this.repairCooldownMs = positiveInteger(options.repairCooldownMs ?? 30_000, "repairCooldownMs");
    this.now = options.now ?? (() => new Date());
    this.states = options.programs.map(
      ({ programId, source, probeLatestActivity, probeSignatureStatus }) => ({
        programId,
        source,
        ...(probeLatestActivity ? { probeLatestActivity } : {}),
        ...(probeSignatureStatus ? { probeSignatureStatus } : {}),
        running: false,
        startedAtMs: null,
        consecutiveBreachSamples: 0,
        consecutiveHealthySamples: 0,
        clusterSlot: null,
        sourceSlot: null,
        slotLag: null,
        rawSilenceMs: null,
        breachReasons: [],
        incident: null,
        lastRestartAtMs: null,
        lastRestartError: null,
        initialLiveEventBaseline: source.getDiagnostics().liveEventCount ?? 0,
        initialLiveEventEvaluated: false,
        websocketNotificationBaseline: source.getDiagnostics().websocketNotificationCount ?? 0,
        observedSubscriptionAckTimeoutCount:
          source.getDiagnostics().subscriptionAckTimeoutCount ?? 0,
        observedBackfillTruncatedCount: source.getDiagnostics().backfillTruncatedCount ?? 0,
        observedQueuePressureCount: source.getDiagnostics().queuePressureCount ?? 0,
        observedDroppedSignatureCount: source.getDiagnostics().droppedSignatureCount ?? 0,
        queuePressureBreachActive: false,
        sourceGeneration: 0,
        lastActivityProbeAtMs: null,
        latestProgramActivity: null,
        activityProbeStatus: probeLatestActivity ? "idle" : "not-configured",
        activityProbeErrorCount: 0,
        consecutiveActivityProbeFailures: 0,
        lastActivityProbeError: null,
        lastGapRepairAtMs: null,
        lastGapRepairResult: null
      })
    );
  }

  async initialize(): Promise<void> {
    await this.refreshOpenIncidents();
  }

  start(handler: (event: SolanaChainEvent) => Promise<void> | void): Promise<void> {
    if (!this.desiredRunning) this.lifecycleGeneration += 1;
    this.desiredRunning = true;
    this.handler = handler;
    const generation = this.lifecycleGeneration;
    return this.enqueueLifecycle(async () => {
      await this.refreshOpenIncidents(() => this.isLifecycleCurrent(generation));
      if (!this.isLifecycleCurrent(generation)) return;
      for (const state of this.states) {
        if (!this.isLifecycleCurrent(generation) || state.running) continue;
        try {
          await state.source.start(handler);
        } catch (error) {
          if (!this.isLifecycleCurrent(generation)) continue;
          const openedAt = this.now().toISOString();
          const message = error instanceof Error ? error.message : String(error);
          state.lastRestartError = message.slice(0, 300);
          state.breachReasons = ["source_start_failed"];
          if (!state.incident) {
            const idempotencyKey = createHash("sha256")
              .update(
                [
                  "solana-ingestion-coverage",
                  this.provider,
                  state.programId,
                  "source-start-failed",
                  openedAt
                ].join(":")
              )
              .digest("hex");
            state.incident = await this.repository.openIngestionCoverageIncident({
              idempotencyKey,
              chain: "solana",
              provider: this.provider,
              programAddress: state.programId,
              reason: "source_start_failed",
              gapStartedAt: openedAt,
              openedAt,
              subscriptionAckTimeoutCount:
                state.source.getDiagnostics().subscriptionAckTimeoutCount ?? 0,
              successfulSubscriptionAckCount:
                state.source.getDiagnostics().successfulSubscriptionAckCount ?? 0,
              metadata: {
                sourceStartError: state.lastRestartError,
                coverageDisposition: "alpha_excluded_unreconciled"
              }
            });
          }
          continue;
        }
        if (!this.isLifecycleCurrent(generation)) {
          await state.source.stop();
          continue;
        }
        state.running = true;
        this.resetSourceBaselines(state);
      }
    });
  }

  async stop(): Promise<void> {
    // Flip this synchronously so a restart already between stop/start cannot
    // reopen a source after the storage gate or process shutdown has closed it.
    if (this.desiredRunning) this.lifecycleGeneration += 1;
    const generation = this.lifecycleGeneration;
    this.desiredRunning = false;
    const stopped = this.enqueueLifecycle(async () => {
      for (const state of this.states) {
        if (!state.running) continue;
        await state.source.stop();
        state.running = false;
      }
    });
    await stopped;
    // A repository mutation may already have crossed its transaction boundary
    // when stop synchronously fenced the lifecycle. Wait for that sample and
    // rehydrate the authoritative open set so a committed close cannot leave
    // stale in-memory state that blocks the next incident after resume.
    await this.sampleTail;
    await this.refreshOpenIncidents(
      () => !this.desiredRunning && generation === this.lifecycleGeneration
    );
  }

  sampleHead(clusterSlot: number, checkedAt = this.now()): Promise<void> {
    if (!Number.isSafeInteger(clusterSlot) || clusterSlot < 0) {
      return Promise.reject(new Error("Discovery sentinel cluster slot must be a safe integer."));
    }
    const generation = this.lifecycleGeneration;
    const sample = this.sampleTail.then(() =>
      this.applyHeadSample(clusterSlot, checkedAt, generation)
    );
    this.sampleTail = sample.catch(() => undefined);
    return sample;
  }

  recordSentinelFailure(error: unknown, checkedAt = this.now()): void {
    const message = error instanceof Error ? error.message : String(error);
    this.sentinelDiagnostics = {
      ...this.sentinelDiagnostics,
      lastCheckedAt: checkedAt.toISOString(),
      consecutiveFailureCount: this.sentinelDiagnostics.consecutiveFailureCount + 1,
      errorCount: this.sentinelDiagnostics.errorCount + 1,
      lastErrorAt: checkedAt.toISOString(),
      lastError: message.slice(0, 300)
    };
  }

  setSentinelInterval(intervalMs: number): void {
    this.sentinelDiagnostics.intervalSeconds = Math.round(intervalMs / 1_000);
  }

  getSentinelDiagnostics(): DiscoverySentinelDiagnostics {
    return { ...this.sentinelDiagnostics };
  }

  getProgramDiagnostics(): DiscoveryProgramDiagnostics[] {
    return this.states.map((state) => {
      const source = state.source.getDiagnostics();
      const transportDegraded =
        state.incident !== null ||
        state.breachReasons.length > 0 ||
        state.consecutiveActivityProbeFailures > 0 ||
        this.sentinelDiagnostics.consecutiveFailureCount >= 2;
      const websocketNotificationCount = source.websocketNotificationCount ?? 0;
      const lastMessageAtMs = parseTime(source.lastWebsocketMessageAt);
      const freshWebsocketEvidence =
        websocketNotificationCount > state.websocketNotificationBaseline &&
        state.startedAtMs !== null &&
        lastMessageAtMs !== null &&
        lastMessageAtMs >= state.startedAtMs;
      return {
        programId: state.programId,
        provider: this.provider,
        status:
          (this.desiredRunning && !state.running) || source.status === "down"
            ? "down"
            : transportDegraded
              ? "degraded"
              : source.status,
        running: state.running,
        source,
        clusterSlot: state.clusterSlot,
        sourceSlot: state.sourceSlot,
        slotLag: state.slotLag,
        rawSilenceMs: state.rawSilenceMs,
        consecutiveBreachSamples: state.consecutiveBreachSamples,
        consecutiveHealthySamples: state.consecutiveHealthySamples,
        breachReasons: [...state.breachReasons],
        openIncidentId: state.incident?.idempotencyKey ?? null,
        gapStartedAt: state.incident?.gapStartedAt ?? null,
        lastRestartAt:
          state.lastRestartAtMs !== null ? new Date(state.lastRestartAtMs).toISOString() : null,
        lastRestartError: state.lastRestartError,
        sourceGeneration: state.sourceGeneration,
        freshWebsocketEvidence,
        activityProbeStatus: state.activityProbeStatus,
        lastActivityProbeAt:
          state.lastActivityProbeAtMs === null
            ? null
            : new Date(state.lastActivityProbeAtMs).toISOString(),
        latestProgramActivitySlot: state.latestProgramActivity?.slot ?? null,
        activityProbeErrorCount: state.activityProbeErrorCount,
        lastActivityProbeError: state.lastActivityProbeError,
        coverageDisposition: state.incident
          ? "alpha_excluded_unreconciled"
          : state.lastGapRepairResult?.status === "completed"
            ? "reconciled"
            : "current_transport_healthy",
        lastGapRepairAt:
          state.lastGapRepairAtMs === null ? null : new Date(state.lastGapRepairAtMs).toISOString(),
        gapRepairStatus: state.lastGapRepairResult?.status ?? null,
        gapRepairFetchedSignatureCount: state.lastGapRepairResult?.fetchedSignatureCount ?? 0,
        gapRepairCompletedSignatureCount: state.lastGapRepairResult?.completedSignatureCount ?? 0,
        lastGapRepairError: state.lastGapRepairResult?.error ?? null
      };
    });
  }

  getAggregateDiagnostics(): SolanaEventSourceDiagnostics {
    const programs = this.getProgramDiagnostics();
    const sources = programs.map((program) => program.source);
    const status = programs.some((program) => program.status === "down")
      ? "down"
      : programs.some((program) => program.status === "degraded")
        ? "degraded"
        : "ok";
    return {
      provider: this.provider,
      status,
      reconnectCount: sum(sources, "reconnectCount"),
      duplicateSignatureCount: sum(sources, "duplicateSignatureCount"),
      backfillEventCount: sum(sources, "backfillEventCount"),
      backfillTruncatedCount: sum(sources, "backfillTruncatedCount"),
      backfillTruncatedAddressCount: sum(sources, "backfillTruncatedAddressCount"),
      lastBackfillTruncatedAt: latestIso(sources, "lastBackfillTruncatedAt"),
      lastBackfillTruncatedCursorAt: latestIso(sources, "lastBackfillTruncatedCursorAt"),
      lastBackfillTruncatedCursorSlot: maxNullable(sources, "lastBackfillTruncatedCursorSlot"),
      missingSlotCount: sum(sources, "missingSlotCount"),
      unresolvedTransactionCount: sum(sources, "unresolvedTransactionCount"),
      lastProviderLatencyMs: maxNullable(sources, "lastProviderLatencyMs"),
      lastEventOrigin: latestOrigin(sources),
      lastLiveProviderLatencyMs: maxNullable(sources, "lastLiveProviderLatencyMs"),
      maxLiveProviderLatencyMs: maxNullable(sources, "maxLiveProviderLatencyMs"),
      lastBackfillProviderLatencyMs: maxNullable(sources, "lastBackfillProviderLatencyMs"),
      lastLiveNotificationAt: latestIso(sources, "lastLiveNotificationAt"),
      lastWebsocketMessageAt: latestIso(sources, "lastWebsocketMessageAt"),
      lastWebsocketContextSlot: maxNullable(sources, "lastWebsocketContextSlot"),
      websocketNotificationCount: sum(sources, "websocketNotificationCount"),
      lastWebsocketNotificationAgeMs: maxNullable(sources, "lastWebsocketNotificationAgeMs"),
      maxWebsocketNotificationAgeMs: maxNullable(sources, "maxWebsocketNotificationAgeMs"),
      lastNotificationToObservedMs: maxNullable(sources, "lastNotificationToObservedMs"),
      maxNotificationToObservedMs: maxNullable(sources, "maxNotificationToObservedMs"),
      lastTransactionQueueDelayMs: maxNullable(sources, "lastTransactionQueueDelayMs"),
      maxTransactionQueueDelayMs: maxNullable(sources, "maxTransactionQueueDelayMs"),
      lastTransactionFetchCycleDurationMs: maxNullable(
        sources,
        "lastTransactionFetchCycleDurationMs"
      ),
      maxTransactionFetchCycleDurationMs: maxNullable(
        sources,
        "maxTransactionFetchCycleDurationMs"
      ),
      lastTransactionHttpDurationMs: maxNullable(sources, "lastTransactionHttpDurationMs"),
      maxTransactionHttpDurationMs: maxNullable(sources, "maxTransactionHttpDurationMs"),
      lastTransactionFetchAttempts: maxOptional(sources, "lastTransactionFetchAttempts"),
      transactionNullResponseCount: sum(sources, "transactionNullResponseCount"),
      transactionRequestErrorCount: sum(sources, "transactionRequestErrorCount"),
      transactionRequestTimeoutCount: sum(sources, "transactionRequestTimeoutCount"),
      transactionRequestTimeoutMs: maxOptional(sources, "transactionRequestTimeoutMs"),
      transactionRequestRetryLimit: maxOptional(sources, "transactionRequestRetryLimit"),
      providerLatencyWarningMs: maxOptional(sources, "providerLatencyWarningMs"),
      liveEventCount: sum(sources, "liveEventCount"),
      slowLiveEventCount: sum(sources, "slowLiveEventCount"),
      lastSlowLiveEventAt: latestIso(sources, "lastSlowLiveEventAt"),
      websocketMessageCount: sum(sources, "websocketMessageCount"),
      websocketMessageBytes: sum(sources, "websocketMessageBytes"),
      prefilteredWebsocketMessageCount: sum(sources, "prefilteredWebsocketMessageCount"),
      prefilteredWebsocketMessageBytes: sum(sources, "prefilteredWebsocketMessageBytes"),
      postfetchFilteredTransactionCount: sum(sources, "postfetchFilteredTransactionCount"),
      seenSignatureCount: sum(sources, "seenSignatureCount"),
      seenSignatureLimit: sum(sources, "seenSignatureLimit"),
      inFlightSignatureCount: sum(sources, "inFlightSignatureCount"),
      queuedSignatureCount: sum(sources, "queuedSignatureCount"),
      activeTransactionWorkerCount: sum(sources, "activeTransactionWorkerCount"),
      maxConcurrentTransactionFetches: sum(sources, "maxConcurrentTransactionFetches"),
      maxQueuedSignatures: sum(sources, "maxQueuedSignatures"),
      droppedSignatureCount: sum(sources, "droppedSignatureCount"),
      queuePressureCount: sum(sources, "queuePressureCount"),
      queuePressureAddressCount: sum(sources, "queuePressureAddressCount"),
      queueHighWatermark: sum(sources, "queueHighWatermark"),
      transactionRequestCount: sum(sources, "transactionRequestCount"),
      transactionRetryCount: sum(sources, "transactionRetryCount"),
      recoveredTransactionCount: sum(sources, "recoveredTransactionCount"),
      pendingSubscriptionRequestCount: sum(sources, "pendingSubscriptionRequestCount"),
      configuredAddressCount: sum(sources, "configuredAddressCount"),
      subscribedAddressCount: sum(sources, "subscribedAddressCount"),
      successfulSubscriptionAckCount: sum(sources, "successfulSubscriptionAckCount"),
      successfulSubscriptionAckAddressCount: sum(sources, "successfulSubscriptionAckAddressCount"),
      lastSubscriptionRequestAt: latestIso(sources, "lastSubscriptionRequestAt"),
      lastSubscriptionAckAt: latestIso(sources, "lastSubscriptionAckAt"),
      subscriptionAckTimeoutCount: sum(sources, "subscriptionAckTimeoutCount"),
      subscriptionAckTimedOutAddressCount: sum(sources, "subscriptionAckTimedOutAddressCount"),
      lastSubscriptionAckTimeoutAt: latestIso(sources, "lastSubscriptionAckTimeoutAt"),
      handlerRejectedEventCount: sum(sources, "handlerRejectedEventCount"),
      handlerAdmissionRetryCount: sum(sources, "handlerAdmissionRetryCount"),
      lastHandlerRejectedEventAt: latestIso(sources, "lastHandlerRejectedEventAt"),
      heartbeatTimeoutCount: sum(sources, "heartbeatTimeoutCount"),
      lastPingAt: latestIso(sources, "lastPingAt"),
      lastPongAt: latestIso(sources, "lastPongAt"),
      gapRepairCollectionCount: sum(sources, "gapRepairCollectionCount"),
      gapRepairCompletionCount: sum(sources, "gapRepairCompletionCount"),
      gapRepairStagedSignatureCount: sum(sources, "gapRepairStagedSignatureCount"),
      gapRepairReplayedSignatureCount: sum(sources, "gapRepairReplayedSignatureCount"),
      lastGapRepairAt: latestIso(sources, "lastGapRepairAt"),
      lastGapRepairCompletedAt: latestIso(sources, "lastGapRepairCompletedAt"),
      lastGapRepairId: latestIso(sources, "lastGapRepairId"),
      lastGapRepairError: latestIso(sources, "lastGapRepairError"),
      lastGapRepairCoveredThroughSignature: latestIso(
        sources,
        "lastGapRepairCoveredThroughSignature"
      ),
      lastGapRepairCoveredThroughSlot: maxNullable(sources, "lastGapRepairCoveredThroughSlot")
    };
  }

  private async applyHeadSample(
    clusterSlot: number,
    checkedAt: Date,
    generation: number
  ): Promise<void> {
    if (!this.isLifecycleCurrent(generation)) return;
    const checkedAtMs = checkedAt.getTime();
    this.sentinelDiagnostics = {
      ...this.sentinelDiagnostics,
      lastCheckedAt: checkedAt.toISOString(),
      lastClusterSlot: clusterSlot,
      consecutiveFailureCount: 0,
      lastError: null
    };
    for (const state of this.states) {
      if (!this.isLifecycleCurrent(generation)) return;
      if (!state.running) {
        state.clusterSlot = clusterSlot;
        if (state.incident) await this.maybeRestart(state, checkedAt, generation);
        continue;
      }
      const diagnostics = state.source.getDiagnostics();
      const sourceSlot = finiteNonNegativeInteger(diagnostics.lastWebsocketContextSlot);
      const lastMessageAtMs = parseTime(diagnostics.lastWebsocketMessageAt);
      const silenceOriginMs = lastMessageAtMs ?? state.startedAtMs;
      const rawSilenceMs =
        silenceOriginMs === null ? null : Math.max(0, checkedAtMs - silenceOriginMs);
      const slotLag = sourceSlot === null ? null : Math.max(0, clusterSlot - sourceSlot);
      const reasons: IngestionCoverageIncidentReason[] = [];
      const liveEventCount = diagnostics.liveEventCount ?? 0;
      if (!state.initialLiveEventEvaluated && liveEventCount > state.initialLiveEventBaseline) {
        state.initialLiveEventEvaluated = true;
        if (
          (diagnostics.lastWebsocketNotificationAgeMs ?? 0) > this.initialLiveNotificationMaxAgeMs
        ) {
          reasons.push("stale_live_notification");
        }
      }

      const subscriptionAckTimeoutCount = diagnostics.subscriptionAckTimeoutCount ?? 0;
      if (subscriptionAckTimeoutCount > state.observedSubscriptionAckTimeoutCount) {
        reasons.push("subscription_ack_timeout");
      }
      state.observedSubscriptionAckTimeoutCount = Math.max(
        state.observedSubscriptionAckTimeoutCount,
        subscriptionAckTimeoutCount
      );

      const backfillTruncatedCount = diagnostics.backfillTruncatedCount ?? 0;
      if (backfillTruncatedCount > state.observedBackfillTruncatedCount) {
        reasons.push("backfill_truncated");
      }
      state.observedBackfillTruncatedCount = Math.max(
        state.observedBackfillTruncatedCount,
        backfillTruncatedCount
      );

      const queuePressureCount = diagnostics.queuePressureCount ?? 0;
      const droppedSignatureCount = diagnostics.droppedSignatureCount ?? 0;
      const queuePressureBreached =
        queuePressureCount > state.observedQueuePressureCount ||
        droppedSignatureCount > state.observedDroppedSignatureCount;
      if (queuePressureBreached) {
        // The database constraint intentionally keeps a small reason vocabulary.
        // Exact queue evidence is preserved below in metadata while `combined`
        // makes the interval fail closed for every alpha consumer.
        reasons.push("combined");
      }
      state.observedQueuePressureCount = Math.max(
        state.observedQueuePressureCount,
        queuePressureCount
      );
      state.observedDroppedSignatureCount = Math.max(
        state.observedDroppedSignatureCount,
        droppedSignatureCount
      );
      state.queuePressureBreachActive = queuePressureBreached;

      const activityReasons: IngestionCoverageIncidentReason[] = [];
      if (slotLag !== null && slotLag > this.headLagThresholdSlots) {
        activityReasons.push("head_slot_lag");
      }
      if (rawSilenceMs !== null && rawSilenceMs > this.rawSilenceThresholdMs) {
        activityReasons.push("raw_websocket_silence");
      }
      if (activityReasons.length > 0) {
        const activityAhead = await this.probeProgramActivity(
          state,
          sourceSlot,
          clusterSlot,
          checkedAt
        );
        if (!this.isLifecycleCurrent(generation)) return;
        if (activityAhead === true || (activityAhead === null && !state.probeLatestActivity)) {
          reasons.push(...activityReasons);
        } else if (activityAhead === null && state.consecutiveActivityProbeFailures >= 2) {
          // Repeated inability to disambiguate an apparent stale transport is
          // fail-closed. The probe error is retained in incident metadata.
          reasons.push(...activityReasons);
        }
      }
      state.clusterSlot = clusterSlot;
      state.sourceSlot = sourceSlot;
      state.slotLag = slotLag;
      state.rawSilenceMs = rawSilenceMs;
      state.breachReasons = reasons;

      const configuredAddressCount = diagnostics.configuredAddressCount ?? 0;
      const subscriptionHealthy =
        configuredAddressCount > 0 &&
        (diagnostics.subscribedAddressCount ?? 0) === configuredAddressCount &&
        (diagnostics.pendingSubscriptionRequestCount ?? 0) === 0;
      const websocketNotificationCount = diagnostics.websocketNotificationCount ?? 0;
      const freshWebsocketEvidence =
        websocketNotificationCount > state.websocketNotificationBaseline &&
        state.startedAtMs !== null &&
        lastMessageAtMs !== null &&
        lastMessageAtMs >= state.startedAtMs;
      const lastPongAtMs = parseTime(diagnostics.lastPongAt);
      const quietHeartbeatEvidence =
        subscriptionHealthy &&
        state.activityProbeStatus === "quiet" &&
        state.startedAtMs !== null &&
        lastPongAtMs !== null &&
        lastPongAtMs >= state.startedAtMs &&
        checkedAtMs - lastPongAtMs <= this.rawSilenceThresholdMs;
      const transportSampleProvesHealthy =
        subscriptionHealthy &&
        ((sourceSlot !== null && lastMessageAtMs !== null && freshWebsocketEvidence) ||
          quietHeartbeatEvidence);

      if (reasons.length === 0 && transportSampleProvesHealthy) {
        state.consecutiveBreachSamples = 0;
        state.consecutiveHealthySamples += 1;
      } else if (reasons.length === 0) {
        state.consecutiveBreachSamples = 0;
        state.consecutiveHealthySamples = 0;
      } else {
        state.consecutiveHealthySamples = 0;
        state.consecutiveBreachSamples += 1;
        const requiredSamples =
          queuePressureBreached ||
          reasons.some((reason) =>
            ["subscription_ack_timeout", "stale_live_notification", "backfill_truncated"].includes(
              reason
            )
          )
            ? 1
            : 2;
        if (state.consecutiveBreachSamples >= requiredSamples && !state.incident) {
          const openInput = this.buildIncidentInput(
            state,
            diagnostics,
            reasons,
            clusterSlot,
            sourceSlot,
            slotLag,
            rawSilenceMs,
            checkedAt,
            queuePressureBreached
          );
          if (!this.isLifecycleCurrent(generation)) return;
          state.incident = await this.repository.openIngestionCoverageIncident(openInput);
          state.lastGapRepairAtMs = null;
          state.lastGapRepairResult = null;
          if (!this.isLifecycleCurrent(generation)) return;
        }
      }

      if (state.incident) {
        const reconciled = await this.maybeRepairCoverage(
          state,
          clusterSlot,
          sourceSlot,
          checkedAt,
          generation,
          subscriptionHealthy,
          websocketNotificationCount,
          lastMessageAtMs
        );
        if (!this.isLifecycleCurrent(generation)) return;
        if (reconciled) continue;
        if (reasons.length > 0) {
          await this.maybeRestart(state, checkedAt, generation, reasons, queuePressureBreached);
        }
      }
    }
  }

  private async probeProgramActivity(
    state: ProgramState,
    sourceSlot: number | null,
    clusterSlot: number,
    checkedAt: Date,
    sourceSignature = state.source.getDiagnostics().lastWebsocketSignature ?? null,
    force = false
  ): Promise<boolean | null> {
    if (!state.probeLatestActivity) {
      state.activityProbeStatus = "not-configured";
      return null;
    }
    const checkedAtMs = checkedAt.getTime();
    if (
      !force &&
      state.lastActivityProbeAtMs !== null &&
      checkedAtMs - state.lastActivityProbeAtMs < this.activityProbeCooldownMs
    ) {
      if (state.activityProbeStatus === "error") return null;
      const ahead = activityHeadIsAhead(
        state.latestProgramActivity,
        sourceSlot,
        sourceSignature,
        clusterSlot,
        state.startedAtMs,
        this.headLagThresholdSlots
      );
      state.activityProbeStatus = ahead ? "ahead" : "quiet";
      return ahead;
    }

    state.lastActivityProbeAtMs = checkedAtMs;
    try {
      state.latestProgramActivity = await state.probeLatestActivity();
      state.consecutiveActivityProbeFailures = 0;
      state.lastActivityProbeError = null;
      const ahead = activityHeadIsAhead(
        state.latestProgramActivity,
        sourceSlot,
        sourceSignature,
        clusterSlot,
        state.startedAtMs,
        this.headLagThresholdSlots
      );
      state.activityProbeStatus = ahead ? "ahead" : "quiet";
      return ahead;
    } catch (error) {
      state.activityProbeStatus = "error";
      state.activityProbeErrorCount += 1;
      state.consecutiveActivityProbeFailures += 1;
      state.lastActivityProbeError =
        error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
      return null;
    }
  }

  private async maybeRepairCoverage(
    state: ProgramState,
    clusterSlot: number,
    sourceSlot: number | null,
    checkedAt: Date,
    generation: number,
    subscriptionHealthy: boolean,
    websocketNotificationCount: number,
    lastMessageAtMs: number | null
  ): Promise<boolean> {
    const incident = state.incident;
    if (!incident || !this.handler) return false;
    const repairBoundary = safeRepairBoundary(incident, state.source.getDiagnostics());
    if (!state.source.repairGap || !repairBoundary) {
      if (state.consecutiveHealthySamples < 2) return false;
      const closed = await this.repository.closeIngestionCoverageIncident(incident.idempotencyKey, {
        closedAt: checkedAt.toISOString(),
        clusterSlot,
        ...(sourceSlot !== null ? { sourceSlot } : {}),
        metadata: {
          healthySamples: state.consecutiveHealthySamples,
          proof: "fresh-post-start-websocket-notification",
          sourceGeneration: state.sourceGeneration,
          websocketNotificationBaseline: state.websocketNotificationBaseline,
          websocketNotificationCount,
          coverageDisposition: "alpha_excluded_unreconciled",
          note: state.source.repairGap
            ? "Transport recovered; no exact truncation-cursor boundary was available, so the interval remains unreconciled."
            : "Transport recovered; no durable repair adapter was available."
        }
      });
      if (closed) state.incident = null;
      return closed;
    }

    const previous = state.lastGapRepairResult;
    if (
      previous?.status === "completed" &&
      previous.coveredThroughSlot !== undefined &&
      previous.coveredThroughSignature
    ) {
      if (!state.probeSignatureStatus) {
        state.lastGapRepairResult = {
          ...previous,
          error: "exact-repair-target-status-probe-unavailable"
        };
        return false;
      }
      try {
        const targetStatus = await state.probeSignatureStatus(previous.coveredThroughSignature);
        if (!this.isLifecycleCurrent(generation)) return false;
        if (!targetStatus) {
          state.lastGapRepairResult = {
            ...previous,
            error: "exact-repair-target-not-found"
          };
          return false;
        }
        if (targetStatus.slot !== previous.coveredThroughSlot) {
          state.lastGapRepairResult = {
            ...previous,
            error: `exact-repair-target-slot-mismatch:${targetStatus.slot}`
          };
          return false;
        }
        if (targetStatus.confirmationStatus !== "finalized") {
          state.lastGapRepairResult = {
            ...previous,
            error: `exact-repair-target-awaiting-finality:${targetStatus.confirmationStatus}`
          };
          return false;
        }
        const incidentOpenedAtMs = Date.parse(incident.openedAt);
        const postIncidentWebsocketEvidence =
          subscriptionHealthy &&
          lastMessageAtMs !== null &&
          Number.isFinite(incidentOpenedAtMs) &&
          lastMessageAtMs >= incidentOpenedAtMs;
        if (!postIncidentWebsocketEvidence) return false;
        const targetVerified = await this.repository.verifyIngestionGapRepairTarget(
          previous.repairId,
          {
            signature: previous.coveredThroughSignature,
            slot: previous.coveredThroughSlot,
            confirmationStatus: "finalized",
            verifiedAt: checkedAt.toISOString()
          }
        );
        if (!this.isLifecycleCurrent(generation)) return false;
        if (!targetVerified) {
          state.lastGapRepairResult = {
            ...previous,
            error: "exact-repair-target-proof-persistence-conflict"
          };
          return false;
        }
        const verifiedRepair = { ...previous };
        delete verifiedRepair.error;
        state.lastGapRepairResult = verifiedRepair;
        const closedAt = checkedAt.toISOString();
        const closed = await this.repository.closeIngestionCoverageIncident(
          incident.idempotencyKey,
          {
            closedAt,
            clusterSlot,
            ...(sourceSlot !== null ? { sourceSlot } : {}),
            coverageReconciledAt: closedAt,
            coverageRepairId: previous.repairId,
            metadata: {
              healthySamples: state.consecutiveHealthySamples,
              proof: "durable-oldest-first-replay-and-exact-finalized-target",
              sourceGeneration: state.sourceGeneration,
              websocketNotificationCount,
              repairId: previous.repairId,
              fetchedSignatureCount: previous.fetchedSignatureCount,
              completedSignatureCount: previous.completedSignatureCount,
              coveredThroughSignature: previous.coveredThroughSignature,
              coveredThroughSlot: previous.coveredThroughSlot,
              targetConfirmationStatus: targetStatus.confirmationStatus,
              targetTransactionSucceeded: targetStatus.succeeded,
              targetVerifiedAt: closedAt,
              coverageDisposition: "reconciled"
            }
          }
        );
        if (closed) state.incident = null;
        return closed;
      } catch (error) {
        if (!this.isLifecycleCurrent(generation)) return false;
        state.lastGapRepairResult = {
          ...previous,
          error:
            error instanceof Error
              ? `exact-repair-target-probe-error:${error.message.slice(0, 240)}`
              : `exact-repair-target-probe-error:${String(error).slice(0, 240)}`
        };
        return false;
      }
    }

    const nowMs = checkedAt.getTime();
    if (
      state.lastGapRepairAtMs !== null &&
      nowMs - state.lastGapRepairAtMs < this.repairCooldownMs
    ) {
      return false;
    }
    state.lastGapRepairAtMs = nowMs;
    try {
      state.lastGapRepairResult = await state.source.repairGap(
        state.programId,
        incident.idempotencyKey,
        this.handler,
        repairBoundary
      );
    } catch (error) {
      state.lastGapRepairResult = {
        repairId: incident.idempotencyKey,
        status: "blocked",
        fetchedSignatureCount: 0,
        completedSignatureCount: 0,
        error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
      };
    }
    const result = state.lastGapRepairResult;
    const postStartWebsocketEvidence =
      subscriptionHealthy &&
      websocketNotificationCount > state.websocketNotificationBaseline &&
      state.startedAtMs !== null &&
      lastMessageAtMs !== null &&
      lastMessageAtMs >= state.startedAtMs;
    if (
      result.status === "blocked" &&
      isGapRepairCapacityError(result.error) &&
      state.consecutiveHealthySamples >= 2 &&
      postStartWebsocketEvidence
    ) {
      const closed = await this.repository.closeIngestionCoverageIncident(incident.idempotencyKey, {
        closedAt: checkedAt.toISOString(),
        clusterSlot,
        ...(sourceSlot !== null ? { sourceSlot } : {}),
        metadata: {
          healthySamples: state.consecutiveHealthySamples,
          proof: "current-transport-healthy-repair-cap-exhausted",
          sourceGeneration: state.sourceGeneration,
          websocketNotificationBaseline: state.websocketNotificationBaseline,
          websocketNotificationCount,
          repairId: result.repairId,
          fetchedSignatureCount: result.fetchedSignatureCount,
          completedSignatureCount: result.completedSignatureCount,
          repairError: result.error,
          coverageDisposition: "alpha_excluded_unreconciled",
          note: "The bounded historical repair exceeded its reviewed capacity. The interval remains permanently excluded; only current transport health was restored."
        }
      });
      if (closed) {
        state.source.acknowledgeUnreconciledGap?.(state.programId);
        state.incident = null;
      }
      return closed;
    }
    return false;
  }

  private buildIncidentInput(
    state: ProgramState,
    diagnostics: SolanaEventSourceDiagnostics,
    reasons: IngestionCoverageIncidentReason[],
    clusterSlot: number,
    sourceSlot: number | null,
    slotLag: number | null,
    rawSilenceMs: number | null,
    checkedAt: Date,
    queuePressureBreached = false
  ): IngestionCoverageIncidentOpenInput {
    const lastMessageAtMs = parseTime(diagnostics.lastWebsocketMessageAt);
    const candidateStarts: number[] = [];
    if (reasons.some((reason) => ["head_slot_lag", "raw_websocket_silence"].includes(reason))) {
      candidateStarts.push(lastMessageAtMs ?? state.startedAtMs ?? checkedAt.getTime());
    }
    if (reasons.includes("subscription_ack_timeout")) {
      candidateStarts.push(
        parseTime(diagnostics.lastSubscriptionRequestAt) ??
          parseTime(diagnostics.lastSubscriptionAckTimeoutAt) ??
          state.startedAtMs ??
          checkedAt.getTime()
      );
    }
    if (reasons.includes("backfill_truncated")) {
      const cursorAt = parseTime(diagnostics.lastBackfillTruncatedCursorAt);
      candidateStarts.push(
        cursorAt !== null
          ? Math.max(0, cursorAt - this.initialLiveNotificationMaxAgeMs)
          : (state.startedAtMs ?? checkedAt.getTime())
      );
    }
    if (queuePressureBreached) {
      candidateStarts.push(lastMessageAtMs ?? state.startedAtMs ?? checkedAt.getTime());
    }
    const staleNotificationAgeMs = diagnostics.lastWebsocketNotificationAgeMs;
    const staleEventEstimatedBlockAtMs =
      reasons.includes("stale_live_notification") &&
      lastMessageAtMs !== null &&
      staleNotificationAgeMs !== null &&
      staleNotificationAgeMs !== undefined
        ? Math.max(0, lastMessageAtMs - staleNotificationAgeMs)
        : null;
    if (reasons.includes("stale_live_notification")) {
      candidateStarts.push(
        staleEventEstimatedBlockAtMs ?? lastMessageAtMs ?? state.startedAtMs ?? checkedAt.getTime()
      );
    }
    const gapStartedAtMs =
      candidateStarts.length > 0 ? Math.min(...candidateStarts) : checkedAt.getTime();
    const reason: IngestionCoverageIncidentReason = reasons.length === 1 ? reasons[0]! : "combined";
    const openedAt = checkedAt.toISOString();
    const gapStartedAt = new Date(gapStartedAtMs).toISOString();
    const idempotencyKey = createHash("sha256")
      .update(
        ["solana-ingestion-coverage", this.provider, state.programId, gapStartedAt, openedAt].join(
          ":"
        )
      )
      .digest("hex");
    return {
      idempotencyKey,
      chain: "solana",
      provider: this.provider,
      programAddress: state.programId,
      reason,
      gapStartedAt,
      openedAt,
      clusterSlot,
      ...(sourceSlot !== null ? { sourceSlot } : {}),
      ...(slotLag !== null ? { slotLag } : {}),
      ...(diagnostics.lastWebsocketMessageAt
        ? { lastWebsocketMessageAt: diagnostics.lastWebsocketMessageAt }
        : {}),
      ...(rawSilenceMs !== null ? { silenceMs: rawSilenceMs } : {}),
      subscriptionAckTimeoutCount: diagnostics.subscriptionAckTimeoutCount ?? 0,
      successfulSubscriptionAckCount: diagnostics.successfulSubscriptionAckCount ?? 0,
      metadata: {
        breachReasons: reasons,
        consecutiveBreachSamples: state.consecutiveBreachSamples,
        headLagThresholdSlots: this.headLagThresholdSlots,
        rawSilenceThresholdMs: this.rawSilenceThresholdMs,
        initialLiveNotificationMaxAgeMs: this.initialLiveNotificationMaxAgeMs,
        pendingSubscriptionRequestCount: diagnostics.pendingSubscriptionRequestCount ?? 0,
        configuredAddressCount: diagnostics.configuredAddressCount ?? 0,
        subscribedAddressCount: diagnostics.subscribedAddressCount ?? 0,
        backfillTruncatedCount: diagnostics.backfillTruncatedCount ?? 0,
        backfillTruncatedAddressCount: diagnostics.backfillTruncatedAddressCount ?? 0,
        ...(queuePressureBreached
          ? {
              coverageTrigger: "live_queue_pressure",
              queuePressureCount: diagnostics.queuePressureCount ?? 0,
              droppedSignatureCount: diagnostics.droppedSignatureCount ?? 0,
              queuedSignatureCount: diagnostics.queuedSignatureCount ?? 0,
              queueHighWatermark: diagnostics.queueHighWatermark ?? 0,
              maxQueuedSignatures: diagnostics.maxQueuedSignatures ?? 0
            }
          : {}),
        ...(diagnostics.lastBackfillTruncatedCursorAt
          ? { backfillCursorOccurredAt: diagnostics.lastBackfillTruncatedCursorAt }
          : {}),
        ...(diagnostics.lastBackfillTruncatedCursorSlot !== null &&
        diagnostics.lastBackfillTruncatedCursorSlot !== undefined
          ? { backfillCursorSlot: diagnostics.lastBackfillTruncatedCursorSlot }
          : {}),
        ...(diagnostics.lastBackfillTruncatedCursorSignature
          ? { backfillCursorSignature: diagnostics.lastBackfillTruncatedCursorSignature }
          : {}),
        activityProbeStatus: state.activityProbeStatus,
        activityProbeErrorCount: state.activityProbeErrorCount,
        ...(state.latestProgramActivity
          ? {
              latestProgramActivitySlot: state.latestProgramActivity.slot,
              ...(state.latestProgramActivity.blockTime !== undefined
                ? { latestProgramActivityBlockTime: state.latestProgramActivity.blockTime }
                : {})
            }
          : {}),
        ...(state.lastActivityProbeError
          ? { lastActivityProbeError: state.lastActivityProbeError }
          : {}),
        ...(reasons.includes("stale_live_notification") &&
        staleNotificationAgeMs !== null &&
        staleNotificationAgeMs !== undefined
          ? { staleLiveNotificationAgeMs: staleNotificationAgeMs }
          : {}),
        ...(reasons.includes("stale_live_notification") && lastMessageAtMs !== null
          ? { staleLiveNotificationReceivedAt: new Date(lastMessageAtMs).toISOString() }
          : {}),
        ...(staleEventEstimatedBlockAtMs !== null
          ? { staleLiveEstimatedBlockAt: new Date(staleEventEstimatedBlockAtMs).toISOString() }
          : {}),
        coverageDisposition: "alpha_excluded_unreconciled"
      }
    };
  }

  private async maybeRestart(
    state: ProgramState,
    checkedAt: Date,
    generation: number,
    reasons: IngestionCoverageIncidentReason[] = state.breachReasons,
    queuePressureBreached = state.queuePressureBreachActive
  ): Promise<void> {
    if (!state.incident || !this.isLifecycleCurrent(generation)) return;
    if (
      state.running &&
      reasons.length > 0 &&
      reasons.every((reason) => reason === "backfill_truncated" || reason === "combined") &&
      (reasons.includes("backfill_truncated") || queuePressureBreached)
    ) {
      return;
    }
    const checkedAtMs = checkedAt.getTime();
    if (
      state.lastRestartAtMs !== null &&
      checkedAtMs - state.lastRestartAtMs < this.restartCooldownMs
    ) {
      return;
    }
    const incidentId = state.incident.idempotencyKey;
    const markedAttempt = await this.repository.markIngestionCoverageIncidentRestart(
      incidentId,
      "attempted",
      checkedAt.toISOString()
    );
    if (!this.isLifecycleCurrent(generation) || !markedAttempt) return;
    state.lastRestartAtMs = checkedAtMs;
    state.lastRestartError = null;
    state.incident = {
      ...state.incident,
      ...(!state.incident.restartAttemptedAt
        ? { restartAttemptedAt: checkedAt.toISOString() }
        : {}),
      restartAttemptCount: state.incident.restartAttemptCount + 1,
      lastRestartAttemptedAt: checkedAt.toISOString()
    };
    try {
      const restarted = await this.enqueueLifecycle(async () => {
        if (!this.isLifecycleCurrent(generation) || !this.handler) return false;
        if (state.running) {
          await state.source.stop();
          state.running = false;
        }
        if (!this.isLifecycleCurrent(generation)) return false;
        await state.source.start(this.handler);
        if (!this.isLifecycleCurrent(generation)) {
          await state.source.stop();
          return false;
        }
        state.running = true;
        this.resetSourceBaselines(state);
        return true;
      });
      if (restarted && this.isLifecycleCurrent(generation) && state.incident) {
        const completedAt = laterIso(this.now(), checkedAt);
        const markedCompleted = await this.repository.markIngestionCoverageIncidentRestart(
          incidentId,
          "completed",
          completedAt
        );
        if (!markedCompleted || !this.isLifecycleCurrent(generation)) return;
        state.incident = {
          ...state.incident,
          ...(!state.incident.restartCompletedAt ? { restartCompletedAt: completedAt } : {}),
          lastRestartCompletedAt: completedAt
        };
      }
    } catch (error) {
      state.lastRestartError = error instanceof Error ? error.message.slice(0, 300) : String(error);
      const failedAt = laterIso(this.now(), checkedAt);
      if (this.isLifecycleCurrent(generation) && state.incident) {
        const markedFailed = await this.repository.markIngestionCoverageIncidentRestart(
          incidentId,
          "failed",
          failedAt,
          state.lastRestartError
        );
        if (markedFailed) {
          state.incident = { ...state.incident, lastRestartError: state.lastRestartError };
        }
      }
    }
  }

  private resetSourceBaselines(state: ProgramState): void {
    const diagnostics = state.source.getDiagnostics();
    state.startedAtMs = this.now().getTime();
    state.initialLiveEventBaseline = diagnostics.liveEventCount ?? 0;
    state.initialLiveEventEvaluated = false;
    state.websocketNotificationBaseline = diagnostics.websocketNotificationCount ?? 0;
    state.observedSubscriptionAckTimeoutCount = diagnostics.subscriptionAckTimeoutCount ?? 0;
    state.observedBackfillTruncatedCount = diagnostics.backfillTruncatedCount ?? 0;
    state.observedQueuePressureCount = diagnostics.queuePressureCount ?? 0;
    state.observedDroppedSignatureCount = diagnostics.droppedSignatureCount ?? 0;
    state.queuePressureBreachActive = false;
    state.sourceGeneration += 1;
  }

  private async refreshOpenIncidents(shouldApply: () => boolean = () => true): Promise<void> {
    const openIncidents = await this.repository.listOpenIngestionCoverageIncidents(this.provider);
    if (!shouldApply()) return;
    const byProgram = new Map(openIncidents.map((incident) => [incident.programAddress, incident]));
    for (const state of this.states) {
      const nextIncident = byProgram.get(state.programId) ?? null;
      if (state.incident?.idempotencyKey !== nextIncident?.idempotencyKey) {
        state.lastGapRepairAtMs = null;
        state.lastGapRepairResult = null;
      }
      state.incident = nextIncident;
      const lastRestartAt =
        state.incident?.lastRestartAttemptedAt ?? state.incident?.restartAttemptedAt;
      state.lastRestartAtMs = lastRestartAt ? Date.parse(lastRestartAt) : null;
      state.lastRestartError = state.incident?.lastRestartError ?? null;
    }
  }

  private isLifecycleCurrent(generation: number): boolean {
    return this.desiredRunning && generation === this.lifecycleGeneration;
  }

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

function safeRepairBoundary(
  incident: IngestionCoverageIncident,
  diagnostics: SolanaEventSourceDiagnostics
): SolanaGapRepairBoundary | undefined {
  const metadataSignature = incident.metadata.backfillCursorSignature;
  const metadataSlot = incident.metadata.backfillCursorSlot;
  const metadataOccurredAt = incident.metadata.backfillCursorOccurredAt;
  if (
    typeof metadataSignature === "string" &&
    metadataSignature.length > 0 &&
    Number.isSafeInteger(metadataSlot) &&
    Number(metadataSlot) >= 0
  ) {
    return {
      signature: metadataSignature,
      slot: Number(metadataSlot),
      ...(typeof metadataOccurredAt === "string" ? { occurredAt: metadataOccurredAt } : {}),
      source: "truncation_cursor"
    };
  }

  const truncationAt = parseTime(diagnostics.lastBackfillTruncatedAt);
  const gapStartedAt = Date.parse(incident.gapStartedAt);
  const signature = diagnostics.lastBackfillTruncatedCursorSignature;
  const slot = diagnostics.lastBackfillTruncatedCursorSlot;
  if (
    truncationAt !== null &&
    Number.isFinite(gapStartedAt) &&
    truncationAt >= gapStartedAt &&
    typeof signature === "string" &&
    signature.length > 0 &&
    Number.isSafeInteger(slot) &&
    Number(slot) >= 0
  ) {
    return {
      signature,
      slot: Number(slot),
      ...(diagnostics.lastBackfillTruncatedCursorAt
        ? { occurredAt: diagnostics.lastBackfillTruncatedCursorAt }
        : {}),
      source: "truncation_cursor"
    };
  }
  return undefined;
}

function isGapRepairCapacityError(error: string | undefined): boolean {
  return Boolean(error?.startsWith("gap-repair-signature-cap-"));
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive.`);
  return value;
}

function finiteNonNegativeInteger(value: number | null | undefined): number | null {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : null;
}

function activityHeadIsAhead(
  head: DiscoveryProgramActivityHead | null,
  sourceSlot: number | null,
  sourceSignature: string | null,
  clusterSlot: number,
  startedAtMs: number | null,
  recentSlotThreshold: number
): boolean {
  if (!head) return false;
  if (sourceSlot !== null) {
    if (head.slot !== sourceSlot) return head.slot > sourceSlot;
    return sourceSignature !== null && head.signature !== sourceSignature;
  }
  if (head.blockTime !== undefined && startedAtMs !== null) {
    return head.blockTime * 1_000 >= startedAtMs - 5_000;
  }
  return Math.max(0, clusterSlot - head.slot) <= recentSlotThreshold;
}

function isSignatureConfirmationStatus(
  value: string | null | undefined
): value is DiscoverySignatureStatus["confirmationStatus"] {
  return value === "processed" || value === "confirmed" || value === "finalized";
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sum(
  diagnostics: SolanaEventSourceDiagnostics[],
  key: keyof SolanaEventSourceDiagnostics
): number {
  return diagnostics.reduce((total, current) => {
    const value = current[key];
    return total + (typeof value === "number" && Number.isFinite(value) ? value : 0);
  }, 0);
}

function maxNullable(
  diagnostics: SolanaEventSourceDiagnostics[],
  key: keyof SolanaEventSourceDiagnostics
): number | null {
  const values = diagnostics
    .map((current) => current[key])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : null;
}

function maxOptional(
  diagnostics: SolanaEventSourceDiagnostics[],
  key: keyof SolanaEventSourceDiagnostics
): number {
  return maxNullable(diagnostics, key) ?? 0;
}

function latestIso(
  diagnostics: SolanaEventSourceDiagnostics[],
  key: keyof SolanaEventSourceDiagnostics
): string | null {
  const values = diagnostics
    .map((current) => current[key])
    .filter((value): value is string => typeof value === "string")
    .sort();
  return values.at(-1) ?? null;
}

function latestOrigin(diagnostics: SolanaEventSourceDiagnostics[]): "live" | "backfill" | null {
  return diagnostics.some((current) => current.lastEventOrigin === "live")
    ? "live"
    : diagnostics.some((current) => current.lastEventOrigin === "backfill")
      ? "backfill"
      : null;
}

function laterIso(candidate: Date, floor: Date): string {
  return new Date(Math.max(candidate.getTime(), floor.getTime())).toISOString();
}
