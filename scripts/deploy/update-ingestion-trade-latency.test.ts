import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("./update-ingestion-trade-latency.py", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

describe("scoped ingestion RPC-trade latency updater", () => {
  it("dry-runs then changes only the reviewed latency and recovery keys", async () => {
    const fixture = await createFixture();
    const before = await readFile(fixture);
    const hash = sha256(before);

    const dryRun = runPython(fixture, hash);
    expect(dryRun.status).toBe(0);
    expect(await readFile(fixture)).toEqual(before);

    const applied = runPython(fixture, hash, true);
    expect(applied.status).toBe(0);
    const after = await readFile(fixture, "utf8");
    expect(after).toContain("SOLANA_TRANSACTION_FETCH_DELAY_MS=0");
    expect(after).toContain("RPC_TRADE_BACKFILL_PAGE_LIMIT=500");
    expect(after).toContain("RPC_TRADE_MAX_BACKFILL_PAGES=4");
    expect(after).toContain("ENABLE_LIVE_EXECUTION=false");
    expect(JSON.parse(applied.stdout)).toMatchObject({
      mode: "apply",
      change: {
        beforeSha256: hash,
        changes: [
          { key: "SOLANA_TRANSACTION_FETCH_DELAY_MS", from: "1000", to: "0" },
          { key: "RPC_TRADE_BACKFILL_PAGE_LIMIT", from: "5", to: "500" },
          { key: "RPC_TRADE_MAX_BACKFILL_PAGES", from: "1", to: "4" }
        ]
      }
    });
  });

  it("fails without mutation when the file hash is stale", async () => {
    const fixture = await createFixture();
    const before = await readFile(fixture);
    const result = runPython(fixture, "0".repeat(64), true);

    expect(result.status).not.toBe(0);
    expect(await readFile(fixture)).toEqual(before);
  });

  it("fails without mutation when a reviewed pre-state value drifted", async () => {
    const fixture = await createFixture("SOLANA_TRANSACTION_FETCH_DELAY_MS=250");
    const before = await readFile(fixture);
    const result = runPython(fixture, sha256(before), true);

    expect(result.status).not.toBe(0);
    expect(await readFile(fixture)).toEqual(before);
  });
});

async function createFixture(delay = "SOLANA_TRANSACTION_FETCH_DELAY_MS=1000"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "walletscaner-trade-latency-"));
  temporaryDirectories.push(directory);
  const path = join(directory, ".env.server");
  await writeFile(
    path,
    [
      "DATABASE_URL=postgresql://not-a-real-secret",
      delay,
      "RPC_TRADE_BACKFILL_PAGE_LIMIT=5",
      "RPC_TRADE_MAX_BACKFILL_PAGES=1",
      "ENABLE_LIVE_EXECUTION=false",
      ""
    ].join("\n"),
    "utf8"
  );
  return path;
}

function runPython(envFile: string, expectedSha256: string, apply = false) {
  return spawnSync(
    "python",
    [
      scriptPath,
      "--env-file",
      envFile,
      "--expected-sha256",
      expectedSha256,
      ...(apply ? ["--apply"] : [])
    ],
    { encoding: "utf8", shell: false }
  );
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
