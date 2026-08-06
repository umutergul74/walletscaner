import { describe, expect, it } from "vitest";
import { dedupeSignalsByToken } from "./signal-cohorts.js";

describe("signal cohort independence", () => {
  it("keeps only the earliest signal for each token", () => {
    const signals = [
      { tokenAddress: "token-a", signalAt: "2026-07-04T12:05:00.000Z", method: "wallet" },
      { tokenAddress: "token-b", signalAt: "2026-07-04T12:03:00.000Z", method: "traction" },
      { tokenAddress: "token-a", signalAt: "2026-07-04T12:01:00.000Z", method: "traction" }
    ];

    expect(dedupeSignalsByToken(signals)).toEqual([signals[2], signals[1]]);
  });
});
