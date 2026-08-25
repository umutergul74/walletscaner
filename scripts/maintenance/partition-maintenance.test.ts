import { describe, expect, it, vi } from "vitest";
import { ensurePayloadPartitions, ensurePricePartitions } from "./partition-maintenance";

describe("maintenance partition creation", () => {
  it("does not issue DDL when all payload partitions already exist", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ relation_exists: true, attached: true }]
    });
    const connect = vi.fn();

    const result = await ensurePayloadPartitions({ query, connect } as never, 1, {
      now: new Date("2026-08-25T12:00:00.000Z")
    });

    expect(result).toEqual({ existing: 3, created: 0, deferred: 0 });
    expect(connect).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("locks the canonical inbox before creating a missing payload partition", async () => {
    let inspected = 0;
    const query = vi.fn().mockImplementation(async () => ({
      rows: [
        inspected++ === 0
          ? { relation_exists: false, attached: false }
          : { relation_exists: true, attached: true }
      ]
    }));
    const clientQuery = vi.fn().mockResolvedValue({ rows: [] });
    const release = vi.fn();
    const connect = vi.fn().mockResolvedValue({ query: clientQuery, release });

    const result = await ensurePayloadPartitions({ query, connect } as never, -1, {
      now: new Date("2026-08-25T12:00:00.000Z")
    });

    expect(result).toEqual({ existing: 0, created: 1, deferred: 0 });
    const statements = clientQuery.mock.calls.map((call) => String(call[0]));
    expect(
      statements.indexOf("LOCK TABLE chain_event_inbox IN SHARE ROW EXCLUSIVE MODE")
    ).toBeLessThan(statements.findIndex((statement) => statement.startsWith("CREATE TABLE")));
    expect(statements.at(-1)).toBe("COMMIT");
    expect(release).toHaveBeenCalledWith(false);
  });

  it("configures price autovacuum only on a newly created partition", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ relation_exists: false, attached: false }]
    });
    const clientQuery = vi.fn().mockResolvedValue({ rows: [] });
    const connect = vi.fn().mockResolvedValue({ query: clientQuery, release: vi.fn() });

    expect(
      await ensurePricePartitions({ query, connect } as never, 0, {
        now: new Date("2026-08-25T12:00:00.000Z")
      })
    ).toEqual({ existing: 0, created: 1, deferred: 0 });
    expect(clientQuery.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "autovacuum_vacuum_scale_factor"
    );
  });
});
