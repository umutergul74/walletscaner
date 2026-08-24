import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("exact finalized discovery repair migration", () => {
  it("binds completion to the immutable target and reconciliation to finalized proof", async () => {
    const sql = await readFile(
      "scripts/migrations/046_exact_finalized_discovery_repair_proof.sql",
      "utf8"
    );

    expect(sql).toContain("ingestion_gap_repair_target_proofs");
    expect(sql).toContain("discovery repair target proof is append-only");
    expect(sql).toContain("covered_through_signature IS DISTINCT FROM NEW.target_signature");
    expect(sql).toContain("repair.completed_signature_count = repair.fetched_signature_count");
    expect(sql).toContain("proof.confirmation_status = 'finalized'");
    expect(sql).toContain("exact finalized repair target proof");
  });
});
