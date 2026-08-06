import { describe, expect, it } from "vitest";
import { evaluateFixedHorizon, simulatePaperExitPath } from "./market-watch-evaluation.js";

describe("market-watch fixed horizon evaluation", () => {
  it("freezes the first 20-40 minute observation and deducts costs", () => {
    const result = evaluateFixedHorizon(
      "2026-07-10T12:00:00.000Z",
      1,
      [
        { observedAt: "2026-07-10T12:05:00.000Z", priceUsd: 2 },
        { observedAt: "2026-07-10T12:22:00.000Z", priceUsd: 1.2 },
        { observedAt: "2026-07-10T12:35:00.000Z", priceUsd: 3 },
        { observedAt: "2026-07-10T12:50:00.000Z", priceUsd: 5 }
      ],
      { horizonMinutes: 20, maxDelayMinutes: 20, estimatedRoundTripCostPct: 3 }
    );

    expect(result?.outcome.observedAt).toBe("2026-07-10T12:22:00.000Z");
    expect(result?.grossReturnPct).toBeCloseTo(20);
    expect(result?.netReturnPct).toBeCloseTo(17);
    expect(result?.ageMinutes).toBe(22);
    expect(result?.path).toHaveLength(2);
  });

  it("does not manufacture an outcome outside the 20-40 minute window", () => {
    const result = evaluateFixedHorizon(
      "2026-07-10T12:00:00.000Z",
      1,
      [
        { observedAt: "2026-07-10T12:05:00.000Z", priceUsd: 2 },
        { observedAt: "2026-07-10T12:45:00.000Z", priceUsd: 3 }
      ],
      { horizonMinutes: 20, maxDelayMinutes: 20, estimatedRoundTripCostPct: 3 }
    );

    expect(result).toBeUndefined();
  });
});

describe("market-watch paper exit evaluation", () => {
  it("keeps an unfinished path provisional", () => {
    const result = simulatePaperExitPath(
      [
        { observedAt: "2026-07-10T12:00:00.000Z", minutesSinceSignal: 0, returnPct: 0 },
        { observedAt: "2026-07-10T12:10:00.000Z", minutesSinceSignal: 10, returnPct: 5 }
      ],
      { takeProfitPct: 25, stopLossPct: 25, timeoutMinutes: 45 }
    );

    expect(result.mature).toBe(false);
    expect(result.reason).toBe("provisional");
  });

  it("matures immediately when a real threshold is reached", () => {
    const result = simulatePaperExitPath(
      [
        { observedAt: "2026-07-10T12:00:00.000Z", minutesSinceSignal: 0, returnPct: 0 },
        { observedAt: "2026-07-10T12:10:00.000Z", minutesSinceSignal: 10, returnPct: 30 }
      ],
      { takeProfitPct: 25, stopLossPct: 25, timeoutMinutes: 45 }
    );

    expect(result).toEqual({ returnPct: 25, reason: "take-profit", mature: true });
  });

  it("applies the moonbag trailing stop to price rather than return points", () => {
    const result = simulatePaperExitPath(
      [
        { observedAt: "2026-07-10T12:00:00.000Z", minutesSinceSignal: 0, returnPct: 0 },
        { observedAt: "2026-07-10T12:10:00.000Z", minutesSinceSignal: 10, returnPct: 100 },
        { observedAt: "2026-07-10T12:20:00.000Z", minutesSinceSignal: 20, returnPct: 60 },
        { observedAt: "2026-07-10T12:30:00.000Z", minutesSinceSignal: 30, returnPct: 35 }
      ],
      {
        exitStrategy: "moonbag",
        takeProfitPct: 100,
        stopLossPct: 30,
        timeoutMinutes: 90,
        moonbagSellFraction: 0.5,
        trailingStopPercent: 30
      }
    );

    expect(result.mature).toBe(true);
    expect(result.reason).toBe("moonbag_trailing_stop");
    expect(result.returnPct).toBeCloseTo(67.5);
  });
});
