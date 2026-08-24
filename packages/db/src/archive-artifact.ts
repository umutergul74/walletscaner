import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import QueryStream from "pg-query-stream";
import type { ArchiveArtifactManifest, ArchiveSegment } from "./archive-store";

interface ArchiveJsonRow {
  line: string;
  canonical_metadata_available: boolean;
}

export interface ArchiveArtifactResult extends ArchiveArtifactManifest {
  filePath: string;
}

export interface ArchiveValidationResult {
  sourceRowCount: number;
  canonicalMetadataRowCount: number;
  sourceBytes: number;
  sourceSha256: string;
}

export async function exportArchiveSegment(options: {
  client: pg.PoolClient;
  segment: ArchiveSegment;
  outputPath: string;
  zstdCommand?: string;
  maximumArchiveBytes?: number;
}): Promise<ArchiveArtifactResult> {
  if (options.segment.sourceKind !== "chain-event-payloads") {
    throw new Error(`Unsupported archive source: ${options.segment.sourceKind}`);
  }
  if (options.segment.formatVersion !== "raw-solana-v1") {
    throw new Error(`Unsupported archive format: ${options.segment.formatVersion}`);
  }
  if (options.segment.compression !== "zstd-3") {
    throw new Error(`Unsupported archive compression: ${options.segment.compression}`);
  }
  const maximumArchiveBytes = options.maximumArchiveBytes ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maximumArchiveBytes) || maximumArchiveBytes <= 0) {
    throw new Error("maximumArchiveBytes must be a positive safe integer");
  }

  const partialPath = `${options.outputPath}.partial`;
  await rm(partialPath, { force: true });
  await rm(options.outputPath, { force: true });
  const zstd = spawn(
    options.zstdCommand ?? "zstd",
    ["-q", "-3", "--single-thread", "--check", "-c"],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    }
  );
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  zstd.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes < 8_192) {
      stderr.push(chunk.subarray(0, 8_192 - stderrBytes));
      stderrBytes += chunk.byteLength;
    }
  });

  const sourceDigest = createHash("sha256");
  const archiveDigest = createHash("sha256");
  const archiveMd5 = createHash("md5");
  let sourceBytes = 0;
  let sourceRowCount = 0;
  let canonicalMetadataRowCount = 0;
  let archiveBytes = 0;
  const jsonl = new Transform({
    writableObjectMode: true,
    transform(row: ArchiveJsonRow, _encoding, callback) {
      const chunk = Buffer.from(`${row.line}\n`, "utf8");
      sourceBytes += chunk.byteLength;
      sourceRowCount += 1;
      if (row.canonical_metadata_available) canonicalMetadataRowCount += 1;
      sourceDigest.update(chunk);
      callback(null, chunk);
    }
  });
  const archiveHasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      archiveBytes += chunk.byteLength;
      if (archiveBytes > maximumArchiveBytes) {
        callback(new Error("Archive artifact exceeded its disk-headroom ceiling"));
        return;
      }
      archiveDigest.update(chunk);
      archiveMd5.update(chunk);
      callback(null, chunk);
    }
  });
  const output = createWriteStream(partialPath, { flags: "wx", mode: 0o600 });

  await options.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await options.client.query("SET LOCAL max_parallel_workers_per_gather = 0");
    const query = new QueryStream(
      `SELECT jsonb_build_object(
         'schema_version', 'raw-solana-v1',
         'event_idempotency_key', payload.event_idempotency_key,
         'canonical_metadata_available', event.idempotency_key IS NOT NULL,
         'chain', event.chain,
         'signature', event.signature,
         'slot', event.slot,
         'transaction_index', event.transaction_index,
         'instruction_index', event.instruction_index,
         'inner_instruction_index', event.inner_instruction_index,
         'event_type', event.event_type,
         'token_address', event.token_address,
         'pool_address', event.pool_address,
         'occurred_at', event.occurred_at,
         'received_at', payload.received_at,
         'commitment', event.commitment,
         'source', event.source,
         'decoder_version', event.decoder_version,
         'payload_sha256', payload.payload_sha256,
         'payload', payload.payload
       )::text AS line,
       event.idempotency_key IS NOT NULL AS canonical_metadata_available
       FROM chain_event_payloads AS payload
       LEFT JOIN LATERAL (
         SELECT
           inbox.idempotency_key,
           inbox.chain,
           inbox.signature,
           inbox.slot,
           inbox.transaction_index,
           inbox.instruction_index,
           inbox.inner_instruction_index,
           inbox.event_type,
           inbox.token_address,
           inbox.pool_address,
           inbox.occurred_at,
           inbox.commitment,
           inbox.source,
           inbox.decoder_version
         FROM chain_event_inbox AS inbox
         WHERE inbox.idempotency_key = payload.event_idempotency_key
         OFFSET 0
       ) AS event ON true
       WHERE payload.received_at >= $1
         AND payload.received_at < $2
       ORDER BY payload.received_at, payload.event_idempotency_key`,
      [options.segment.rangeStart, options.segment.rangeEnd],
      { batchSize: 32, highWaterMark: 8 }
    );
    const rows = options.client.query(query);
    const processExit = new Promise<void>((resolve, reject) => {
      zstd.once("error", reject);
      zstd.once("close", (code) => {
        if (code === 0) resolve();
        else
          reject(new Error(`zstd exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
      });
    });

    await Promise.all([
      pipeline(rows, jsonl, zstd.stdin),
      pipeline(zstd.stdout, archiveHasher, output),
      processExit
    ]);
    await options.client.query("COMMIT");
  } catch (error) {
    zstd.kill();
    await options.client.query("ROLLBACK");
    await rm(partialPath, { force: true });
    throw error;
  }

  if (archiveBytes <= 0) {
    await rm(partialPath, { force: true });
    throw new Error("Archive compressor produced an empty artifact");
  }
  await rename(partialPath, options.outputPath);
  return {
    filePath: options.outputPath,
    objectKey: buildArchiveObjectKey(options.segment),
    sourceRowCount,
    canonicalMetadataRowCount,
    sourceBytes,
    sourceSha256: sourceDigest.digest("hex"),
    archiveBytes,
    archiveSha256: archiveDigest.digest("hex"),
    contentMd5Base64: archiveMd5.digest("base64")
  };
}

export async function validateArchiveArtifact(options: {
  filePath: string;
  expected: Pick<
    ArchiveArtifactManifest,
    "sourceRowCount" | "canonicalMetadataRowCount" | "sourceBytes" | "sourceSha256"
  >;
  zstdCommand?: string;
  maximumLineBytes?: number;
}): Promise<ArchiveValidationResult> {
  const maximumLineBytes = options.maximumLineBytes ?? 32 * 1_024 * 1_024;
  if (!Number.isSafeInteger(maximumLineBytes) || maximumLineBytes < 1_024) {
    throw new Error("maximumLineBytes must be a bounded positive integer");
  }
  const zstd = spawn(options.zstdCommand ?? "zstd", ["-q", "-d", "--stdout", options.filePath], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const stderr: Buffer[] = [];
  zstd.stderr.on("data", (chunk: Buffer) => {
    if (Buffer.concat(stderr).byteLength < 8_192) stderr.push(chunk);
  });
  const digest = createHash("sha256");
  let sourceBytes = 0;
  let sourceRowCount = 0;
  let canonicalMetadataRowCount = 0;
  let pending = Buffer.alloc(0);
  const validator = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        sourceBytes += chunk.byteLength;
        digest.update(chunk);
        pending =
          pending.byteLength === 0
            ? Buffer.from(chunk)
            : Buffer.concat([pending, Buffer.from(chunk)]);
        if (pending.byteLength > maximumLineBytes && !pending.includes(0x0a)) {
          throw new Error("Archive JSONL line exceeded the configured safety ceiling");
        }
        let newline = pending.indexOf(0x0a);
        while (newline >= 0) {
          const line = pending.subarray(0, newline);
          pending = pending.subarray(newline + 1);
          if (line.byteLength === 0) throw new Error("Archive contains an empty JSONL line");
          if (validateArchiveEnvelope(JSON.parse(line.toString("utf8")) as unknown)) {
            canonicalMetadataRowCount += 1;
          }
          sourceRowCount += 1;
          newline = pending.indexOf(0x0a);
        }
        if (pending.byteLength > maximumLineBytes) {
          throw new Error("Archive JSONL line exceeded the configured safety ceiling");
        }
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      callback(
        pending.byteLength === 0 ? undefined : new Error("Archive JSONL is not newline-terminated")
      );
    }
  });
  const processExit = new Promise<void>((resolve, reject) => {
    zstd.once("error", reject);
    zstd.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`zstd restore exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`)
        );
    });
  });

  await Promise.all([pipeline(zstd.stdout, validator), processExit]);
  const sourceSha256 = digest.digest("hex");
  if (
    sourceRowCount !== options.expected.sourceRowCount ||
    canonicalMetadataRowCount !== options.expected.canonicalMetadataRowCount ||
    sourceBytes !== options.expected.sourceBytes ||
    sourceSha256 !== options.expected.sourceSha256
  ) {
    throw new Error("Restored archive content does not match the PostgreSQL manifest");
  }
  return { sourceRowCount, canonicalMetadataRowCount, sourceBytes, sourceSha256 };
}

export function buildArchiveObjectKey(segment: ArchiveSegment): string {
  const day = segment.rangeStart.slice(0, 10);
  const revision = segment.revision.toString().padStart(6, "0");
  return `raw-solana/date=${day}/revision=${revision}/${segment.formatVersion}.jsonl.zst`;
}

function validateArchiveEnvelope(value: unknown): boolean {
  if (!value || typeof value !== "object") throw new Error("Archive JSONL row is not an object");
  const row = value as Record<string, unknown>;
  if (row.schema_version !== "raw-solana-v1") {
    throw new Error("Archive JSONL row has an unsupported schema version");
  }
  if (typeof row.event_idempotency_key !== "string" || !row.event_idempotency_key) {
    throw new Error("Archive JSONL row is missing its event idempotency key");
  }
  if (typeof row.canonical_metadata_available !== "boolean") {
    throw new Error("Archive JSONL row is missing its canonical metadata coverage flag");
  }
  if (typeof row.payload_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.payload_sha256)) {
    throw new Error("Archive JSONL row is missing its payload SHA-256");
  }
  if (!("payload" in row)) throw new Error("Archive JSONL row is missing its canonical payload");
  return row.canonical_metadata_available;
}
