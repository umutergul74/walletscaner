import { describe, expect, it } from "vitest";
import {
  evaluateSolanaTokenRisk,
  fetchSolanaTokenRisk,
  passesSolanaRiskMarketGate,
  creatorAddressFromAsset
} from "./token-risk";

describe("Solana token risk", () => {
  it("prefers a verified creator over generic asset authorities", () => {
    expect(
      creatorAddressFromAsset({
        creators: [
          { address: "UnverifiedCreator", verified: false },
          { address: "VerifiedCreator", verified: true }
        ],
        authorities: [{ address: "AuthorityWallet" }]
      })
    ).toBe("VerifiedCreator");
  });

  it("passes only positively verified authority and holder evidence", () => {
    const result = evaluateSolanaTokenRisk({
      asset: {
        id: "Mint111",
        token_info: { mint_authority: null, freeze_authority: null },
        creators: [{ address: "Creator111", verified: true }]
      },
      supplyRawAmount: "1000000",
      largestRawAmounts: ["200000", "100000", "50000"],
      maximumTopHolderPercent: 35
    });

    expect(result).toMatchObject({
      known: true,
      passed: true,
      topHolderPercent: 20,
      top10HolderPercent: 35,
      creatorAddress: "Creator111"
    });
  });

  it("fails closed when authority evidence is missing", () => {
    const result = evaluateSolanaTokenRisk({
      asset: { id: "Mint111", token_info: {} },
      supplyRawAmount: "1000000",
      largestRawAmounts: ["100000"],
      maximumTopHolderPercent: 35
    });

    expect(result.known).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.warnings).toContain("Critical token safety evidence is incomplete.");
  });

  it("uses bigint arithmetic for high-supply tokens", () => {
    const result = evaluateSolanaTokenRisk({
      asset: { token_info: { mint_authority: null, freeze_authority: null } },
      supplyRawAmount: "18446744073709551615",
      largestRawAmounts: ["1844674407370955161"],
      maximumTopHolderPercent: 35
    });

    expect(result.topHolderPercent).toBeCloseTo(10, 2);
  });

  it("defers paid risk lookups until the pool passes the market gate", () => {
    const base = {
      liquidityUsd: 20_000,
      volume5mUsd: 8_000,
      buys5m: 60,
      sells5m: 30,
      minimumLiquidityUsd: 10_000,
      minimumVolume5mUsd: 5_000,
      maximumSwaps5m: 300,
      maximumVolumeLiquidityRatio: 4
    };

    expect(passesSolanaRiskMarketGate(base)).toBe(true);
    expect(passesSolanaRiskMarketGate({ ...base, liquidityUsd: 9_999 })).toBe(false);
    expect(passesSolanaRiskMarketGate({ ...base, buys5m: 400 })).toBe(false);
    expect(passesSolanaRiskMarketGate({ ...base, buys5m: 95, sells5m: 5 })).toBe(false);
  });

  it("derives authority evidence from standard RPC without a DAS asset", async () => {
    const methods: string[] = [];
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      methods.push(request.method);
      const result =
        request.method === "getTokenLargestAccounts"
          ? { value: [{ amount: "200000" }, { amount: "100000" }] }
          : request.method === "getTokenSupply"
            ? { value: { amount: "1000000" } }
            : {
                value: {
                  data: {
                    parsed: {
                      info: { mintAuthority: null, freezeAuthority: null, decimals: 6 }
                    }
                  }
                }
              };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };

    const result = await fetchSolanaTokenRisk({
      rpcUrl: "https://rpc.example",
      mint: "Mint111",
      maximumTopHolderPercent: 35,
      fetchImpl
    });

    expect(methods.sort()).toEqual(["getAccountInfo", "getTokenLargestAccounts", "getTokenSupply"]);
    expect(result).toMatchObject({ known: true, passed: true, topHolderPercent: 20 });
  });
});
