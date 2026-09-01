import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("durable Solana signature retry migration", () => {
  it("adds due-time retry state, terminal evidence and fail-closed coverage", async () => {
    const sql = await readFile(
      "scripts/migrations/057_durable_solana_signature_retry.sql",
      "utf8"
    );
    expect(sql).toContain("attempt_count INTEGER NOT NULL DEFAULT 0");
    expect(sql).toContain("next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
    expect(sql).toContain("status IN ('pending', 'completed', 'dead_letter')");
    expect(sql).toContain("idx_solana_signature_queue_pending_due");
    expect(sql).toContain("idx_solana_signature_queue_dead_letter");
    expect(sql).toContain("'unresolved_transaction'");
  });
});
