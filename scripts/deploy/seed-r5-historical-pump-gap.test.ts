import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const scriptPath = new URL("./seed-r5-historical-pump-gap.sql", import.meta.url);

describe("R5 historical Pump gap seed contract", () => {
  it("is idempotent, advisory-locked and preserves the reviewed evidence boundary", async () => {
    const source = await readFile(scriptPath, "utf8");

    expect(source).toContain("\\set ON_ERROR_STOP on");
    expect(source).toContain("BEGIN;");
    expect(source).toContain("COMMIT;");
    expect(source).toContain("pg_advisory_xact_lock");
    expect(source).toContain("walletscaner:discovery-coverage:");
    expect(source).toContain("ON CONFLICT (idempotency_key) DO NOTHING");
    expect(source).toContain("r5-historical-pump-gap-440548309-440551012");
    expect(source).toContain("'2026-08-20T21:10:45.000Z'::timestamptz");
    expect(source).toContain("'2026-08-20T21:29:31.000Z'::timestamptz");
    expect(source).toContain("'observedGapSeconds', 1126");
    expect(source).toContain("'historicalReconstructionProven', false");
    expect(source).toContain("transport_recovered_gap_unreconciled");
    expect(source).toContain("exact_match_count <> 1");
  });

  it("inserts evidence without modifying or deleting existing production rows", async () => {
    const source = await readFile(scriptPath, "utf8");

    expect(source).toContain("INSERT INTO ingestion_coverage_incidents");
    expect(source).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE|DROP)\b/i);
  });
});
