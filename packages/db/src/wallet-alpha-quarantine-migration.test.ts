import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("wallet-alpha evidence quarantine migration", () => {
  it("preserves active quarantine across function and legacy enqueue paths", async () => {
    const sql = await readFile(
      new URL(
        "../../../scripts/migrations/047_wallet_alpha_evidence_quarantine.sql",
        import.meta.url
      ),
      "utf8"
    );

    expect(sql).toContain("quarantine_reason TEXT");
    expect(sql).toContain("quarantine_reason = 'evidence_limit'");
    expect(sql.match(/wallet_alpha_work_queue\.not_before > NOW\(\)/g)).toHaveLength(2);
    expect(sql).toContain("NEW.revision > OLD.revision");
    expect(sql).toContain("NEW.not_before := OLD.not_before");
    expect(sql).toContain("NEW.quarantine_reason := NULL");
  });
});
