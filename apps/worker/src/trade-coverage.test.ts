import { describe, expect, it } from "vitest";
import {
  activateTradeSubscription,
  excludeTradeCoverage,
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
});
