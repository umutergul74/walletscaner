import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("wallet FIFO continuation migration", () => {
  it("is additive, bounded and exposes source-revision/checkpoint CAS primitives", async () => {
    const sql = await readFile(
      new URL("../../../scripts/migrations/054_wallet_fifo_continuation.sql", import.meta.url),
      "utf8"
    );

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS wallet_trade_revisions");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS wallet_fifo_continuations");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS wallet_fifo_realization_facts");
    expect(sql).toContain("octet_length(checkpoint_payload) <= 4194304");
    expect(sql).toContain("checkpoint_sha256 = digest(checkpoint_payload, 'sha256')");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION record_wallet_trade_revision");
    expect(sql).toContain("CREATE OR REPLACE FUNCTION commit_wallet_fifo_continuation");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("current_revision IS DISTINCT FROM p_expected_revision");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS base_raw_amount NUMERIC(78, 0)");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS base_token_decimals SMALLINT");
    expect(sql).toContain("NOT VALID");
    expect(sql).not.toMatch(/\b(?:DELETE|TRUNCATE|DROP)\b/i);
    expect(sql).not.toMatch(/\bFROM\s+wallet_trade_events\b/i);
  });
});
