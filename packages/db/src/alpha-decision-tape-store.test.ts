import { describe, expect, it, vi } from "vitest";
import {
  ALPHA_DECISION_TAPE_VERSION,
  AlphaDecisionTapeStore,
  type AlphaExecutionQuoteEvidence
} from "./alpha-decision-tape-store";

describe("AlphaDecisionTapeStore", () => {
  it("bounds future decision seeding and reports explicit remaining capacity", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          inspected: 25,
          inserted: 4,
          research_eligible: 2,
          has_more: true,
          daily_capacity_remaining: 96
        }
      ]
    });
    const store = new AlphaDecisionTapeStore({ query } as never);

    await expect(store.seedFutureDecisions()).resolves.toEqual({
      inspected: 25,
      inserted: 4,
      researchEligible: 2,
      hasMore: true,
      dailyCapacityRemaining: 96
    });
    expect(query.mock.calls[0]?.[1]).toEqual([
      ALPHA_DECISION_TAPE_VERSION,
      "evidence-v1",
      25,
      100,
      "So11111111111111111111111111111111111111112",
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    ]);
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("LIMIT $3::integer + 1");
    expect(sql).toContain("event.pool_address = pool.pool_address");
    expect(sql).not.toContain("OR event.token_address = pool.base_token_address");
  });

  it("claims oldest due work with lease recovery and maps frozen entry quantities", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          checkpoint_id: 7,
          decision_id: "decision-1",
          strategy_version: ALPHA_DECISION_TAPE_VERSION,
          token_address: "Token111",
          quote_token_address: "Quote111",
          pool_address: "Pool111",
          dex: "Dex111",
          pool_created_at: "2026-08-30T00:00:00.000Z",
          decided_at: "2026-08-30T00:02:00.000Z",
          horizon_seconds: 60,
          due_at: "2026-08-30T00:03:00.000Z",
          attempt_count: 2,
          entry_raw_amounts: { "600": "123", "2500": "456" }
        }
      ]
    });
    const store = new AlphaDecisionTapeStore({ query } as never);

    const claims = await store.claimDueCheckpoints({ workerId: "worker-1", limit: 2 });

    expect(claims[0]).toMatchObject({
      checkpointId: 7,
      horizonSeconds: 60,
      entryRawAmounts: { 600: "123", 2500: "456" }
    });
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("FOR UPDATE OF checkpoint SKIP LOCKED");
    expect(sql).toContain("checkpoint.attempt_count >= 6 THEN 'dead_letter'");
    expect(sql).toContain("initial.horizon_seconds = 0");
  });

  it("rejects duplicate, non-exact, and unbounded quote evidence before SQL", async () => {
    const query = vi.fn();
    const store = new AlphaDecisionTapeStore({ query } as never);
    const valid = quote();

    await expect(
      store.completeCheckpoint(
        { checkpointId: 1, horizonSeconds: 0, poolAddress: "Pool111" },
        "worker",
        {
          exactPairStatus: "live",
          priceUsd: 0.001,
          liquidityUsd: 20_000,
          identityIndependenceStatus: "unknown",
          quotes: [valid, valid]
        }
      )
    ).rejects.toThrow("Duplicate checkpoint quote");
    await expect(
      store.completeCheckpoint(
        { checkpointId: 1, horizonSeconds: 0, poolAddress: "Pool111" },
        "worker",
        {
          exactPairStatus: "live",
          priceUsd: 0.001,
          liquidityUsd: 20_000,
          identityIndependenceStatus: "unknown",
          quotes: [{ ...valid, routePoolAddress: "WrongPool" }]
        }
      )
    ).rejects.toThrow("exact expected pool");
    await expect(
      store.completeCheckpoint(
        { checkpointId: 1, horizonSeconds: 0, poolAddress: "Pool111" },
        "worker",
        {
          exactPairStatus: "live",
          priceUsd: 0.001,
          liquidityUsd: 20_000,
          identityIndependenceStatus: "unknown",
          quotes: [valid]
        }
      )
    ).rejects.toThrow("requires exactly 6 quote evidence rows");
    expect(query).not.toHaveBeenCalled();
  });

  it("persists completion only under the live lease and never stores raw provider JSON", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ completed: true }] });
    const store = new AlphaDecisionTapeStore({ query } as never);

    await expect(
      store.completeCheckpoint(
        { checkpointId: 1, horizonSeconds: 0, poolAddress: "Pool111" },
        "worker",
        {
          exactPairStatus: "live",
          priceUsd: 0.001,
          liquidityUsd: 20_000,
          buys5m: 10,
          sells5m: 7,
          identityIndependenceStatus: "unknown",
          marketObservedAt: "2026-08-30T00:02:01.000Z",
          marketProvider: "dexscreener-exact-pair",
          marketProviderLatencyMs: 50,
          quotes: quoteSurface()
        }
      )
    ).resolves.toBe(true);

    const sql = String(query.mock.calls[0]?.[0]);
    const serializedQuotes = String((query.mock.calls[0]?.[1] as unknown[])[15]);
    expect(sql).toContain("checkpoint.lock_expires_at > NOW()");
    expect(sql).toContain("jsonb_to_recordset");
    expect(serializedQuotes).not.toContain('"raw"');
  });

  it("moves the final bounded failure to dead-letter and detects a lost lease", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ status: "dead_letter" }] })
      .mockResolvedValueOnce({ rows: [] });
    const store = new AlphaDecisionTapeStore({ query } as never);

    await expect(
      store.failCheckpoint({ checkpointId: 1 }, "worker", "provider failed", {
        maximumAttempts: 6
      })
    ).resolves.toBe("dead_letter");
    await expect(
      store.failCheckpoint({ checkpointId: 1 }, "worker", "provider failed")
    ).resolves.toBe("lost-lease");
  });
});

function quote(): AlphaExecutionQuoteEvidence {
  return {
    direction: "buy",
    notionalUsdCents: 600,
    positionSource: "new-buy",
    status: "quoted-not-filled",
    inputMint: "Quote111",
    outputMint: "Token111",
    rawInputAmount: "6000000",
    rawExpectedOutputAmount: "1200000000",
    rawMinimumOutputAmount: "1152000000",
    slippageBps: 400,
    priceImpactPercent: 0.03,
    expectedPoolAddress: "Pool111",
    routePoolAddress: "Pool111",
    provider: "jupiter-swap-v2-order",
    observedAt: "2026-08-30T00:02:01.000Z"
  };
}

function quoteSurface(): AlphaExecutionQuoteEvidence[] {
  return (["buy", "sell"] as const).flatMap((direction) =>
    ([600, 2500, 10000] as const).map((notionalUsdCents) => ({
      ...quote(),
      direction,
      notionalUsdCents
    }))
  );
}
