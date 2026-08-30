import { describe, expect, it } from "vitest";
import { evaluateMaintenanceHealth, inspectMaintenanceReport } from "./maintenance-health";

const now = new Date("2026-08-30T21:30:00Z");
const completed = {
  type: "operational-maintenance",
  status: "completed",
  checkedAt: "2026-08-30T21:00:00Z"
};

describe("maintenance latest-attempt health", () => {
  it("accepts only a fresh completed maintenance report as healthy", () => {
    expect(evaluateMaintenanceHealth(completed, now, 3_600).reason).toBeUndefined();
    expect(evaluateMaintenanceHealth(completed, now, 1_000).reason).toBe(
      "maintenance report stale"
    );
  });
  it("does not confuse failed, partial, or dry-run work with successful retention", () => {
    for (const status of ["failed", "partial", "dry-run"]) {
      expect(evaluateMaintenanceHealth({ ...completed, status }, now, 3_600).reason).toBeDefined();
    }
  });
  it("rejects missing/malformed/future reports without inventing freshness", async () => {
    for (const value of [
      null,
      {},
      { ...completed, checkedAt: "wrong" },
      { ...completed, checkedAt: "2026-08-30T21:32:00Z" },
      { ...completed, status: "ok" }
    ]) {
      expect(evaluateMaintenanceHealth(value, now, 3_600).status).toBe("unknown");
    }
    expect(
      (await inspectMaintenanceReport("missing-maintenance-report.json", now, 3_600)).status
    ).toBe("unknown");
  });
});
