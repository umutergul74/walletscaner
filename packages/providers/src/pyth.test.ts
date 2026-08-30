import { describe, expect, it, vi } from "vitest";
import { PythPriceClient } from "./pyth";

const feedId = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

function response(publishTime: number) {
  return new Response(JSON.stringify({
    parsed: [{
      id: feedId,
      price: { price: "15025000000", conf: "10000000", expo: -8, publish_time: publishTime },
      metadata: { slot: 42 }
    }]
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("PythPriceClient", () => {
  it("parses fixed-point latest prices and validates freshness", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response(1_000));
    const client = new PythPriceClient({
      apiKey: "test-only",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date(1_030_000),
      maxStalenessSeconds: 60
    });
    const quote = await client.latest(feedId);

    expect(quote).toMatchObject({ priceUsd: 150.25, confidenceUsd: 0.1, slot: 42 });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("ids%5B%5D=");
  });

  it("uses the benchmarks endpoint for historical timestamps", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response(950));
    const client = new PythPriceClient({
      apiKey: "test-only",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date(2_000_000)
    });
    const quote = await client.historical(feedId, 940, 60);

    expect(quote.source).toBe("pyth-benchmarks");
    expect(quote.requestedTime).toBe(940);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/v1/updates/price/940?");
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain("/940/60");
  });

  it("rejects stale latest prices", async () => {
    const client = new PythPriceClient({
      apiKey: "test-only",
      fetchImpl: (async () => response(1_000)) as typeof fetch,
      now: () => new Date(1_200_000),
      maxStalenessSeconds: 60
    });
    await expect(client.latest(feedId)).rejects.toThrow("stale");
  });

  it("makes no requests without credentials and exposes the missing dependency", async () => {
    const fetchImpl = vi.fn();
    const client = new PythPriceClient({ fetchImpl });
    await expect(client.latest(feedId)).rejects.toThrow("missing-api-key");
    await expect(client.historical(feedId, 940)).rejects.toThrow("missing-api-key");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.diagnostics()).toMatchObject({ status: "missing-api-key", requestCount: 0, suppressedCount: 2 });
  });

  it.each([[401, 900_000, "authentication"], [403, 900_000, "authentication"],
    [429, 60_000, "rate-limited"], [503, 5_000, "unavailable"]] as const)(
    "shares a bounded circuit across latest/historical after HTTP %i", async (status, delay, code) => {
      let nowMs = 1_030_000;
      const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("private provider body", { status }))
        .mockImplementation(async () => response(Math.floor(nowMs / 1000)));
      const client = new PythPriceClient({ apiKey: "test-only", fetchImpl, now: () => new Date(nowMs) });
      await expect(client.latest(feedId)).rejects.toThrow(code);
      await expect(client.historical(feedId, 940)).rejects.toThrow(code);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(client.diagnostics()).toMatchObject({ errorCount: 1, backoffRemainingMs: delay });
      expect(JSON.stringify(client.diagnostics())).not.toContain("test-only");
      nowMs += delay;
      await expect(client.latest(feedId)).resolves.toMatchObject({ priceUsd: 150.25 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(client.diagnostics()).toMatchObject({ status: "ready", consecutiveFailures: 0 });
      const headers = fetchImpl.mock.calls[0]?.[1]?.headers;
      expect(headers.Authorization).toBe("Bearer test-only");
    }
  );

  it("bounds an unresponsive provider with one aborted request", async () => {
    const fetchImpl = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const client = new PythPriceClient({ apiKey: "test-only", fetchImpl, timeoutMs: 100 });
    await expect(client.latest(feedId)).rejects.toThrow("unavailable");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects negative confidence, fractional time and invalid slots", async () => {
    for (const patch of [{ conf: "-1" }, { publish_time: 1000.5 }, { slot: -1 }]) {
      const body = await response(1000).json();
      Object.assign(body.parsed[0].price, patch);
      if ("slot" in patch) body.parsed[0].metadata.slot = patch.slot;
      const client = new PythPriceClient({ apiKey: "test-only", now: () => new Date(1_030_000),
        fetchImpl: async () => new Response(JSON.stringify(body)) });
      await expect(client.latest(feedId)).rejects.toThrow("invalid fixed-point");
    }
  });
});
