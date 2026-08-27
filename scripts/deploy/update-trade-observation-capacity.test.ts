import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(
  new URL("./update-trade-observation-capacity.py", import.meta.url)
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

describe("scoped trade-observation capacity updater", () => {
  it("dry-runs by default and atomically changes only the guarded key", async () => {
    const fixture = await createFixture();
    const before = await readFile(fixture);
    const arguments_ = guardedArguments(fixture, digest(before));

    expect(runPython(arguments_).status).toBe(0);
    expect(await readFile(fixture)).toEqual(before);

    const applied = runPython([...arguments_, "--apply"]);
    expect(applied.status).toBe(0);
    expect(await readFile(fixture, "utf8")).toBe(
      "SECRET_VALUE=preserved\nRPC_TRADE_MAX_ACTIVE_POOLS=1\nOTHER=unchanged\n"
    );
    expect(JSON.parse(applied.stdout)).toMatchObject({
      mode: "apply",
      change: { key: "RPC_TRADE_MAX_ACTIVE_POOLS", from: "3", to: "1" }
    });
  });

  it("refuses stale hashes, stale values and out-of-range capacities without mutation", async () => {
    const fixture = await createFixture();
    const before = await readFile(fixture);
    expect(runPython(guardedArguments(fixture, "0".repeat(64))).status).not.toBe(0);
    expect(runPython([...guardedArguments(fixture, digest(before)), "--expected-current", "2"])
      .status).not.toBe(0);
    expect(runPython([...guardedArguments(fixture, digest(before)), "--set", "21"]).status).not.toBe(
      0
    );
    expect(await readFile(fixture)).toEqual(before);
  });

  it("refuses duplicate keys without mutation", async () => {
    const fixture = await createFixture();
    await writeFile(fixture, "RPC_TRADE_MAX_ACTIVE_POOLS=3\nRPC_TRADE_MAX_ACTIVE_POOLS=3\n");
    const before = await readFile(fixture);
    expect(runPython([...guardedArguments(fixture, digest(before)), "--apply"]).status).not.toBe(0);
    expect(await readFile(fixture)).toEqual(before);
  });
});

async function createFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "walletscaner-trade-capacity-env-"));
  temporaryDirectories.push(directory);
  const path = join(directory, ".env.server");
  await writeFile(
    path,
    "SECRET_VALUE=preserved\nRPC_TRADE_MAX_ACTIVE_POOLS=3\nOTHER=unchanged\n"
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
    "3",
    "--set",
    "1"
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
