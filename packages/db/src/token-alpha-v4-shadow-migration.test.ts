import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("token alpha v4 shadow migration", () => {
  it("pauses v3 only without open positions and freezes a no-capital shadow cohort", async () => {
    const sql = await readFile("scripts/migrations/039_token_alpha_v4_shadow.sql", "utf8");

    expect(sql).toContain("status = 'open'");
    expect(sql).toContain("RAISE EXCEPTION");
    expect(sql).toContain("SET status = 'paused'");
    expect(sql).toContain("'paperEnabled', false");
    expect(sql).toContain("'telegramEnabled', false");
    expect(sql).toContain("'liveExecutionEnabled', false");
    expect(sql).toContain("ON CONFLICT (idempotency_key) DO NOTHING");
    expect(sql).toContain("'shadow'");
    expect(sql).not.toMatch(/DELETE\s+FROM/i);
  });
});
