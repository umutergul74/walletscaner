import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("migration 044 durable discovery gap repair contract", () => {
  it("persists bounded oldest-first replay state and explicit reconciliation proof", async () => {
    const sql = await readFile(
      "scripts/migrations/044_durable_discovery_gap_repair.sql",
      "utf8"
    );

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS ingestion_gap_repairs");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS ingestion_gap_repair_signatures");
    expect(sql).toContain("idx_ingestion_gap_repairs_one_active");
    expect(sql).toContain("WHERE status IN ('collecting', 'replaying')");
    expect(sql).toContain("UNIQUE (repair_id, position_from_head)");
    expect(sql).toContain("position_from_head DESC");
    expect(sql).toContain("coverage_reconciled_at TIMESTAMPTZ");
    expect(sql).toContain("coverage_repair_id TEXT");
    expect(sql).toContain("REFERENCES ingestion_gap_repairs(repair_id)");
    expect(sql).toContain("coverage_reconciled_at <= closed_at");
    expect(sql).not.toMatch(/ON DELETE CASCADE/i);
    expect(sql).not.toMatch(/DROP\s+TABLE/i);
  });
});
