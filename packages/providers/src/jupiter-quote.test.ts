import { describe, expect, it, vi } from "vitest";
import { JupiterQuoteClient, JupiterQuoteIntegrityError } from "./jupiter-quote";

const inputMint = "So11111111111111111111111111111111111111112";
const outputMint = "TokenMint111111111111111111111111111111111";
const pool = "Pool11111111111111111111111111111111111111";

function response(overrides: Record<string, unknown> = {}) {
  return {
    inputMint,
    inAmount: "6000000",
    outputMint,
    outAmount: "1200000000",
    otherAmountThreshold: "1152000000",
    swapMode: "ExactIn",
    slippageBps: 400,
    priceImpact: 0.031,
    routePlan: [
      {
        swapInfo: {
          ammKey: pool,
          label: "Meteora DLMM",
          inputMint,
          outputMint
        },
        percent: 100
      }
    ],
    feeBps: 50,
    feeMint: inputMint,
    platformFee: { amount: "1250", feeBps: 50, feeMint: inputMint },
    router: "metis",
    transaction: null,
    totalTime: 12,
    ...overrides
  };
}

describe("Jupiter quote evidence", () => {
  it("captures a direct exact-pool quote without claiming it was filled", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(response()), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
    );
    const quote = await new JupiterQuoteClient(
      "test-key",
      "https://api.jup.ag/swap/v2",
      fetchImpl
    ).fetchDirectExactInQuote({
      inputMint,
      outputMint,
      rawInputAmount: 6_000_000n,
      slippageBps: 400,
      expectedPoolAddress: pool
    });

    expect(quote).toMatchObject({
      status: "quoted-not-filled",
      rawExpectedOutputAmount: "1200000000",
      rawMinimumOutputAmount: "1152000000",
      routePoolAddress: pool,
      routeRouter: "metis",
      providerFeeBps: 50,
      providerFeeMint: inputMint,
      platformFeeRawAmount: "1250",
      platformFeeBps: 50,
      platformFeeMint: inputMint,
      providerTimeMs: 12,
      httpLatencyMs: expect.any(Number)
    });
    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/swap/v2/order");
    expect(url.searchParams.has("taker")).toBe(false);
    expect(url.searchParams.get("amount")).toBe("6000000");
  });

  it("fails closed when the quote silently uses another pool", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(response()), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
    );
    await expect(
      new JupiterQuoteClient("test-key", undefined, fetchImpl).fetchDirectExactInQuote({
        inputMint,
        outputMint,
        rawInputAmount: "6000000",
        slippageBps: 400,
        expectedPoolAddress: "DifferentPool111111111111111111111111111111"
      })
    ).rejects.toBeInstanceOf(JupiterQuoteIntegrityError);
  });

  it("rejects split routes and malformed amounts", async () => {
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify(
            response({
              routePlan: [
                { swapInfo: { ammKey: pool }, percent: 50 },
                { swapInfo: { ammKey: "Pool2" }, percent: 50 }
              ]
            })
          ),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );
    const client = new JupiterQuoteClient("test-key", undefined, fetchImpl);
    await expect(
      client.fetchDirectExactInQuote({
        inputMint,
        outputMint,
        rawInputAmount: 6_000_000n,
        slippageBps: 400
      })
    ).rejects.toThrow("single 100% direct route");
    await expect(
      client.fetchDirectExactInQuote({
        inputMint,
        outputMint,
        rawInputAmount: 0n,
        slippageBps: 400
      })
    ).rejects.toThrow("outside uint64");
  });

  it("rejects a response that unexpectedly contains a transaction", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(response({ transaction: "base64-transaction" })), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
    );
    await expect(
      new JupiterQuoteClient("test-key", undefined, fetchImpl).fetchDirectExactInQuote({
        inputMint,
        outputMint,
        rawInputAmount: 6_000_000n,
        slippageBps: 400,
        expectedPoolAddress: pool
      })
    ).rejects.toThrow("quote-only response unexpectedly contained a transaction");
  });
});
