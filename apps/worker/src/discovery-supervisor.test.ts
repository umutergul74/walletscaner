import { describe, expect, it } from "vitest";
import { MemoryRepository } from "@memecoin-alpha/db";
import type {
  SolanaChainEvent,
  SolanaEventSource,
  SolanaEventSourceDiagnostics,
  SolanaGapRepairBoundary,
  SolanaGapRepairResult
} from "@memecoin-alpha/providers";
import {
  DiscoverySupervisor,
  fetchConfirmedSolanaSlot,
  fetchLatestSolanaAddressActivity,
  fetchSolanaSignatureStatus
} from "./discovery-supervisor";

class FakeSource implements SolanaEventSource {
  startCount = 0;
  stopCount = 0;
  stopGate: Promise<void> | null = null;
  startFailuresRemaining = 0;
  acknowledgedUnreconciledGapCount = 0;
  diagnostics: SolanaEventSourceDiagnostics;
  repairGap?: (
    address: string,
    incidentId: string,
    handler: (event: SolanaChainEvent) => Promise<void> | void,
    boundary?: SolanaGapRepairBoundary
  ) => Promise<SolanaGapRepairResult>;

  constructor(provider: string, diagnostics: Partial<SolanaEventSourceDiagnostics> = {}) {
    this.diagnostics = {
      provider,
      status: "ok",
      reconnectCount: 0,
      duplicateSignatureCount: 0,
      backfillEventCount: 0,
      missingSlotCount: 0,
      unresolvedTransactionCount: 0,
      lastProviderLatencyMs: null,
      configuredAddressCount: 1,
      subscribedAddressCount: 1,
      pendingSubscriptionRequestCount: 0,
      subscriptionAckTimedOutAddressCount: 0,
      subscriptionAckTimeoutCount: 0,
      successfulSubscriptionAckCount: 1,
      ...diagnostics
    };
  }

  async start(_handler: (event: SolanaChainEvent) => Promise<void> | void): Promise<void> {
    this.startCount += 1;
    if (this.startFailuresRemaining > 0) {
      this.startFailuresRemaining -= 1;
      throw new Error("simulated source start failure");
    }
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    if (this.stopGate) await this.stopGate;
  }

  async subscribeAddress(): Promise<void> {}

  unsubscribeAddress(): void {}

  acknowledgeUnreconciledGap(): void {
    this.acknowledgedUnreconciledGapCount += 1;
  }

  async backfill(): Promise<number> {
    return 0;
  }

  getDiagnostics(): SolanaEventSourceDiagnostics {
    return { ...this.diagnostics };
  }
}

describe("DiscoverySupervisor", () => {
  it("starts and stops each isolated program source idempotently and preserves aggregate health", async () => {
    const first = healthySource("provider", 1_000, 990, 4);
    const second = healthySource("provider", 1_000, 995, 7);
    const supervisor = new DiscoverySupervisor({
      provider: "provider",
      programs: [
        { programId: "Program111", source: first },
        { programId: "Program222", source: second }
      ],
      repository: new MemoryRepository(),
      now: () => new Date("2026-08-21T00:00:00.000Z")
    });
    await supervisor.initialize();

    await supervisor.start(() => undefined);
    await supervisor.start(() => undefined);
    expect([first.startCount, second.startCount]).toEqual([1, 1]);
    expect(supervisor.getAggregateDiagnostics()).toMatchObject({
      provider: "provider",
      status: "ok",
      websocketMessageCount: 11,
      configuredAddressCount: 2,
      subscribedAddressCount: 2
    });

    await supervisor.stop();
    await supervisor.stop();
    expect([first.stopCount, second.stopCount]).toEqual([1, 1]);
  });

  it("isolates an initial source start failure and records a durable fail-closed incident", async () => {
    const repository = new MemoryRepository();
    const failed = healthySource("provider", 1_000, 990, 1);
    const healthy = healthySource("provider", 1_000, 995, 1);
    failed.startFailuresRemaining = 1;
    const supervisor = new DiscoverySupervisor({
      provider: "provider",
      programs: [
        { programId: "FailedStart111", source: failed },
        { programId: "HealthyStart222", source: healthy }
      ],
      repository,
      now: () => new Date("2026-08-21T00:00:00.000Z")
    });
    await supervisor.initialize();

    await supervisor.start(() => undefined);

    expect([failed.startCount, healthy.startCount]).toEqual([1, 1]);
    expect(supervisor.getProgramDiagnostics()).toEqual([
      expect.objectContaining({ programId: "FailedStart111", running: false, status: "down" }),
      expect.objectContaining({ programId: "HealthyStart222", running: true })
    ]);
    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toEqual([
      expect.objectContaining({
        programAddress: "FailedStart111",
        reason: "source_start_failed"
      })
    ]);
  });

  it("opens an incident after two slot-lag samples and restarts only the affected program", async () => {
    const repository = new MemoryRepository();
    const lagged = healthySource("provider", 1_000, 800, 4);
    const current = healthySource("provider", 1_000, 995, 7);
    const supervisor = new DiscoverySupervisor({
      provider: "provider",
      programs: [
        { programId: "Lagged111", source: lagged },
        { programId: "Current222", source: current }
      ],
      repository,
      headLagThresholdSlots: 150,
      rawSilenceThresholdMs: 120_000,
      now: () => new Date("2026-08-21T00:00:00.000Z")
    });
    await supervisor.initialize();
    await supervisor.start(() => undefined);
    lagged.diagnostics.lastWebsocketMessageAt = "2026-08-21T00:00:20.000Z";

    await supervisor.sampleHead(1_000, new Date("2026-08-21T00:00:30.000Z"));
    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toHaveLength(0);
    await supervisor.sampleHead(1_001, new Date("2026-08-21T00:01:00.000Z"));

    const incidents = await repository.listOpenIngestionCoverageIncidents("provider");
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      provider: "provider",
      programAddress: "Lagged111",
      reason: "head_slot_lag",
      clusterSlot: 1_001,
      sourceSlot: 800,
      slotLag: 201,
      gapStartedAt: "2026-08-21T00:00:20.000Z",
      restartAttemptedAt: "2026-08-21T00:01:00.000Z"
    });
    expect([lagged.stopCount, lagged.startCount]).toEqual([1, 2]);
    expect([current.stopCount, current.startCount]).toEqual([0, 1]);
    expect(supervisor.getAggregateDiagnostics().status).toBe("degraded");
  });

  it("does not restart a legitimately quiet low-volume program", async () => {
    const repository = new MemoryRepository();
    const source = healthySource("provider", 1_000, 700, 1);
    let probes = 0;
    const supervisor = new DiscoverySupervisor({
      provider: "provider",
      programs: [
        {
          programId: "Quiet111",
          source,
          probeLatestActivity: async () => {
            probes += 1;
            return { signature: "already-seen", slot: 700, blockTime: 1_700_000_000 };
          }
        }
      ],
      repository,
      headLagThresholdSlots: 100,
      rawSilenceThresholdMs: 120_000,
      activityProbeCooldownMs: 120_000,
      now: () => new Date("2026-08-21T00:00:00.000Z")
    });
    await supervisor.initialize();
    await supervisor.start(() => undefined);

    await supervisor.sampleHead(1_000, new Date("2026-08-21T00:03:00.000Z"));
    await supervisor.sampleHead(1_010, new Date("2026-08-21T00:03:30.000Z"));

    expect(probes).toBe(1);
    expect(source.stopCount).toBe(0);
    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toHaveLength(0);
    expect(supervisor.getProgramDiagnostics()[0]).toMatchObject({
      activityProbeStatus: "quiet",
      latestProgramActivitySlot: 700
    });
  });

  it("restarts only a program whose latest chain activity is ahead of its websocket", async () => {
    const repository = new MemoryRepository();
    const missed = healthySource("provider", 1_000, 700, 1);
    const quiet = healthySource("provider", 1_000, 700, 1);
    const supervisor = new DiscoverySupervisor({
      provider: "provider",
      programs: [
        {
          programId: "Missed111",
          source: missed,
          probeLatestActivity: async () => ({ signature: "new-chain-event", slot: 995 })
        },
        {
          programId: "Quiet222",
          source: quiet,
          probeLatestActivity: async () => ({ signature: "old-chain-event", slot: 700 })
        }
      ],
      repository,
      headLagThresholdSlots: 100,
      activityProbeCooldownMs: 120_000,
      now: () => new Date("2026-08-21T00:00:00.000Z")
    });
    await supervisor.initialize();
    await supervisor.start(() => undefined);

    await supervisor.sampleHead(1_000, new Date("2026-08-21T00:00:30.000Z"));
    await supervisor.sampleHead(1_001, new Date("2026-08-21T00:01:00.000Z"));

    expect([missed.stopCount, missed.startCount]).toEqual([1, 2]);
    expect([quiet.stopCount, quiet.startCount]).toEqual([0, 1]);
    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toEqual([
      expect.objectContaining({ programAddress: "Missed111", reason: "head_slot_lag" })
    ]);
  });

  it("treats a different latest signature in the same slot as ambiguous coverage", async () => {
    const repository = new MemoryRepository();
    const source = healthySource("provider", 1_000, 700, 1);
    source.diagnostics = { ...source.diagnostics, lastWebsocketSignature: "seen-in-slot" };
    const supervisor = new DiscoverySupervisor({
      provider: "provider",
      programs: [
        {
          programId: "SameSlot111",
          source,
          probeLatestActivity: async () => ({ signature: "missed-in-slot", slot: 700 })
        }
      ],
      repository,
      headLagThresholdSlots: 100,
      activityProbeCooldownMs: 120_000,
      now: () => new Date("2026-08-21T00:00:00.000Z")
    });
    await supervisor.initialize();
    await supervisor.start(() => undefined);

    await supervisor.sampleHead(1_000, new Date("2026-08-21T00:00:30.000Z"));
    await supervisor.sampleHead(1_001, new Date("2026-08-21T00:01:00.000Z"));

    expect([source.stopCount, source.startCount]).toEqual([1, 2]);
    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toEqual([
      expect.objectContaining({ programAddress: "SameSlot111", reason: "head_slot_lag" })
    ]);
  });

  it("treats a bounded subscription ACK timeout as immediate incident evidence", async () => {
    const repository = new MemoryRepository();
    const source = healthySource("provider", 1_000, 999, 1);
    const supervisor = new DiscoverySupervisor({
      provider: "provider",
      programs: [{ programId: "Ack111", source }],
      repository,
      now: () => new Date("2026-08-21T00:00:30.000Z")
    });
    await supervisor.initialize();
    await supervisor.start(() => undefined);
    source.diagnostics = {
      ...source.diagnostics,
      status: "degraded",
      subscribedAddressCount: 0,
      pendingSubscriptionRequestCount: 1,
      subscriptionAckTimedOutAddressCount: 1,
      subscriptionAckTimeoutCount: 1,
      lastSubscriptionRequestAt: "2026-08-21T00:00:10.000Z",
      lastSubscriptionAckTimeoutAt: "2026-08-21T00:00:15.000Z"
    };

    await supervisor.sampleHead(1_000, new Date("2026-08-21T00:00:30.000Z"));
    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toEqual([
      expect.objectContaining({
        programAddress: "Ack111",
        reason: "subscription_ack_timeout",
        gapStartedAt: "2026-08-21T00:00:10.000Z",
        subscriptionAckTimeoutCount: 1
      })
    ]);
    expect([source.stopCount, source.startCount]).toEqual([1, 2]);
  });

  it("retains a timeout incident when the subscription ACK arrives before the sentinel sample", async () => {
    const repository = new MemoryRepository();
    const source = healthySource("provider", 1_000, 999, 1);
    const supervisor = new DiscoverySupervisor({
      provider: "provider",
      programs: [{ programId: "LateAck111", source }],
      repository,
      now: () => new Date("2026-08-21T00:00:00.000Z")
    });
    await supervisor.initialize();
    await supervisor.start(() => undefined);
    source.diagnostics = {
      ...source.diagnostics,
      subscriptionAckTimeoutCount: 1,
      subscriptionAckTimedOutAddressCount: 0,
      successfulSubscriptionAckCount: 2,
      subscribedAddressCount: 1,
      pendingSubscriptionRequestCount: 0,
      lastSubscriptionRequestAt: "2026-08-21T00:00:10.000Z",
      lastSubscriptionAckTimeoutAt: "2026-08-21T00:00:15.000Z",
      lastSubscriptionAckAt: "2026-08-21T00:00:16.000Z"
    };

    await supervisor.sampleHead(1_000, new Date("2026-08-21T00:00:30.000Z"));

    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toEqual([
      expect.objectContaining({
        programAddress: "LateAck111",
        reason: "subscription_ack_timeout",
        subscriptionAckTimeoutCount: 1
      })
    ]);
  });

  it("recovers a legitimately quiet ACK-timeout transport without claiming gap reconciliation", async () => {
    const repository = new MemoryRepository();
    const source = healthySource("provider", 1_000, 999, 1);
    source.diagnostics = { ...source.diagnostics, lastWebsocketSignature: "quiet-head" };
    let repairCalls = 0;
    source.repairGap = async () => {
      repairCalls += 1;
      throw new Error("repair must not run without a safe truncation cursor");
    };
    const supervisor = new DiscoverySupervisor({
      provider: "provider",
      programs: [
        {
          programId: "QuietAckRecovery111",
          source,
          probeLatestActivity: async () => ({ signature: "quiet-head", slot: 999 })
        }
      ],
      repository,
      rawSilenceThresholdMs: 120_000,
      activityProbeCooldownMs: 120_000,
      now: () => new Date("2026-08-21T00:00:00.000Z")
    });
    await supervisor.initialize();
    await supervisor.start(() => undefined);
    source.diagnostics = {
      ...source.diagnostics,
      status: "degraded",
      subscribedAddressCount: 0,
      pendingSubscriptionRequestCount: 1,
      subscriptionAckTimedOutAddressCount: 1,
      subscriptionAckTimeoutCount: 1,
      lastSubscriptionRequestAt: "2026-08-21T00:00:10.000Z",
      lastSubscriptionAckTimeoutAt: "2026-08-21T00:00:15.000Z"
    };
    await supervisor.sampleHead(1_000, new Date("2026-08-21T00:00:30.000Z"));

    source.diagnostics = {
      ...source.diagnostics,
      status: "ok",
      subscribedAddressCount: 1,
      pendingSubscriptionRequestCount: 0,
      subscriptionAckTimedOutAddressCount: 0,
      successfulSubscriptionAckCount: 2,
      lastSubscriptionAckAt: "2026-08-21T00:00:31.000Z",
      lastPongAt: "2026-08-21T00:02:59.000Z"
    };
    await supervisor.sampleHead(1_010, new Date("2026-08-21T00:03:00.000Z"));
    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toHaveLength(1);
    source.diagnostics = {
      ...source.diagnostics,
      lastPongAt: "2026-08-21T00:03:29.000Z"
    };
    await supervisor.sampleHead(1_011, new Date("2026-08-21T00:03:30.000Z"));

    expect(repairCalls).toBe(0);
    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toHaveLength(0);
    expect(supervisor.getProgramDiagnostics()[0]).toMatchObject({
      activityProbeStatus: "quiet",
      coverageDisposition: "current_transport_healthy"
    });
  });

  it("rejects a bad startup backend when its first live notification is already stale", async () => {
    const repository = new MemoryRepository();
    const source = healthySource("provider", 1_000, 999, 1);
    const supervisor = new DiscoverySupervisor({
      provider: "provider",
      programs: [{ programId: "Stale111", source }],
      repository,
      initialLiveNotificationMaxAgeMs: 30_000,
      now: () => new Date("2026-08-21T00:00:00.000Z")
    });
    await supervisor.initialize();
    await supervisor.start(() => undefined);
    source.diagnostics = {
      ...source.diagnostics,
      liveEventCount: 1,
      lastWebsocketNotificationAgeMs: 85_000,
      lastWebsocketContextSlot: 1_000,
      lastWebsocketMessageAt: "2026-08-21T00:00:29.000Z"
    };

    await supervisor.sampleHead(1_001, new Date("2026-08-21T00:00:30.000Z"));

    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toEqual([
      expect.objectContaining({
        programAddress: "Stale111",
        reason: "stale_live_notification",
        metadata: expect.objectContaining({
          initialLiveNotificationMaxAgeMs: 30_000,
          staleLiveNotificationAgeMs: 85_000,
          staleLiveNotificationReceivedAt: "2026-08-21T00:00:29.000Z",
          staleLiveEstimatedBlockAt: "2026-08-20T23:59:04.000Z",
          coverageDisposition: "alpha_excluded_unreconciled"
        })
      })
    ]);
    expect([source.stopCount, source.startCount]).toEqual([1, 2]);
  });

  it("retries a failed source start after cooldown while the incident remains open", async () => {
    const repository = new MemoryRepository();
    const source = healthySource("provider", 1_000, 700, 1);
    const supervisor = new DiscoverySupervisor({
      provider: "provider",
      programs: [{ programId: "Retry111", source }],
      repository,
      headLagThresholdSlots: 100,
      restartCooldownMs: 300_000,
      now: () => new Date("2026-08-21T00:00:00.000Z")
    });
    await supervisor.initialize();
    await supervisor.start(() => undefined);
    source.startFailuresRemaining = 1;

    await supervisor.sampleHead(1_000, new Date("2026-08-21T00:00:30.000Z"));
    await supervisor.sampleHead(1_001, new Date("2026-08-21T00:01:00.000Z"));
    expect(source.startCount).toBe(2);
    expect(supervisor.getProgramDiagnostics()[0]).toMatchObject({
      running: false,
      status: "down",
      lastRestartError: "simulated source start failure"
    });

    await supervisor.sampleHead(1_100, new Date("2026-08-21T00:03:00.000Z"));
    expect(source.startCount).toBe(2);
    await supervisor.sampleHead(1_200, new Date("2026-08-21T00:06:01.000Z"));
    expect(source.startCount).toBe(3);
    expect(source.stopCount).toBe(1);
    expect(supervisor.getProgramDiagnostics()[0]?.running).toBe(true);
    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toEqual([
      expect.objectContaining({
        restartAttemptCount: 2,
        lastRestartAttemptedAt: "2026-08-21T00:06:01.000Z",
        lastRestartCompletedAt: "2026-08-21T00:06:01.000Z"
      })
    ]);
  });

  it("closes only after two proven healthy samples without declaring the historical gap complete", async () => {
    const repository = new MemoryRepository();
    const source = healthySource("provider", 1_000, 700, 1);
    const supervisor = new DiscoverySupervisor({
      provider: "provider",
      programs: [{ programId: "Recover111", source }],
      repository,
      headLagThresholdSlots: 100,
      now: () => new Date("2026-08-21T00:00:00.000Z")
    });
    await supervisor.initialize();
    await supervisor.start(() => undefined);
    await supervisor.sampleHead(1_000, new Date("2026-08-21T00:00:30.000Z"));
    await supervisor.sampleHead(1_001, new Date("2026-08-21T00:01:00.000Z"));
    const incident = (await repository.listOpenIngestionCoverageIncidents("provider"))[0]!;

    source.diagnostics = {
      ...source.diagnostics,
      status: "ok",
      lastWebsocketContextSlot: 1_010,
      lastWebsocketMessageAt: "2026-08-21T00:01:29.000Z",
      subscribedAddressCount: 1,
      pendingSubscriptionRequestCount: 0,
      subscriptionAckTimedOutAddressCount: 0
    };
    await supervisor.sampleHead(1_010, new Date("2026-08-21T00:01:30.000Z"));
    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toHaveLength(1);
    await supervisor.sampleHead(1_011, new Date("2026-08-21T00:02:00.000Z"));
    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toHaveLength(1);

    source.diagnostics = {
      ...source.diagnostics,
      websocketNotificationCount: 2,
      lastWebsocketContextSlot: 1_020,
      lastWebsocketMessageAt: "2026-08-21T00:02:29.000Z"
    };
    await supervisor.sampleHead(1_020, new Date("2026-08-21T00:02:30.000Z"));
    await supervisor.sampleHead(1_021, new Date("2026-08-21T00:03:00.000Z"));
    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toHaveLength(0);
    expect(incident.metadata).toMatchObject({
      coverageDisposition: "alpha_excluded_unreconciled"
    });
    expect(supervisor.getProgramDiagnostics()[0]?.coverageDisposition).toBe(
      "current_transport_healthy"
    );
  });

  it("enforces the five-minute restart cooldown across consecutive incidents", async () => {
    const repository = new MemoryRepository();
    const source = healthySource("provider", 1_000, 700, 1);
    const supervisor = new DiscoverySupervisor({
      provider: "provider",
      programs: [{ programId: "Cooldown111", source }],
      repository,
      headLagThresholdSlots: 100,
      restartCooldownMs: 300_000,
      now: () => new Date("2026-08-21T00:00:00.000Z")
    });
    await supervisor.initialize();
    await supervisor.start(() => undefined);
    await supervisor.sampleHead(1_000, new Date("2026-08-21T00:00:30.000Z"));
    await supervisor.sampleHead(1_001, new Date("2026-08-21T00:01:00.000Z"));
    expect(source.stopCount).toBe(1);

    source.diagnostics = {
      ...source.diagnostics,
      lastWebsocketContextSlot: 1_010,
      lastWebsocketMessageAt: "2026-08-21T00:01:29.000Z",
      websocketNotificationCount: 2
    };
    await supervisor.sampleHead(1_010, new Date("2026-08-21T00:01:30.000Z"));
    await supervisor.sampleHead(1_011, new Date("2026-08-21T00:02:00.000Z"));

    source.diagnostics = {
      ...source.diagnostics,
      lastWebsocketContextSlot: 1_000,
      lastWebsocketMessageAt: "2026-08-21T00:02:00.000Z"
    };
    await supervisor.sampleHead(1_300, new Date("2026-08-21T00:02:30.000Z"));
    await supervisor.sampleHead(1_301, new Date("2026-08-21T00:03:00.000Z"));
    expect(source.stopCount).toBe(1);
    await supervisor.sampleHead(1_600, new Date("2026-08-21T00:06:01.000Z"));
    expect(source.stopCount).toBe(2);
  });

  it("does not reopen a source when the storage gate stops during a controlled restart", async () => {
    const repository = new MemoryRepository();
    const source = healthySource("provider", 1_000, 700, 1);
    let releaseStop = () => {};
    source.stopGate = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const supervisor = new DiscoverySupervisor({
      provider: "provider",
      programs: [{ programId: "Race111", source }],
      repository,
      headLagThresholdSlots: 100,
      now: () => new Date("2026-08-21T00:00:00.000Z")
    });
    await supervisor.initialize();
    await supervisor.start(() => undefined);
    await supervisor.sampleHead(1_000, new Date("2026-08-21T00:00:30.000Z"));
    const restart = supervisor.sampleHead(1_001, new Date("2026-08-21T00:01:00.000Z"));
    await waitUntil(() => source.stopCount === 1);
    const stopped = supervisor.stop();
    releaseStop();
    await Promise.all([restart, stopped]);

    expect(source.startCount).toBe(1);
    expect(supervisor.getProgramDiagnostics()[0]?.running).toBe(false);
  });

  it("opens a durable incident for a newly detected bounded-backfill truncation", async () => {
    const repository = new MemoryRepository();
    const source = healthySource("provider", 1_000, 999, 1);
    const supervisor = new DiscoverySupervisor({
      provider: "provider",
      programs: [{ programId: "Truncated111", source }],
      repository,
      initialLiveNotificationMaxAgeMs: 30_000,
      now: () => new Date("2026-08-21T00:00:00.000Z")
    });
    await supervisor.initialize();
    await supervisor.start(() => undefined);
    source.diagnostics = {
      ...source.diagnostics,
      backfillTruncatedCount: 1,
      backfillTruncatedAddressCount: 1,
      lastBackfillTruncatedAt: "2026-08-21T00:00:20.000Z",
      lastBackfillTruncatedCursorAt: "2026-08-20T23:55:00.000Z",
      lastBackfillTruncatedCursorSlot: 900,
      lastBackfillTruncatedCursorSignature: "cursor-safe"
    };

    await supervisor.sampleHead(1_000, new Date("2026-08-21T00:00:30.000Z"));

    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toEqual([
      expect.objectContaining({
        programAddress: "Truncated111",
        reason: "backfill_truncated",
        gapStartedAt: "2026-08-20T23:54:30.000Z",
        metadata: expect.objectContaining({
          backfillCursorSlot: 900,
          backfillCursorSignature: "cursor-safe",
          backfillTruncatedCount: 1
        })
      })
    ]);
    // A restart cannot make a deliberately bounded historical window complete.
    expect(source.stopCount).toBe(0);
  });

  it("keeps an incident open while a durable repair is only partially collected", async () => {
    const repository = new MemoryRepository();
    const source = healthySource("provider", 1_000, 999, 1);
    let repairCalls = 0;
    let receivedBoundary: unknown;
    source.repairGap = async (_address, incidentId, _handler, boundary) => {
      repairCalls += 1;
      receivedBoundary = boundary;
      return {
        repairId: `${incidentId}:repair`,
        status: "collecting",
        fetchedSignatureCount: repairCalls * 100,
        completedSignatureCount: 0
      };
    };
    const supervisor = new DiscoverySupervisor({
      provider: "provider",
      programs: [{ programId: "PartialRepair111", source }],
      repository,
      repairCooldownMs: 30_000,
      now: () => new Date("2026-08-21T00:00:00.000Z")
    });
    await supervisor.initialize();
    await supervisor.start(() => undefined);
    source.diagnostics = {
      ...source.diagnostics,
      backfillTruncatedCount: 1,
      backfillTruncatedAddressCount: 1,
      lastBackfillTruncatedAt: "2026-08-21T00:00:20.000Z",
      lastBackfillTruncatedCursorAt: "2026-08-21T00:00:00.000Z",
      lastBackfillTruncatedCursorSlot: 900,
      lastBackfillTruncatedCursorSignature: "cursor-safe"
    };

    await supervisor.sampleHead(1_000, new Date("2026-08-21T00:00:30.000Z"));
    source.diagnostics = {
      ...source.diagnostics,
      status: "ok",
      websocketNotificationCount: 2,
      lastWebsocketContextSlot: 1_010,
      lastWebsocketMessageAt: "2026-08-21T00:00:59.000Z"
    };
    await supervisor.sampleHead(1_010, new Date("2026-08-21T00:01:00.000Z"));
    await supervisor.sampleHead(1_011, new Date("2026-08-21T00:01:30.000Z"));

    expect(repairCalls).toBe(3);
    expect(receivedBoundary).toEqual({
      signature: "cursor-safe",
      slot: 900,
      occurredAt: "2026-08-21T00:00:00.000Z",
      source: "truncation_cursor"
    });
    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toHaveLength(1);
    expect(supervisor.getProgramDiagnostics()[0]).toMatchObject({
      gapRepairStatus: "collecting",
      gapRepairFetchedSignatureCount: 300,
      coverageDisposition: "alpha_excluded_unreconciled"
    });
  });

  it("retires a capacity-exhausted repair only as a permanently excluded interval", async () => {
    const repository = new MemoryRepository();
    const source = healthySource("provider", 1_000, 999, 1);
    source.repairGap = async (_address, incidentId) => ({
      repairId: `${incidentId}:repair`,
      status: "blocked",
      fetchedSignatureCount: 20_000,
      completedSignatureCount: 0,
      error: "gap-repair-signature-cap-20000"
    });
    const supervisor = new DiscoverySupervisor({
      provider: "provider",
      programs: [{ programId: "CapacityRepair111", source }],
      repository,
      repairCooldownMs: 30_000,
      now: () => new Date("2026-08-24T00:00:00.000Z")
    });
    await supervisor.initialize();
    await supervisor.start(() => undefined);
    source.diagnostics = {
      ...source.diagnostics,
      backfillTruncatedCount: 1,
      backfillTruncatedAddressCount: 1,
      lastBackfillTruncatedAt: "2026-08-24T00:00:20.000Z",
      lastBackfillTruncatedCursorAt: "2026-08-24T00:00:00.000Z",
      lastBackfillTruncatedCursorSlot: 900,
      lastBackfillTruncatedCursorSignature: "cursor-old"
    };
    await supervisor.sampleHead(1_000, new Date("2026-08-24T00:00:30.000Z"));

    source.diagnostics = {
      ...source.diagnostics,
      status: "ok",
      websocketNotificationCount: 2,
      lastWebsocketContextSlot: 1_010,
      lastWebsocketMessageAt: "2026-08-24T00:00:59.000Z"
    };
    await supervisor.sampleHead(1_010, new Date("2026-08-24T00:01:00.000Z"));
    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toHaveLength(1);
    await supervisor.sampleHead(1_011, new Date("2026-08-24T00:01:30.000Z"));

    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toHaveLength(0);
    expect(source.acknowledgedUnreconciledGapCount).toBe(1);
    expect(supervisor.getProgramDiagnostics()[0]).toMatchObject({
      gapRepairStatus: "blocked",
      lastGapRepairError: "gap-repair-signature-cap-20000",
      coverageDisposition: "current_transport_healthy"
    });
  });

  it("closes coverage after durable replay, exact target finality and post-incident WS evidence even when the head advances", async () => {
    const repository = new MemoryRepository();
    const source = healthySource("provider", 1_000, 999, 1);
    let targetConfirmationStatus: "confirmed" | "finalized" = "confirmed";
    source.repairGap = async (address, incidentId) => {
      const repairId = `${incidentId}:repair`;
      await repository.getOrCreateIngestionGapRepair({
        repairId,
        incidentId,
        provider: "provider",
        programAddress: address,
        cursorSignature: "cursor-old",
        cursorSlot: 900,
        boundarySource: "truncation_cursor"
      });
      await repository.stageIngestionGapRepairPage({
        repairId,
        signatures: [{ signature: "covered-head", slot: 1_010, positionFromHead: 0 }],
        boundaryReached: true,
        targetSignature: "covered-head",
        targetSlot: 1_010
      });
      await repository.completeIngestionGapRepairSignature(repairId, "covered-head");
      await repository.completeIngestionGapRepair(repairId, {
        signature: "covered-head",
        slot: 1_010
      });
      return {
        repairId,
        status: "completed",
        fetchedSignatureCount: 1,
        completedSignatureCount: 1,
        coveredThroughSignature: "covered-head",
        coveredThroughSlot: 1_010
      };
    };
    const supervisor = new DiscoverySupervisor({
      provider: "provider",
      programs: [
        {
          programId: "Reconciled111",
          source,
          probeLatestActivity: async () => ({ signature: "newer-head", slot: 1_050 }),
          probeSignatureStatus: async (signature) => {
            expect(signature).toBe("covered-head");
            return { slot: 1_010, confirmationStatus: targetConfirmationStatus, succeeded: true };
          }
        }
      ],
      repository,
      repairCooldownMs: 30_000,
      now: () => new Date("2026-08-21T00:00:00.000Z")
    });
    await supervisor.initialize();
    await supervisor.start(() => undefined);
    source.diagnostics = {
      ...source.diagnostics,
      backfillTruncatedCount: 1,
      backfillTruncatedAddressCount: 1,
      lastBackfillTruncatedAt: "2026-08-21T00:00:20.000Z",
      lastBackfillTruncatedCursorAt: "2026-08-21T00:00:00.000Z",
      lastBackfillTruncatedCursorSlot: 900,
      lastBackfillTruncatedCursorSignature: "cursor-old"
    };

    await supervisor.sampleHead(1_000, new Date("2026-08-21T00:00:30.000Z"));
    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toHaveLength(1);

    source.diagnostics = {
      ...source.diagnostics,
      status: "ok",
      websocketNotificationCount: 2,
      lastWebsocketSignature: "covered-head",
      lastWebsocketContextSlot: 1_010,
      lastWebsocketMessageAt: "2026-08-21T00:00:59.000Z"
    };
    await supervisor.sampleHead(1_010, new Date("2026-08-21T00:01:00.000Z"));
    await supervisor.sampleHead(1_011, new Date("2026-08-21T00:01:30.000Z"));
    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toHaveLength(1);

    targetConfirmationStatus = "finalized";
    await supervisor.sampleHead(1_012, new Date("2026-08-21T00:02:00.000Z"));
    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toHaveLength(0);
    expect(supervisor.getProgramDiagnostics()[0]).toMatchObject({
      gapRepairStatus: "completed",
      gapRepairCompletedSignatureCount: 1,
      coverageDisposition: "reconciled"
    });
  });

  it("fails closed immediately when live discovery queue pressure can hide signatures", async () => {
    const repository = new MemoryRepository();
    const source = healthySource("provider", 1_000, 999, 1);
    const supervisor = new DiscoverySupervisor({
      provider: "provider",
      programs: [{ programId: "Pressure111", source }],
      repository,
      now: () => new Date("2026-08-21T00:00:00.000Z")
    });
    await supervisor.initialize();
    await supervisor.start(() => undefined);
    source.diagnostics = {
      ...source.diagnostics,
      status: "degraded",
      queuePressureCount: 2,
      droppedSignatureCount: 1,
      queuedSignatureCount: 500,
      queueHighWatermark: 500,
      maxQueuedSignatures: 500,
      lastWebsocketMessageAt: "2026-08-21T00:00:29.000Z"
    };

    await supervisor.sampleHead(1_000, new Date("2026-08-21T00:00:30.000Z"));

    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toEqual([
      expect.objectContaining({
        programAddress: "Pressure111",
        reason: "combined",
        gapStartedAt: "2026-08-21T00:00:29.000Z",
        metadata: expect.objectContaining({
          coverageTrigger: "live_queue_pressure",
          queuePressureCount: 2,
          droppedSignatureCount: 1,
          queuedSignatureCount: 500,
          queueHighWatermark: 500,
          maxQueuedSignatures: 500,
          coverageDisposition: "alpha_excluded_unreconciled"
        })
      })
    ]);
    expect(supervisor.getProgramDiagnostics()[0]?.coverageDisposition).toBe(
      "alpha_excluded_unreconciled"
    );
    // Restarting cannot recover signatures that were already dropped.
    expect(source.stopCount).toBe(0);

    source.diagnostics = {
      ...source.diagnostics,
      status: "ok",
      websocketNotificationCount: 2,
      lastWebsocketContextSlot: 1_010,
      lastWebsocketMessageAt: "2026-08-21T00:00:59.000Z",
      queuedSignatureCount: 0
    };
    await supervisor.sampleHead(1_010, new Date("2026-08-21T00:01:00.000Z"));
    await supervisor.sampleHead(1_011, new Date("2026-08-21T00:01:30.000Z"));

    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toHaveLength(0);
    expect(supervisor.getProgramDiagnostics()[0]?.coverageDisposition).toBe(
      "current_transport_healthy"
    );
  });

  it("rehydrates incident state when stop races a committed close", async () => {
    const repository = new MemoryRepository();
    let closeStarted = false;
    let releaseClose = () => {};
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const delayedRepository = {
      openIngestionCoverageIncident: repository.openIngestionCoverageIncident.bind(repository),
      listOpenIngestionCoverageIncidents:
        repository.listOpenIngestionCoverageIncidents.bind(repository),
      markIngestionCoverageIncidentRestart:
        repository.markIngestionCoverageIncidentRestart.bind(repository),
      closeIngestionCoverageIncident: async (
        ...args: Parameters<MemoryRepository["closeIngestionCoverageIncident"]>
      ) => {
        closeStarted = true;
        await closeGate;
        return repository.closeIngestionCoverageIncident(...args);
      },
      verifyIngestionGapRepairTarget: repository.verifyIngestionGapRepairTarget.bind(repository)
    };
    const source = healthySource("provider", 1_000, 700, 1);
    const supervisor = new DiscoverySupervisor({
      provider: "provider",
      programs: [{ programId: "CloseRace111", source }],
      repository: delayedRepository,
      headLagThresholdSlots: 100,
      now: () => new Date("2026-08-21T00:00:00.000Z")
    });
    await supervisor.initialize();
    await supervisor.start(() => undefined);
    await supervisor.sampleHead(1_000, new Date("2026-08-21T00:00:30.000Z"));
    await supervisor.sampleHead(1_001, new Date("2026-08-21T00:01:00.000Z"));

    source.diagnostics = {
      ...source.diagnostics,
      status: "ok",
      websocketNotificationCount: 2,
      lastWebsocketContextSlot: 1_010,
      lastWebsocketMessageAt: "2026-08-21T00:01:29.000Z"
    };
    await supervisor.sampleHead(1_010, new Date("2026-08-21T00:01:30.000Z"));
    const closing = supervisor.sampleHead(1_011, new Date("2026-08-21T00:02:00.000Z"));
    await waitUntil(() => closeStarted);
    const stopped = supervisor.stop();
    releaseClose();
    await Promise.all([closing, stopped]);

    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toHaveLength(0);
    expect(supervisor.getProgramDiagnostics()[0]?.openIncidentId).toBeNull();

    await supervisor.start(() => undefined);
    source.diagnostics = {
      ...source.diagnostics,
      backfillTruncatedCount: 1,
      backfillTruncatedAddressCount: 1,
      lastBackfillTruncatedAt: "2026-08-21T00:02:30.000Z"
    };
    await supervisor.sampleHead(1_020, new Date("2026-08-21T00:03:00.000Z"));
    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toEqual([
      expect.objectContaining({ programAddress: "CloseRace111", reason: "backfill_truncated" })
    ]);
  });

  it("discards an in-flight health sample after the lifecycle is stopped", async () => {
    const repository = new MemoryRepository();
    const source = healthySource("provider", 1_000, 700, 1);
    let releaseProbe = () => {};
    let probeStarted = false;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const supervisor = new DiscoverySupervisor({
      provider: "provider",
      programs: [
        {
          programId: "Generation111",
          source,
          probeLatestActivity: async () => {
            probeStarted = true;
            await probeGate;
            return { signature: "missed", slot: 999 };
          }
        }
      ],
      repository,
      headLagThresholdSlots: 100,
      now: () => new Date("2026-08-21T00:00:00.000Z")
    });
    await supervisor.initialize();
    await supervisor.start(() => undefined);

    const sample = supervisor.sampleHead(1_000, new Date("2026-08-21T00:03:00.000Z"));
    await waitUntil(() => probeStarted);
    const stopped = supervisor.stop();
    releaseProbe();
    await Promise.all([sample, stopped]);

    expect(await repository.listOpenIngestionCoverageIncidents("provider")).toHaveLength(0);
    expect(supervisor.getProgramDiagnostics()[0]?.running).toBe(false);
  });
});

describe("fetchConfirmedSolanaSlot", () => {
  it("uses one confirmed getSlot logical call", async () => {
    const requests: unknown[] = [];
    const slot = await fetchConfirmedSolanaSlot({
      rpcUrl: "https://rpc.example",
      provider: "provider",
      timeoutMs: 1_000,
      retries: 0,
      fetchImpl: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 123_456 }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    });

    expect(slot).toBe(123_456);
    expect(requests).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "getSlot",
        params: [{ commitment: "confirmed" }]
      }
    ]);
  });

  it("reads only the latest confirmed program signature for activity disambiguation", async () => {
    const requests: unknown[] = [];
    const activity = await fetchLatestSolanaAddressActivity({
      rpcUrl: "https://rpc.example",
      provider: "provider",
      address: "Program111",
      timeoutMs: 1_000,
      retries: 0,
      fetchImpl: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: [{ signature: "latest", slot: 123_450, blockTime: 1_700_000_000 }]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    });

    expect(activity).toEqual({ signature: "latest", slot: 123_450, blockTime: 1_700_000_000 });
    expect(requests).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "getSignaturesForAddress",
        params: ["Program111", { limit: 1, commitment: "confirmed" }]
      }
    ]);
  });

  it("rejects HTTP-success JSON-RPC activity errors instead of reporting a quiet program", async () => {
    await expect(
      fetchLatestSolanaAddressActivity({
        rpcUrl: "https://rpc.example",
        provider: "provider",
        address: "Program111",
        timeoutMs: 1_000,
        retries: 0,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32005, message: "rate limited" }
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
      })
    ).rejects.toThrow("RPC error -32005: rate limited");
  });

  it("queries one exact signature through transaction history for finalized repair proof", async () => {
    const requests: unknown[] = [];
    const status = await fetchSolanaSignatureStatus({
      rpcUrl: "https://rpc.example",
      provider: "provider",
      signature: "repair-target",
      timeoutMs: 1_000,
      retries: 0,
      fetchImpl: async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              value: [
                { slot: 123_400, confirmations: null, err: null, confirmationStatus: "finalized" }
              ]
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    });

    expect(status).toEqual({ slot: 123_400, confirmationStatus: "finalized", succeeded: true });
    expect(requests).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "getSignatureStatuses",
        params: [["repair-target"], { searchTransactionHistory: true }]
      }
    ]);
  });
});

function healthySource(
  provider: string,
  checkedSlot: number,
  sourceSlot: number,
  websocketMessageCount: number
): FakeSource {
  return new FakeSource(provider, {
    lastWebsocketContextSlot: sourceSlot,
    lastWebsocketMessageAt: "2026-08-21T00:00:00.000Z",
    websocketMessageCount,
    websocketNotificationCount: websocketMessageCount,
    lastProviderLatencyMs: Math.max(0, checkedSlot - sourceSlot)
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("condition not reached");
}
