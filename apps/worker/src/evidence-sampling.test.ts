import { describe, expect, it } from "vitest";
import {
  chunksOf,
  classifyMissingExactPair,
  compactDexScreenerPair,
  dexScreenerObservationSignature,
  groupEvidenceMarkets,
  sampleBucketStart,
  selectEvidencePair,
  shouldPersistOutcomeTransition,
  walletOutcomeLifecycleKey
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

  it("fails closed when the entry's exact pool is absent", () => {
    const pairs = [
      {
        pairAddress: "PoolOther",
        baseToken: { address: "Token111" },
        liquidity: { usd: 1_000_000 }
      },
      {
        pairAddress: "PoolExact",
        baseToken: { address: "Token111" },
        liquidity: { usd: 10_000 }
      }
    ];

    expect(selectEvidencePair(pairs, "PoolExact")?.pairAddress).toBe("PoolExact");
    expect(selectEvidencePair(pairs, "PoolMissing")).toBeUndefined();
    expect(selectEvidencePair(pairs)?.pairAddress).toBe("PoolOther");
  });

  it("keeps same-mint entries separated by exact execution pool", () => {
    const groups = groupEvidenceMarkets([
      { id: "a", tokenAddress: "Token111", poolAddress: "PoolA" },
      { id: "b", tokenAddress: "Token111", poolAddress: "PoolB" },
      { id: "c", tokenAddress: "Token111", poolAddress: "PoolA" },
      { id: "d", tokenAddress: "Token222" }
    ]);

    expect(groups).toEqual([
      {
        tokenAddress: "Token111",
        poolAddress: "PoolA",
        entries: [
          { id: "a", tokenAddress: "Token111", poolAddress: "PoolA" },
          { id: "c", tokenAddress: "Token111", poolAddress: "PoolA" }
        ]
      },
      {
        tokenAddress: "Token111",
        poolAddress: "PoolB",
        entries: [{ id: "b", tokenAddress: "Token111", poolAddress: "PoolB" }]
      },
      {
        tokenAddress: "Token222",
        entries: [{ id: "d", tokenAddress: "Token222" }]
      }
    ]);
  });

  it("queues only monotonic outcome lifecycle transitions", () => {
    expect(shouldPersistOutcomeTransition(undefined, "provisional")).toBe(true);
    expect(shouldPersistOutcomeTransition("provisional", "provisional")).toBe(false);
    expect(shouldPersistOutcomeTransition("provisional", "unresolved")).toBe(true);
    expect(shouldPersistOutcomeTransition("provisional", "mature")).toBe(true);
    expect(shouldPersistOutcomeTransition("unresolved", "mature")).toBe(true);
    expect(shouldPersistOutcomeTransition("mature", "unresolved")).toBe(false);
    expect(
      walletOutcomeLifecycleKey({
        entryIdempotencyKey: "entry",
        horizonMinutes: 20,
        exitStrategy: "fixed-horizon",
        strategyVersion: "evidence-v1"
      })
    ).toBe("entry:20:fixed-horizon:evidence-v1");
  });

  it("requires repeated exact-pair absence after last-sellable evidence before a rug", () => {
    const live = {
      idempotencyKey: "live",
      chain: "solana" as const,
      tokenAddress: "Token111",
      poolAddress: "Pool111",
      priceUsd: 1,
      liquidityUsd: 10_000,
      rugged: false,
      signature: "live",
      slot: 1,
      provider: "dexscreener",
      observedAt: "2026-08-23T00:00:00.000Z",
      strategyVersion: "evidence-v1",
      raw: { marketState: "live", marketExecutable: true }
    };
    const missing = (index: number) => ({
      ...live,
      idempotencyKey: `missing-${index}`,
      priceUsd: 0,
      liquidityUsd: 0,
      observedAt: `2026-08-23T00:0${index}:00.000Z`,
      raw: { marketState: "pair-missing-confirmed", marketExecutable: false }
    });

    expect(classifyMissingExactPair([live], "Pool111", 3)).toMatchObject({
      missingStreak: 1,
      rugged: false,
      lastSellablePriceUsd: 1
    });
    expect(classifyMissingExactPair([live, missing(1)], "Pool111", 3)).toMatchObject({
      missingStreak: 2,
      rugged: false
    });
    expect(classifyMissingExactPair([live, missing(1), missing(2)], "Pool111", 3)).toMatchObject({
      missingStreak: 3,
      rugged: true
    });
    expect(classifyMissingExactPair([], "Pool111", 3)).toMatchObject({
      missingStreak: 1,
      rugged: false
    });
  });
});
