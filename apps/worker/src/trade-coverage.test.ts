import { describe, expect, it } from "vitest";
import {
  activateTradeSubscription,
  bootstrapTradeSubscription,
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
  it("occupies the slot before awaited provider bootstrap and coalesces duplicate admission", async () => {
    const state = pool();
    state.subscribedToBuys = false;
    state.everSubscribedToBuys = false;
    let finishBootstrap!: () => void;
    const providerBootstrap = new Promise<void>((resolve) => {
      finishBootstrap = resolve;
    });
    let subscribeCount = 0;
    const first = bootstrapTradeSubscription(state, 1_777_500_000_000, {
      subscribe: () => {
        subscribeCount += 1;
        return providerBootstrap;
      },
      failClosed: async () => undefined
    });

    expect(state).toMatchObject({
      subscribedToBuys: true,
      everSubscribedToBuys: true,
      observationSubscribedAtMs: 1_777_500_000_000
    });
    await expect(
      bootstrapTradeSubscription(state, 1_777_500_000_001, {
        subscribe: async () => {
          subscribeCount += 1;
        },
        failClosed: async () => undefined
      })
    ).resolves.toBe("already-active");
    expect(subscribeCount).toBe(1);

    finishBootstrap();
    await expect(first).resolves.toBe("activated");
  });

  it("does not reactivate coverage excluded by the awaited provider backfill", async () => {
    const state = pool();
    state.subscribedToBuys = false;
    state.everSubscribedToBuys = false;

    await expect(
      bootstrapTradeSubscription(state, 1_777_500_000_000, {
        subscribe: async () => {
          excludeTradeCoverage(
            state,
            "rpc-trade-backfill-cursorless-initial-limit",
            "2026-08-27T17:40:00.000Z"
          );
        },
        failClosed: async () => undefined
      })
    ).resolves.toBe("excluded-during-bootstrap");
    expect(state).toMatchObject({
      subscribedToBuys: false,
      tradeCoverageComplete: false,
      tradeCoverageGapReason: "rpc-trade-backfill-cursorless-initial-limit"
    });
  });

  it("runs durable fail-closed handling while a failed bootstrap still occupies the slot", async () => {
    const state = pool();
    state.subscribedToBuys = false;
    state.everSubscribedToBuys = false;
    const order: string[] = [];

    await expect(
      bootstrapTradeSubscription(state, 1_777_500_000_000, {
        subscribe: async () => {
          order.push("provider-failed");
          throw new Error("provider unavailable");
        },
        failClosed: async () => {
          order.push("fail-closed");
          expect(state.subscribedToBuys).toBe(true);
          excludeTradeCoverage(
            state,
            "rpc-trade-subscription-bootstrap-failed",
            "2026-08-27T17:40:00.000Z"
          );
        }
      })
    ).rejects.toThrow("provider unavailable");
    expect(order).toEqual(["provider-failed", "fail-closed"]);
    expect(state).toMatchObject({
      subscribedToBuys: false,
      tradeCoverageComplete: false,
      tradeCoverageGapReason: "rpc-trade-subscription-bootstrap-failed"
    });
  });

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
