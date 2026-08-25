import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const composePath = new URL("../../docker-compose.server.yml", import.meta.url);

describe("server PostgreSQL backup scheduler", () => {
  it("uses the bounded fast PostgreSQL 16 custom archive profile", async () => {
    const compose = await readFile(composePath, "utf8");
    const scheduler = compose.slice(
      compose.indexOf("  postgres-backup:"),
      compose.indexOf("\nvolumes:")
    );

    expect(scheduler).toContain("-Fc \\");
    expect(scheduler).toContain("--compress=zstd:1 --no-owner --no-acl");
    expect(scheduler).not.toContain("-Z 6");
    expect(scheduler).toContain('pg_restore --list "$${tmp}"');
    expect(scheduler).toContain('mv "$${tmp}" "$${final}"');
  });
});
