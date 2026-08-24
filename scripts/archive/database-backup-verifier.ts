import "dotenv/config";
import { readFile, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { loadArchiveRuntimeConfig } from "@memecoin-alpha/config";
import {
  parseDatabaseBackupArchiveManifest,
  validatePostgresCustomArchive,
  writeJsonAtomically
} from "@memecoin-alpha/db/immutable-file-archive";
import { S3CompatibleArchiveStore } from "@memecoin-alpha/providers/object-storage";
import { resolveObjectLockEvidence } from "./runtime";

const config = loadArchiveRuntimeConfig("verifier");
if (!config.enabled || config.dryRun)
  throw new Error("Backup verifier requires enabled non-dry-run archive configuration");
const manifestPath = required("ARCHIVE_DATABASE_BACKUP_MANIFEST_PATH");
const verificationPath = required("ARCHIVE_DATABASE_BACKUP_VERIFICATION_PATH");
const manifest = parseDatabaseBackupArchiveManifest(
  JSON.parse(await readFile(manifestPath, "utf8"))
);
const destinationPath = join(config.stagingDirectory, `${manifest.sha256}.dump`);
const fileSystem = await statfs(config.stagingDirectory);
const availableBytes = fileSystem.bavail * fileSystem.bsize;
if (availableBytes < config.minimumFreeBytes + manifest.bytes) {
  throw new Error("Backup verifier staging headroom is below its fail-closed threshold");
}

try {
  const objectStore = new S3CompatibleArchiveStore(config);
  const minimumRetainUntil = new Date(
    Date.now() + config.objectLockMinimumRemainingDays * 86_400_000
  );
  const receipt = await objectStore.downloadVerifiedObject(
    {
      relativeKey: manifest.objectKey,
      contentLength: manifest.bytes,
      sha256: manifest.sha256,
      metadata: {
        "backup-name": manifest.sourceFilename,
        "source-created-at": manifest.sourceCreatedAt,
        "source-bytes": manifest.bytes.toString()
      },
      requireObjectLock: config.objectLockEvidenceMode === "api-verified",
      ...(config.objectLockEvidenceMode === "api-verified" ? { minimumRetainUntil } : {})
    },
    destinationPath
  );
  await validatePostgresCustomArchive(destinationPath);
  const lock = resolveObjectLockEvidence({
    evidenceMode: config.objectLockEvidenceMode,
    ...(receipt.objectLockMode ? { apiMode: receipt.objectLockMode } : {}),
    ...(receipt.retainUntil ? { apiRetainUntil: receipt.retainUntil } : {}),
    defaultMode: config.objectLockDefaultMode,
    defaultDays: config.objectLockDefaultDays,
    uploadedAt: manifest.uploadedAt
  });
  if (new Date(lock.retainUntil).getTime() < minimumRetainUntil.getTime()) {
    throw new Error("PostgreSQL backup Object Lock horizon is below the safety reserve");
  }
  const verifiedAt = new Date().toISOString();
  const verification = {
    ...manifest,
    status: "verified" as const,
    verifiedAt,
    verification: "independent-full-get-sha256-pg16-archive-list" as const,
    objectLockMode: lock.objectLockMode,
    objectLockEvidence: lock.objectLockEvidence,
    retainUntil: lock.retainUntil,
    ...(receipt.etag ? { verifiedEtag: receipt.etag } : {}),
    ...(receipt.versionId ? { verifiedObjectVersionId: receipt.versionId } : {})
  };
  await writeJsonAtomically(verificationPath, verification);
  console.log(JSON.stringify({ type: "database-backup-archive", ...verification }));
} finally {
  await rm(destinationPath, { force: true });
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
