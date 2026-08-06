import { describe, expect, it } from "vitest";
import { selectBoundedPoolSamplingBatch } from "./pool-sampling-budget";

describe("pool sampling budget", () => {
  it("prioritizes subscriptions, then fair oldest sampling with deterministic ties", () => {
    const candidates = [
      {
        poolAddress: "recent-controlled",
        createdAt: "2026-07-15T12:04:00.000Z",
        lastSampledAt: "2026-07-15T12:03:00.000Z",
        subscribedToBuys: false,
        controlledFlow: true
      },
      {
        poolAddress: "old-uncontrolled",
        createdAt: "2026-07-15T12:01:00.000Z",
        lastSampledAt: "2026-07-15T12:01:30.000Z",
        subscribedToBuys: false,
        controlledFlow: false
      },
      {
        poolAddress: "new-unsampled",
        createdAt: "2026-07-15T12:05:00.000Z",
        subscribedToBuys: false,
        controlledFlow: false
      },
      {
        poolAddress: "controlled-unsampled",
        createdAt: "2026-07-15T12:02:00.000Z",
        subscribedToBuys: false,
        controlledFlow: true
      },
      {
        poolAddress: "subscribed",
        createdAt: "2026-07-15T12:00:00.000Z",
        lastSampledAt: "2026-07-15T12:04:30.000Z",
        subscribedToBuys: true,
        controlledFlow: true
      }
    ];

    expect(selectBoundedPoolSamplingBatch(candidates, 3).map((item) => item.poolAddress)).toEqual([
      "subscribed",
      "controlled-unsampled",
      "new-unsampled"
    ]);
    expect(candidates[0]?.poolAddress).toBe("recent-controlled");
  });

  it("never returns more than the bounded cycle budget", () => {
    const candidates = Array.from({ length: 500 }, (_, index) => ({
      poolAddress: `pool-${index}`,
      createdAt: new Date(1_700_000_000_000 + index).toISOString(),
      subscribedToBuys: false,
      controlledFlow: false
    }));

    expect(selectBoundedPoolSamplingBatch(candidates, 120)).toHaveLength(120);
  });
});
