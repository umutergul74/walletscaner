import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { collectMaintenanceProbes, payloadCompactionHasPriority } from "./maintenance-inventory";

function fakePool(run: (sql: string) => unknown) {
  const query = vi.fn(async (sql: string) => run(sql));
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ query, release })) };
  return { pool: pool as unknown as pg.Pool, query, release };
}

describe("bounded independent maintenance inventory", () => {
  it("keeps unknown after one timed-out probe and continues the unrelated probe", async () => {
    const { pool, query, release } = fakePool((sql) => {
      if (sql === "slow") throw Object.assign(new Error("timeout"), { code: "57014" });
      return { rows: [{ eligible: false }] };
    });
    const result = await collectMaintenanceProbes(
      pool,
      [
        { key: "chain_event_payloads_overdue", sql: "slow" },
        { key: "price", sql: "fast" }
      ],
      { budgetMs: 5_000, probeTimeoutMs: 1_000 }
    );
    expect(result).toEqual({
      values: { chain_event_payloads_overdue: null, price: false },
      timedOut: ["chain_event_payloads_overdue"],
      deferred: []
    });
    expect(payloadCompactionHasPriority(result)).toBe(true);
    expect(query.mock.calls.map((call) => call[0])).toContain("ROLLBACK");
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenLastCalledWith(false);
  });

  it("grants competing metadata work only on an explicitly false payload-priority probe", () => {
    for (const value of [true, null, undefined]) {
      expect(
        payloadCompactionHasPriority({
          values:
            value === undefined
              ? {}
              : {
                  chain_event_payloads_overdue: value
                },
          timedOut: [],
          deferred: []
        })
      ).toBe(true);
    }
    expect(
      payloadCompactionHasPriority({
        values: { chain_event_payloads_overdue: false },
        timedOut: [],
        deferred: []
      })
    ).toBe(false);
  });

  it("defers remaining probes without inventing false after the total budget expires", async () => {
    let now = 0;
    const { pool } = fakePool((sql) => {
      if (sql === "first") now = 50;
      return { rows: [{ eligible: true }] };
    });
    const result = await collectMaintenanceProbes(
      pool,
      [
        { key: "a", sql: "first" },
        { key: "b", sql: "second" }
      ],
      { budgetMs: 50, probeTimeoutMs: 1_000, now: () => now }
    );
    expect(result).toEqual({ values: { a: true, b: null }, timedOut: [], deferred: ["b"] });
  });

  it("does not suppress permission/schema/connection failures or malformed evidence", async () => {
    for (const code of ["42501", "42P01", "08006"]) {
      const { pool } = fakePool((sql) => {
        if (sql === "probe") throw Object.assign(new Error("failed"), { code });
        return { rows: [] };
      });
      await expect(
        collectMaintenanceProbes(pool, [{ key: "a", sql: "probe" }], {
          budgetMs: 100,
          probeTimeoutMs: 50
        })
      ).rejects.toMatchObject({ code });
    }
    const { pool } = fakePool(() => ({ rows: [{ eligible: null }] }));
    await expect(
      collectMaintenanceProbes(pool, [{ key: "a", sql: "probe" }], {
        budgetMs: 100,
        probeTimeoutMs: 50
      })
    ).rejects.toThrow("invalid evidence");
  });

  it("destroys a connection whose timeout rollback fails", async () => {
    const { pool, release } = fakePool((sql) => {
      if (sql === "probe" || sql === "ROLLBACK") {
        throw Object.assign(new Error("failed"), { code: "57014" });
      }
      return { rows: [] };
    });
    await expect(
      collectMaintenanceProbes(pool, [{ key: "a", sql: "probe" }], {
        budgetMs: 100,
        probeTimeoutMs: 50
      })
    ).rejects.toThrow("failed");
    expect(release).toHaveBeenCalledWith(true);
  });

  it("rejects unbounded or duplicate probe configurations", async () => {
    const { pool } = fakePool(() => ({ rows: [] }));
    await expect(
      collectMaintenanceProbes(pool, [], { budgetMs: Infinity, probeTimeoutMs: 100 })
    ).rejects.toThrow("Invalid");
    await expect(
      collectMaintenanceProbes(
        pool,
        [
          { key: "a", sql: "a" },
          { key: "a", sql: "b" }
        ],
        { budgetMs: 100, probeTimeoutMs: 50 }
      )
    ).rejects.toThrow("Invalid");
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "maintenance inventory PostgreSQL16 recovery",
  () => {
    it("cancels one read-only query, rolls back, then reads correctly on the same pooled backend", async () => {
      const pool = new pg.Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        max: 1,
        connectionTimeoutMillis: 2_000,
        statement_timeout: 1_000
      });
      try {
        const result = await collectMaintenanceProbes(
          pool,
          [
            { key: "slow", sql: "SELECT true AS eligible FROM pg_sleep(0.15)" },
            { key: "fast", sql: "SELECT true AS eligible" }
          ],
          { budgetMs: 1_000, probeTimeoutMs: 30 }
        );
        expect(result).toEqual({
          values: { slow: null, fast: true },
          timedOut: ["slow"],
          deferred: []
        });
        expect((await pool.query("SHOW statement_timeout")).rows[0].statement_timeout).toBe("1s");
      } finally {
        await pool.end();
      }
    });
  }
);
