import { describe, expect, it } from "vitest";
import { buildGoalCompletionAudit } from "./goal-completion-audit";

describe("goal completion audit", () => {
  it("requires 30 unique mature signals, seven days, two holdouts, and replay gates", () => {
    const outcomes = Array.from({ length: 30 }, (_, index) => ({
      key: `token-${index}`,
      observedAt: new Date(
        Date.UTC(2026, 6, 1) + index * 8 * 60 * 60 * 1_000
      ).toISOString(),
      netReturnPct: index < 10 ? 1 : index % 2 === 0 ? 8 : 2
    }));
    const audit = buildGoalCompletionAudit(outcomes, {
      profitFactor: 1.3,
      maxDrawdownPercent: 12
    });

    expect(audit.completed).toBe(true);
    expect(audit.holdouts).toHaveLength(2);
    expect(audit.holdouts.every((holdout) => holdout.passed)).toBe(true);
  });

  it("deduplicates token keys and rejects a single-winner inflated holdout", () => {
    const outcomes = Array.from({ length: 30 }, (_, index) => ({
      key: `token-${index}`,
      observedAt: new Date(
        Date.UTC(2026, 6, 1) + index * 8 * 60 * 60 * 1_000
      ).toISOString(),
      netReturnPct: index === 15 ? 100 : index >= 10 ? -1 : 0
    }));
    outcomes.push({
      key: "token-0",
      observedAt: "2026-07-20T00:00:00.000Z",
      netReturnPct: 1_000
    });

    const audit = buildGoalCompletionAudit(outcomes, {
      profitFactor: 1.3,
      maxDrawdownPercent: 12
    });

    expect(audit.independentMatureSignalCount).toBe(30);
    expect(audit.completed).toBe(false);
    expect(audit.holdouts[0]).toMatchObject({
      passed: false,
      averageReturnExBestPct: -1
    });
  });

  it("does not complete without capital-constrained replay evidence", () => {
    const outcomes = Array.from({ length: 30 }, (_, index) => ({
      key: `token-${index}`,
      observedAt: new Date(
        Date.UTC(2026, 6, 1) + index * 8 * 60 * 60 * 1_000
      ).toISOString(),
      netReturnPct: 4
    }));

    const audit = buildGoalCompletionAudit(outcomes);

    expect(audit.completed).toBe(false);
    expect(audit.replay.available).toBe(false);
  });
});
