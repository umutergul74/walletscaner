import "dotenv/config";
import { basename } from "node:path";
import { loadArchiveRuntimeConfig } from "@memecoin-alpha/config";
import {
  buildDatabaseBackupObjectKey,
  digestImmutableFile,
  validatePostgresCustomArchive,
  writeJsonAtomically
} from "@memecoin-alpha/db/immutable-file-archive";
import { S3CompatibleArchiveStore } from "@memecoin-alpha/providers/object-storage";

requireApproval("upload-verified-postgres-backup-to-b2");
const config = loadArchiveRuntimeConfig("writer");
if (!config.enabled || config.dryRun)
  throw new Error("Backup writer requires enabled non-dry-run archive configuration");
const filePath = required("ARCHIVE_DATABASE_BACKUP_FILE");
const expectedSha256 = required("ARCHIVE_DATABASE_BACKUP_SHA256").toLowerCase();
const sourceCreatedAt = required("ARCHIVE_DATABASE_BACKUP_CREATED_AT");
const manifestPath = required("ARCHIVE_DATABASE_BACKUP_MANIFEST_PATH");

await validatePostgresCustomArchive(filePath);
const digest = await digestImmutableFile(filePath);
if (digest.sha256 !== expectedSha256)
  throw new Error("PostgreSQL backup SHA-256 does not match its verified sidecar");
const objectKey = buildDatabaseBackupObjectKey({
  filePath,
  sourceCreatedAt,
  sha256: digest.sha256
});
const uploadedAt = new Date().toISOString();
const objectStore = new S3CompatibleArchiveStore(config);
const receipt = await objectStore.uploadFile({
  relativeKey: objectKey,
  filePath,
  contentLength: digest.bytes,
  sha256: digest.sha256,
  contentMd5Base64: digest.contentMd5Base64,
  schemaVersion: "postgres-backup-archive-v1",
  contentType: "application/octet-stream",
  metadata: {
    "backup-name": basename(filePath),
    "source-created-at": new Date(sourceCreatedAt).toISOString(),
    "source-bytes": digest.bytes.toString()
  }
});
const manifest = {
  schemaVersion: "postgres-backup-archive-v1" as const,
  sourceFilename: basename(filePath),
  sourceCreatedAt: new Date(sourceCreatedAt).toISOString(),
  ...digest,
  objectKey,
  uploadedAt,
  ...(receipt.etag ? { etag: receipt.etag } : {}),
  ...(receipt.versionId ? { objectVersionId: receipt.versionId } : {})
};
await writeJsonAtomically(manifestPath, manifest);
console.log(JSON.stringify({ type: "database-backup-archive", status: "uploaded", ...manifest }));

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requireApproval(expected: string): void {
  if (process.env.ARCHIVE_DATABASE_BACKUP_APPROVAL?.trim() !== expected) {
    throw new Error("Explicit PostgreSQL backup archive approval is required");
  }
}
