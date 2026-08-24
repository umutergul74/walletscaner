import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("wallet-alpha priority queue migration", () => {
  it("adds bounded priority, revision-safe enqueue and a wake-up-only notification", async () => {
    const sql = await readFile(
      new URL("../../../scripts/migrations/043_wallet_alpha_priority_queue.sql", import.meta.url),
      "utf8"
    );

    expect(sql).toContain("priority SMALLINT NOT NULL DEFAULT 0");
    expect(sql).toContain("CHECK (priority BETWEEN 0 AND 2)");
    expect(sql).toContain("idx_wallet_alpha_work_priority_claim");
    expect(sql).toContain("revision = wallet_alpha_work_queue.revision + 1");
    expect(sql).toContain("GREATEST(wallet_alpha_work_queue.priority, EXCLUDED.priority)");
    expect(sql).toContain(
      "wallet_alpha_work_queue.revision > wallet_alpha_work_queue.completed_revision"
    );
    expect(sql).toContain("normalize_wallet_alpha_work");
    expect(sql).toContain("BEFORE INSERT OR UPDATE OF revision, completed_revision, pending_since");
    expect(sql).toContain("pg_notify(");
    expect(sql).toContain("'wallet_alpha_work'");
  });
});
