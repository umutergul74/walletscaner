import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = "scripts/deploy/update-discovery-ws-route-env.py";
const programs = JSON.stringify(["LaunchLab111", "Cpmm111"]);

function run(path: string, apply: boolean) {
  return spawnSync(
    "python",
    [
      script,
      "--env-file",
      path,
      "--expected-image",
      "worker:r18",
      "--image",
      "worker:r19",
      "--secondary-url",
      "wss://secondary.example",
      "--secondary-program",
      "LaunchLab111",
      "--secondary-program",
      "Cpmm111",
      ...(apply ? ["--apply"] : [])
    ],
    { encoding: "utf8" }
  );
}

describe("update-discovery-ws-route-env", () => {
  it("applies the exact route atomically and is idempotent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "walletscaner-ws-route-"));
    const path = join(directory, ".env.server");
    await writeFile(path, "KEEP=value\nWALLETSCANER_INGEST_IMAGE=worker:r18\n", "utf8");

    expect(run(path, false).status).toBe(0);
    expect(await readFile(path, "utf8")).not.toContain("SECONDARY");
    expect(run(path, true).status).toBe(0);
    expect(await readFile(path, "utf8")).toBe(
      "KEEP=value\n" +
        "WALLETSCANER_INGEST_IMAGE=worker:r19\n" +
        "SOLANA_DISCOVERY_WS_SECONDARY_URL=wss://secondary.example\n" +
        `SOLANA_DISCOVERY_WS_SECONDARY_PROGRAMS_JSON=${programs}\n`
    );
    const idempotent = run(path, true);
    expect(idempotent.status).toBe(0);
    expect(JSON.parse(idempotent.stdout).changes).toEqual([]);
  });

  it("refuses an unexpected image or conflicting route", async () => {
    const directory = await mkdtemp(join(tmpdir(), "walletscaner-ws-route-"));
    const path = join(directory, ".env.server");
    await writeFile(path, "WALLETSCANER_INGEST_IMAGE=worker:other\n", "utf8");
    expect(run(path, true).status).not.toBe(0);

    await writeFile(
      path,
      "WALLETSCANER_INGEST_IMAGE=worker:r18\n" +
        "SOLANA_DISCOVERY_WS_SECONDARY_URL=wss://wrong.example\n",
      "utf8"
    );
    expect(run(path, true).status).not.toBe(0);
  });

  it("transitions only from an exact reviewed existing route", async () => {
    const directory = await mkdtemp(join(tmpdir(), "walletscaner-ws-route-transition-"));
    const path = join(directory, ".env.server");
    await writeFile(
      path,
      "WALLETSCANER_INGEST_IMAGE=worker:r18\n" +
        "SOLANA_DISCOVERY_WS_SECONDARY_URL=wss://secondary.example\n" +
        `SOLANA_DISCOVERY_WS_SECONDARY_PROGRAMS_JSON=${programs}\n`,
      "utf8"
    );
    const transition = spawnSync(
      "python",
      [
        script,
        "--env-file",
        path,
        "--expected-image",
        "worker:r18",
        "--image",
        "worker:r18",
        "--expected-secondary-url",
        "wss://secondary.example",
        "--expected-secondary-program",
        "LaunchLab111",
        "--expected-secondary-program",
        "Cpmm111",
        "--secondary-url",
        "wss://secondary.example",
        "--secondary-program",
        "Pump111",
        "--secondary-program",
        "LaunchLab111",
        "--secondary-program",
        "Cpmm111",
        "--apply"
      ],
      { encoding: "utf8" }
    );
    expect(transition.status).toBe(0);
    expect(await readFile(path, "utf8")).toContain(
      'SOLANA_DISCOVERY_WS_SECONDARY_PROGRAMS_JSON=["Pump111","LaunchLab111","Cpmm111"]'
    );
  });
});
