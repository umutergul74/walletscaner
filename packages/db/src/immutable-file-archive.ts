import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { spawn } from "node:child_process";

const SHA256_HEX = /^[a-f0-9]{64}$/;
const POSTGRES_BACKUP_NAME = /^memecoin_alpha_(\d{8}T\d{6}Z)\.dump$/;

export interface ImmutableFileDigest {
  bytes: number;
  sha256: string;
  contentMd5Base64: string;
}

export interface DatabaseBackupArchiveManifest extends ImmutableFileDigest {
  schemaVersion: "postgres-backup-archive-v1";
  sourceFilename: string;
  sourceCreatedAt: string;
  objectKey: string;
  uploadedAt: string;
  etag?: string;
  objectVersionId?: string;
}

export interface DatabaseBackupVerificationReceipt extends DatabaseBackupArchiveManifest {
  status: "verified";
  verifiedAt: string;
  verification: "independent-full-get-sha256-pg16-archive-list";
  objectLockMode: "GOVERNANCE" | "COMPLIANCE";
  objectLockEvidence: "api-verified" | "attested-default-policy";
  retainUntil: string;
}

export async function digestImmutableFile(
  filePath: string,
  maximumBytes = 64 * 1_024 * 1_024 * 1_024
): Promise<ImmutableFileDigest> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error("Immutable file byte ceiling must be a positive safe integer");
  }
  const file = await stat(filePath);
  if (!file.isFile() || file.size <= 0 || file.size > maximumBytes) {
    throw new Error("Immutable archive source must be a non-empty bounded regular file");
  }
  const sha256 = createHash("sha256");
  const md5 = createHash("md5");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    bytes += chunk.byteLength;
    if (bytes > maximumBytes) throw new Error("Immutable archive source exceeded its byte ceiling");
    sha256.update(chunk);
    md5.update(chunk);
  }
  if (bytes !== file.size) throw new Error("Immutable archive source changed while hashing");
  return {
    bytes,
    sha256: sha256.digest("hex"),
    contentMd5Base64: md5.digest("base64")
  };
}

export function buildDatabaseBackupObjectKey(options: {
  filePath: string;
  sourceCreatedAt: string;
  sha256: string;
}): string {
  const sourceFilename = basename(options.filePath);
  if (!POSTGRES_BACKUP_NAME.test(sourceFilename)) {
    throw new Error("PostgreSQL backup filename does not match the production dump contract");
  }
  const createdAt = new Date(options.sourceCreatedAt);
  const sha256 = options.sha256.toLowerCase();
  if (Number.isNaN(createdAt.getTime()) || !SHA256_HEX.test(sha256)) {
    throw new Error("PostgreSQL backup archive metadata is invalid");
  }
  return `database-backups/date=${createdAt.toISOString().slice(0, 10)}/sha256=${sha256}/${sourceFilename}`;
}

export function parseDatabaseBackupArchiveManifest(value: unknown): DatabaseBackupArchiveManifest {
  if (!value || typeof value !== "object")
    throw new Error("Backup archive manifest is not an object");
  const row = value as Record<string, unknown>;
  const bytes = Number(row.bytes);
  if (
    row.schemaVersion !== "postgres-backup-archive-v1" ||
    typeof row.sourceFilename !== "string" ||
    !POSTGRES_BACKUP_NAME.test(row.sourceFilename) ||
    typeof row.sourceCreatedAt !== "string" ||
    Number.isNaN(new Date(row.sourceCreatedAt).getTime()) ||
    !Number.isSafeInteger(bytes) ||
    bytes <= 0 ||
    typeof row.sha256 !== "string" ||
    !SHA256_HEX.test(row.sha256) ||
    typeof row.contentMd5Base64 !== "string" ||
    !/^[A-Za-z0-9+/]{22}==$/.test(row.contentMd5Base64) ||
    typeof row.objectKey !== "string" ||
    !row.objectKey.startsWith("database-backups/") ||
    typeof row.uploadedAt !== "string" ||
    Number.isNaN(new Date(row.uploadedAt).getTime())
  ) {
    throw new Error("Backup archive manifest failed validation");
  }
  return {
    schemaVersion: "postgres-backup-archive-v1",
    sourceFilename: row.sourceFilename,
    sourceCreatedAt: row.sourceCreatedAt,
    bytes,
    sha256: row.sha256,
    contentMd5Base64: row.contentMd5Base64,
    objectKey: row.objectKey,
    uploadedAt: row.uploadedAt,
    ...(typeof row.etag === "string" ? { etag: row.etag } : {}),
    ...(typeof row.objectVersionId === "string" ? { objectVersionId: row.objectVersionId } : {})
  };
}

export function parseDatabaseBackupVerificationReceipt(
  value: unknown
): DatabaseBackupVerificationReceipt {
  const manifest = parseDatabaseBackupArchiveManifest(value);
  const row = value as Record<string, unknown>;
  if (
    row.status !== "verified" ||
    row.verification !== "independent-full-get-sha256-pg16-archive-list" ||
    typeof row.verifiedAt !== "string" ||
    Number.isNaN(new Date(row.verifiedAt).getTime()) ||
    (row.objectLockMode !== "GOVERNANCE" && row.objectLockMode !== "COMPLIANCE") ||
    (row.objectLockEvidence !== "api-verified" &&
      row.objectLockEvidence !== "attested-default-policy") ||
    typeof row.retainUntil !== "string" ||
    Number.isNaN(new Date(row.retainUntil).getTime())
  ) {
    throw new Error("PostgreSQL backup verification receipt failed validation");
  }
  return {
    ...manifest,
    status: "verified",
    verifiedAt: row.verifiedAt,
    verification: "independent-full-get-sha256-pg16-archive-list",
    objectLockMode: row.objectLockMode,
    objectLockEvidence: row.objectLockEvidence,
    retainUntil: row.retainUntil
  };
}

export async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  const partialPath = `${filePath}.partial`;
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await rm(partialPath, { force: true });
  const file = await open(partialPath, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(partialPath, filePath);
}

export async function validatePostgresCustomArchive(
  filePath: string,
  pgRestoreCommand = "pg_restore"
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(pgRestoreCommand, ["--list", filePath], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < 8_192) {
        stderr.push(chunk.subarray(0, 8_192 - stderrBytes));
        stderrBytes += chunk.byteLength;
      }
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `pg_restore --list exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`
          )
        );
    });
  });
}
