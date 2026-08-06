import { describe, expect, it } from "vitest";
import { HeliusEnhancedClient, normalizeHeliusWebhook, verifyHeliusWebhookAuth } from "./helius";

describe("Helius webhook adapter", () => {
  it("requires and verifies webhook auth headers", () => {
    expect(verifyHeliusWebhookAuth(undefined, undefined)).toBe(false);
    expect(verifyHeliusWebhookAuth("secret", "secret")).toBe(true);
    expect(verifyHeliusWebhookAuth("secret", "wrong")).toBe(false);
  });

  it("normalizes one swap without expanding its token transfers into fake events", () => {
    const events = normalizeHeliusWebhook([
      {
        signature: "sig",
        slot: 123,
        timestamp: 1_700_000_000,
        source: "JUPITER",
        tokenTransfers: [{ mint: "Mint111", fromUserAccount: "a", toUserAccount: "b" }],
        events: { swap: { nativeInput: { amount: "1000" } } }
      }
    ]);

    expect(events.map((event) => event.type)).toEqual(["swap"]);
    expect(new Set(events.map((event) => event.idempotencyKey)).size).toBe(1);
  });

  it("fetches address history with time and pagination filters", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify([{ signature: "sig", slot: 123 }]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    const client = new HeliusEnhancedClient("key", "https://mainnet.helius-rpc.com", fetchImpl);

    const result = await client.getTransactionsByAddress("Program111", {
      afterSignature: "after",
      commitment: "finalized",
      sortOrder: "asc",
      gteTime: 1,
      lteTime: 2,
      limit: 50
    });

    expect(result).toHaveLength(1);
    const url = new URL(seen[0]!);
    expect(url.pathname).toBe("/v0/addresses/Program111/transactions");
    expect(url.searchParams.get("api-key")).toBe("key");
    expect(url.searchParams.get("after-signature")).toBe("after");
    expect(url.searchParams.get("sort-order")).toBe("asc");
    expect(url.searchParams.get("gte-time")).toBe("1");
    expect(url.searchParams.get("lte-time")).toBe("2");
    expect(url.searchParams.get("limit")).toBe("50");
  });

  it("fetches token metadata in one DAS batch request", async () => {
    let body: Record<string, unknown> | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          result: [
            {
              id: "Mint111",
              interface: "FungibleToken",
              token_info: { symbol: "MEME", decimals: 6 }
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }) as typeof fetch;
    const client = new HeliusEnhancedClient("key", "https://mainnet.helius-rpc.com", fetchImpl);

    const assets = await client.getAssetBatch(["Mint111"]);

    expect(assets[0]?.token_info?.symbol).toBe("MEME");
    expect(body?.method).toBe("getAssetBatch");
    expect(body?.params).toEqual({ ids: ["Mint111"] });
  });
});
