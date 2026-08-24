import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("PostgreSQL query observability migration", () => {
  it("installs pg_stat_statements without destructive DDL", async () => {
    const sql = await readFile(
      "scripts/migrations/040_postgres_query_observability.sql",
      "utf8"
    );

    expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE)\b/iu);
  });
});
