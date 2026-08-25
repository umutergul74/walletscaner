import { describe, expect, it } from "vitest";
import { canonicalClaimRetryDecision, postgresErrorCode } from "./postgres-retry";

describe("canonical PostgreSQL claim retry", () => {
  it("retries deadlocks quickly with a bounded exponential delay", () => {
    expect(canonicalClaimRetryDecision({ code: "40P01" }, 1, () => 0.5)).toEqual({
      code: "40P01",
      transient: true,
      delayMs: 250
    });
    expect(canonicalClaimRetryDecision({ code: "40P01" }, 20, () => 0.5).delayMs).toBe(10_000);
  });

  it("keeps unknown failures alive but backs them off more conservatively", () => {
    expect(canonicalClaimRetryDecision(new Error("schema mismatch"), 1, () => 0.5)).toEqual({
      code: "unknown",
      transient: false,
      delayMs: 5_000
    });
    expect(canonicalClaimRetryDecision({}, 20, () => 0.5).delayMs).toBe(60_000);
  });

  it("extracts only the PostgreSQL error code", () => {
    expect(postgresErrorCode({ code: " 55P03 ", detail: "sensitive detail" })).toBe("55P03");
    expect(postgresErrorCode("failed")).toBe("unknown");
  });
});
