import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("durable Solana signature queue migration", () => {
  it("creates bounded pending and completed-retention access paths", async () => {
    const sql = await readFile(
      "scripts/migrations/041_durable_solana_signature_queue.sql",
      "utf8"
    );
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS solana_signature_queue");
    expect(sql).toContain("PRIMARY KEY (provider, address, signature)");
    expect(sql).toContain("idx_solana_signature_queue_pending");
    expect(sql).toContain("idx_solana_signature_queue_completed_retention");
    expect(sql).toContain("status IN ('pending', 'completed')");
  });
});
