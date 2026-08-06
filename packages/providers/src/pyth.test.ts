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
      fetchImpl: (async () => response(1_000)) as typeof fetch,
      now: () => new Date(1_200_000),
      maxStalenessSeconds: 60
    });
    await expect(client.latest(feedId)).rejects.toThrow("stale");
  });
});
