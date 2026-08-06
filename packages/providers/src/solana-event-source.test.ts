import { describe, expect, it } from "vitest";
import {
  HeliusTransactionEventSource,
  StandardSolanaEventSource,
  type SolanaChainEvent,
  type SolanaCursor,
  type SolanaCursorStore
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

class FakeSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer | Blob }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
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
    expect(cursorStore.values.get("Program111")).toEqual({ signature: "sig-3", slot: 13 });
    expect(requests[0]?.params).toEqual([
      "Program111",
      expect.objectContaining({ until: "sig-old", commitment: "confirmed" })
    ]);
    expect(source.getDiagnostics().backfillEventCount).toBe(2);
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
      logIncludesByAddress: {
        Program111: ["Program log: Instruction: Create"]
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
    await wait(10);

    expect(transactionRequests).toBe(1);
    await source.stop();
  });

  it("subscribes to dynamic pool addresses without backfilling them by default", async () => {
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
    await source.subscribeAddress("Pool111", ["Program log: Instruction: Buy"], false);
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

  it("bounds live transaction workers and queues excess signatures", async () => {
    const cursorStore = new MemoryCursorStore();
    const sockets: FakeSocket[] = [];
    let releaseTransactions: (() => void) | undefined;
    const transactionGate = new Promise<void>((resolve) => {
      releaseTransactions = resolve;
    });
    const queuePressure: Array<{ reason: "high-water" | "full"; queuedSignatures: number }> = [];
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
      inFlightSignatureCount: 2,
      activeTransactionWorkerCount: 2,
      queuedSignatureCount: 3,
      maxConcurrentTransactionFetches: 2,
      maxQueuedSignatures: 3,
      droppedSignatureCount: 1,
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
    expect(events).toHaveLength(5);
    expect(source.getDiagnostics()).toMatchObject({
      inFlightSignatureCount: 0,
      activeTransactionWorkerCount: 0,
      queuedSignatureCount: 0
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
      slot: 55
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
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
