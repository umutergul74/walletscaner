import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { PaperTradingStore } from "./paper-trading-store";

describe("PaperTradingStore discovery coverage", () => {
  it("derives candidate coverage only from the canonical exact pool", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const store = new PaperTradingStore({ query } as never);

    await store.listQualifiedPoolCandidates("paper-v1", 120, 5, "strict-v1");

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("pool.pool_address = message.payload->>'poolAddress'");
    expect(sql).toContain("pool.base_token_address = message.payload->>'tokenAddress'");
    expect(sql).toContain("pool.created_at IS NOT NULL");
    expect(sql).toContain("incident.program_address = pool.dex");
    expect(sql).toContain("portfolio.status = 'active'");
    expect(sql).toContain("message.payload->>'qualificationVersion' = $4::text");
    expect(sql).not.toContain("$4::text IS NULL");
    expect(sql).not.toContain("(message.payload->>'createdAt')::timestamptz");
  });

  it("uses the same fail-closed exact-pool predicate for the late recheck", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ eligible: false }] });
    const store = new PaperTradingStore({ query } as never);

    await expect(store.isQualifiedPoolCandidateCoverageEligible("message-1")).resolves.toBe(false);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("SELECT EXISTS (");
    expect(sql).toContain("FROM pools pool");
    expect(sql).toContain("pool.created_at IS NOT NULL");
    expect(sql).toContain("AND NOT EXISTS (");
  });

  it("requires an explicit paper qualification version", async () => {
    const query = vi.fn();
    const store = new PaperTradingStore({ query } as never);

    await expect(store.listQualifiedPoolCandidates("paper-v1", 120, 5, "")).rejects.toThrow(
      "qualification version is required"
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("keeps the production worker pinned to the authorized v3 cohort", async () => {
    const source = await readFile("apps/worker/src/process-wallet-alpha-outbox.ts", "utf8");
    expect(source).toContain("configured !== QUALIFIED_POOL_PAPER_V3_STRATEGY_VERSION");
    expect(source).toContain("PAPER_STRATEGY_VERSION must be exactly");
    expect(source).not.toContain(
      "process.env.PAPER_STRATEGY_VERSION ?? QUALIFIED_POOL_PAPER_STRATEGY_VERSION"
    );
  });
});
