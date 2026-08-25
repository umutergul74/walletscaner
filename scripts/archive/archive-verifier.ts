import "dotenv/config";
import { mkdir, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { loadArchiveRuntimeConfig } from "@memecoin-alpha/config";
import { validateArchiveArtifact } from "@memecoin-alpha/db/archive-artifact";
import { ArchiveStore } from "@memecoin-alpha/db/archive-store";
import {
  ArchiveIntegrityError,
  S3CompatibleArchiveStore
} from "@memecoin-alpha/providers/object-storage";
import {
  archiveMetadata,
  archiveWorkerId,
  errorMessage,
  httpStatus,
  resolveObjectLockEvidence,
  startLeaseHeartbeat
} from "./runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the archive verifier");
const config = loadArchiveRuntimeConfig("verifier");
if (!config.enabled) {
  console.log(JSON.stringify({ type: "archive-verifier", status: "disabled" }));
  process.exit(0);
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, statement_timeout: 0 });
const store = new ArchiveStore(pool);
const workerId = archiveWorkerId("verifier");
const startedAt = Date.now();
const deadline = startedAt + config.maxRunSeconds * 1_000;

try {
  if (config.dryRun) {
    console.log(
      JSON.stringify({
        type: "archive-verifier",
        status: "dry-run",
        checkedAt: new Date().toISOString(),
        summary: await store.summary()
      })
    );
  } else {
    await mkdir(config.stagingDirectory, { recursive: true, mode: 0o700 });
    const objectStore = new S3CompatibleArchiveStore(config);
    let processed = 0;
    let verified = 0;
    let failed = 0;

    while (processed < config.maxSegmentsPerRun && Date.now() < deadline) {
      const segment = await store.claimVerifier({ workerId, leaseSeconds: config.leaseSeconds });
      if (!segment) break;
      processed += 1;
      const destinationPath = join(
        config.stagingDirectory,
        `verify-${segment.id}-revision-${segment.revision}.jsonl.zst`
      );
      let leaseError: unknown;
      const stopHeartbeat = startLeaseHeartbeat({
        intervalSeconds: Math.floor(config.leaseSeconds / 3),
        heartbeat: () =>
          store.heartbeat({
            segment,
            workerId,
            leaseSeconds: config.leaseSeconds,
            stage: "verifier"
          }),
        onFailure: (error) => {
          leaseError = error;
        }
      });

      try {
        if (
          !segment.objectKey ||
          segment.archiveBytes === undefined ||
          !segment.archiveSha256 ||
          segment.sourceRowCount === undefined ||
          segment.canonicalMetadataRowCount === undefined ||
          !segment.recordTypeCounts ||
          segment.sourceBytes === undefined ||
          !segment.sourceSha256
        ) {
          throw new ArchiveIntegrityError(
            "Archive segment has an incomplete verification manifest"
          );
        }
        if (segment.canonicalMetadataRowCount !== segment.sourceRowCount) {
          throw new ArchiveIntegrityError("Archive canonical metadata coverage is incomplete");
        }
        const fileSystem = await statfs(config.stagingDirectory);
        const availableBytes = fileSystem.bavail * fileSystem.bsize;
        if (availableBytes < config.minimumFreeBytes + segment.archiveBytes) {
          throw new Error("Archive verifier staging headroom is below its fail-closed threshold");
        }
        const minimumRetainUntil = new Date(
          Date.now() + config.objectLockMinimumRemainingDays * 86_400_000
        );
        const receipt = await objectStore.downloadVerifiedObject(
          {
            relativeKey: segment.objectKey,
            contentLength: segment.archiveBytes,
            sha256: segment.archiveSha256,
            metadata: archiveMetadata(segment),
            requireObjectLock: config.objectLockEvidenceMode === "api-verified",
            ...(config.objectLockEvidenceMode === "api-verified" ? { minimumRetainUntil } : {})
          },
          destinationPath
        );
        if (leaseError) throw leaseError;
        const restored = await validateArchiveArtifact({
          filePath: destinationPath,
          expected: {
            sourceRowCount: segment.sourceRowCount,
            canonicalMetadataRowCount: segment.canonicalMetadataRowCount,
            recordTypeCounts: segment.recordTypeCounts,
            sourceBytes: segment.sourceBytes,
            sourceSha256: segment.sourceSha256
          },
          zstdCommand: config.zstdCommand
        });
        const lock = resolveObjectLockEvidence({
          evidenceMode: config.objectLockEvidenceMode,
          ...(receipt.objectLockMode ? { apiMode: receipt.objectLockMode } : {}),
          ...(receipt.retainUntil ? { apiRetainUntil: receipt.retainUntil } : {}),
          defaultMode: config.objectLockDefaultMode,
          defaultDays: config.objectLockDefaultDays,
          ...(segment.uploadedAt ? { uploadedAt: segment.uploadedAt } : {})
        });
        const current = await store.completeVerification({
          segment,
          workerId,
          receipt: {
            objectLockMode: lock.objectLockMode,
            objectLockEvidence: lock.objectLockEvidence,
            retainUntil: lock.retainUntil,
            ...(receipt.etag ? { etag: receipt.etag } : {}),
            ...(receipt.versionId ? { objectVersionId: receipt.versionId } : {})
          },
          minimumRetainUntil: minimumRetainUntil.toISOString(),
          details: { ...restored }
        });
        if (!current) throw new Error("Archive restore completed for a stale segment revision");
        verified += 1;
      } catch (error) {
        failed += 1;
        const status = httpStatus(error);
        const disposition =
          status === 404
            ? "retry_export"
            : error instanceof ArchiveIntegrityError &&
                !error.message.includes("Object Lock retention is not visible")
              ? "dead_letter"
              : "retry_verify";
        await store.failVerification({
          segment,
          workerId,
          error: errorMessage(error),
          retrySeconds: config.retrySeconds,
          maxAttempts: config.maxAttempts,
          disposition
        });
      } finally {
        stopHeartbeat();
        await rm(destinationPath, { force: true });
      }
    }

    console.log(
      JSON.stringify({
        type: "archive-verifier",
        status: failed > 0 ? "degraded" : "completed",
        checkedAt: new Date().toISOString(),
        workerId,
        processed,
        verified,
        failed,
        elapsedMs: Date.now() - startedAt,
        summary: await store.summary()
      })
    );
    if (failed > 0) process.exitCode = 1;
  }
} finally {
  await pool.end();
}
