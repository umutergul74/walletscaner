import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "maintenance script schema051 and failure-report compatibility",
  () => {
    const schema = `maintenance_run_${Date.now()}`;
    const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    let pool: pg.Pool;
    let directory: string;
    let childUrl: string;

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "walletscaner-maintenance-run-"));
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new pg.Pool({
        connectionString: databaseUrl,
        max: 1,
        options: `-c search_path=${schema},public`
      });
      for (const name of (await readdir("scripts/migrations"))
        .filter((name) => /^\d+.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 51)
        .sort()) {
        await pool.query(await readFile(join("scripts/migrations", name), "utf8"));
      }
      const url = new URL(databaseUrl!);
      url.searchParams.set("options", `-c search_path=${schema},public`);
      childUrl = url.toString();
    });

    afterAll(async () => {
      if (pool) await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    async function invoke() {
      return run(
        process.execPath,
        [
          "--import",
          pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href,
          resolve("scripts/maintenance/prune-operational-data.ts")
        ],
        {
          cwd: directory,
          windowsHide: true,
          timeout: 15_000,
          maxBuffer: 64 * 1024,
          env: {
            ...process.env,
            DATABASE_URL: childUrl,
            MAINTENANCE_DRY_RUN: "true",
            ARCHIVE_RETIREMENT_ENABLED: "false",
            ENABLE_LIVE_EXECUTION: "false"
          }
        }
      );
    }
    async function report() {
      return JSON.parse(
        await readFile(join(directory, "reports/operational-maintenance-latest.json"), "utf8")
      );
    }

    it("runs safely on current production schema without optional tape tables", async () => {
      await invoke();
      expect(await report()).toMatchObject({
        status: "dry-run",
        optionalSchema: { alphaDecisionTapeAvailable: false },
        deleted: { walletTrades: 0 }
      });
    });

    it("overwrites old success with sanitized failure evidence, then recovers next attempt", async () => {
      await pool.query("ALTER TABLE chain_event_inbox RENAME TO temporarily_missing_inbox");
      try {
        await expect(invoke()).rejects.toMatchObject({ code: 1 });
        const failed = await report();
        expect(failed).toMatchObject({ status: "failed", stage: "inventory", code: "42P01" });
        expect(failed).not.toHaveProperty("message");
      } finally {
        await pool.query("ALTER TABLE temporarily_missing_inbox RENAME TO chain_event_inbox");
      }
      await invoke();
      expect((await report()).status).toBe("dry-run");
    });
  }
);
