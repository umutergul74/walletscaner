import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("qualified-pool delivery mode updater", () => {
  it("dry-runs then atomically adds only the reviewed non-secret key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "walletscaner-pool-mode-"));
    const fixture = join(directory, ".env.server");
    const before = "POSTGRES_PASSWORD=secret\nWALLETSCANER_SIGNAL_IMAGE=old\n";
    await writeFile(fixture, before);
    const sha = digest(before);

    expect(run(fixture, sha).status).toBe(0);
    expect(await readFile(fixture, "utf8")).toBe(before);
    expect(run(fixture, sha, true).status).toBe(0);
    expect(await readFile(fixture, "utf8")).toBe(`${before}QUALIFIED_POOL_DELIVERY_MODE=shadow\n`);
  });

  it("refuses a stale hash or unexpected pre-state without mutation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "walletscaner-pool-mode-stale-"));
    const fixture = join(directory, ".env.server");
    const before = "QUALIFIED_POOL_DELIVERY_MODE=notify\n";
    await writeFile(fixture, before);

    expect(run(fixture, "0".repeat(64), true, "notify").status).not.toBe(0);
    expect(run(fixture, digest(before), true).status).not.toBe(0);
    expect(await readFile(fixture, "utf8")).toBe(before);
  });
});

function run(path: string, sha: string, apply = false, expected = "__ABSENT__") {
  return spawnSync(
    "python",
    [
      "scripts/deploy/update-qualified-pool-mode.py",
      "--env-file",
      path,
      "--expected-sha256",
      sha,
      "--expected",
      expected,
      "--set",
      "shadow",
      ...(apply ? ["--apply"] : [])
    ],
    { encoding: "utf8" }
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
