import { describe, expect, it } from "vitest";
import {
  HeliusTransactionEventSource,
  SolanaEventNotAcceptedError,
  StandardSolanaEventSource,
  type SolanaChainEvent,
  type SolanaCursor,
  type SolanaCursorStore,
  type DurableSolanaGapRepairStore,
  type DurableSolanaSignatureItem,
  type DurableSolanaSignatureStore,
  type SolanaGapRepairSession,
  type SolanaGapRepairSignatureItem
} from "./solana-event-source";

class MemoryCursorStore implements SolanaCursorStore {
  readonly values = new Map<string, SolanaCursor>();

  async get(address: string): Promise<SolanaCursor | undefined> {
    return this.values.get(address);
  }

  async save(address: string, cursor: SolanaCursor): Promise<void> {
    this.values.set(address, cursor);
  }
}

class MemoryLiveSignatureStore implements DurableSolanaSignatureStore {
  readonly values = new Map<
    string,
    DurableSolanaSignatureItem & { status: "pending" | "completed" }
  >();

  async admitSolanaSignature(item: DurableSolanaSignatureItem): Promise<boolean> {
    const key = `${item.provider}:${item.address}:${item.signature}`;
    const existing = this.values.get(key);
    if (existing) return existing.status === "pending";
    this.values.set(key, { ...item, status: "pending" });
    return true;
  }

  async listPendingSolanaSignatures(
    provider: string,
    address: string,
    limit: number
  ): Promise<DurableSolanaSignatureItem[]> {
    return [...this.values.values()]
      .filter(
        (item) =>
          item.provider === provider && item.address === address && item.status === "pending"
      )
      .sort(
        (left, right) => left.slot - right.slot || left.signature.localeCompare(right.signature)
      )
      .slice(0, limit)
      .map(({ status: _status, ...item }) => item);
  }

  async completeSolanaSignature(
    provider: string,
    address: string,
    signature: string
  ): Promise<boolean> {
    const key = `${provider}:${address}:${signature}`;
    const existing = this.values.get(key);
    if (!existing || existing.status !== "pending") return false;
    this.values.set(key, { ...existing, status: "completed" });
    return true;
  }
}

class MemoryGapRepairStore implements DurableSolanaGapRepairStore {
  readonly repairs = new Map<string, SolanaGapRepairSession>();
  readonly signatures = new Map<
    string,
    SolanaGapRepairSignatureItem & { status: "pending" | "completed" }
  >();

  async getOrCreateIngestionGapRepair(
    input: Parameters<DurableSolanaGapRepairStore["getOrCreateIngestionGapRepair"]>[0]
  ): Promise<SolanaGapRepairSession> {
    const active = [...this.repairs.values()].find(
      (repair) =>
        repair.incidentId === input.incidentId &&
        (repair.status === "collecting" || repair.status === "replaying")
    );
    if (active) return { ...active };
    const existing = this.repairs.get(input.repairId);
    if (existing) return { ...existing };
    const created: SolanaGapRepairSession = {
      ...input,
      status: "collecting",
      boundaryReached: false,
      fetchedSignatureCount: 0,
      completedSignatureCount: 0,
      collectionAttemptCount: 0,
      replayAttemptCount: 0
    };
    this.repairs.set(input.repairId, created);
    return { ...created };
  }

  async stageIngestionGapRepairPage(
    input: Parameters<DurableSolanaGapRepairStore["stageIngestionGapRepairPage"]>[0]
  ): Promise<SolanaGapRepairSession> {
    const repair = this.repairs.get(input.repairId)!;
    for (const item of input.signatures) {
      const key = `${input.repairId}:${item.signature}`;
      if (!this.signatures.has(key)) {
        this.signatures.set(key, { ...item, repairId: input.repairId, status: "pending" });
      }
    }
    const updated: SolanaGapRepairSession = {
      ...repair,
      ...(repair.targetSignature
        ? {}
        : input.targetSignature && input.targetSlot !== undefined
          ? { targetSignature: input.targetSignature, targetSlot: input.targetSlot }
          : {}),
      ...(input.beforeSignature ? { beforeSignature: input.beforeSignature } : {}),
      status: input.boundaryReached ? "replaying" : "collecting",
      boundaryReached: input.boundaryReached,
      fetchedSignatureCount: [...this.signatures.values()].filter(
        (item) => item.repairId === input.repairId
      ).length,
      collectionAttemptCount: repair.collectionAttemptCount + 1
    };
    this.repairs.set(input.repairId, updated);
    return { ...updated };
  }

  async listPendingIngestionGapRepairSignatures(
    repairId: string,
    limit: number
  ): Promise<SolanaGapRepairSignatureItem[]> {
    return [...this.signatures.values()]
      .filter((item) => item.repairId === repairId && item.status === "pending")
      .sort((left, right) => right.positionFromHead - left.positionFromHead)
      .slice(0, limit)
      .map(({ status: _status, ...item }) => item);
  }

  async completeIngestionGapRepairSignature(repairId: string, signature: string): Promise<boolean> {
    const key = `${repairId}:${signature}`;
    const item = this.signatures.get(key);
    const repair = this.repairs.get(repairId);
    if (!item || item.status !== "pending" || !repair) return false;
    this.signatures.set(key, { ...item, status: "completed" });
    this.repairs.set(repairId, {
      ...repair,
      completedSignatureCount: repair.completedSignatureCount + 1,
      replayAttemptCount: repair.replayAttemptCount + 1
    });
    return true;
  }

  async recordIngestionGapRepairError(
    repairId: string,
    phase: "collection" | "replay",
    error: string
  ): Promise<boolean> {
    const repair = this.repairs.get(repairId);
    if (!repair) return false;
    this.repairs.set(repairId, {
      ...repair,
      collectionAttemptCount: repair.collectionAttemptCount + (phase === "collection" ? 1 : 0),
      replayAttemptCount: repair.replayAttemptCount + (phase === "replay" ? 1 : 0),
      status: error.startsWith("gap-repair-signature-cap-") ? "failed" : repair.status,
      lastError: error
    });
    return true;
  }

  async completeIngestionGapRepair(
    repairId: string,
    coveredThrough: { signature: string; slot: number }
  ): Promise<boolean> {
    const repair = this.repairs.get(repairId);
    if (!repair) return false;
    if (
      !repair.targetSignature ||
      repair.targetSlot === undefined ||
      repair.targetSignature !== coveredThrough.signature ||
      repair.targetSlot !== coveredThrough.slot
    ) {
      return false;
    }
    if (
      [...this.signatures.values()].some(
        (item) => item.repairId === repairId && item.status === "pending"
      )
    ) {
      return false;
    }
    this.repairs.set(repairId, {
      ...repair,
      status: "completed",
      coveredThroughSignature: coveredThrough.signature,
      coveredThroughSlot: coveredThrough.slot
    });
    return true;
  }
}

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer | Blob }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onpong: (() => void) | null = null;
  readonly sent: string[] = [];

  send(data: string) {
    this.sent.push(data);
  }

  close() {}

  open() {
    this.onopen?.();
  }

  message(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  messageData(data: string | ArrayBuffer | Blob) {
    this.onmessage?.({ data });
  }

  disconnect() {
    this.onclose?.();
  }
}

describe("StandardSolanaEventSource", () => {
  it("backfills from a cursor oldest-first and advances the cursor", async () => {
    const cursorStore = new MemoryCursorStore();
    cursorStore.values.set("Program111", { signature: "sig-old", slot: 10 });
    const requests: Array<{ method: string; params: unknown[] }> = [];
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      requests.push(request);
      const result =
        request.method === "getSignaturesForAddress"
          ? [
              { signature: "sig-3", slot: 13 },
              { signature: "sig-2", slot: 12 }
            ]
          : {
              blockTime: 1_700_000_000,
              transaction: { message: { instructions: [] } },
              meta: {}
            };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["Program111"],
      cursorStore,
      fetchImpl,
      now: () => new Date("2026-07-05T00:00:00.000Z")
    });
    const events: SolanaChainEvent[] = [];

    await source.backfill("Program111", (event) => {
      events.push(event);
    });

    expect(events.map((event) => event.signature)).toEqual(["sig-2", "sig-3"]);
    expect(cursorStore.values.get("Program111")).toEqual({
      signature: "sig-3",
      slot: 13,
      occurredAt: "2023-11-14T22:13:20.000Z"
    });
    expect(requests[0]?.params).toEqual([
      "Program111",
      expect.objectContaining({ until: "sig-old", commitment: "confirmed" })
    ]);
    expect(source.getDiagnostics().backfillEventCount).toBe(2);
  });

  it("fails a truncated bounded backfill closed without advancing the durable cursor", async () => {
    const cursorStore = new MemoryCursorStore();
    cursorStore.values.set("Program111", {
      signature: "sig-old",
      slot: 10,
      updatedAt: "2026-08-20T23:55:00.000Z"
    });
    let transactionRequests = 0;
    const truncations: Array<{
      address: string;
      reason: string;
      fetchedSignatureCount: number;
      limit: number;
    }> = [];
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["Program111"],
      cursorStore,
      backfillPageLimit: 5,
      maxBackfillPages: 1,
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        if (request.method === "getTransaction") transactionRequests += 1;
        const result = Array.from({ length: 5 }, (_, index) => ({
          signature: `sig-${index + 1}`,
          slot: 20 - index
        }));
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      },
      onBackfillTruncated: async (truncation) => {
        await Promise.resolve();
        truncations.push(truncation);
      },
      now: () => new Date("2026-08-21T00:00:00.000Z")
    });

    await expect(source.backfill("Program111", () => undefined)).resolves.toBe(0);

    expect(transactionRequests).toBe(0);
    expect(cursorStore.values.get("Program111")).toEqual({
      signature: "sig-old",
      slot: 10,
      updatedAt: "2026-08-20T23:55:00.000Z"
    });
    expect(source.getDiagnostics()).toMatchObject({
      status: "degraded",
      backfillTruncatedCount: 1,
      backfillTruncatedAddressCount: 1,
      lastBackfillTruncatedCursorAt: "2026-08-20T23:55:00.000Z",
      lastBackfillTruncatedCursorSlot: 10
    });
    expect(truncations).toEqual([
      {
        address: "Program111",
        reason: "cursor-boundary-not-reached",
        fetchedSignatureCount: 5,
        limit: 5
      }
    ]);
  });

  it("repairs a reconnect gap across bounded pages and preserves oldest-first admission", async () => {
    const cursorStore = new MemoryCursorStore();
    cursorStore.values.set("LaunchLab111", {
      signature: "cursor-old",
      slot: 10,
      occurredAt: "2026-08-23T21:00:00.000Z"
    });
    const signatureOptions: Array<{ before?: string; until?: string; limit?: number }> = [];
    let signatureRequests = 0;
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["LaunchLab111"],
      cursorStore,
      backfillPageLimit: 2,
      maxBackfillPages: 2,
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          method: string;
          params: unknown[];
        };
        let result: unknown;
        if (request.method === "getSignaturesForAddress") {
          signatureOptions.push(request.params[1] as { before?: string; until?: string });
          signatureRequests += 1;
          result =
            signatureRequests === 1
              ? [
                  { signature: "sig-4", slot: 14 },
                  { signature: "sig-3", slot: 13 }
                ]
              : signatureRequests === 2
                ? [
                    { signature: "sig-2", slot: 12 },
                    { signature: "sig-1", slot: 11 }
                  ]
                : [];
        } else {
          result = {
            blockTime: 1_700_000_000,
            transaction: { message: { instructions: [] } },
            meta: {}
          };
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    });
    const events: string[] = [];

    await expect(
      source.backfill("LaunchLab111", (event) => {
        events.push(event.signature);
      })
    ).resolves.toBe(4);

    expect(signatureOptions).toEqual([
      expect.objectContaining({ limit: 2, until: "cursor-old" }),
      expect.objectContaining({ limit: 2, until: "cursor-old", before: "sig-3" }),
      expect.objectContaining({ limit: 1, until: "cursor-old", before: "sig-1" })
    ]);
    expect(events).toEqual(["sig-1", "sig-2", "sig-3", "sig-4"]);
    expect(cursorStore.values.get("LaunchLab111")).toEqual({
      signature: "sig-4",
      slot: 14,
      occurredAt: "2023-11-14T22:13:20.000Z"
    });
    expect(source.getDiagnostics()).toMatchObject({
      backfillEventCount: 4,
      backfillTruncatedCount: 0,
      backfillTruncatedAddressCount: 0
    });
  });

  it("persists a multi-cycle gap repair and replays oldest-first after a source restart", async () => {
    const cursorStore = new MemoryCursorStore();
    cursorStore.values.set("ProgramRepair111", {
      signature: "cursor-old",
      slot: 10,
      occurredAt: "2026-08-24T00:00:00.000Z"
    });
    const gapRepairStore = new MemoryGapRepairStore();
    const replayed: string[] = [];
    const signaturePages = new Map<string, Array<{ signature: string; slot: number }>>([
      [
        "head",
        [
          { signature: "sig-4", slot: 14 },
          { signature: "sig-3", slot: 13 }
        ]
      ],
      [
        "sig-3",
        [
          { signature: "sig-2", slot: 12 },
          { signature: "sig-1", slot: 11 }
        ]
      ],
      ["sig-1", []]
    ]);
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as {
        method: string;
        params: Array<unknown>;
      };
      const options = (request.params[1] ?? {}) as { before?: string; limit?: number };
      const result =
        request.method === "getSignaturesForAddress"
          ? (signaturePages.get(options.before ?? "head") ?? [])
          : {
              blockTime: 1_700_000_000,
              transaction: { message: { instructions: [] } },
              meta: {}
            };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const createSource = () =>
      new StandardSolanaEventSource({
        rpcUrl: "https://rpc.example",
        wsUrl: "wss://rpc.example",
        addresses: ["ProgramRepair111"],
        cursorStore,
        gapRepairStore,
        backfillPageLimit: 2,
        maxBackfillPages: 1,
        gapRepairReplayLimit: 2,
        fetchImpl,
        now: () => new Date("2026-08-24T00:10:00.000Z")
      });
    const firstSource = createSource();

    await expect(
      firstSource.repairGap(
        "ProgramRepair111",
        "incident-1",
        (event) => {
          replayed.push(event.signature);
        },
        { signature: "cursor-old", slot: 10, source: "truncation_cursor" }
      )
    ).resolves.toMatchObject({ status: "collecting", fetchedSignatureCount: 2 });
    expect(cursorStore.values.get("ProgramRepair111")?.signature).toBe("cursor-old");
    expect(replayed).toEqual([]);

    const resumedSource = createSource();
    await expect(
      resumedSource.repairGap(
        "ProgramRepair111",
        "incident-1",
        (event) => {
          replayed.push(event.signature);
        },
        { signature: "cursor-old", slot: 10, source: "truncation_cursor" }
      )
    ).resolves.toMatchObject({
      status: "replaying",
      fetchedSignatureCount: 4,
      completedSignatureCount: 2
    });
    expect(replayed).toEqual(["sig-1", "sig-2"]);
    expect(cursorStore.values.get("ProgramRepair111")?.signature).toBe("sig-2");

    await expect(
      resumedSource.repairGap(
        "ProgramRepair111",
        "incident-1",
        (event) => {
          replayed.push(event.signature);
        },
        { signature: "cursor-old", slot: 10, source: "truncation_cursor" }
      )
    ).resolves.toMatchObject({
      status: "completed",
      fetchedSignatureCount: 4,
      completedSignatureCount: 4,
      coveredThroughSignature: "sig-4",
      coveredThroughSlot: 14
    });
    expect(replayed).toEqual(["sig-1", "sig-2", "sig-3", "sig-4"]);
    expect(cursorStore.values.get("ProgramRepair111")?.signature).toBe("sig-4");
    expect(resumedSource.getDiagnostics()).toMatchObject({
      gapRepairCollectionCount: 1,
      gapRepairCompletionCount: 1,
      gapRepairReplayedSignatureCount: 4,
      lastGapRepairError: null
    });
  });

  it("fails a persisted replay that exceeds a lowered active repair cap without more RPC", async () => {
    const gapRepairStore = new MemoryGapRepairStore();
    gapRepairStore.repairs.set("persisted-over-cap", {
      repairId: "persisted-over-cap",
      incidentId: "incident-over-cap",
      provider: "solana-rpc",
      programAddress: "ProgramOverCap111",
      cursorSignature: "captured-cursor",
      cursorSlot: 10,
      boundarySource: "truncation_cursor",
      targetSignature: "repair-target",
      targetSlot: 14,
      status: "replaying",
      boundaryReached: true,
      fetchedSignatureCount: 4,
      completedSignatureCount: 1,
      collectionAttemptCount: 2,
      replayAttemptCount: 1
    });
    let rpcCalls = 0;
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["ProgramOverCap111"],
      cursorStore: new MemoryCursorStore(),
      gapRepairStore,
      gapRepairMaxSignatures: 3,
      fetchImpl: async () => {
        rpcCalls += 1;
        throw new Error("over-cap resume must not call RPC");
      }
    });

    await expect(
      source.repairGap("ProgramOverCap111", "incident-over-cap", () => undefined, {
        signature: "captured-cursor",
        slot: 10,
        source: "truncation_cursor"
      })
    ).resolves.toEqual({
      repairId: "persisted-over-cap",
      status: "blocked",
      fetchedSignatureCount: 4,
      completedSignatureCount: 1,
      error: "gap-repair-signature-cap-3"
    });
    expect(rpcCalls).toBe(0);
    expect(gapRepairStore.repairs.get("persisted-over-cap")).toMatchObject({
      status: "failed",
      replayAttemptCount: 2,
      lastError: "gap-repair-signature-cap-3"
    });
    expect(source.getDiagnostics().lastGapRepairError).toBe("gap-repair-signature-cap-3");
  });

  it("anchors repair to the captured truncation cursor even after the live cursor advances", async () => {
    const cursorStore = new MemoryCursorStore();
    cursorStore.values.set("ProgramSafeBoundary111", {
      signature: "live-cursor-already-ahead",
      slot: 99
    });
    const gapRepairStore = new MemoryGapRepairStore();
    const requestedUntil: string[] = [];
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["ProgramSafeBoundary111"],
      cursorStore,
      gapRepairStore,
      backfillPageLimit: 2,
      maxBackfillPages: 1,
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          method: string;
          params: [string, { limit: number; until: string }];
        };
        const options = request.params[1];
        requestedUntil.push(options.until);
        const result =
          options.limit === 1
            ? [{ signature: "still-older", slot: 11 }]
            : [
                { signature: "repair-head", slot: 13 },
                { signature: "repair-middle", slot: 12 }
              ];
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    });

    await expect(
      source.repairGap("ProgramSafeBoundary111", "incident-safe", () => undefined, {
        signature: "captured-truncation-cursor",
        slot: 10,
        source: "truncation_cursor"
      })
    ).resolves.toMatchObject({ status: "collecting", fetchedSignatureCount: 2 });
    expect(requestedUntil).toEqual(["captured-truncation-cursor", "captured-truncation-cursor"]);
    expect([...gapRepairStore.repairs.values()][0]).toMatchObject({
      cursorSignature: "captured-truncation-cursor",
      cursorSlot: 10,
      boundarySource: "truncation_cursor"
    });
  });

  it("completes against the immutable repair target when the live cursor advances concurrently", async () => {
    const cursorStore = new MemoryCursorStore();
    cursorStore.values.set("ProgramConcurrentCursor111", {
      signature: "captured-cursor",
      slot: 10
    });
    const gapRepairStore = new MemoryGapRepairStore();
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["ProgramConcurrentCursor111"],
      cursorStore,
      gapRepairStore,
      backfillPageLimit: 2,
      maxBackfillPages: 1,
      gapRepairReplayLimit: 2,
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          method: string;
          params?: [string, { limit?: number }];
        };
        const result =
          request.method === "getSignaturesForAddress"
            ? request.params?.[1]?.limit === 1
              ? []
              : [
                  { signature: "repair-target", slot: 12 },
                  { signature: "repair-oldest", slot: 11 }
                ]
            : { slot: 12, blockTime: 1_777_000_000, meta: {}, transaction: {} };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      },
      now: () => new Date("2026-08-24T00:10:00.000Z")
    });

    await expect(
      source.repairGap("ProgramConcurrentCursor111", "incident-concurrent", () => undefined, {
        signature: "captured-cursor",
        slot: 10,
        source: "truncation_cursor"
      })
    ).resolves.toMatchObject({ status: "completed", coveredThroughSignature: "repair-target" });

    cursorStore.values.set("ProgramConcurrentCursor111", {
      signature: "live-cursor-far-ahead",
      slot: 99
    });
    await expect(
      source.repairGap("ProgramConcurrentCursor111", "incident-concurrent", () => undefined, {
        signature: "captured-cursor",
        slot: 10,
        source: "truncation_cursor"
      })
    ).resolves.toMatchObject({
      status: "completed",
      coveredThroughSignature: "repair-target",
      coveredThroughSlot: 12
    });
  });

  it("does not start durable repair without an exact safe cursor boundary", async () => {
    let rpcCalls = 0;
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["ProgramNoBoundary111"],
      cursorStore: new MemoryCursorStore(),
      gapRepairStore: new MemoryGapRepairStore(),
      fetchImpl: async () => {
        rpcCalls += 1;
        throw new Error("RPC must not be called");
      }
    });

    await expect(
      source.repairGap("ProgramNoBoundary111", "incident-unsafe", () => undefined)
    ).resolves.toMatchObject({
      status: "unavailable",
      error: "safe-truncation-cursor-boundary-unavailable"
    });
    expect(rpcCalls).toBe(0);
  });

  it("fails a saturated cursorless initial page closed before fetching any transaction", async () => {
    const cursorStore = new MemoryCursorStore();
    let transactionRequests = 0;
    let callbackCompleted = false;
    const truncations: unknown[] = [];
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["PoolCursorless111"],
      cursorStore,
      initialBackfillLimit: 3,
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        if (request.method === "getTransaction") transactionRequests += 1;
        const result = Array.from({ length: 3 }, (_, index) => ({
          signature: `cursorless-${index}`,
          slot: 30 - index
        }));
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      },
      onBackfillTruncated: async (truncation) => {
        await Promise.resolve();
        truncations.push(truncation);
        callbackCompleted = true;
      }
    });

    await expect(source.backfill("PoolCursorless111", () => undefined)).resolves.toBe(0);

    expect(callbackCompleted).toBe(true);
    expect(transactionRequests).toBe(0);
    expect(cursorStore.values.has("PoolCursorless111")).toBe(false);
    expect(truncations).toEqual([
      {
        address: "PoolCursorless111",
        reason: "cursorless-initial-limit",
        fetchedSignatureCount: 3,
        limit: 3
      }
    ]);
    expect(source.getDiagnostics()).toMatchObject({
      status: "degraded",
      backfillTruncatedCount: 1,
      backfillTruncatedAddressCount: 1,
      lastBackfillTruncatedCursorAt: null,
      lastBackfillTruncatedCursorSlot: null
    });
    source.acknowledgeUnreconciledGap("PoolCursorless111");
    expect(source.getDiagnostics()).toMatchObject({
      status: "ok",
      backfillTruncatedCount: 1,
      backfillTruncatedAddressCount: 0
    });
  });

  it("emits a below-limit cursorless history oldest-first and saves its newest cursor", async () => {
    const cursorStore = new MemoryCursorStore();
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["PoolCursorless111"],
      cursorStore,
      initialBackfillLimit: 3,
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        const result =
          request.method === "getSignaturesForAddress"
            ? [
                { signature: "cursorless-new", slot: 32 },
                { signature: "cursorless-old", slot: 31 }
              ]
            : {
                blockTime: 1_700_000_000,
                transaction: { message: { instructions: [] } },
                meta: {}
              };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    });
    const events: string[] = [];

    await expect(
      source.backfill("PoolCursorless111", (event) => {
        events.push(event.signature);
      })
    ).resolves.toBe(2);

    expect(events).toEqual(["cursorless-old", "cursorless-new"]);
    expect(cursorStore.values.get("PoolCursorless111")).toEqual({
      signature: "cursorless-new",
      slot: 32,
      occurredAt: "2023-11-14T22:13:20.000Z"
    });
    expect(source.getDiagnostics()).toMatchObject({
      backfillEventCount: 2,
      backfillTruncatedCount: 0,
      backfillTruncatedAddressCount: 0
    });
  });

  it("accepts an exactly full final backfill page when the one-row boundary probe is empty", async () => {
    const cursorStore = new MemoryCursorStore();
    cursorStore.values.set("Program111", { signature: "sig-old", slot: 10 });
    let signatureRequests = 0;
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["Program111"],
      cursorStore,
      backfillPageLimit: 5,
      maxBackfillPages: 1,
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        let result: unknown;
        if (request.method === "getSignaturesForAddress") {
          signatureRequests += 1;
          result =
            signatureRequests === 1
              ? Array.from({ length: 5 }, (_, index) => ({
                  signature: `sig-${5 - index}`,
                  slot: 15 - index
                }))
              : [];
        } else {
          result = {
            blockTime: 1_700_000_000,
            transaction: { message: { instructions: [] } },
            meta: {}
          };
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    });
    const events: string[] = [];

    await expect(
      source.backfill("Program111", (event) => {
        events.push(event.signature);
      })
    ).resolves.toBe(5);

    expect(signatureRequests).toBe(2);
    expect(events).toEqual(["sig-1", "sig-2", "sig-3", "sig-4", "sig-5"]);
    expect(cursorStore.values.get("Program111")).toEqual({
      signature: "sig-5",
      slot: 15,
      occurredAt: "2023-11-14T22:13:20.000Z"
    });
    expect(source.getDiagnostics()).toMatchObject({
      backfillTruncatedCount: 0,
      backfillTruncatedAddressCount: 0
    });
  });

  it("does not advance a cursor when the durable event handler rejects admission", async () => {
    const cursorStore = new MemoryCursorStore();
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["Program111"],
      cursorStore,
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        const result =
          request.method === "getSignaturesForAddress"
            ? [{ signature: "paused-event", slot: 42 }]
            : {
                blockTime: 1_700_000_000,
                transaction: { message: { instructions: [] } },
                meta: {}
              };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    });

    await expect(
      source.backfill("Program111", () => {
        throw new SolanaEventNotAcceptedError("storage paused");
      })
    ).resolves.toBe(0);

    expect(cursorStore.values.has("Program111")).toBe(false);
    expect(source.getDiagnostics()).toMatchObject({
      handlerRejectedEventCount: 1,
      unresolvedTransactionCount: 0,
      seenSignatureCount: 0
    });
  });

  it("deduplicates live signatures and reconnects subscriptions", async () => {
    const cursorStore = new MemoryCursorStore();
    const sockets: FakeSocket[] = [];
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      const result =
        request.method === "getSignaturesForAddress"
          ? []
          : {
              blockTime: 1_700_000_000,
              transaction: { message: { instructions: [] } },
              meta: {}
            };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://api.mainnet-beta.solana.com",
      wsUrl: "wss://api.mainnet-beta.solana.com",
      addresses: ["Program111"],
      cursorStore,
      fetchImpl,
      reconnectDelayMs: 1,
      now: () => new Date(1_700_000_001_000),
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }
    });
    const events: SolanaChainEvent[] = [];
    await source.start((event) => {
      events.push(event);
    });
    sockets[0]!.open();
    sockets[0]!.message({ id: 1, result: 99 });
    expect(source.getDiagnostics().pendingSubscriptionRequestCount).toBe(0);
    const notification = {
      method: "logsNotification",
      params: {
        subscription: 99,
        result: {
          context: { slot: 55 },
          value: { signature: "sig-live", err: null }
        }
      }
    };
    sockets[0]!.message(notification);
    sockets[0]!.message(notification);
    await wait(10);

    expect(events).toHaveLength(1);
    expect(source.getDiagnostics()).toMatchObject({
      status: "ok",
      duplicateSignatureCount: 1,
      websocketMessageCount: 3
    });
    expect(source.getDiagnostics().websocketMessageBytes).toBeGreaterThan(0);

    sockets[0]!.disconnect();
    await wait(10);
    expect(sockets).toHaveLength(2);
    await source.stop();
  });

  it("backs off rapid standard websocket failures and resets only after a stable socket", async () => {
    const sockets: FakeSocket[] = [];
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: [],
      cursorStore: new MemoryCursorStore(),
      fetchImpl: async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }),
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectDelayMs: 5,
      reconnectMaxDelayMs: 20,
      reconnectStableAfterMs: 30,
      reconnectJitterRatio: 0
    });

    await source.start(() => undefined);
    sockets[0]!.open();
    expect(source.getDiagnostics()).toMatchObject({
      connectionState: "open",
      reconnectAttempt: 0,
      nextReconnectDelayMs: null
    });

    sockets[0]!.disconnect();
    expect(source.getDiagnostics()).toMatchObject({
      connectionState: "backoff",
      reconnectAttempt: 1,
      nextReconnectDelayMs: 5
    });
    await waitUntil(() => sockets.length === 2);
    sockets[1]!.open();
    sockets[1]!.disconnect();
    expect(source.getDiagnostics()).toMatchObject({
      connectionState: "backoff",
      reconnectAttempt: 2,
      nextReconnectDelayMs: 10
    });

    await waitUntil(() => sockets.length === 3);
    sockets[2]!.open();
    await waitUntil(() => source.getDiagnostics().reconnectAttempt === 0);
    expect(source.getDiagnostics()).toMatchObject({
      connectionState: "open",
      reconnectAttempt: 0,
      nextReconnectDelayMs: null
    });

    const reconnectCount = source.getDiagnostics().reconnectCount;
    sockets[0]!.disconnect();
    expect(source.getDiagnostics().reconnectCount).toBe(reconnectCount);

    sockets[2]!.disconnect();
    expect(source.getDiagnostics()).toMatchObject({
      connectionState: "backoff",
      reconnectAttempt: 1,
      nextReconnectDelayMs: 5
    });
    await source.stop();
    await wait(10);
    expect(sockets).toHaveLength(3);
    expect(source.getDiagnostics()).toMatchObject({
      connectionState: "stopped",
      reconnectAttempt: 0,
      nextReconnectDelayMs: null
    });
  });

  it("coalesces repeated automatic backfills during reconnect churn", async () => {
    const sockets: FakeSocket[] = [];
    const signatureRequestResolvers: Array<(response: Response) => void> = [];
    let signatureRequestCount = 0;
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["Program111"],
      cursorStore: new MemoryCursorStore(),
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        if (request.method !== "getSignaturesForAddress") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
        signatureRequestCount += 1;
        return new Promise<Response>((resolve) => signatureRequestResolvers.push(resolve));
      },
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectDelayMs: 1,
      reconnectMaxDelayMs: 1,
      reconnectStableAfterMs: 100,
      reconnectJitterRatio: 0
    });

    await source.start(() => undefined);
    sockets[0]!.open();
    await waitUntil(() => signatureRequestCount === 1);

    sockets[0]!.disconnect();
    await waitUntil(() => sockets.length === 2);
    sockets[1]!.open();
    sockets[1]!.disconnect();
    await waitUntil(() => sockets.length === 3);
    sockets[2]!.open();
    expect(signatureRequestCount).toBe(1);

    signatureRequestResolvers[0]!(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    await waitUntil(() => signatureRequestCount === 2);
    signatureRequestResolvers[1]!(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
    await wait(0);

    expect(signatureRequestCount).toBe(2);
    await source.stop();
  });

  it("bounds the standard RPC signature dedupe memory", async () => {
    const cursorStore = new MemoryCursorStore();
    const signatures = ["sig-1", "sig-2", "sig-3", "sig-3", "sig-1"];
    let backfillRequest = 0;
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      const result =
        request.method === "getSignaturesForAddress"
          ? [{ signature: signatures[backfillRequest++]!, slot: 100 + backfillRequest }]
          : {
              blockTime: 1_700_000_000,
              transaction: { message: { instructions: [] } },
              meta: {}
            };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["Program111"],
      cursorStore,
      fetchImpl,
      seenSignatureLimit: 2
    });
    const emitted: string[] = [];

    for (let index = 0; index < signatures.length; index += 1) {
      await source.backfill("Program111", (event) => {
        emitted.push(event.signature);
      });
    }

    expect(emitted).toEqual(["sig-1", "sig-2", "sig-3", "sig-1"]);
    expect(source.getDiagnostics()).toMatchObject({
      seenSignatureCount: 2,
      seenSignatureLimit: 2
    });
  });

  it("filters live notifications by program log before fetching transactions", async () => {
    const cursorStore = new MemoryCursorStore();
    const sockets: FakeSocket[] = [];
    let transactionRequests = 0;
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method === "getTransaction") transactionRequests += 1;
      const result =
        request.method === "getSignaturesForAddress"
          ? []
          : {
              blockTime: 1_700_000_000,
              transaction: { message: { instructions: [] } },
              meta: { logMessages: ["Program log: Instruction: Create"] }
            };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["Program111"],
      logIncludesByAddress: {
        Program111: [
          "Program log: Instruction: Create",
          "Program log: Instruction: Initialize(V2)+[Token]?"
        ]
      },
      cursorStore,
      fetchImpl,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }
    });

    await source.start(() => undefined);
    sockets[0]!.open();
    sockets[0]!.message({ id: 1, result: 99 });
    sockets[0]!.message({
      method: "logsNotification",
      params: {
        subscription: 99,
        result: {
          context: { slot: 55 },
          value: {
            signature: "buy-sig",
            err: null,
            logs: ["Program log: Instruction: CreateIdempotent"]
          }
        }
      }
    });
    sockets[0]!.message({
      method: "logsNotification",
      params: {
        subscription: 99,
        result: {
          context: { slot: 56 },
          value: {
            signature: "create-sig",
            err: null,
            logs: ["Program log: Instruction: Create"]
          }
        }
      }
    });
    sockets[0]!.message({
      method: "logsNotification",
      params: {
        subscription: 99,
        result: {
          context: { slot: 57 },
          value: {
            signature: "regex-literal-sig",
            err: null,
            logs: ["Program log: Instruction: Initialize(V2)+[Token]?"]
          }
        }
      }
    });
    await wait(10);

    expect(transactionRequests).toBe(2);
    expect(source.getDiagnostics()).toMatchObject({
      websocketMessageCount: 4,
      prefilteredWebsocketMessageCount: 1
    });
    expect(source.getDiagnostics().prefilteredWebsocketMessageBytes).toBeGreaterThan(0);
    expect(source.getDiagnostics().websocketMessageBytes).toBeGreaterThan(
      source.getDiagnostics().prefilteredWebsocketMessageBytes ?? 0
    );
    await source.stop();
  });

  it("captures raw slot and signature before negative-prefilter and failed-notification returns", async () => {
    const sockets: FakeSocket[] = [];
    let nowMs = Date.parse("2026-08-21T00:00:00.000Z");
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["Program111"],
      logIncludesByAddress: { Program111: ["Program log: Instruction: Create"] },
      cursorStore: new MemoryCursorStore(),
      fetchImpl: async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }),
      now: () => new Date(nowMs),
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }
    });

    await source.start(() => undefined);
    sockets[0]!.open();
    sockets[0]!.message({ id: 1, result: 99 });
    nowMs += 321;
    sockets[0]!.message({
      method: "logsNotification",
      params: {
        subscription: 99,
        result: {
          context: { slot: 345_678_901 },
          value: {
            signature: "irrelevant-sig",
            err: null,
            logs: ["Program log: Instruction: Swap"]
          }
        }
      }
    });

    expect(source.getDiagnostics()).toMatchObject({
      websocketMessageCount: 2,
      websocketNotificationCount: 1,
      prefilteredWebsocketMessageCount: 1,
      lastWebsocketMessageAt: new Date(nowMs).toISOString(),
      lastWebsocketContextSlot: 345_678_901,
      lastWebsocketSignature: "irrelevant-sig"
    });

    nowMs += 321;
    sockets[0]!.message({
      method: "logsNotification",
      params: {
        subscription: 99,
        result: {
          context: { slot: 345_678_901 },
          value: {
            signature: "failed-same-slot-sig",
            err: { InstructionError: [0, "Custom"] },
            logs: ["Program log: Instruction: Create"]
          }
        }
      }
    });
    expect(source.getDiagnostics()).toMatchObject({
      websocketMessageCount: 3,
      websocketNotificationCount: 2,
      prefilteredWebsocketMessageCount: 1,
      lastWebsocketMessageAt: new Date(nowMs).toISOString(),
      lastWebsocketContextSlot: 345_678_901,
      lastWebsocketSignature: "failed-same-slot-sig"
    });
    await source.stop();
  });

  it("fails subscription health closed after a bounded ACK timeout and recovers on late ACK", async () => {
    const sockets: FakeSocket[] = [];
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["Program111"],
      cursorStore: new MemoryCursorStore(),
      fetchImpl: async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }),
      subscriptionAckTimeoutMs: 5,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }
    });

    await source.start(() => undefined);
    sockets[0]!.open();
    await wait(10);
    expect(source.getDiagnostics()).toMatchObject({
      status: "degraded",
      configuredAddressCount: 1,
      subscribedAddressCount: 0,
      pendingSubscriptionRequestCount: 1,
      subscriptionAckTimeoutCount: 1,
      subscriptionAckTimedOutAddressCount: 1,
      successfulSubscriptionAckCount: 0,
      successfulSubscriptionAckAddressCount: 0,
      lastSubscriptionRequestAt: expect.any(String)
    });

    sockets[0]!.message({ id: 1, result: 99 });
    expect(source.getDiagnostics()).toMatchObject({
      status: "ok",
      subscribedAddressCount: 1,
      pendingSubscriptionRequestCount: 0,
      subscriptionAckTimedOutAddressCount: 0,
      // Cumulative evidence survives a late ACK even though the active timeout
      // set is now empty; the supervisor keys off this monotonic counter.
      subscriptionAckTimeoutCount: 1,
      successfulSubscriptionAckCount: 1,
      successfulSubscriptionAckAddressCount: 1
    });
    await source.stop();
  });

  it("ignores a delayed ACK from an obsolete websocket generation", async () => {
    const sockets: FakeSocket[] = [];
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["Program111"],
      cursorStore: new MemoryCursorStore(),
      reconnectDelayMs: 1,
      subscriptionAckTimeoutMs: 1_000,
      fetchImpl: async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }),
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }
    });

    await source.start(() => undefined);
    sockets[0]!.open();
    sockets[0]!.disconnect();
    await wait(10);
    sockets[1]!.open();

    sockets[0]!.message({ id: 1, result: 98 });
    expect(source.getDiagnostics()).toMatchObject({
      pendingSubscriptionRequestCount: 1,
      subscribedAddressCount: 0,
      successfulSubscriptionAckCount: 0
    });

    sockets[1]!.message({ id: 1, result: 99 });
    expect(source.getDiagnostics()).toMatchObject({
      pendingSubscriptionRequestCount: 0,
      subscribedAddressCount: 1,
      successfulSubscriptionAckCount: 1
    });
    await source.stop();
  });

  it("accepts a top-level target log and rejects a cross-program collision", async () => {
    const cursorStore = new MemoryCursorStore();
    cursorStore.values.set("Program111", { signature: "sig-old", slot: 10 });
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      const result =
        request.method === "getSignaturesForAddress"
          ? [
              { signature: "noise-newest", slot: 13 },
              { signature: "create-older", slot: 12 }
            ]
          : {
              blockTime: 1_700_000_000,
              transaction: { message: { instructions: [] } },
              meta: {
                logMessages:
                  request.params[0] === "create-older"
                    ? [
                        "Program Program111 invoke [1]",
                        "Program log: Instruction: Create",
                        "Program Program111 success"
                      ]
                    : [
                        "Program OtherProgram111 invoke [1]",
                        "Program log: Instruction: Create",
                        "Program OtherProgram111 success",
                        "Program Jupiter111 invoke [1]",
                        "Program Program111 invoke [2]",
                        "Program log: Instruction: Buy",
                        "Program Program111 success",
                        "Program Jupiter111 success"
                      ]
              }
            };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["Program111"],
      logIncludesByAddress: {
        Program111: ["Program log: Instruction: Create"]
      },
      cursorStore,
      fetchImpl,
      now: () => new Date("2026-07-05T00:00:00.000Z")
    });
    const events: SolanaChainEvent[] = [];

    await expect(
      source.backfill("Program111", (event) => {
        events.push(event);
      })
    ).resolves.toBe(1);

    expect(events.map((event) => event.signature)).toEqual(["create-older"]);
    expect(cursorStore.values.get("Program111")).toEqual({
      signature: "noise-newest",
      slot: 13,
      occurredAt: "2023-11-14T22:13:20.000Z"
    });
    expect(source.getDiagnostics()).toMatchObject({
      backfillEventCount: 1,
      postfetchFilteredTransactionCount: 1
    });
  });

  it("accepts a configured instruction log from an inner target-program invocation", async () => {
    const cursorStore = new MemoryCursorStore();
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      const result =
        request.method === "getSignaturesForAddress"
          ? [{ signature: "inner-create", slot: 14 }]
          : {
              blockTime: 1_700_000_000,
              transaction: { message: { instructions: [] } },
              meta: {
                logMessages: [
                  "Program Jupiter111 invoke [1]",
                  "Program Program111 invoke [2]",
                  "Program log: Instruction: Create",
                  "Program Program111 success",
                  "Program Jupiter111 success"
                ]
              }
            };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["Program111"],
      logIncludesByAddress: {
        Program111: ["Program log: Instruction: Create"]
      },
      cursorStore,
      fetchImpl
    });
    const events: SolanaChainEvent[] = [];

    await expect(
      source.backfill("Program111", (event) => {
        events.push(event);
      })
    ).resolves.toBe(1);

    expect(events.map((event) => event.signature)).toEqual(["inner-create"]);
    expect(source.getDiagnostics().postfetchFilteredTransactionCount).toBe(0);
  });

  it("keeps a completed target proof when a later unrelated log suffix is truncated", async () => {
    const cursorStore = new MemoryCursorStore();
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      const result =
        request.method === "getSignaturesForAddress"
          ? [{ signature: "completed-before-truncated-suffix", slot: 15 }]
          : {
              blockTime: 1_700_000_000,
              transaction: { message: { instructions: [] } },
              meta: {
                logMessages: [
                  "Program Program111 invoke [1]",
                  "Program log: Instruction: Create",
                  "Program Program111 success",
                  "Program Unrelated111 invoke [1]"
                ]
              }
            };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["Program111"],
      logIncludesByAddress: {
        Program111: ["Program log: Instruction: Create"]
      },
      cursorStore,
      fetchImpl
    });
    const events: SolanaChainEvent[] = [];

    await expect(
      source.backfill("Program111", (event) => {
        events.push(event);
      })
    ).resolves.toBe(1);

    expect(events.map((event) => event.signature)).toEqual(["completed-before-truncated-suffix"]);
    expect(source.getDiagnostics().postfetchFilteredTransactionCount).toBe(0);
  });

  it("does not prove a target instruction whose invocation completed with failure", async () => {
    const cursorStore = new MemoryCursorStore();
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      const result =
        request.method === "getSignaturesForAddress"
          ? [{ signature: "caught-target-failure", slot: 16 }]
          : {
              blockTime: 1_700_000_000,
              transaction: { message: { instructions: [] } },
              meta: {
                logMessages: [
                  "Program Program111 invoke [1]",
                  "Program log: Instruction: Create",
                  "Program Program111 failed: custom program error: 0x1"
                ]
              }
            };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["Program111"],
      logIncludesByAddress: {
        Program111: ["Program log: Instruction: Create"]
      },
      cursorStore,
      fetchImpl
    });

    await expect(source.backfill("Program111", () => undefined)).resolves.toBe(0);
    expect(source.getDiagnostics().postfetchFilteredTransactionCount).toBe(1);
  });

  it("rejects matching logs when the invocation stream is malformed or unbalanced", async () => {
    const cursorStore = new MemoryCursorStore();
    const logsBySignature: Record<string, string[]> = {
      "mismatched-completion": [
        "Program Program111 invoke [1]",
        "Program log: Instruction: Create",
        "Program OtherProgram111 success"
      ],
      "missing-completion": ["Program Program111 invoke [1]", "Program log: Instruction: Create"]
    };
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      const result =
        request.method === "getSignaturesForAddress"
          ? [
              { signature: "missing-completion", slot: 16 },
              { signature: "mismatched-completion", slot: 15 }
            ]
          : {
              blockTime: 1_700_000_000,
              transaction: { message: { instructions: [] } },
              meta: { logMessages: logsBySignature[String(request.params[0])] }
            };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["Program111"],
      logIncludesByAddress: {
        Program111: ["Program log: Instruction: Create"]
      },
      cursorStore,
      fetchImpl
    });
    const events: SolanaChainEvent[] = [];

    await expect(
      source.backfill("Program111", (event) => {
        events.push(event);
      })
    ).resolves.toBe(0);

    expect(events).toHaveLength(0);
    expect(cursorStore.values.get("Program111")).toEqual({
      signature: "missing-completion",
      slot: 16,
      occurredAt: "2023-11-14T22:13:20.000Z"
    });
    expect(source.getDiagnostics().postfetchFilteredTransactionCount).toBe(2);
  });

  it("subscribes to unfiltered dynamic pool addresses without backfilling them by default", async () => {
    const cursorStore = new MemoryCursorStore();
    const sockets: FakeSocket[] = [];
    const requests: string[] = [];
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      requests.push(request.method);
      const result =
        request.method === "getSignaturesForAddress"
          ? []
          : {
              blockTime: 1_700_000_000,
              transaction: { message: { instructions: [] } },
              meta: { logMessages: ["Program log: Instruction: Buy"] }
            };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["Program111"],
      cursorStore,
      fetchImpl,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }
    });
    const events: SolanaChainEvent[] = [];

    await source.start((event) => {
      events.push(event);
    });
    sockets[0]!.open();
    sockets[0]!.message({ id: 1, result: 99 });
    await source.subscribeAddress("Pool111", [], false);
    sockets[0]!.message({ id: 2, result: 100 });
    sockets[0]!.message({
      method: "logsNotification",
      params: {
        subscription: 100,
        result: {
          context: { slot: 56 },
          value: {
            signature: "pool-buy",
            err: null,
            logs: ["Program log: Instruction: Buy"]
          }
        }
      }
    });
    await wait(10);

    const subscribeRequest = JSON.parse(sockets[0]!.sent[1]!) as {
      method: string;
      params: unknown[];
    };
    expect(subscribeRequest.method).toBe("logsSubscribe");
    expect(subscribeRequest.params[0]).toEqual({ mentions: ["Pool111"] });
    expect(requests.filter((method) => method === "getSignaturesForAddress")).toHaveLength(1);
    expect(events.map((event) => event.address)).toEqual(["Pool111"]);
    expect(source.getDiagnostics().prefilteredWebsocketMessageCount).toBe(0);
    await source.stop();
  });

  it("keeps backfill alive when one transaction request fails", async () => {
    const cursorStore = new MemoryCursorStore();
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method === "getTransaction") {
        return new Response("bad request", { status: 400 });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: [{ signature: "bad-sig", slot: 77 }]
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }
      );
    };
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["Program111"],
      cursorStore,
      fetchImpl
    });

    await expect(source.backfill("Program111", () => undefined)).resolves.toBe(0);
    expect(source.getDiagnostics()).toMatchObject({
      status: "degraded",
      unresolvedTransactionCount: 1
    });
  });

  it("retries a signature when RPC has not resolved the transaction yet", async () => {
    const cursorStore = new MemoryCursorStore();
    let transactionRequests = 0;
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      let result: unknown;
      if (request.method === "getSignaturesForAddress") {
        result = [{ signature: "eventual-sig", slot: 77 }];
      } else {
        transactionRequests += 1;
        result =
          transactionRequests === 1
            ? null
            : {
                blockTime: 1_700_000_000,
                transaction: { message: { instructions: [] } },
                meta: {}
              };
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["Program111"],
      cursorStore,
      fetchImpl
    });
    const events: SolanaChainEvent[] = [];

    expect(
      await source.backfill("Program111", (event) => {
        events.push(event);
      })
    ).toBe(0);
    expect(
      await source.backfill("Program111", (event) => {
        events.push(event);
      })
    ).toBe(1);
    expect(events).toHaveLength(1);
    expect(source.getDiagnostics().unresolvedTransactionCount).toBe(1);
  });

  it("recovers a delayed transaction with bounded exponential retries", async () => {
    const cursorStore = new MemoryCursorStore();
    let transactionRequests = 0;
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      const result =
        request.method === "getSignaturesForAddress"
          ? [{ signature: "delayed-sig", slot: 88 }]
          : ++transactionRequests < 3
            ? null
            : {
                blockTime: 1_700_000_000,
                transaction: { message: { instructions: [] } },
                meta: {}
              };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["Program111"],
      cursorStore,
      fetchImpl,
      transactionFetchMaxAttempts: 3,
      transactionFetchRetryDelayMs: 1,
      transactionFetchRetryMaxDelayMs: 2
    });

    await expect(source.backfill("Program111", () => undefined)).resolves.toBe(1);
    expect(source.getDiagnostics()).toMatchObject({
      unresolvedTransactionCount: 0,
      transactionRequestCount: 3,
      transactionRetryCount: 2,
      recoveredTransactionCount: 1,
      inFlightSignatureCount: 0
    });
  });

  it("separates live websocket age, queue delay, and transaction resolution latency", async () => {
    const cursorStore = new MemoryCursorStore();
    const sockets: FakeSocket[] = [];
    const blockTime = 1_700_000_000;
    let nowMs = blockTime * 1_000 + 70_000;
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      const result =
        request.method === "getSignaturesForAddress"
          ? []
          : (() => {
              nowMs = blockTime * 1_000 + 72_000;
              return {
                blockTime,
                transaction: { message: { instructions: [] } },
                meta: {}
              };
            })();
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["Program111"],
      cursorStore,
      fetchImpl,
      providerLatencyWarningMs: 30_000,
      now: () => new Date(nowMs),
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }
    });
    const events: SolanaChainEvent[] = [];
    await source.start((event) => {
      events.push(event);
    });
    sockets[0]!.open();
    sockets[0]!.message({ id: 1, result: 99 });
    sockets[0]!.message({
      method: "logsNotification",
      params: {
        subscription: 99,
        result: {
          context: { slot: 55 },
          value: { signature: "late-live", err: null }
        }
      }
    });
    await wait(10);

    expect(events).toHaveLength(1);
    expect(events[0]?.observedAt).toBe(new Date(blockTime * 1_000 + 72_000).toISOString());
    expect(events[0]?.providerTiming).toEqual({
      origin: "live",
      fetchStartedAtMs: blockTime * 1_000 + 70_000,
      fetchCompletedAtMs: blockTime * 1_000 + 72_000,
      fetchCycleDurationMs: 2_000,
      transactionHttpDurationMs: 2_000,
      fetchAttempts: 1,
      notificationReceivedAtMs: blockTime * 1_000 + 70_000,
      queueDelayMs: 0
    });
    expect(source.getDiagnostics()).toMatchObject({
      status: "degraded",
      lastEventOrigin: "live",
      liveEventCount: 1,
      lastLiveProviderLatencyMs: 72_000,
      maxLiveProviderLatencyMs: 72_000,
      lastBackfillProviderLatencyMs: null,
      lastWebsocketNotificationAgeMs: 70_000,
      maxWebsocketNotificationAgeMs: 70_000,
      lastNotificationToObservedMs: 2_000,
      maxNotificationToObservedMs: 2_000,
      lastTransactionQueueDelayMs: 0,
      maxTransactionQueueDelayMs: 0,
      lastTransactionFetchCycleDurationMs: 2_000,
      maxTransactionFetchCycleDurationMs: 2_000,
      lastTransactionHttpDurationMs: 2_000,
      maxTransactionHttpDurationMs: 2_000,
      lastTransactionFetchAttempts: 1,
      slowLiveEventCount: 1,
      lastSlowLiveEventAt: new Date(blockTime * 1_000 + 72_000).toISOString()
    });
    await source.stop();
  });

  it("labels old backfill latency without treating it as a slow live provider event", async () => {
    const cursorStore = new MemoryCursorStore();
    const blockTime = 1_700_000_000;
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      const result =
        request.method === "getSignaturesForAddress"
          ? [{ signature: "old-backfill", slot: 55 }]
          : {
              blockTime,
              transaction: { message: { instructions: [] } },
              meta: {}
            };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["Program111"],
      cursorStore,
      fetchImpl,
      providerLatencyWarningMs: 30_000,
      now: () => new Date(blockTime * 1_000 + 120_000)
    });

    await expect(source.backfill("Program111", () => undefined)).resolves.toBe(1);
    expect(source.getDiagnostics()).toMatchObject({
      status: "ok",
      lastEventOrigin: "backfill",
      lastProviderLatencyMs: 120_000,
      lastBackfillProviderLatencyMs: 120_000,
      lastLiveProviderLatencyMs: null,
      lastWebsocketNotificationAgeMs: null,
      slowLiveEventCount: 0,
      lastSlowLiveEventAt: null
    });
  });

  it("bounds getTransaction HTTP hangs with an explicit timeout", async () => {
    const cursorStore = new MemoryCursorStore();
    const fetchImpl = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method === "getSignaturesForAddress") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: [{ signature: "hung-transaction", slot: 55 }]
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          )
        );
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            const error = new Error("request aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true }
        );
      });
    };
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["Program111"],
      cursorStore,
      fetchImpl,
      transactionFetchMaxAttempts: 1,
      transactionRequestTimeoutMs: 5,
      transactionRequestRetries: 0
    });

    await expect(source.backfill("Program111", () => undefined)).resolves.toBe(0);
    expect(source.getDiagnostics()).toMatchObject({
      status: "degraded",
      unresolvedTransactionCount: 1,
      transactionRequestCount: 1,
      transactionRequestErrorCount: 1,
      transactionRequestTimeoutCount: 1,
      transactionRequestTimeoutMs: 5,
      transactionRequestRetryLimit: 0,
      lastTransactionFetchAttempts: 1
    });
    expect(source.getDiagnostics().lastTransactionHttpDurationMs).toBeGreaterThanOrEqual(1);
  });

  it("bounds live transaction workers and queues excess signatures", async () => {
    const cursorStore = new MemoryCursorStore();
    const sockets: FakeSocket[] = [];
    let releaseTransactions: (() => void) | undefined;
    const transactionGate = new Promise<void>((resolve) => {
      releaseTransactions = resolve;
    });
    const queuePressure: Array<{
      reason: "stale" | "high-water" | "full";
      queuedSignatures: number;
    }> = [];
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      if (request.method === "getTransaction") await transactionGate;
      const result =
        request.method === "getSignaturesForAddress"
          ? []
          : {
              blockTime: 1_700_000_000,
              transaction: { message: { instructions: [] } },
              meta: {}
            };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["Program111"],
      cursorStore,
      fetchImpl,
      maxConcurrentTransactionFetches: 2,
      maxQueuedSignatures: 3,
      onQueuePressure: (pressure) => {
        queuePressure.push({
          reason: pressure.reason,
          queuedSignatures: pressure.queuedSignatures
        });
      },
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }
    });
    const events: SolanaChainEvent[] = [];
    await source.start((event) => {
      events.push(event);
    });
    sockets[0]!.open();
    sockets[0]!.message({ id: 1, result: 99 });

    for (let index = 0; index < 6; index += 1) {
      sockets[0]!.message({
        method: "logsNotification",
        params: {
          subscription: 99,
          result: {
            context: { slot: 100 + index },
            value: { signature: `queued-${index}`, err: null }
          }
        }
      });
    }
    await wait(10);

    expect(source.getDiagnostics()).toMatchObject({
      inFlightSignatureCount: 1,
      activeTransactionWorkerCount: 1,
      queuedSignatureCount: 3,
      maxConcurrentTransactionFetches: 2,
      maxQueuedSignatures: 3,
      droppedSignatureCount: 2,
      queuePressureCount: 2,
      queueHighWatermark: 3,
      status: "degraded"
    });
    expect(queuePressure).toEqual([
      { reason: "high-water", queuedSignatures: 3 },
      { reason: "full", queuedSignatures: 3 }
    ]);

    releaseTransactions?.();
    await wait(20);
    expect(events).toHaveLength(4);
    expect(source.getDiagnostics()).toMatchObject({
      inFlightSignatureCount: 0,
      activeTransactionWorkerCount: 0,
      queuedSignatureCount: 0
    });
    await source.stop();
  });

  it("reports a stale ordered live queue before depth pressure can hide latency", async () => {
    const cursorStore = new MemoryCursorStore();
    const socket = new FakeSocket();
    let nowMs = 1_700_000_000_000;
    let releaseFirstTransaction: (() => void) | undefined;
    const firstTransactionGate = new Promise<void>((resolve) => {
      releaseFirstTransaction = resolve;
    });
    let transactionRequestCount = 0;
    const pressure: Array<{ reason: string; queuedSignatures: number }> = [];
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["PoolStale111"],
      cursorStore,
      now: () => new Date(nowMs),
      maximumLiveQueueDelayMs: 1_000,
      maxQueuedSignatures: 10,
      queuePressureRatio: 0.8,
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        if (request.method === "getTransaction") {
          transactionRequestCount += 1;
          if (transactionRequestCount === 1) await firstTransactionGate;
        }
        const result =
          request.method === "getSignaturesForAddress"
            ? []
            : {
                blockTime: 1_700_000_000,
                transaction: { message: { instructions: [] } },
                meta: {}
              };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      },
      onQueuePressure: (event) => {
        pressure.push({
          reason: event.reason,
          queuedSignatures: event.queuedSignatures
        });
      },
      webSocketFactory: () => socket
    });
    const accepted: string[] = [];
    await source.start((event) => {
      accepted.push(event.signature);
    });
    socket.open();
    socket.message({ id: 1, result: 99 });
    socket.message(standardLogNotification(99, "stale-head", 100));
    socket.message(standardLogNotification(99, "stale-queued", 101));
    await waitUntil(
      () =>
        source.getDiagnostics().activeTransactionWorkerCount === 1 &&
        source.getDiagnostics().queuedSignatureCount === 1
    );

    nowMs += 1_001;
    releaseFirstTransaction?.();
    await waitUntil(() => source.getDiagnostics().activeTransactionWorkerCount === 0);

    expect(pressure).toEqual([{ reason: "stale", queuedSignatures: 1 }]);
    expect(accepted).toEqual(["stale-head", "stale-queued"]);
    expect(source.getDiagnostics()).toMatchObject({
      maximumLiveQueueDelayMs: 1_000,
      lastTransactionQueueDelayMs: 1_001,
      maxTransactionQueueDelayMs: 1_001,
      queuePressureCount: 1,
      droppedSignatureCount: 0,
      queuedSignatureCount: 0
    });
    await source.stop();
  });

  it("fires the stale queue watchdog while the admitted address head is still blocked", async () => {
    const cursorStore = new MemoryCursorStore();
    const socket = new FakeSocket();
    let releaseFirstTransaction: (() => void) | undefined;
    const firstTransactionGate = new Promise<void>((resolve) => {
      releaseFirstTransaction = resolve;
    });
    let transactionRequestCount = 0;
    const pressure: Array<{
      reason: string;
      queuedSignatures: number;
      oldestQueueDelayMs?: number;
    }> = [];
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["PoolWatchdog111"],
      cursorStore,
      maximumLiveQueueDelayMs: 25,
      maxQueuedSignatures: 10,
      queuePressureRatio: 0.8,
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        if (request.method === "getTransaction") {
          transactionRequestCount += 1;
          if (transactionRequestCount === 1) await firstTransactionGate;
        }
        const result =
          request.method === "getSignaturesForAddress"
            ? []
            : {
                blockTime: 1_700_000_000,
                transaction: { message: { instructions: [] } },
                meta: {}
              };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      },
      onQueuePressure: (event) => {
        pressure.push({
          reason: event.reason,
          queuedSignatures: event.queuedSignatures,
          ...(event.oldestQueueDelayMs === undefined
            ? {}
            : { oldestQueueDelayMs: event.oldestQueueDelayMs })
        });
        source.unsubscribeAddress(event.address);
      },
      webSocketFactory: () => socket
    });
    const accepted: string[] = [];
    await source.start((event) => {
      accepted.push(event.signature);
    });
    socket.open();
    socket.message({ id: 1, result: 99 });
    socket.message(standardLogNotification(99, "watchdog-head", 100));
    socket.message(standardLogNotification(99, "watchdog-queued", 101));
    await waitUntil(
      () =>
        source.getDiagnostics().activeTransactionWorkerCount === 1 &&
        source.getDiagnostics().queuedSignatureCount === 1
    );

    await waitUntil(() => pressure.length === 1);

    expect(pressure[0]).toMatchObject({
      reason: "stale",
      queuedSignatures: 1
    });
    expect(pressure[0]!.oldestQueueDelayMs).toBeGreaterThanOrEqual(25);
    expect(accepted).toEqual([]);
    expect(source.getDiagnostics()).toMatchObject({
      maximumLiveQueueDelayMs: 25,
      lastQueuePressureReason: "stale",
      purgedSignatureCount: 1,
      queuedSignatureCount: 0,
      activeTransactionWorkerCount: 1
    });
    expect(source.getDiagnostics().lastQueuePressureDelayMs).toBeGreaterThanOrEqual(25);

    releaseFirstTransaction?.();
    await waitUntil(() => source.getDiagnostics().activeTransactionWorkerCount === 0);
    expect(accepted).toEqual(["watchdog-head"]);
    await source.stop();
  });

  it("purges queued work for an unsubscribed address without cancelling the admitted head", async () => {
    const cursorStore = new MemoryCursorStore();
    const socket = new FakeSocket();
    let releaseTransaction: (() => void) | undefined;
    const transactionGate = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["PoolUnsubscribe111"],
      cursorStore,
      maxQueuedSignatures: 10,
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        if (request.method === "getTransaction") await transactionGate;
        const result =
          request.method === "getSignaturesForAddress"
            ? []
            : {
                blockTime: 1_700_000_000,
                transaction: { message: { instructions: [] } },
                meta: {}
              };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      },
      webSocketFactory: () => socket
    });
    const events: SolanaChainEvent[] = [];
    await source.start((event) => {
      events.push(event);
    });
    socket.open();
    socket.message({ id: 1, result: 99 });
    for (let index = 0; index < 4; index += 1) {
      socket.message(standardLogNotification(99, `unsubscribe-${index}`, 200 + index));
    }
    await wait(10);
    expect(source.getDiagnostics()).toMatchObject({
      activeTransactionWorkerCount: 1,
      queuedSignatureCount: 3,
      purgedSignatureCount: 0
    });

    source.unsubscribeAddress("PoolUnsubscribe111");
    expect(source.getDiagnostics()).toMatchObject({
      configuredAddressCount: 0,
      subscribedAddressCount: 0,
      activeTransactionWorkerCount: 1,
      queuedSignatureCount: 0,
      purgedSignatureCount: 3
    });

    releaseTransaction?.();
    await waitUntil(() => source.getDiagnostics().activeTransactionWorkerCount === 0);
    expect(events.map((event) => event.signature)).toEqual(["unsubscribe-0"]);
    await source.stop();
  });

  it("durably defers queue overflow and drains one address with bounded concurrency", async () => {
    const cursorStore = new MemoryCursorStore();
    const liveSignatureStore = new MemoryLiveSignatureStore();
    const socket = new FakeSocket();
    let releaseTransactions: (() => void) | undefined;
    const transactionGate = new Promise<void>((resolve) => {
      releaseTransactions = resolve;
    });
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["ProgramDurable111"],
      cursorStore,
      liveSignatureStore,
      allowConcurrentLiveSignaturesPerAddress: true,
      maxConcurrentTransactionFetches: 2,
      maxQueuedSignatures: 2,
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        if (request.method === "getTransaction") await transactionGate;
        const result =
          request.method === "getSignaturesForAddress"
            ? []
            : {
                blockTime: 1_700_000_000,
                transaction: { message: { instructions: [] } },
                meta: {}
              };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      },
      webSocketFactory: () => socket
    });
    const accepted: string[] = [];
    await source.start((event) => {
      accepted.push(event.signature);
    });
    socket.open();
    socket.message({ id: 1, result: 99 });
    for (let index = 0; index < 6; index += 1) {
      socket.message(standardLogNotification(99, `durable-${index}`, 100 + index));
    }
    await waitUntil(
      () =>
        [...liveSignatureStore.values.values()].filter((item) => item.status === "pending")
          .length === 6
    );
    await waitUntil(() => source.getDiagnostics().activeTransactionWorkerCount === 2);

    expect(source.getDiagnostics()).toMatchObject({
      activeTransactionWorkerCount: 2,
      droppedSignatureCount: 0,
      durableSignatureAdmissionErrorCount: 0
    });
    releaseTransactions?.();
    await waitUntil(() => accepted.length === 6);
    await waitUntil(() =>
      [...liveSignatureStore.values.values()].every((item) => item.status === "completed")
    );
    expect(new Set(accepted)).toEqual(
      new Set(Array.from({ length: 6 }, (_, index) => `durable-${index}`))
    );
    expect(source.getDiagnostics()).toMatchObject({
      droppedSignatureCount: 0,
      durableSignatureAdmissionCount: 6,
      activeTransactionWorkerCount: 0
    });
    await source.stop();
  });

  it("reloads a pending durable signature before opening the websocket", async () => {
    const cursorStore = new MemoryCursorStore();
    const liveSignatureStore = new MemoryLiveSignatureStore();
    await liveSignatureStore.admitSolanaSignature({
      provider: "solana-rpc",
      address: "ProgramReplay111",
      signature: "pending-before-restart",
      slot: 77,
      notifiedAt: "2026-08-23T00:00:00.000Z"
    });
    const accepted: string[] = [];
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["ProgramReplay111"],
      cursorStore,
      liveSignatureStore,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              blockTime: 1_700_000_000,
              transaction: { message: { instructions: [] } },
              meta: {}
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
      webSocketFactory: () => new FakeSocket()
    });

    await source.start((event) => {
      accepted.push(event.signature);
    });
    await waitUntil(() => accepted.length === 1);
    expect(accepted).toEqual(["pending-before-restart"]);
    expect(source.getDiagnostics()).toMatchObject({
      durableSignatureReloadCount: 1,
      droppedSignatureCount: 0
    });
    await source.stop();
  });

  it("holds later live cursors behind a storage admission rejection", async () => {
    const cursorStore = new MemoryCursorStore();
    const socket = new FakeSocket();
    const transactionRequests: string[] = [];
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      if (request.method === "getTransaction") transactionRequests.push(String(request.params[0]));
      const result =
        request.method === "getSignaturesForAddress"
          ? []
          : {
              blockTime: 1_700_000_000,
              transaction: { message: { instructions: [] } },
              meta: {}
            };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    let admissionOpen = false;
    const accepted: string[] = [];
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["ProgramAdmission111"],
      cursorStore,
      fetchImpl,
      maxConcurrentTransactionFetches: 2,
      handlerRejectionRetryDelayMs: 5,
      webSocketFactory: () => socket
    });
    await source.start((event) => {
      if (!admissionOpen) throw new SolanaEventNotAcceptedError("storage paused");
      accepted.push(event.signature);
    });
    socket.open();
    socket.message({ id: 1, result: 99 });
    for (const [signature, slot] of [
      ["admission-first", 100],
      ["admission-second", 101]
    ] as const) {
      socket.message({
        method: "logsNotification",
        params: { subscription: 99, result: { context: { slot }, value: { signature, err: null } } }
      });
    }
    await wait(3);
    expect(transactionRequests).toEqual(["admission-first"]);
    expect(cursorStore.values.has("ProgramAdmission111")).toBe(false);

    admissionOpen = true;
    await waitUntil(() => accepted.length === 2);
    expect(accepted).toEqual(["admission-first", "admission-second"]);
    expect(cursorStore.values.get("ProgramAdmission111")).toMatchObject({
      signature: "admission-second",
      slot: 101
    });
    expect(source.getDiagnostics()).toMatchObject({ handlerRejectedEventCount: 1 });
    await source.stop();
  });

  it("blocks a later live cursor until an unresolved transaction becomes available", async () => {
    const cursorStore = new MemoryCursorStore();
    const socket = new FakeSocket();
    const transactionRequests: string[] = [];
    let firstAvailable = false;
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["ProgramRpcBarrier111"],
      cursorStore,
      transactionFetchMaxAttempts: 1,
      handlerRejectionRetryDelayMs: 50,
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        let result: unknown = [];
        if (request.method === "getTransaction") {
          const signature = String(request.params[0]);
          transactionRequests.push(signature);
          result =
            signature === "rpc-barrier-first" && !firstAvailable
              ? null
              : {
                  blockTime: 1_700_000_000,
                  transaction: { message: { instructions: [] } },
                  meta: {}
                };
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      },
      webSocketFactory: () => socket
    });
    const accepted: string[] = [];
    await source.start((event) => {
      accepted.push(event.signature);
    });
    socket.open();
    socket.message({ id: 1, result: 99 });
    socket.message(standardLogNotification(99, "rpc-barrier-first", 100));
    socket.message(standardLogNotification(99, "rpc-barrier-second", 101));

    await wait(5);
    expect(transactionRequests).toEqual(["rpc-barrier-first"]);
    expect(accepted).toEqual([]);
    expect(cursorStore.values.has("ProgramRpcBarrier111")).toBe(false);

    firstAvailable = true;
    await waitUntil(() => accepted.length === 2);
    expect(accepted).toEqual(["rpc-barrier-first", "rpc-barrier-second"]);
    expect(cursorStore.values.get("ProgramRpcBarrier111")).toMatchObject({
      signature: "rpc-barrier-second",
      slot: 101
    });
    await source.stop();
  });

  it("blocks a later live cursor while a generic durable-handler failure retries", async () => {
    const cursorStore = new MemoryCursorStore();
    const socket = new FakeSocket();
    let firstHandlerHealthy = false;
    const accepted: string[] = [];
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["ProgramHandlerBarrier111"],
      cursorStore,
      handlerRejectionRetryDelayMs: 50,
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        const result =
          request.method === "getSignaturesForAddress"
            ? []
            : {
                blockTime: 1_700_000_000,
                transaction: { message: { instructions: [] } },
                meta: {}
              };
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      },
      webSocketFactory: () => socket
    });
    await source.start((event) => {
      if (event.signature === "handler-barrier-first" && !firstHandlerHealthy) {
        throw new Error("temporary database failure");
      }
      accepted.push(event.signature);
    });
    socket.open();
    socket.message({ id: 1, result: 99 });
    socket.message(standardLogNotification(99, "handler-barrier-first", 200));
    socket.message(standardLogNotification(99, "handler-barrier-second", 201));

    await wait(5);
    expect(accepted).toEqual([]);
    expect(cursorStore.values.has("ProgramHandlerBarrier111")).toBe(false);

    firstHandlerHealthy = true;
    await waitUntil(() => accepted.length === 2);
    expect(accepted).toEqual(["handler-barrier-first", "handler-barrier-second"]);
    expect(cursorStore.values.get("ProgramHandlerBarrier111")).toMatchObject({
      signature: "handler-barrier-second",
      slot: 201
    });
    expect(source.getDiagnostics().unresolvedTransactionCount).toBe(1);
    await source.stop();
  });

  it("keeps a quiet standard websocket alive with an acknowledged application heartbeat", async () => {
    const socket = new FakeSocket();
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["QuietHeartbeat111"],
      cursorStore: new MemoryCursorStore(),
      fetchImpl: async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }),
      webSocketFactory: () => socket,
      heartbeatIntervalMs: 15,
      heartbeatTimeoutMs: 30,
      now: () => new Date("2026-08-24T06:00:00.000Z")
    });
    await source.start(() => undefined);
    socket.open();
    await wait(0);
    const subscription = socket.sent
      .map((message) => JSON.parse(message) as { id: number; method: string })
      .find((request) => request.method === "logsSubscribe")!;
    socket.message({ id: subscription.id, result: 77 });

    await waitUntil(() =>
      socket.sent.some(
        (message) => (JSON.parse(message) as { method?: string }).method === "getHealth"
      )
    );
    const heartbeat = socket.sent
      .map((message) => JSON.parse(message) as { id: number; method: string })
      .find((request) => request.method === "getHealth")!;
    socket.message({ jsonrpc: "2.0", id: heartbeat.id, result: "ok" });

    expect(source.getDiagnostics()).toMatchObject({
      status: "ok",
      heartbeatTimeoutCount: 0,
      lastPingAt: "2026-08-24T06:00:00.000Z",
      lastPongAt: "2026-08-24T06:00:00.000Z"
    });
    await source.stop();
  });

  it("fences and reconnects a standard websocket that misses its heartbeat deadline", async () => {
    const sockets: FakeSocket[] = [];
    const source = new StandardSolanaEventSource({
      rpcUrl: "https://rpc.example",
      wsUrl: "wss://rpc.example",
      addresses: ["HeartbeatTimeout111"],
      cursorStore: new MemoryCursorStore(),
      fetchImpl: async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }),
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 10,
      reconnectDelayMs: 1
    });
    await source.start(() => undefined);
    sockets[0]!.open();

    await waitUntil(() => sockets.length === 2);
    expect(source.getDiagnostics()).toMatchObject({
      status: "degraded",
      heartbeatTimeoutCount: 1,
      reconnectCount: 1
    });
    await source.stop();
  });
});

describe("HeliusTransactionEventSource", () => {
  it("emits full transaction notifications without a live getTransaction request", async () => {
    const cursorStore = new MemoryCursorStore();
    const sockets: FakeSocket[] = [];
    const rpcMethods: string[] = [];
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      rpcMethods.push(request.method);
      const result = request.method === "getSignaturesForAddress" ? [] : 1_700_000_000;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };
    const source = new HeliusTransactionEventSource({
      rpcUrl: "https://mainnet.helius-rpc.com/?api-key=test",
      wsUrl: "wss://mainnet.helius-rpc.com/?api-key=test",
      addresses: ["Pool111"],
      cursorStore,
      fetchImpl,
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 10_000
    });
    const events: SolanaChainEvent[] = [];
    await source.start((event) => {
      events.push(event);
    });
    sockets[0]!.open();
    await wait(0);
    const subscribe = sockets[0]!.sent
      .map((message) => JSON.parse(message) as { id: number; method: string; params: unknown[] })
      .find((request) => request.method === "transactionSubscribe")!;
    sockets[0]!.message({ id: subscribe.id, result: 77 });
    sockets[0]!.message({
      method: "transactionNotification",
      params: {
        subscription: 77,
        result: {
          signature: "helius-live-sig",
          slot: 55,
          transactionIndex: 3,
          blockTime: 1_700_000_000,
          transaction: {
            transaction: {
              signatures: ["helius-live-sig"],
              message: { accountKeys: ["Pool111", "Wallet111"] }
            },
            meta: { logMessages: ["Program log: Instruction: Swap"] }
          }
        }
      }
    });
    await wait(10);

    expect(events).toEqual([
      expect.objectContaining({
        address: "Pool111",
        matchedAddresses: ["Pool111"],
        signature: "helius-live-sig",
        slot: 55,
        transactionIndex: 3,
        occurredAt: "2023-11-14T22:13:20.000Z",
        source: "helius-transaction-subscribe"
      })
    ]);
    expect(cursorStore.values.get("Pool111")).toEqual({
      signature: "helius-live-sig",
      slot: 55,
      occurredAt: "2023-11-14T22:13:20.000Z"
    });
    expect(rpcMethods).not.toContain("getTransaction");
    expect(source.getDiagnostics()).toMatchObject({
      status: "ok",
      activeSubscriptionCount: 1,
      lastEventSlot: 55
    });
    await source.stop();
  });

  it("chunks accountInclude filters at the configured provider limit", async () => {
    const cursorStore = new MemoryCursorStore();
    const socket = new FakeSocket();
    const source = new HeliusTransactionEventSource({
      rpcUrl: "https://mainnet.helius-rpc.com/?api-key=test",
      wsUrl: "wss://mainnet.helius-rpc.com/?api-key=test",
      addresses: ["Pool1", "Pool2", "Pool3"],
      cursorStore,
      accountIncludeChunkSize: 2,
      fetchImpl: async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }),
      webSocketFactory: () => socket,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 10_000
    });

    await source.start(() => undefined);
    socket.open();
    await wait(0);
    const subscriptions = socket.sent
      .map(
        (message) =>
          JSON.parse(message) as {
            method: string;
            params: [{ accountInclude: string[] }];
          }
      )
      .filter((request) => request.method === "transactionSubscribe");

    expect(subscriptions.map((request) => request.params[0].accountInclude)).toEqual([
      ["Pool1", "Pool2"],
      ["Pool3"]
    ]);
    expect(source.getDiagnostics()).toMatchObject({
      subscribedAddressCount: 3,
      pendingSubscriptionCount: 2
    });
    await source.stop();
  });

  it("does not advance a live cursor until chain time is resolved", async () => {
    const cursorStore = new MemoryCursorStore();
    const socket = new FakeSocket();
    const source = new HeliusTransactionEventSource({
      rpcUrl: "https://mainnet.helius-rpc.com/?api-key=test",
      wsUrl: "wss://mainnet.helius-rpc.com/?api-key=test",
      addresses: ["PoolNoTime"],
      cursorStore,
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        const result = request.method === "getSignaturesForAddress" ? [] : null;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      },
      webSocketFactory: () => socket,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 10_000
    });
    const events: SolanaChainEvent[] = [];

    await source.start((event) => {
      events.push(event);
    });
    socket.open();
    await wait(0);
    const subscribe = socket.sent
      .map((message) => JSON.parse(message) as { id: number; method: string })
      .find((request) => request.method === "transactionSubscribe")!;
    socket.message({ id: subscribe.id, result: 88 });
    socket.message({
      method: "transactionNotification",
      params: {
        subscription: 88,
        result: {
          signature: "missing-time",
          slot: 99,
          transaction: {
            transaction: { message: { accountKeys: ["PoolNoTime"] } },
            meta: {}
          }
        }
      }
    });
    await wait(10);

    expect(events).toEqual([]);
    expect(cursorStore.values.has("PoolNoTime")).toBe(false);
    expect(source.getDiagnostics()).toMatchObject({
      status: "degraded",
      unresolvedBlockTimeCount: 1
    });
    await source.stop();
  });

  it("surfaces free-plan entitlement failures and disables further gap repair", async () => {
    const socket = new FakeSocket();
    const source = new HeliusTransactionEventSource({
      rpcUrl: "https://mainnet.helius-rpc.com/?api-key=test",
      wsUrl: "wss://mainnet.helius-rpc.com/?api-key=test",
      addresses: ["PoolFreePlan"],
      cursorStore: new MemoryCursorStore(),
      fetchImpl: async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }),
      webSocketFactory: () => socket,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 10_000
    });

    await source.start(() => undefined);
    socket.open();
    await wait(0);
    const subscribe = socket.sent
      .map((message) => JSON.parse(message) as { id: number; method: string })
      .find((request) => request.method === "transactionSubscribe")!;
    socket.message({
      id: subscribe.id,
      error: {
        code: -32600,
        message: "transactionSubscribe is not available on the free plan"
      }
    });
    await wait(0);

    expect(source.getDiagnostics()).toMatchObject({
      status: "degraded",
      activeSubscriptionCount: 0,
      subscriptionErrorCount: 1,
      subscriptionUnavailableReason: "transactionSubscribe is not available on the free plan",
      lastSubscriptionErrorCode: -32600
    });
    await source.stop();
  });

  it("holds later Helius events behind a storage admission rejection", async () => {
    const cursorStore = new MemoryCursorStore();
    const socket = new FakeSocket();
    let admissionOpen = false;
    const accepted: string[] = [];
    const source = new HeliusTransactionEventSource({
      rpcUrl: "https://mainnet.helius-rpc.com/?api-key=test",
      wsUrl: "wss://mainnet.helius-rpc.com/?api-key=test",
      addresses: ["HeliusAdmission111"],
      cursorStore,
      fetchImpl: async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }),
      webSocketFactory: () => socket,
      handlerRejectionRetryDelayMs: 5,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 10_000
    });
    await source.start((event) => {
      if (!admissionOpen) throw new SolanaEventNotAcceptedError("storage paused");
      accepted.push(event.signature);
    });
    socket.open();
    await wait(0);
    const subscribe = socket.sent
      .map((message) => JSON.parse(message) as { id: number; method: string })
      .find((request) => request.method === "transactionSubscribe")!;
    socket.message({ id: subscribe.id, result: 77 });
    for (const [signature, slot] of [
      ["helius-admission-first", 100],
      ["helius-admission-second", 101]
    ] as const) {
      socket.message({
        method: "transactionNotification",
        params: {
          subscription: 77,
          result: {
            signature,
            slot,
            blockTime: 1_700_000_000,
            transaction: {
              transaction: { message: { accountKeys: ["HeliusAdmission111"] } },
              meta: {}
            }
          }
        }
      });
    }
    await wait(3);
    expect(cursorStore.values.has("HeliusAdmission111")).toBe(false);
    admissionOpen = true;
    await waitUntil(() => accepted.length === 2);
    expect(accepted).toEqual(["helius-admission-first", "helius-admission-second"]);
    expect(cursorStore.values.get("HeliusAdmission111")).toMatchObject({
      signature: "helius-admission-second",
      slot: 101
    });
    await source.stop();
  });

  it("blocks a later Helius cursor until missing block time resolves in address order", async () => {
    const cursorStore = new MemoryCursorStore();
    const socket = new FakeSocket();
    let firstBlockTimeAvailable = false;
    const source = new HeliusTransactionEventSource({
      rpcUrl: "https://mainnet.helius-rpc.com/?api-key=test",
      wsUrl: "wss://mainnet.helius-rpc.com/?api-key=test",
      addresses: ["HeliusRpcBarrier111"],
      cursorStore,
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        const result =
          request.method === "getSignaturesForAddress"
            ? []
            : firstBlockTimeAvailable
              ? 1_700_000_000
              : null;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      },
      webSocketFactory: () => socket,
      handlerRejectionRetryDelayMs: 50,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 10_000
    });
    const accepted: string[] = [];
    await source.start((event) => {
      accepted.push(event.signature);
    });
    socket.open();
    await wait(0);
    const subscribe = socket.sent
      .map((message) => JSON.parse(message) as { id: number; method: string })
      .find((request) => request.method === "transactionSubscribe")!;
    socket.message({ id: subscribe.id, result: 77 });
    socket.message(
      heliusTransactionNotification(77, "HeliusRpcBarrier111", "helius-rpc-first", 100)
    );
    socket.message(
      heliusTransactionNotification(
        77,
        "HeliusRpcBarrier111",
        "helius-rpc-second",
        101,
        1_700_000_000
      )
    );

    await wait(5);
    expect(accepted).toEqual([]);
    expect(cursorStore.values.has("HeliusRpcBarrier111")).toBe(false);

    firstBlockTimeAvailable = true;
    await waitUntil(() => accepted.length === 2);
    expect(accepted).toEqual(["helius-rpc-first", "helius-rpc-second"]);
    expect(cursorStore.values.get("HeliusRpcBarrier111")).toMatchObject({
      signature: "helius-rpc-second",
      slot: 101
    });
    await source.stop();
  });

  it("blocks a later Helius cursor while a generic durable-handler failure retries", async () => {
    const cursorStore = new MemoryCursorStore();
    const socket = new FakeSocket();
    let firstHandlerHealthy = false;
    const accepted: string[] = [];
    const source = new HeliusTransactionEventSource({
      rpcUrl: "https://mainnet.helius-rpc.com/?api-key=test",
      wsUrl: "wss://mainnet.helius-rpc.com/?api-key=test",
      addresses: ["HeliusHandlerBarrier111"],
      cursorStore,
      fetchImpl: async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }),
      webSocketFactory: () => socket,
      handlerRejectionRetryDelayMs: 50,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 10_000
    });
    await source.start((event) => {
      if (event.signature === "helius-handler-first" && !firstHandlerHealthy) {
        throw new Error("temporary database failure");
      }
      accepted.push(event.signature);
    });
    socket.open();
    await wait(0);
    const subscribe = socket.sent
      .map((message) => JSON.parse(message) as { id: number; method: string })
      .find((request) => request.method === "transactionSubscribe")!;
    socket.message({ id: subscribe.id, result: 77 });
    socket.message(
      heliusTransactionNotification(
        77,
        "HeliusHandlerBarrier111",
        "helius-handler-first",
        200,
        1_700_000_000
      )
    );
    socket.message(
      heliusTransactionNotification(
        77,
        "HeliusHandlerBarrier111",
        "helius-handler-second",
        201,
        1_700_000_000
      )
    );

    await wait(5);
    expect(accepted).toEqual([]);
    expect(cursorStore.values.has("HeliusHandlerBarrier111")).toBe(false);

    firstHandlerHealthy = true;
    await waitUntil(() => accepted.length === 2);
    expect(accepted).toEqual(["helius-handler-first", "helius-handler-second"]);
    expect(cursorStore.values.get("HeliusHandlerBarrier111")).toMatchObject({
      signature: "helius-handler-second",
      slot: 201
    });
    expect(source.getDiagnostics().unresolvedTransactionCount).toBe(1);
    await source.stop();
  });

  it("ignores a delayed acknowledgement from an obsolete Helius socket", async () => {
    const sockets: FakeSocket[] = [];
    let resolveOldMessage: ((value: string) => void) | undefined;
    const delayedText = new Promise<string>((resolve) => {
      resolveOldMessage = resolve;
    });
    const source = new HeliusTransactionEventSource({
      rpcUrl: "https://mainnet.helius-rpc.com/?api-key=test",
      wsUrl: "wss://mainnet.helius-rpc.com/?api-key=test",
      addresses: ["HeliusFence111"],
      cursorStore: new MemoryCursorStore(),
      fetchImpl: async () =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        }),
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectInitialDelayMs: 1,
      reconnectMaxDelayMs: 1,
      reconnectJitterRatio: 0,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 10_000
    });
    await source.start(() => undefined);
    sockets[0]!.open();
    sockets[0]!.messageData({ text: () => delayedText } as Blob);
    sockets[0]!.disconnect();
    await waitUntil(() => sockets.length === 2);
    sockets[1]!.open();
    await wait(0);
    const subscribe = sockets[1]!.sent
      .map((message) => JSON.parse(message) as { id: number; method: string })
      .find((request) => request.method === "transactionSubscribe")!;
    resolveOldMessage?.(JSON.stringify({ id: subscribe.id, result: 999 }));
    await wait(5);
    sockets[0]!.onerror?.();
    expect(source.getDiagnostics()).toMatchObject({
      connectionState: "open",
      activeSubscriptionCount: 0,
      pendingSubscriptionCount: 1
    });
    sockets[1]!.message({ id: subscribe.id, result: 1_000 });
    await wait(0);
    expect(source.getDiagnostics()).toMatchObject({
      activeSubscriptionCount: 1,
      pendingSubscriptionCount: 0
    });
    await source.stop();
  });

  it("keeps Helius truncation degraded independently per address", async () => {
    const cursorStore = new MemoryCursorStore();
    cursorStore.values.set("TruncatedA111", { signature: "cursor-a", slot: 10 });
    cursorStore.values.set("HealthyB111", { signature: "cursor-b", slot: 20 });
    const source = new HeliusTransactionEventSource({
      rpcUrl: "https://mainnet.helius-rpc.com/?api-key=test",
      wsUrl: "wss://mainnet.helius-rpc.com/?api-key=test",
      addresses: ["TruncatedA111", "HealthyB111"],
      cursorStore,
      backfillPageLimit: 1,
      maxBackfillPages: 1,
      fetchImpl: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        const [address, options] = request.params as [string, { before?: string }];
        const result =
          request.method !== "getSignaturesForAddress" || address === "HealthyB111"
            ? []
            : options.before
              ? [{ signature: "still-before-cursor", slot: 8 }]
              : [{ signature: "newer-than-cursor", slot: 11 }];
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    });

    await expect(source.backfill("TruncatedA111", () => undefined)).resolves.toBe(0);
    expect(source.getDiagnostics()).toMatchObject({
      status: "degraded",
      backfillTruncatedAddressCount: 1
    });
    await expect(source.backfill("HealthyB111", () => undefined)).resolves.toBe(0);
    expect(source.getDiagnostics()).toMatchObject({
      status: "degraded",
      backfillTruncatedAddressCount: 1
    });
    source.unsubscribeAddress("TruncatedA111");
    expect(source.getDiagnostics().backfillTruncatedAddressCount).toBe(0);
  });
});

function standardLogNotification(subscription: number, signature: string, slot: number) {
  return {
    method: "logsNotification",
    params: {
      subscription,
      result: {
        context: { slot },
        value: { signature, err: null }
      }
    }
  };
}

function heliusTransactionNotification(
  subscription: number,
  address: string,
  signature: string,
  slot: number,
  blockTime?: number
) {
  return {
    method: "transactionNotification",
    params: {
      subscription,
      result: {
        signature,
        slot,
        ...(blockTime !== undefined ? { blockTime } : {}),
        transaction: {
          transaction: { message: { accountKeys: [address] } },
          meta: {}
        }
      }
    }
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await wait(2);
  }
  throw new Error("condition not reached");
}
