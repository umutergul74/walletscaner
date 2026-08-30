import { readFile } from "node:fs/promises";
import pg from "pg";
import { describe, expect, it } from "vitest";

describe.skipIf(!process.env.TEST_DATABASE_URL)("partition-safe price retention", () => {
  it("reproduces the old ctid collision and proves the actual maintenance SQL retains fresh rows", async () => {
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    const schema = `price_retention_${Date.now()}`;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET LOCAL search_path = ${schema}`);
      await client.query(`CREATE TABLE price_observations (observed_at timestamptz NOT NULL)
        PARTITION BY RANGE(observed_at)`);
      for (const [name, low, high] of [
        ["old", "2000-01-01", "2020-01-01"],
        ["fresh", "2020-01-01", "2100-01-01"]
      ]) {
        await client.query(`CREATE TABLE ${name} PARTITION OF price_observations
          FOR VALUES FROM ('${low}') TO ('${high}')`);
      }
      await client.query("INSERT INTO price_observations VALUES ('2010-01-01'), (NOW())");
      const rows = await client.query(
        "SELECT tableoid::text, ctid::text FROM price_observations ORDER BY observed_at"
      );
      expect(rows.rows[0].ctid).toBe(rows.rows[1].ctid);
      expect(rows.rows[0].tableoid).not.toBe(rows.rows[1].tableoid);
      await client.query("SAVEPOINT before_legacy_bug");
      const legacy = await client.query(`WITH doomed AS (SELECT ctid FROM price_observations
        WHERE observed_at < NOW() - INTERVAL '2 days' LIMIT 1 FOR UPDATE SKIP LOCKED)
        DELETE FROM price_observations target USING doomed WHERE target.ctid = doomed.ctid`);
      expect(legacy.rowCount).toBe(2);
      await client.query("ROLLBACK TO SAVEPOINT before_legacy_bug");
      const source = await readFile(
        new URL("./prune-operational-data.ts", import.meta.url),
        "utf8"
      );
      const match = source
        .slice(source.indexOf("deletedPriceObservations = await pruneInBatches("))
        .match(/`([\s\S]*?)`/);
      expect(match).not.toBeNull();
      expect((await client.query(match![1]!, [2, 1])).rowCount).toBe(1);
      expect((await client.query("SELECT count(*)::int AS n FROM fresh")).rows[0].n).toBe(1);
      expect((await client.query("SELECT count(*)::int AS n FROM old")).rows[0].n).toBe(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
      await pool.end();
    }
  });
});
