import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("./update-release-image-env.py", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

describe("scoped release image environment updater", () => {
  it("is dry-run by default and applies only both explicitly guarded keys", async () => {
    const fixture = await createFixture();
    const arguments_ = updateArguments(fixture);

    const dryRun = runPython(arguments_);
    expect(dryRun.status).toBe(0);
    expect(await readFile(fixture, "utf8")).toContain("WALLETSCANER_INGEST_IMAGE=ingest-old");

    const applied = runPython([...arguments_, "--apply"]);
    expect(applied.status).toBe(0);
    expect(await readFile(fixture, "utf8")).toBe(
      [
        "SECRET_VALUE=preserved",
        "WALLETSCANER_INGEST_IMAGE=r5-image",
        "WALLETSCANER_RESEARCH_IMAGE=research-old",
        "WALLETSCANER_SIGNAL_IMAGE=r5-image",
        "UNRELATED_IMAGE=unchanged",
        ""
      ].join("\n")
    );
    expect(JSON.parse(applied.stdout)).toMatchObject({
      mode: "apply",
      changes: [
        { key: "WALLETSCANER_INGEST_IMAGE", from: "ingest-old", to: "r5-image" },
        { key: "WALLETSCANER_SIGNAL_IMAGE", from: "signal-old", to: "r5-image" }
      ]
    });
  });

  it("updates the research image without changing ingestion or signal releases", async () => {
    const fixture = await createFixture();
    const applied = runPython([...researchUpdateArguments(fixture), "--apply"]);

    expect(applied.status).toBe(0);
    expect(await readFile(fixture, "utf8")).toBe(
      [
        "SECRET_VALUE=preserved",
        "WALLETSCANER_INGEST_IMAGE=ingest-old",
        "WALLETSCANER_RESEARCH_IMAGE=research-r11",
        "WALLETSCANER_SIGNAL_IMAGE=signal-old",
        "UNRELATED_IMAGE=unchanged",
        ""
      ].join("\n")
    );
  });

  it("fails without mutation on stale pre-state or a non-whitelisted key", async () => {
    const fixture = await createFixture();
    const before = await readFile(fixture, "utf8");
    const stale = runPython([
      "--env-file",
      fixture,
      "--expected",
      "WALLETSCANER_INGEST_IMAGE=wrong",
      "--set",
      "WALLETSCANER_INGEST_IMAGE=r5-image",
      "--apply"
    ]);
    expect(stale.status).not.toBe(0);
    expect(await readFile(fixture, "utf8")).toBe(before);

    const forbidden = runPython([
      "--env-file",
      fixture,
      "--expected",
      "POSTGRES_PASSWORD=old",
      "--set",
      "POSTGRES_PASSWORD=new",
      "--apply"
    ]);
    expect(forbidden.status).not.toBe(0);
    expect(await readFile(fixture, "utf8")).toBe(before);
  });
});

async function createFixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "walletscaner-release-env-"));
  temporaryDirectories.push(directory);
  const path = join(directory, ".env.server");
  await writeFile(
    path,
    [
      "SECRET_VALUE=preserved",
      "WALLETSCANER_INGEST_IMAGE=ingest-old",
      "WALLETSCANER_RESEARCH_IMAGE=research-old",
      "WALLETSCANER_SIGNAL_IMAGE=signal-old",
      "UNRELATED_IMAGE=unchanged",
      ""
    ].join("\n"),
    "utf8"
  );
  return path;
}

function updateArguments(envFile: string): string[] {
  return [
    "--env-file",
    envFile,
    "--expected",
    "WALLETSCANER_INGEST_IMAGE=ingest-old",
    "--expected",
    "WALLETSCANER_SIGNAL_IMAGE=signal-old",
    "--set",
    "WALLETSCANER_INGEST_IMAGE=r5-image",
    "--set",
    "WALLETSCANER_SIGNAL_IMAGE=r5-image"
  ];
}

function researchUpdateArguments(envFile: string): string[] {
  return [
    "--env-file",
    envFile,
    "--expected",
    "WALLETSCANER_RESEARCH_IMAGE=research-old",
    "--set",
    "WALLETSCANER_RESEARCH_IMAGE=research-r11"
  ];
}

function runPython(arguments_: string[]) {
  return spawnSync("python", [scriptPath, ...arguments_], {
    encoding: "utf8",
    shell: false
  });
}
