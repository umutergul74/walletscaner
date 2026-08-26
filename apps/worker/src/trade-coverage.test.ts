import { describe, expect, it } from "vitest";
import {
  activateTradeSubscription,
  excludeTradeCoverage,
  TradeCoverageReleaseCoordinator,
  type MutableTradeCoverageState
} from "./trade-coverage.js";

function pool(): MutableTradeCoverageState {
  return {
    subscribedToBuys: true,
    everSubscribedToBuys: true,
    controlledFlow: true,
    tradeCoverageComplete: true,
    tradeCoveragePersisted: true
  };
}

describe("trade coverage state", () => {
  it("fails a subscribed pool closed and preserves the first gap evidence", () => {
    const state = pool();

    expect(
      excludeTradeCoverage(
        state,
        "rpc-trade-backfill-cursorless-initial-limit",
        "2026-08-22T17:00:00.000Z"
      )
    ).toBe(true);
    expect(state).toMatchObject({
      subscribedToBuys: false,
      controlledFlow: false,
      tradeCoverageComplete: false,
      tradeCoveragePersisted: false,
      tradeCoverageGapAt: "2026-08-22T17:00:00.000Z",
      tradeCoverageGapReason: "rpc-trade-backfill-cursorless-initial-limit"
    });

    expect(
      excludeTradeCoverage(state, "later-reason", "2026-08-22T17:01:00.000Z")
    ).toBe(false);
    expect(state.tradeCoverageGapAt).toBe("2026-08-22T17:00:00.000Z");
    expect(state.tradeCoverageGapReason).toBe("rpc-trade-backfill-cursorless-initial-limit");
  });

  it("does not reactivate a subscription after an awaited backfill exclusion", () => {
    const state = pool();
    excludeTradeCoverage(
      state,
      "rpc-trade-backfill-cursor-boundary-not-reached",
      "2026-08-22T17:00:00.000Z"
    );

    expect(activateTradeSubscription(state)).toBe(false);
    expect(state.subscribedToBuys).toBe(false);
  });

  it("activates only a pool whose coverage is still complete", () => {
    const state = pool();
    state.subscribedToBuys = false;
    state.everSubscribedToBuys = false;

    expect(activateTradeSubscription(state)).toBe(true);
    expect(state.subscribedToBuys).toBe(true);
    expect(state.everSubscribedToBuys).toBe(true);
  });

  it("persists the coverage gap before it unsubscribes", async () => {
    const state = pool();
    const order: string[] = [];
    const coordinator = new TradeCoverageReleaseCoordinator();

    await expect(
      coordinator.release(
        "pool-1",
        state,
        "rpc-trade-observation-capacity-rotation",
        "2026-08-26T21:00:00.000Z",
        {
          persist: async () => {
            order.push("persist");
            expect(state.subscribedToBuys).toBe(true);
            expect(state.tradeCoverageComplete).toBe(false);
          },
          unsubscribe: () => order.push("unsubscribe")
        }
      )
    ).resolves.toBe("released");

    expect(order).toEqual(["persist", "unsubscribe"]);
    expect(state).toMatchObject({
      subscribedToBuys: false,
      tradeCoverageComplete: false,
      tradeCoveragePersisted: false,
      tradeCoverageGapReason: "rpc-trade-observation-capacity-rotation"
    });
  });

  it("restores exact state and keeps the subscription on persistence failure", async () => {
    const state = pool();
    const before = { ...state };
    const coordinator = new TradeCoverageReleaseCoordinator();
    let unsubscribed = false;

    await expect(
      coordinator.release(
        "pool-1",
        state,
        "rpc-trade-queue-full",
        "2026-08-26T21:00:00.000Z",
        {
          persist: async () => {
            throw new Error("database unavailable");
          },
          unsubscribe: () => {
            unsubscribed = true;
          }
        }
      )
    ).rejects.toThrow("database unavailable");

    expect(state).toEqual(before);
    expect(unsubscribed).toBe(false);
    expect(coordinator.isInFlight("pool-1")).toBe(false);
  });

  it("coalesces a concurrent release for the same pool", async () => {
    const state = pool();
    const coordinator = new TradeCoverageReleaseCoordinator();
    let finishPersist!: () => void;
    const persisted = new Promise<void>((resolve) => {
      finishPersist = resolve;
    });
    let unsubscribeCount = 0;
    const first = coordinator.release(
      "pool-1",
      state,
      "rpc-trade-queue-high-water",
      "2026-08-26T21:00:00.000Z",
      {
        persist: () => persisted,
        unsubscribe: () => {
          unsubscribeCount += 1;
        }
      }
    );

    await expect(
      coordinator.release(
        "pool-1",
        state,
        "later-reason",
        "2026-08-26T21:00:01.000Z",
        { persist: async () => undefined, unsubscribe: () => undefined }
      )
    ).resolves.toBe("already-in-flight");
    expect(coordinator.isInFlight("pool-1")).toBe(true);

    finishPersist();
    await expect(first).resolves.toBe("released");
    expect(unsubscribeCount).toBe(1);
    expect(coordinator.isInFlight("pool-1")).toBe(false);
  });
});
