import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const scriptPath = new URL("./backfill-ingestion-cursor-chain-time.ts", import.meta.url);

describe("discovery cursor chain-time repair contract", () => {
  it("is dry-run by default and requires every configured program cursor", async () => {
    const source = await readFile(scriptPath, "utf8");

    expect(source).toContain('const APPLY = process.env.CURSOR_CHAIN_TIME_APPLY === "true"');
    expect(source).toContain("Missing durable discovery cursors");
    expect(source).toContain(
      "SOLANA_POOL_PROGRAMS_JSON contains an invalid or duplicate program id"
    );
    expect(source).toContain('mode: APPLY ? "apply" : "dry-run"');
  });

  it("repairs only the exact unchanged cursor and verifies zero unresolved rows", async () => {
    const source = await readFile(scriptPath, "utf8");

    expect(source).toContain('method: "getBlockTime"');
    expect(source).toContain("occurredAt.getTime() > observedAt.getTime() + 5 * 60_000");
    expect(source).toContain("SET last_event_occurred_at = $5::timestamptz");
    expect(source).toContain("AND address = $2");
    expect(source).toContain("AND last_signature = $3");
    expect(source).toContain("AND last_slot = $4");
    expect(source).toContain("AND last_event_occurred_at IS NULL");
    expect(source).toContain('await client.query("BEGIN")');
    expect(source).toContain('await client.query("COMMIT")');
    expect(source).toContain('await client.query("ROLLBACK")');
    expect(source).toContain("Discovery cursors kept moving or remained unresolved");
  });

  it("contains no destructive SQL or retention bypass", async () => {
    const source = await readFile(scriptPath, "utf8");

    expect(source).not.toMatch(/\b(?:DELETE|TRUNCATE|DROP)\b/i);
    expect(source).not.toContain("ARCHIVE_RETIREMENT_ENABLED");
  });
});
