import { describe, expect, it } from "vitest";
import { resolveObjectLockEvidence, serializeRecordTypeCounts } from "./runtime";

describe("serializeRecordTypeCounts", () => {
  it("uses a deterministic key order for upload and verification metadata", () => {
    expect(
      serializeRecordTypeCounts({ wallet_signal_outcome: 2, wallet_entry_signal: 1 })
    ).toBe('{"wallet_entry_signal":1,"wallet_signal_outcome":2}');
  });
});

describe("resolveObjectLockEvidence", () => {
  it("preserves retention returned by the API", () => {
    expect(
      resolveObjectLockEvidence({
        evidenceMode: "api-verified",
        apiMode: "COMPLIANCE",
        apiRetainUntil: "2026-09-12T00:00:00.000Z",
        defaultMode: "GOVERNANCE",
        defaultDays: 30
      })
    ).toEqual({
      objectLockMode: "COMPLIANCE",
      objectLockEvidence: "api-verified",
      retainUntil: "2026-09-12T00:00:00.000Z"
    });
  });

  it("labels user-attested bucket-default retention without claiming API verification", () => {
    expect(
      resolveObjectLockEvidence({
        evidenceMode: "attested-default-policy",
        defaultMode: "GOVERNANCE",
        defaultDays: 30,
        uploadedAt: "2026-08-13T00:00:00.000Z"
      })
    ).toEqual({
      objectLockMode: "GOVERNANCE",
      objectLockEvidence: "attested-default-policy",
      retainUntil: "2026-09-12T00:00:00.000Z"
    });
  });

  it("rejects an attested receipt without a durable upload timestamp", () => {
    expect(() =>
      resolveObjectLockEvidence({
        evidenceMode: "attested-default-policy",
        defaultMode: "GOVERNANCE",
        defaultDays: 30
      })
    ).toThrow("valid upload time");
  });
});
