import { describe, expect, it } from "vitest";
import { summarizeReturns } from "./robust-stats.js";

describe("robust return statistics", () => {
  it("reveals when one winner hides a weak cohort", () => {
    const stats = summarizeReturns([252, 10, -10, -20, -30]);

    expect(stats.average).toBeCloseTo(40.4);
    expect(stats.median).toBe(-10);
    expect(stats.averageWithoutBest).toBeCloseTo(-12.5);
    expect(stats.bestWinnerShare).toBeCloseTo(252 / 262);
  });

  it("handles even samples and empty cohorts", () => {
    expect(summarizeReturns([2, 4, 6, 8]).median).toBe(5);
    expect(summarizeReturns([])).toEqual({
      average: 0,
      median: 0,
      averageWithoutBest: 0,
      bestWinnerShare: 0
    });
  });
});
