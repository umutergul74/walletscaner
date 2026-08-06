import { describe, expect, it } from "vitest";
import { shouldPersistPoolState } from "./pool-state-persistence";

describe("pool state persistence", () => {
  const intervalMs = 300_000;

  it("persists the first market sample and each eligibility transition immediately", () => {
    expect(
      shouldPersistPoolState({
        nowMs: 1_000,
        intervalMs,
        marketEligible: false,
        rugged: false
      })
    ).toBe(true);
    expect(
      shouldPersistPoolState({
        nowMs: 2_000,
        intervalMs,
        marketEligible: true,
        rugged: false,
        lastPersistedAtMs: 1_000,
        lastPersistedMarketEligible: false
      })
    ).toBe(true);
  });

  it("skips unchanged high-frequency samples until the durable interval elapses", () => {
    expect(
      shouldPersistPoolState({
        nowMs: 299_999,
        intervalMs,
        marketEligible: true,
        rugged: false,
        lastPersistedAtMs: 0,
        lastPersistedMarketEligible: true
      })
    ).toBe(false);
    expect(
      shouldPersistPoolState({
        nowMs: 300_000,
        intervalMs,
        marketEligible: true,
        rugged: false,
        lastPersistedAtMs: 0,
        lastPersistedMarketEligible: true
      })
    ).toBe(true);
  });

  it("persists a rug immediately even inside the durable interval", () => {
    expect(
      shouldPersistPoolState({
        nowMs: 10_000,
        intervalMs,
        marketEligible: false,
        rugged: true,
        lastPersistedAtMs: 9_000,
        lastPersistedMarketEligible: false
      })
    ).toBe(true);
  });
});
