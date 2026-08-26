import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const sourcePath = "scripts/archive/wallet-evidence-materializer.ts";
const healthSourcePath = "scripts/maintenance/check-operational-health.ts";

describe("wallet evidence materializer control flow", () => {
  it("blocks newer verified days behind the oldest unresolved compact day", async () => {
    const source = await readFile(sourcePath, "utf8");
    const claim = source.slice(
      source.indexOf("WITH oldest_unmaterialized AS"),
      source.indexOf("const segment = candidate.rows[0]")
    );

    expect(claim).toContain("ORDER BY segment.range_start");
    expect(claim).toContain("LIMIT 1");
    expect(claim.indexOf("LIMIT 1")).toBeLessThan(claim.indexOf("compact_not_before <= NOW()"));
  });

  it("separates retryable operational failures from proven parity mismatches", async () => {
    const source = await readFile(sourcePath, "utf8");

    expect(source).toContain('type CompactFailureDisposition = "mismatch" | "retry"');
    expect(source).toContain('"source-counts",\n        "mismatch"');
    expect(source).toContain('"parity",\n        "mismatch"');
    expect(source).toContain('new CompactMaterializationError(name, "retry"');
    expect(source).toContain("WHEN EXCLUDED.status='retry' THEN INTERVAL '30 minutes'");
  });

  it("records bounded phase timings without exposing SQL or connection values", async () => {
    const source = await readFile(sourcePath, "utf8");

    expect(source).toContain('phase("reconcile-episodes"');
    expect(source).toContain('phase("parity-followability-fact"');
    expect(source).toContain("phaseDurationsMs");
    expect(source).not.toContain("console.log(databaseUrl)");
  });

  it("uses one stable ledger snapshot and suppresses unchanged compact rewrites", async () => {
    const source = await readFile(sourcePath, "utf8");

    expect(source).toContain('client.query("BEGIN ISOLATION LEVEL REPEATABLE READ")');
    expect(source).toContain("INSERT INTO wallet_profitability_episode_facts AS fact");
    expect(source).toContain("fact.high_quality_price_coverage, fact.terminal_reason");
    expect(source).toContain("INSERT INTO wallet_open_lot_facts AS fact");
    expect(source).toContain("current_lots AS MATERIALIZED");
    expect(source).toContain("AND NOT EXISTS (\n         SELECT 1 FROM current_lots current");
    expect(source).not.toContain("DELETE FROM wallet_open_lot_facts fact\n     USING affected\n     WHERE fact.episode_hash=affected.episode_hash`");
  });

  it("reports retryable work separately from proven parity mismatches", async () => {
    const source = await readFile(healthSourcePath, "utf8");

    expect(source).toContain("WHERE status = 'mismatch'");
    expect(source).toContain("WHERE status = 'retry'");
    expect(source).toContain("wallet compact operational retry days");
    expect(source).toContain("compactRetryDays: row.wallet_compact_retry_days");
  });
});
