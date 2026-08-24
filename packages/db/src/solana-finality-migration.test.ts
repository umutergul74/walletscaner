import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Solana finality gate migration", () => {
  it("adds a future-only gate without relabelling historical events", async () => {
    const sql = await readFile("scripts/migrations/042_solana_finality_gate.sql", "utf8");
    expect(sql).toContain("finality_required BOOLEAN NOT NULL DEFAULT FALSE");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS solana_transaction_finality");
    expect(sql).toContain("idx_solana_transaction_finality_pending");
    expect(sql).not.toMatch(/UPDATE\s+chain_event_inbox/iu);
  });
});
