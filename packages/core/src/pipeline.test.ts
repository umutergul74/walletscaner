import { describe, expect, it } from "vitest";
import { dedupeEvents } from "./pipeline";

describe("dedupeEvents", () => {
  it("rejects duplicate idempotency keys", () => {
    const result = dedupeEvents([
      {
        idempotencyKey: "same",
        chain: "solana",
        provider: "test",
        type: "token_profile",
        observedAt: new Date().toISOString(),
        payload: {}
      },
      {
        idempotencyKey: "same",
        chain: "solana",
        provider: "test",
        type: "token_profile",
        observedAt: new Date().toISOString(),
        payload: {}
      }
    ]);

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
  });
});

