import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("wallet-alpha transient retry backoff migration", () => {
  it("coalesces new revisions without shortening active retry or quarantine boundaries", async () => {
    const sql = await readFile(
      new URL(
        "../../../scripts/migrations/049_wallet_alpha_transient_retry_backoff.sql",
        import.meta.url
      ),
      "utf8"
    );

    expect(sql).toContain("wallet_alpha_work_queue.last_error IS NOT NULL");
    expect(sql).toContain("wallet_alpha_work_queue.not_before > NOW()");
    expect(sql).toContain("THEN wallet_alpha_work_queue.not_before");
    expect(sql).toContain("OLD.last_error IS NOT NULL");
    expect(sql).toContain("NEW.not_before := OLD.not_before");
    expect(sql).toContain("NEW.last_error := OLD.last_error");
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
  });
});
