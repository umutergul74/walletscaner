import { describe, expect, it, vi } from "vitest";
import type { DirectExactInQuoteEvidence } from "@memecoin-alpha/providers";
import type { AlphaDecisionCheckpointClaim } from "@memecoin-alpha/db";
import {
  collectAlphaDecisionCheckpoint,
  quoteNotionalRawAmount
} from "./alpha-decision-checkpoint";

const usdc = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

describe("alpha decision checkpoint collection", () => {
  it("captures three exact entry buys and conservative immediate sell probes", async () => {
    const quoteClient = { fetchDirectExactInQuote: vi.fn(quoteResponse) };
    const completion = await collectAlphaDecisionCheckpoint(claim(), {
      marketClient: marketClient(),
      quoteClient,
      quoteUsdPrice: async () => 1,
      measureFlow: async () => ({ uniqueBuyers: 3, uniqueSellers: 1 }),
      now: () => new Date("2026-08-30T00:02:01.000Z")
    });

    expect(completion).toMatchObject({
      exactPairStatus: "live",
      identityIndependenceStatus: "unknown",
      uniqueBuyersSinceDecision: 3,
      uniqueSellersSinceDecision: 1,
      liquidityRemoved: false
    });
    expect(completion.quotes).toHaveLength(6);
    expect(completion.quotes.filter((quote) => quote.direction === "buy")).toHaveLength(3);
    expect(completion.quotes.filter((quote) => quote.direction === "sell")).toHaveLength(3);
    const secondRequest = quoteClient.fetchDirectExactInQuote.mock.calls[1]?.[0];
    expect(secondRequest?.rawInputAmount).toBe("1152000000");
    expect(JSON.stringify(completion.quotes)).not.toContain('"raw"');
  });

  it("uses only frozen entry quantities for later sell checkpoints", async () => {
    const quoteClient = { fetchDirectExactInQuote: vi.fn(quoteResponse) };
    const completion = await collectAlphaDecisionCheckpoint(
      claim({
        horizonSeconds: 60,
        entryRawAmounts: { 600: "111", 2500: "222", 10000: "333" }
      }),
      {
        marketClient: marketClient(),
        quoteClient,
        quoteUsdPrice: async () => {
          throw new Error("later sell must not request a current USD entry conversion");
        },
        measureFlow: async () => ({ uniqueBuyers: 2, uniqueSellers: 2 })
      }
    );

    expect(completion.quotes.map((quote) => quote.direction)).toEqual(["sell", "sell", "sell"]);
    expect(completion.quotes.map((quote) => quote.positionSource)).toEqual([
      "decision-entry",
      "decision-entry",
      "decision-entry"
    ]);
    expect(
      quoteClient.fetchDirectExactInQuote.mock.calls.map((call) => call[0].rawInputAmount)
    ).toEqual(["111", "222", "333"]);
  });

  it("records unavailable execution evidence instead of inventing a fill", async () => {
    const completion = await collectAlphaDecisionCheckpoint(claim(), {
      marketClient: marketClient([]),
      quoteUsdPrice: async () => 1,
      measureFlow: async () => ({ uniqueBuyers: 0, uniqueSellers: 0 })
    });

    expect(completion.exactPairStatus).toBe("missing");
    expect(completion.liquidityRemoved).toBe(true);
    expect(completion.quotes).toHaveLength(6);
    expect(completion.quotes.every((quote) => quote.status === "not-attempted")).toBe(true);
    expect(completion.quotes[0]?.failureReason).toBe("jupiter-api-key-not-configured");
  });

  it("converts fixed USD notionals to exact raw USDC and SOL amounts", () => {
    expect(quoteNotionalRawAmount(usdc, 600, 1)).toBe("6000000");
    expect(quoteNotionalRawAmount("So11111111111111111111111111111111111111112", 2500, 200)).toBe(
      "125000000"
    );
  });
});

function claim(
  overrides: Partial<AlphaDecisionCheckpointClaim> = {}
): AlphaDecisionCheckpointClaim {
  return {
    checkpointId: 1,
    decisionId: "decision-1",
    strategyVersion: "survival-execution-tape-v1-20260830",
    tokenAddress: "Token111",
    quoteTokenAddress: usdc,
    poolAddress: "Pool111",
    dex: "Dex111",
    poolCreatedAt: "2026-08-30T00:00:00.000Z",
    decidedAt: "2026-08-30T00:02:00.000Z",
    initialLiquidityUsd: 20_000,
    horizonSeconds: 0,
    dueAt: "2026-08-30T00:02:00.000Z",
    attemptCount: 1,
    entryRawAmounts: {},
    ...overrides
  };
}

function marketClient(
  pairs = [
    {
      chainId: "solana",
      pairAddress: "Pool111",
      priceUsd: "0.001",
      liquidity: { usd: 20_000 },
      txns: { m5: { buys: 20, sells: 10 } }
    }
  ]
) {
  return { fetchPair: vi.fn(async () => pairs) };
}

function quoteResponse(request: {
  inputMint: string;
  outputMint: string;
  rawInputAmount: bigint | string;
  slippageBps: number;
  expectedPoolAddress?: string;
}): Promise<DirectExactInQuoteEvidence> {
  return Promise.resolve({
    provider: "jupiter-swap-v2-order",
    status: "quoted-not-filled",
    inputMint: request.inputMint,
    outputMint: request.outputMint,
    rawInputAmount: String(request.rawInputAmount),
    rawExpectedOutputAmount: "1200000000",
    rawMinimumOutputAmount: "1152000000",
    slippageBps: request.slippageBps,
    priceImpactPercent: 0.03,
    routePoolAddress: request.expectedPoolAddress ?? "Pool111",
    contextSlot: 441000000,
    routeRouter: "metis",
    providerFeeBps: 50,
    providerFeeMint: request.inputMint,
    platformFeeRawAmount: "1250",
    platformFeeBps: 50,
    platformFeeMint: request.inputMint,
    providerTimeMs: 12,
    httpLatencyMs: 20,
    observedAt: "2026-08-30T00:02:01.000Z",
    raw: {}
  });
}
