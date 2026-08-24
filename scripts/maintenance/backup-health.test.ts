import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectBackupDirectory } from "./backup-health";

describe("backup health", () => {
  it("requires a matching offsite acknowledgement for the newest dump", async () => {
    const directory = await mkdtemp(join(tmpdir(), "walletscaner-backup-health-"));
    const filename = "memecoin_alpha_20260823T150923Z.dump";
    const sha = "a".repeat(64);
    await writeFile(join(directory, filename), "archive");
    await writeFile(join(directory, `${filename}.sha256`), `${sha}  ${filename}\n`);
    await writeFile(
      join(directory, `${filename}.offsite-verified`),
      `sha256=${sha}\nverified_at=2026-08-23T16:00:00Z\n`
    );

    const result = await inspectBackupDirectory(directory, new Date("2026-08-23T17:00:00Z"));
    expect(result).toMatchObject({
      available: true,
      filename,
      sidecarPresent: true,
      offsiteAcknowledged: true,
      sha256: sha
    });
  });

  it("fails closed on a missing or mismatched acknowledgement", async () => {
    const directory = await mkdtemp(join(tmpdir(), "walletscaner-backup-health-"));
    const filename = "memecoin_alpha_20260823T150923Z.dump";
    await writeFile(join(directory, filename), "archive");
    await writeFile(join(directory, `${filename}.sha256`), `${"b".repeat(64)}  ${filename}\n`);
    const result = await inspectBackupDirectory(directory);
    expect(result.offsiteAcknowledged).toBe(false);
    expect(result.reason).toBe("offsite-acknowledgement-missing-or-mismatched");
  });
});
