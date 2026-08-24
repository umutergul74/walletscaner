import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDatabaseBackupObjectKey,
  digestImmutableFile,
  parseDatabaseBackupArchiveManifest,
  parseDatabaseBackupVerificationReceipt,
  writeJsonAtomically
} from "./immutable-file-archive";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("immutable PostgreSQL backup archives", () => {
  it("hashes a bounded file and builds a content-addressed key", async () => {
    const directory = await mkdtemp(join(tmpdir(), "walletscaner-backup-"));
    directories.push(directory);
    const filePath = join(directory, "memecoin_alpha_20260814T052837Z.dump");
    const body = Buffer.from("postgres-custom-archive-fixture");
    await writeFile(filePath, body);
    const digest = await digestImmutableFile(filePath);
    expect(digest).toEqual({
      bytes: body.byteLength,
      sha256: createHash("sha256").update(body).digest("hex"),
      contentMd5Base64: createHash("md5").update(body).digest("base64")
    });
    expect(
      buildDatabaseBackupObjectKey({
        filePath,
        sourceCreatedAt: "2026-08-14T05:28:37.000Z",
        sha256: digest.sha256
      })
    ).toContain(`/sha256=${digest.sha256}/memecoin_alpha_20260814T052837Z.dump`);
  });

  it("writes and validates a strict manifest atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "walletscaner-manifest-"));
    directories.push(directory);
    const manifestPath = join(directory, "nested", "manifest.json");
    const manifest = {
      schemaVersion: "postgres-backup-archive-v1",
      sourceFilename: "memecoin_alpha_20260814T052837Z.dump",
      sourceCreatedAt: "2026-08-14T05:28:37.000Z",
      bytes: 10,
      sha256: "a".repeat(64),
      contentMd5Base64: "AAAAAAAAAAAAAAAAAAAAAA==",
      objectKey:
        `database-backups/date=2026-08-14/sha256=${"a".repeat(64)}/` +
        "memecoin_alpha_20260814T052837Z.dump",
      uploadedAt: "2026-08-14T07:00:00.000Z"
    };
    await writeJsonAtomically(manifestPath, manifest);
    expect(
      parseDatabaseBackupArchiveManifest(JSON.parse(await readFile(manifestPath, "utf8")))
    ).toEqual(manifest);
  });

  it("rejects an unbounded or ambiguous source", async () => {
    await expect(digestImmutableFile("missing.dump")).rejects.toThrow();
    expect(() =>
      buildDatabaseBackupObjectKey({
        filePath: "backup.dump",
        sourceCreatedAt: "2026-08-14T05:28:37.000Z",
        sha256: "a".repeat(64)
      })
    ).toThrow(/filename/);
  });

  it("requires full GET, SHA and PostgreSQL 16 evidence before accepting a receipt", () => {
    const receipt = {
      schemaVersion: "postgres-backup-archive-v1",
      sourceFilename: "memecoin_alpha_20260814T052837Z.dump",
      sourceCreatedAt: "2026-08-14T05:28:37.000Z",
      bytes: 10,
      sha256: "a".repeat(64),
      contentMd5Base64: "AAAAAAAAAAAAAAAAAAAAAA==",
      objectKey:
        `database-backups/date=2026-08-14/sha256=${"a".repeat(64)}/` +
        "memecoin_alpha_20260814T052837Z.dump",
      uploadedAt: "2026-08-14T07:00:00.000Z",
      status: "verified",
      verifiedAt: "2026-08-14T07:15:00.000Z",
      verification: "independent-full-get-sha256-pg16-archive-list",
      objectLockMode: "GOVERNANCE",
      objectLockEvidence: "attested-default-policy",
      retainUntil: "2026-09-13T07:00:00.000Z"
    };
    expect(parseDatabaseBackupVerificationReceipt(receipt)).toEqual(receipt);
    expect(() =>
      parseDatabaseBackupVerificationReceipt({ ...receipt, status: "uploaded" })
    ).toThrow(/receipt/);
  });
});
