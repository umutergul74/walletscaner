import "dotenv/config";
import { mkdir, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { loadArchiveRuntimeConfig } from "@memecoin-alpha/config";
import { exportArchiveSegment, validateArchiveArtifact } from "@memecoin-alpha/db/archive-artifact";
import { ArchiveStore } from "@memecoin-alpha/db/archive-store";
import { S3CompatibleArchiveStore } from "@memecoin-alpha/providers/object-storage";
import { archiveWorkerId, errorMessage, startLeaseHeartbeat } from "./runtime";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for the archive writer");
const config = loadArchiveRuntimeConfig("writer");
if (!config.enabled) {
  console.log(JSON.stringify({ type: "archive-writer", status: "disabled" }));
  process.exit(0);
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2, statement_timeout: 0 });
const store = new ArchiveStore(pool);
const workerId = archiveWorkerId("writer");
const startedAt = Date.now();
const deadline = startedAt + config.maxRunSeconds * 1_000;

try {
  if (config.dryRun) {
    const previewLimit = Math.max(config.maxSegmentsPerRun * 4, 10);
    const [chainPayloads, walletEvidence] = await Promise.all([
      store.previewEligiblePartitions(config.settleHours, previewLimit),
      store.previewEligibleWalletEvidenceSegments(
        config.walletEvidenceSettleHours,
        previewLimit
      )
    ]);
    console.log(
      JSON.stringify({
        type: "archive-writer",
        status: "dry-run",
        checkedAt: new Date().toISOString(),
        eligiblePartitions: { chainPayloads, walletEvidence },
        summary: await store.summary()
      })
    );
  } else {
    await mkdir(config.stagingDirectory, { recursive: true, mode: 0o700 });
    const seedLimit = Math.max(config.maxSegmentsPerRun * 4, 10);
    const seededChainPayloads = await store.seedEligibleDailySegments(
      config.settleHours,
      seedLimit
    );
    const seededWalletEvidence = await store.seedEligibleWalletEvidenceSegments(
      config.walletEvidenceSettleHours,
      seedLimit
    );
    const objectStore = new S3CompatibleArchiveStore(config);
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    while (processed < config.maxSegmentsPerRun && Date.now() < deadline) {
      const segment = await store.claimWriter({ workerId, leaseSeconds: config.leaseSeconds });
      if (!segment) break;
      processed += 1;
      const outputPath = join(
        config.stagingDirectory,
        `segment-${segment.id}-revision-${segment.revision}.jsonl.zst`
      );
      let leaseError: unknown;
      const stopHeartbeat = startLeaseHeartbeat({
        intervalSeconds: Math.floor(config.leaseSeconds / 3),
        heartbeat: () =>
          store.heartbeat({
            segment,
            workerId,
            leaseSeconds: config.leaseSeconds,
            stage: "writer"
          }),
        onFailure: (error) => {
          leaseError = error;
        }
      });

      try {
        const fileSystem = await statfs(config.stagingDirectory);
        const availableBytes = fileSystem.bavail * fileSystem.bsize;
        if (availableBytes <= config.minimumFreeBytes) {
          throw new Error(
            `Archive staging has ${availableBytes} free bytes; ${config.minimumFreeBytes} required`
          );
        }
        const client = await pool.connect();
        let artifact;
        try {
          artifact = await exportArchiveSegment({
            client,
            segment,
            outputPath,
            zstdCommand: config.zstdCommand,
            maximumArchiveBytes: availableBytes - config.minimumFreeBytes
          });
        } finally {
          client.release();
        }
        if (leaseError) throw leaseError;
        if (!(await store.isCurrentLease({ segment, workerId, stage: "writer" }))) {
          throw new Error("Archive source changed or writer lease expired during export");
        }
        await validateArchiveArtifact({
          filePath: artifact.filePath,
          expected: artifact,
          zstdCommand: config.zstdCommand
        });
        if (artifact.canonicalMetadataRowCount !== artifact.sourceRowCount) {
          throw new Error(
            `Archive canonical metadata coverage is incomplete: ${artifact.canonicalMetadataRowCount}/${artifact.sourceRowCount}`
          );
        }
        if (!(await store.isCurrentLease({ segment, workerId, stage: "writer" }))) {
          throw new Error("Archive source changed or writer lease expired before upload");
        }

        try {
          const receipt = await objectStore.uploadFile({
            relativeKey: artifact.objectKey,
            filePath: artifact.filePath,
            contentLength: artifact.archiveBytes,
            sha256: artifact.archiveSha256,
            contentMd5Base64: artifact.contentMd5Base64,
            schemaVersion: segment.formatVersion,
            metadata: {
              "source-sha256": artifact.sourceSha256,
              "source-row-count": artifact.sourceRowCount.toString(),
              "canonical-metadata-row-count": artifact.canonicalMetadataRowCount.toString(),
              "record-type-counts": JSON.stringify(artifact.recordTypeCounts),
              "source-bytes": artifact.sourceBytes.toString(),
              "source-start": segment.rangeStart,
              "source-end": segment.rangeEnd,
              "segment-revision": segment.revision.toString()
            }
          });
          const current = await store.markUploadForVerification({
            segment,
            workerId,
            artifact,
            uploadSucceeded: true,
            ...(receipt.etag ? { etag: receipt.etag } : {}),
            ...(receipt.versionId ? { objectVersionId: receipt.versionId } : {})
          });
          if (!current) throw new Error("Archive upload completed for a stale segment revision");
          succeeded += 1;
        } catch (uploadError) {
          const current = await store.markUploadForVerification({
            segment,
            workerId,
            artifact,
            uploadSucceeded: false,
            error: errorMessage(uploadError)
          });
          if (!current) throw uploadError;
          failed += 1;
        }
      } catch (error) {
        failed += 1;
        await store.failExport({
          segment,
          workerId,
          error: errorMessage(error),
          retrySeconds: config.retrySeconds,
          maxAttempts: config.maxAttempts
        });
      } finally {
        stopHeartbeat();
        await rm(outputPath, { force: true });
        await rm(`${outputPath}.partial`, { force: true });
      }
    }

    console.log(
      JSON.stringify({
        type: "archive-writer",
        status: failed > 0 ? "degraded" : "completed",
        checkedAt: new Date().toISOString(),
        workerId,
        seeded: seededChainPayloads + seededWalletEvidence,
        seededBySource: {
          chainEventPayloads: seededChainPayloads,
          walletEvidence: seededWalletEvidence
        },
        processed,
        succeeded,
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
