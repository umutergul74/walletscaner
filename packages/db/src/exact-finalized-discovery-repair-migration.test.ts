import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("exact finalized discovery repair migration", () => {
  it("binds completion to the immutable target and reconciliation to finalized proof", async () => {
    const sql = await readFile(
      "scripts/migrations/046_exact_finalized_discovery_repair_proof.sql",
      "utf8"
    );

    expect(sql).toContain("previous_covered_through_signature");
    expect(sql).toContain("covered_through_signature = repair.target_signature");
    expect(sql).toContain("completed_signature_count = fetched_signature_count");
    expect(sql).toContain("target_verified_at IS NOT NULL");
    expect(sql).toContain("target_confirmation_status = 'finalized'");
    expect(sql).toContain("exact finalized repair target proof");
  });
});
