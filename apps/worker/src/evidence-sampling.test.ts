import { describe, expect, it } from "vitest";
import {
  chunksOf,
  compactDexScreenerPair,
  dexScreenerObservationSignature,
  sampleBucketStart
} from "./evidence-sampling";

describe("evidence sampling", () => {
  it("uses deterministic UTC buckets for retry-safe observation keys", () => {
    expect(sampleBucketStart(new Date("2026-07-15T12:34:59.999Z"), 120)).toBe(
      "2026-07-15T12:34:00.000Z"
    );
  });

  it("shares one durable observation key across writers for the same pool and bucket", () => {
    const bucketStart = "2026-07-15T12:34:00.000Z";
    expect(dexScreenerObservationSignature("Pool111", "Token111", bucketStart)).toBe(
      "dexscreener-observation:Pool111:2026-07-15T12:34:00.000Z"
    );
    expect(dexScreenerObservationSignature(undefined, "Token111", bucketStart)).toBe(
      "dexscreener-observation:Token111:2026-07-15T12:34:00.000Z"
    );
  });

  it("keeps compact market audit fields and drops large provider payload sections", () => {
    const compact = compactDexScreenerPair({
      chainId: "solana",
      dexId: "pumpfun",
      pairAddress: "Pool111",
      baseToken: { address: "Token111" },
      quoteToken: { address: "So111" },
      priceUsd: "0.001",
      liquidity: { usd: 12_000 },
      volume: { m5: 500, h1: 4_000 },
      txns: { m5: { buys: 10, sells: 2 } },
      fdv: 100_000,
      marketCap: 90_000,
      pairCreatedAt: 1_700_000_000_000,
      info: { imageUrl: "large-provider-field" }
    });

    expect(compact).toMatchObject({
      pairAddress: "Pool111",
      priceUsd: "0.001",
      liquidityUsd: 12_000,
      volume1hUsd: 4_000,
      buys5m: 10,
      fdv: 100_000,
      marketCap: 90_000
    });
    expect(compact).not.toHaveProperty("info");
  });

  it("chunks DexScreener requests within its 30-token API limit", () => {
    expect(
      chunksOf(
        Array.from({ length: 61 }, (_, index) => index),
        30
      ).map((part) => part.length)
    ).toEqual([30, 30, 1]);
  });
});
