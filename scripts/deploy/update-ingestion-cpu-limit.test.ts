import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("./update-ingestion-cpu-limit.py", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

describe("scoped ingestion CPU limit updater", () => {
  it("dry-runs then changes only the Solana-ingestion limit", async () => {
    const fixture = await createFixture();
    const before = await readFile(fixture, "utf8");
    const hash = sha256(before);

    const dryRun = runPython(fixture, hash);
    expect(dryRun.status).toBe(0);
    expect(await readFile(fixture, "utf8")).toBe(before);

    const applied = runPython(fixture, hash, true);
    expect(applied.status).toBe(0);
    const after = await readFile(fixture, "utf8");
    expect(after).toContain('  solana-ingestion:\n    cpus: "0.20"');
    expect(after).toContain('  paper-alert:\n    cpus: "0.15"');
    expect(JSON.parse(applied.stdout)).toMatchObject({
      mode: "apply",
      change: { beforeSha256: hash, from: "0.15", to: "0.20" }
    });
  });

  it("fails without mutation when the file hash is stale", async () => {
    const fixture = await createFixture();
    const before = await readFile(fixture, "utf8");

    const result = runPython(fixture, "0".repeat(64), true);
    expect(result.status).not.toBe(0);
    expect(await readFile(fixture, "utf8")).toBe(before);
  });
});

async function createFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "walletscaner-compose-cpu-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "docker-compose.server.yml");
  await writeFile(
    path,
    [
      "services:",
      "  solana-ingestion:",
      '    cpus: "0.15"',
      "    restart: unless-stopped",
      "  paper-alert:",
      '    cpus: "0.15"',
      ""
    ].join("\n"),
    "utf8"
  );
  return path;
}

function runPython(composeFile: string, expectedSha256: string, apply = false) {
  return spawnSync(
    "python",
    [
      scriptPath,
      "--compose-file",
      composeFile,
      "--expected-sha256",
      expectedSha256,
      ...(apply ? ["--apply"] : [])
    ],
    { encoding: "utf8", shell: false }
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
