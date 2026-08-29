import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("future alpha decision tape migration", () => {
  it("freezes a bounded shadow-only evidence contract without destructive data work", async () => {
    const sql = await readFile("scripts/migrations/052_future_alpha_decision_tape.sql", "utf8");

    expect(sql).toContain("'survival-execution-tape-v1-20260830'");
    expect(sql).toContain("'liveExecutionEnabled', false");
    expect(sql).toContain("'paperEnabled', false");
    expect(sql).toContain("'telegramEnabled', false");
    expect(sql).toContain("CHECK (paper_eligible = FALSE)");
    expect(sql).toContain("horizon_seconds IN (0, 15, 30, 60, 120, 300)");
    expect(sql).toContain("notional_usd_cents IN (600, 2500, 10000)");
    expect(sql).toContain("retain_until >= decided_at + INTERVAL '30 days'");
    expect(sql).not.toMatch(/DELETE\s+FROM|DROP\s+TABLE|VACUUM\s+FULL/iu);
  });
});
