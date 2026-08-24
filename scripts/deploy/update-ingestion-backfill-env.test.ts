import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("./update-ingestion-backfill-env.py", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

describe("scoped ingestion backfill environment updater", () => {
  it("dry-runs by default and atomically changes only the guarded key", async () => {
    const fixture = await createFixture();
    const before = await readFile(fixture);
    const arguments_ = guardedArguments(fixture, digest(before));

    expect(runPython(arguments_).status).toBe(0);
    expect(await readFile(fixture)).toEqual(before);

    const applied = runPython([...arguments_, "--apply"]);
    expect(applied.status).toBe(0);
    expect(await readFile(fixture, "utf8")).toBe(
      "SECRET_VALUE=preserved\nRPC_TRADE_INITIAL_BACKFILL_LIMIT=500\nOTHER=unchanged\n"
    );
    expect(JSON.parse(applied.stdout)).toMatchObject({
      mode: "apply",
      change: { key: "RPC_TRADE_INITIAL_BACKFILL_LIMIT", from: "5", to: "500" }
    });
  });

  it("refuses a stale file hash or stale current value without mutation", async () => {
    const fixture = await createFixture();
    const before = await readFile(fixture);
    expect(runPython(guardedArguments(fixture, "0".repeat(64))).status).not.toBe(0);
    expect(await readFile(fixture)).toEqual(before);
    expect(
      runPython([
        "--env-file",
        fixture,
        "--expected-file-sha256",
        digest(before),
        "--expected-current",
        "6",
        "--set",
        "500",
        "--apply"
      ]).status
    ).not.toBe(0);
    expect(await readFile(fixture)).toEqual(before);
  });

  it("refuses a duplicate key without mutation", async () => {
    const fixture = await createFixture();
    await writeFile(fixture, "RPC_TRADE_INITIAL_BACKFILL_LIMIT=5\nRPC_TRADE_INITIAL_BACKFILL_LIMIT=5\n");
    const before = await readFile(fixture);
    expect(runPython([...guardedArguments(fixture, digest(before)), "--apply"]).status).not.toBe(0);
    expect(await readFile(fixture)).toEqual(before);
  });
});

async function createFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "walletscaner-backfill-env-"));
  temporaryDirectories.push(directory);
  const path = join(directory, ".env.server");
  await writeFile(
    path,
    "SECRET_VALUE=preserved\nRPC_TRADE_INITIAL_BACKFILL_LIMIT=5\nOTHER=unchanged\n"
  );
  return path;
}

function guardedArguments(envFile: string, expectedHash: string): string[] {
  return [
    "--env-file",
    envFile,
    "--expected-file-sha256",
    expectedHash,
    "--expected-current",
    "5",
    "--set",
    "500"
  ];
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function runPython(arguments_: string[]) {
  return spawnSync("python", [scriptPath, ...arguments_], {
    encoding: "utf8",
    shell: false
  });
}
