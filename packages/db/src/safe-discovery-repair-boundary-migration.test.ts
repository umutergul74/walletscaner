import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("migration 045 safe discovery repair boundary", () => {
  it("contains legacy live-cursor sessions and enforces exact truncation-cursor proof", async () => {
    const sql = await readFile(
      "scripts/migrations/045_safe_discovery_repair_boundary.sql",
      "utf8"
    );

    expect(sql).toContain("boundary_source TEXT NOT NULL");
    expect(sql).toContain("unsafe_legacy_current_cursor");
    expect(sql).toContain("truncation_cursor");
    expect(sql).toContain("unsafe-live-cursor-boundary-r16");
    expect(sql).toContain("transport_recovered_gap_unreconciled");
    expect(sql).toContain("enforce_ingestion_coverage_repair_proof");
    expect(sql).toContain("completed safe-boundary repair");
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
  });
});
