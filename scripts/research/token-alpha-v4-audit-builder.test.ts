import { describe, expect, it } from "vitest";
import {
  attachCausalCreatorHistory,
  buildTokenAlphaV4Audit,
  matchesCandidate,
  modeledReturn,
  type TokenAlphaV4Candidate,
  type TokenAlphaV4MarketRecord
} from "./token-alpha-v4-audit-builder";

describe("token alpha v4 audit", () => {
  it("models current round-trip friction and treats a rug as a total loss", () => {
    expect(modeledReturn(record({ netReturnPct: 10, estimatedRoundTripCostPct: 3 }))).toBeCloseTo(
      5.9
    );
    expect(modeledReturn(record({ netReturnPct: 500, rugged: true }))).toBe(-100);
  });

  it("uses only creator outcomes frozen before the current decision", () => {
    const enriched = attachCausalCreatorHistory([
      record({
        tokenAddress: "first",
        creatorAddress: "creator-a",
        observedAt: "2026-01-01T00:00:00.000Z",
        frozenAt: "2026-01-03T00:00:00.000Z",
        rugged: true
      }),
      record({
        tokenAddress: "second",
        creatorAddress: "creator-a",
        observedAt: "2026-01-02T00:00:00.000Z",
        frozenAt: "2026-01-02T01:00:00.000Z"
      }),
      record({
        tokenAddress: "third",
        creatorAddress: "creator-a",
        observedAt: "2026-01-04T00:00:00.000Z",
        frozenAt: "2026-01-04T01:00:00.000Z"
      })
    ]);

    expect(enriched.find((item) => item.tokenAddress === "second")).toMatchObject({
      creatorPriorMarkets: 0,
      creatorPriorRugs: 0
    });
    expect(enriched.find((item) => item.tokenAddress === "third")).toMatchObject({
      creatorPriorMarkets: 2,
      creatorPriorRugs: 1,
      creatorPriorRugRate: 0.5
    });
  });

  it("rejects a strict-flow token when no causally safe wallet supports it", () => {
    expect(matchesCandidate(candidate(), record({ causalSafeWallets6: 0 }))).toBe(false);
    expect(matchesCandidate(candidate(), record({ causalSafeWallets6: 2 }))).toBe(true);
  });

  it("locks on train and validation, then fails a rug-heavy untouched holdout", () => {
    const source = Array.from({ length: 60 }, (_, index) =>
      record({
        tokenAddress: `token-${index}`,
        poolAddress: `pool-${index}`,
        observedAt: new Date(
          Date.parse("2026-01-01T00:00:00.000Z") + index * 3_600_000
        ).toISOString(),
        frozenAt: new Date(
          Date.parse("2026-01-01T00:30:00.000Z") + index * 3_600_000
        ).toISOString(),
        netReturnPct: index >= 36 ? -100 : 20,
        rugged: index >= 36
      })
    );

    const audit = buildTokenAlphaV4Audit(source);

    expect(audit.lockedCandidate).not.toBeNull();
    expect(audit.lockedCandidate?.train.passed).toBe(true);
    expect(audit.lockedCandidate?.validation.passed).toBe(true);
    expect(audit.lockedCandidate?.holdout1?.passed).toBe(false);
    expect(audit.verdict).toBe("no-promotable-v4");
  });

  it("allows only a robust candidate that passes every chronological window", () => {
    const source = Array.from({ length: 60 }, (_, index) =>
      record({
        tokenAddress: `token-${index}`,
        poolAddress: `pool-${index}`,
        observedAt: new Date(
          Date.parse("2026-01-01T00:00:00.000Z") + index * 3_600_000
        ).toISOString(),
        frozenAt: new Date(
          Date.parse("2026-01-01T00:30:00.000Z") + index * 3_600_000
        ).toISOString(),
        netReturnPct: 20
      })
    );

    const audit = buildTokenAlphaV4Audit(source);

    expect(audit.lockedCandidate?.passed).toBe(true);
    expect(audit.lockedCandidate?.selectedCount).toBeGreaterThanOrEqual(30);
    expect(audit.verdict).toBe("future-shadow-only");
  });
});

function candidate(): TokenAlphaV4Candidate {
  return {
    id: "fixture",
    walletEvidence: "safe6",
    minimumSafeWallets: 1,
    minimumLiquidityUsd: 10_000,
    minimumBuyShare5m: 0.5,
    maximumBuyShare5mExclusive: 0.6,
    maximumVolumeLiquidityRatioExclusive: 0.5,
    minimumPoolAgeMinutes: 5,
    maximumPoolAgeMinutes: 40,
    maximumTop10HolderPercentExclusive: 20,
    minimumCreatorPriorMarkets: 0,
    maximumCreatorPriorRugRate: 1
  };
}

function record(overrides: Partial<TokenAlphaV4MarketRecord> = {}): TokenAlphaV4MarketRecord {
  return {
    tokenAddress: "token",
    poolAddress: "pool",
    dex: "pumpfun",
    creatorAddress: "creator",
    observedAt: "2026-01-01T00:00:00.000Z",
    frozenAt: "2026-01-01T00:20:00.000Z",
    netReturnPct: 20,
    estimatedRoundTripCostPct: 3,
    rugged: false,
    controlledFlow: true,
    tokenRiskKnown: true,
    tokenRiskPassed: true,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    liquidityUsd: 50_000,
    volume5mUsd: 10_000,
    transactions5m: 30,
    buyShare5m: 0.55,
    volumeLiquidityRatio: 0.2,
    poolAgeMinutes: 6,
    top10HolderPercent: 10,
    supporterCount: 3,
    scoredSupporterCount: 3,
    causalSafeWallets3: 2,
    causalSafeWallets6: 2,
    ...overrides
  };
}
