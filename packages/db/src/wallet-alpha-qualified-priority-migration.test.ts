import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("wallet-alpha qualified signal lane migration", () => {
  it("reclassifies pending legacy P2 work without deleting evidence or revisions", async () => {
    const sql = await readFile(
      new URL(
        "../../../scripts/migrations/048_wallet_alpha_qualified_signal_lane.sql",
        import.meta.url
      ),
      "utf8"
    );

    expect(sql).toContain("work.revision > work.completed_revision");
    expect(sql).toContain("ORDER BY score.calculated_at DESC");
    expect(sql).toContain("'watch', 'candidate', 'validated-paper'");
    expect(sql).toContain("risk-passed-qualified-wallet-entry");
    expect(sql).toContain("risk-passed-unqualified-wallet-entry");
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
  });
});
