import { describe, expect, it } from "vitest";
import { DexScreenerClient } from "./dexscreener";

describe("DexScreenerClient", () => {
  it("batches up to 30 token addresses into one market-data request", async () => {
    let requestedUrl = "";
    const client = new DexScreenerClient("https://api.dexscreener.com", (async (
      input: RequestInfo | URL
    ) => {
      requestedUrl = String(input);
      return Response.json([]);
    }) as typeof fetch);

    await expect(client.fetchTokenPairsBatch("solana", ["Token111", "Token222"])).resolves.toEqual(
      []
    );
    expect(requestedUrl).toBe("https://api.dexscreener.com/tokens/v1/solana/Token111,Token222");
    await expect(
      client.fetchTokenPairsBatch(
        "solana",
        Array.from({ length: 31 }, (_, index) => `Token${index}`)
      )
    ).rejects.toThrow("at most 30");
  });

  it("uses the exact-pair endpoint to confirm a missing token-batch market", async () => {
    let requestedUrl = "";
    const client = new DexScreenerClient("https://api.dexscreener.com", (async (
      input: RequestInfo | URL
    ) => {
      requestedUrl = String(input);
      return Response.json({ pairs: [{ pairAddress: "Pool111", priceUsd: "0.01" }] });
    }) as typeof fetch);

    await expect(client.fetchPair("solana", "Pool111")).resolves.toEqual([
      { pairAddress: "Pool111", priceUsd: "0.01" }
    ]);
    expect(requestedUrl).toBe(
      "https://api.dexscreener.com/latest/dex/pairs/solana/Pool111"
    );
  });

  it("normalizes latest Solana profiles into idempotent events", async () => {
    const fetchImpl = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("token-profiles")) {
        return Response.json([
          { chainId: "solana", tokenAddress: "Token111", description: "new" },
          { chainId: "base", tokenAddress: "0xToken" }
        ]);
      }

      return Response.json([
        {
          chainId: "solana",
          dexId: "raydium",
          pairAddress: "Pool111",
          baseToken: { address: "Token111", symbol: "TOK", name: "Token" },
          quoteToken: { address: "So11111111111111111111111111111111111111112" },
          priceUsd: "0.01",
          liquidity: { usd: 25000 },
          volume: { m5: 5000, h1: 30000 },
          txns: { m5: { buys: 15, sells: 4 } },
          pairCreatedAt: 1_700_000_000_000
        }
      ]);
    };

    const client = new DexScreenerClient("https://api.dexscreener.com", fetchImpl as typeof fetch);
    const events = await client.discoverSolanaProfiles();

    expect(events).toHaveLength(1);
    expect(events[0]?.idempotencyKey).toBe("dexscreener:profile:solana:Token111");
    expect(events[0]?.payload).toMatchObject({
      token: { symbol: "TOK" }
    });
  });
});
