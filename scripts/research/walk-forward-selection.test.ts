import { describe, expect, it } from "vitest";
import { lockBestCandidate, splitChronologicalWalkForward } from "./walk-forward-selection";

describe("walk-forward selection", () => {
  it("creates fixed chronological windows with embargo gaps", () => {
    const start = Date.parse("2026-07-01T00:00:00.000Z");
    const records = Array.from({ length: 100 }, (_, index) => ({
      id: index,
      observedAt: new Date(start + index * 60 * 60 * 1000).toISOString()
    }));

    const windows = splitChronologicalWalkForward(records, 40);

    expect(windows.train.at(-1)?.id).toBe(39);
    expect(windows.validation[0]?.id).toBe(41);
    expect(windows.validation.at(-1)?.id).toBe(59);
    expect(windows.holdout1[0]?.id).toBe(61);
    expect(windows.holdout1.at(-1)?.id).toBe(79);
    expect(windows.holdout2[0]?.id).toBe(81);
    expect(
      new Set(
        Object.values(windows)
          .flat()
          .map((record) => record.id)
      ).size
    ).toBe(97);
  });

  it("locks a candidate using train and validation scores only", () => {
    const locked = lockBestCandidate([
      {
        id: "holdout-lucky",
        train: { passed: true, score: 20 },
        validation: { passed: false, score: -10 },
        selectedCount: 100,
        holdoutScore: 10_000
      },
      {
        id: "validated",
        train: { passed: true, score: 10 },
        validation: { passed: true, score: 5 },
        selectedCount: 50,
        holdoutScore: -10_000
      }
    ]);

    expect(locked?.id).toBe("validated");
  });
});
