import { describe, expect, it } from "vitest";
import {
  buildContextualSurvivalAudit,
  modeledReturn,
  type ContextualSurvivalRecord
} from "./contextual-survival-v1-builder";

describe("contextual wallet survival v1", () => {
  it("models missing friction and terminal rugs conservatively", () => {
    expect(modeledReturn(record({ netReturnPct: 10, estimatedRoundTripCostPct: 3 }))).toBeCloseTo(
      5.9
    );
    expect(modeledReturn(record({ netReturnPct: 10_000, rugged: true }))).toBe(-100);
  });

  it("deduplicates exact markets and rejects invalid decision-time evidence", () => {
    const valid = record({ marketKey: "same", observedAt: at(0) });
    const laterDuplicate = record({ marketKey: "same", observedAt: at(1) });
    const unknownRisk = record({ marketKey: "unknown", observedAt: at(2), tokenRiskKnown: false });
    const audit = buildContextualSurvivalAudit([laterDuplicate, unknownRisk, valid]);

    expect(audit.records).toBe(1);
    expect(audit.decisions[0]?.observedAt).toBe(valid.observedAt);
  });

  it("does not use an outcome until its frozen time precedes the next decision", () => {
    const base = Array.from({ length: 105 }, (_, index) =>
      record({
        marketKey: `base-${index}`,
        observedAt: at(index),
        frozenAt: at(index + 2),
        netReturnPct: 12,
        supporters: [{ walletAddress: "causal-wallet", priorTokenCount: index }]
      })
    );
    const futureGood = record({
      marketKey: "future",
      observedAt: at(105),
      frozenAt: at(106),
      netReturnPct: 100,
      supporters: [{ walletAddress: "causal-wallet", priorTokenCount: 105 }]
    });
    const futureRug = { ...futureGood, rugged: true };

    const good = buildContextualSurvivalAudit([...base, futureGood]);
    const rugged = buildContextualSurvivalAudit([...base, futureRug]);

    expect(good.decisions.slice(0, 105)).toEqual(rugged.decisions.slice(0, 105));
    expect(good.decisions[105]?.walletScore).toBe(rugged.decisions[105]?.walletScore);
    expect(good.decisions[105]?.modeledReturnPct).toBeCloseTo(95.9);
    expect(rugged.decisions[105]?.modeledReturnPct).toBe(-100);
  });

  it("learns wallet-specific followability only from causally completed outcomes", () => {
    const records = Array.from({ length: 180 }, (_, index) => {
      const good = index % 2 === 0;
      return record({
        marketKey: `market-${index}`,
        observedAt: at(index),
        frozenAt: at(index, 20),
        netReturnPct: good ? 20 : -25,
        supporters: [
          {
            walletAddress: good ? "repeat-good" : "repeat-bad",
            priorTokenCount: index
          }
        ]
      });
    });
    const audit = buildContextualSurvivalAudit(records);
    const goodDecision = audit.decisions.at(-2)!;
    const badDecision = audit.decisions.at(-1)!;

    expect(goodDecision.walletScore).toBeGreaterThan(goodDecision.marketScore);
    expect(badDecision.walletScore).toBeLessThan(badDecision.marketScore);
    expect(goodDecision.walletEvidenceCount).toBe(1);
    expect(badDecision.walletEvidenceCount).toBe(1);
  });

  it("learns catastrophic unsellability in the survival head even without a rug label", () => {
    const history = Array.from({ length: 105 }, (_, index) =>
      record({
        marketKey: `survival-${index}`,
        observedAt: at(index),
        frozenAt: at(index, 20),
        netReturnPct: 15
      })
    );
    const loss = record({
      marketKey: "hazard",
      observedAt: at(105),
      frozenAt: at(105, 20),
      netReturnPct: -90,
      rugged: false
    });
    const ordinaryLoss = { ...loss, netReturnPct: -30 };
    const next = record({
      marketKey: "next",
      observedAt: at(106),
      frozenAt: at(106, 20)
    });

    const hazardAudit = buildContextualSurvivalAudit([...history, loss, next]);
    const ordinaryAudit = buildContextualSurvivalAudit([...history, ordinaryLoss, next]);

    expect(hazardAudit.decisions.at(-1)?.marketRiskProbability).toBeGreaterThan(
      ordinaryAudit.decisions.at(-1)!.marketRiskProbability
    );
  });

  it("winsorizes model learning but keeps raw winner concentration in evaluation", () => {
    const records = Array.from({ length: 180 }, (_, index) =>
      record({
        marketKey: `outlier-${index}`,
        observedAt: at(index),
        frozenAt: at(index, 20),
        netReturnPct: index === 179 ? 100_000 : 8,
        supporters: [{ walletAddress: "same-wallet", priorTokenCount: index }]
      })
    );
    const audit = buildContextualSurvivalAudit(records);

    expect(audit.contextualWalletPolicy.all.bestWinnerShare).toBeGreaterThan(0.3);
    expect(audit.contextualWalletPolicy.all.passed).toBe(false);
    expect(audit.verdict).toBe("reject");
  });

  it("is deterministic under input reordering", () => {
    const records = Array.from({ length: 130 }, (_, index) =>
      record({
        marketKey: `deterministic-${index}`,
        observedAt: at(index),
        frozenAt: at(index, 20),
        netReturnPct: index % 7 === 0 ? -30 : 15,
        supporters: [{ walletAddress: `wallet-${index % 5}`, priorTokenCount: index }]
      })
    );
    const forward = buildContextualSurvivalAudit(records);
    const reverse = buildContextualSurvivalAudit([...records].reverse());

    expect(reverse).toEqual(forward);
  });

  it("keeps wallet identities out of the serializable audit result", () => {
    const audit = buildContextualSurvivalAudit([
      record({
        marketKey: "redaction",
        supporters: [{ walletAddress: "must-not-leak", priorTokenCount: 9 }]
      })
    ]);

    expect(JSON.stringify(audit)).not.toContain("must-not-leak");
    expect(audit.walletShuffleControl).toBeDefined();
  });
});

function record(overrides: Partial<ContextualSurvivalRecord> = {}): ContextualSurvivalRecord {
  return {
    marketKey: "market",
    tokenAddress: "token",
    poolAddress: "pool",
    dex: "pump",
    observedAt: at(0),
    frozenAt: at(0, 20),
    netReturnPct: 15,
    estimatedRoundTripCostPct: 3,
    rugged: false,
    controlledFlow: true,
    tokenRiskKnown: true,
    tokenRiskPassed: true,
    mintAuthorityRevoked: true,
    freezeAuthorityRevoked: true,
    liquidityUsd: 20_000,
    volume5mUsd: 8_000,
    transactions5m: 50,
    buyShare5m: 0.56,
    volumeLiquidityRatio: 0.4,
    poolAgeMinutes: 5.5,
    top10HolderPercent: 18,
    supporters: [{ walletAddress: "wallet", priorTokenCount: 6 }],
    ...overrides
  };
}

function at(index: number, extraMinutes = 0): string {
  return new Date(
    Date.parse("2026-01-01T00:00:00.000Z") + (index * 30 + extraMinutes) * 60_000
  ).toISOString();
}
