import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./release-checkpoint.py", import.meta.url));
const python = process.platform === "win32" ? "python" : "python3";

describe("release checkpoint", () => {
  it("advances a rollout with optimistic revisions and atomic JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "walletscaner-rollout-"));
    const ledger = join(directory, "release.json");

    run(ledger, 0, "stage", "planned", ["image-id=sha256:abc"]);
    await expect(stat(ledger)).rejects.toThrow();

    run(ledger, 0, "stage", "planned", ["image-id=sha256:abc"], true);
    run(ledger, 1, "stage", "in_progress", [], true);
    run(ledger, 2, "stage", "completed", ["server-sha256=def"], true);
    run(ledger, 3, "canary", "in_progress", ["restart-count=0"], true);

    const parsed = JSON.parse(await readFile(ledger, "utf8"));
    expect(parsed.revision).toBe(4);
    expect(parsed.current).toMatchObject({ phase: "canary", status: "in_progress" });
    expect(parsed.history).toHaveLength(3);
    expect(parsed.history[2]).toMatchObject({ phase: "stage", status: "completed" });
  });

  it("rejects stale revisions without changing the ledger", async () => {
    const directory = await mkdtemp(join(tmpdir(), "walletscaner-rollout-stale-"));
    const ledger = join(directory, "release.json");
    run(ledger, 0, "stage", "in_progress", [], true);
    const before = await readFile(ledger, "utf8");

    const result = execute(ledger, 0, "stage", "completed", [], true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Revision mismatch");
    expect(await readFile(ledger, "utf8")).toBe(before);
  });

  it("rejects invalid transitions and sensitive evidence keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "walletscaner-rollout-guard-"));
    const ledger = join(directory, "release.json");
    run(ledger, 0, "stage", "planned", [], true);

    const invalid = execute(ledger, 1, "stage", "completed", [], true);
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain("Invalid same-phase transition");

    const sensitive = execute(
      ledger,
      1,
      "stage",
      "in_progress",
      ["access-key=forbidden"],
      true
    );
    expect(sensitive.status).not.toBe(0);
    expect(sensitive.stderr).toContain("Sensitive evidence key is forbidden");
  });
});

function run(
  ledger: string,
  revision: number,
  phase: string,
  status: string,
  evidence: string[],
  apply = false
): void {
  const result = execute(ledger, revision, phase, status, evidence, apply);
  expect(result.status, result.stderr).toBe(0);
}

function execute(
  ledger: string,
  revision: number,
  phase: string,
  status: string,
  evidence: string[],
  apply: boolean
) {
  const args = [
    script,
    "--file",
    ledger,
    "--release",
    "storage-r34-20260826",
    "--phase",
    phase,
    "--status",
    status,
    "--expected-revision",
    String(revision),
    "--next-action",
    "Verify actual runtime state before continuing.",
    "--rollback-ref",
    "walletscaner-worker:previous",
  ];
  if (revision === 0) args.push("--objective", "Interruption-safe storage rollout.");
  for (const item of evidence) args.push("--evidence", item);
  if (apply) args.push("--apply");
  return spawnSync(python, args, { encoding: "utf8" });
}
