import { describe, expect, it } from "vitest";

import { payloadPartitionOutsideHotWindow } from "./archive-retention";

describe("payload partition hot-window retention", () => {
  const now = new Date("2026-08-16T12:00:00.000Z");

  it("uses the configured hour horizon rather than the inbox metadata days", () => {
    expect(
      payloadPartitionOutsideHotWindow("chain_event_payloads_20260813", 48, now)
    ).toBe(true);
    expect(
      payloadPartitionOutsideHotWindow("chain_event_payloads_20260814", 48, now)
    ).toBe(false);
  });

  it("fails closed for malformed partition names and invalid retention", () => {
    expect(payloadPartitionOutsideHotWindow("chain_event_payloads_default", 48, now)).toBe(
      false
    );
    expect(() => payloadPartitionOutsideHotWindow("chain_event_payloads_20260813", 0, now)).toThrow(
      "Payload partition retention hours must be positive"
    );
  });
});
