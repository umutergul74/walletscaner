import { describe, expect, it } from "vitest";
import {
  evaluateTradeObservationHealth,
  planTradeObservationAdmission,
  type TradeObservationPool
} from "./trade-observation-scheduler.js";

const nowMs = Date.parse("2026-08-26T21:00:00.000Z");

function pool(
  poolAddress: string,
  overrides: Partial<TradeObservationPool> = {}
): TradeObservationPool {
  return {
    poolAddress,
    createdAt: "2026-08-26T20:55:00.000Z",
    subscribedToBuys: false,
    controlledFlow: false,
    tradeCoverageComplete: true,
    ...overrides
  };
}

function plan(candidate: TradeObservationPool, pools: TradeObservationPool[]) {
  return planTradeObservationAdmission(candidate, pools, {
    nowMs,
    maximumActivePools: 3,
    minimumHoldMs: 5 * 60_000,
    marketEligible: true
  });
}

describe("trade observation scheduler", () => {
  it("fills empty capacity before token-risk/alpha admission passes", () => {
    expect(plan(pool("candidate"), [])).toEqual({
      action: "subscribe",
      reason: "available-capacity"
    });
  });

  it("fails closed for market-ineligible and coverage-incomplete pools", () => {
    expect(
      planTradeObservationAdmission(pool("market-ineligible"), [], {
        nowMs,
        maximumActivePools: 3,
        minimumHoldMs: 0,
        marketEligible: false
      })
    ).toMatchObject({ action: "defer", reason: "market-ineligible" });
    expect(plan(pool("incomplete", { tradeCoverageComplete: false }), [])).toMatchObject({
      action: "defer",
      reason: "coverage-incomplete"
    });
    expect(
      planTradeObservationAdmission(pool("invalid-capacity"), [], {
        nowMs,
        maximumActivePools: Number.NaN,
        minimumHoldMs: 0,
        marketEligible: true
      })
    ).toMatchObject({ action: "defer", reason: "capacity-disabled" });
  });

  it("enforces the hard cap and minimum hold without subscription churn", () => {
    const active = ["one", "two", "three"].map((address, index) =>
      pool(address, {
        subscribedToBuys: true,
        observationSubscribedAtMs: nowMs - (index + 1) * 60_000
      })
    );

    expect(plan(pool("candidate"), active)).toEqual({
      action: "defer",
      reason: "minimum-hold"
    });
  });

  it("deterministically replaces the oldest held, non-alpha-protected observation", () => {
    const active = [
      pool("alpha", {
        subscribedToBuys: true,
        controlledFlow: true,
        observationSubscribedAtMs: nowMs - 20 * 60_000
      }),
      pool("new-observation", {
        subscribedToBuys: true,
        observationSubscribedAtMs: nowMs - 6 * 60_000
      }),
      pool("old-observation", {
        subscribedToBuys: true,
        observationSubscribedAtMs: nowMs - 10 * 60_000
      })
    ];

    expect(plan(pool("candidate"), active)).toEqual({
      action: "replace",
      reason: "oldest-unprotected-observation",
      evictPoolAddress: "old-observation"
    });
  });

  it("never evicts complete alpha-protected capacity", () => {
    const active = ["one", "two", "three"].map((address) =>
      pool(address, {
        subscribedToBuys: true,
        controlledFlow: true,
        observationSubscribedAtMs: nowMs - 60 * 60_000
      })
    );

    expect(plan(pool("candidate"), active)).toEqual({
      action: "defer",
      reason: "alpha-protected-capacity"
    });
  });

  it("uses pool identity as the final deterministic replacement tie-breaker", () => {
    const active = ["pool-c", "pool-a", "pool-b"].map((address) =>
      pool(address, {
        createdAt: "2026-08-26T20:00:00.000Z",
        subscribedToBuys: true,
        observationSubscribedAtMs: nowMs - 10 * 60_000
      })
    );

    expect(plan(pool("candidate"), active)).toMatchObject({
      action: "replace",
      evictPoolAddress: "pool-a"
    });
  });

  it("reports a market-eligible empty lane and subscription ACK gaps as degraded", () => {
    expect(
      evaluateTradeObservationHealth({
        marketEligibleTrackedPools: 2,
        activePoolSubscriptions: 0,
        configuredAddressCount: 0,
        subscribedAddressCount: 0
      })
    ).toEqual({ status: "degraded", reason: "eligible-lane-starved" });
    expect(
      evaluateTradeObservationHealth({
        marketEligibleTrackedPools: 2,
        activePoolSubscriptions: 2,
        configuredAddressCount: 2,
        subscribedAddressCount: 1
      })
    ).toEqual({ status: "degraded", reason: "subscription-ack-gap" });
    expect(
      evaluateTradeObservationHealth({
        marketEligibleTrackedPools: 2,
        activePoolSubscriptions: 2,
        configuredAddressCount: 2,
        subscribedAddressCount: 2
      })
    ).toEqual({ status: "ok", reason: "active" });
  });
});
