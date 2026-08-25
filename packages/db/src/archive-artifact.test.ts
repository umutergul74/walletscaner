import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildArchiveObjectKey, validateArchiveArtifact } from "./archive-artifact";
import type { ArchiveSegment } from "./archive-store";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("archive artifact", () => {
  it("validates a zstd frame, every envelope, row count and source SHA-256", async () => {
    const directory = await mkdtemp(join(tmpdir(), "walletscanner-archive-artifact-"));
    temporaryDirectories.push(directory);
    const rawPath = join(directory, "fixture.jsonl");
    const archivePath = `${rawPath}.zst`;
    const envelope = {
      schema_version: "raw-solana-v1",
      event_idempotency_key: "event-1",
      canonical_metadata_available: true,
      payload_sha256: "a".repeat(64),
      payload: { value: 1 }
    };
    const raw = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
    await writeFile(rawPath, raw);
    await execFileAsync("zstd", [
      "-q",
      "-3",
      "--single-thread",
      "--check",
      "-o",
      archivePath,
      rawPath
    ]);

    await expect(
      validateArchiveArtifact({
        filePath: archivePath,
        expected: {
          sourceRowCount: 1,
          canonicalMetadataRowCount: 1,
          recordTypeCounts: { chain_event_payload: 1 },
          sourceBytes: raw.byteLength,
          sourceSha256: createHash("sha256").update(raw).digest("hex")
        }
      })
    ).resolves.toMatchObject({ sourceRowCount: 1, sourceBytes: raw.byteLength });
  });

  it("rejects a valid frame whose restored manifest does not match", async () => {
    const directory = await mkdtemp(join(tmpdir(), "walletscanner-archive-artifact-"));
    temporaryDirectories.push(directory);
    const rawPath = join(directory, "fixture.jsonl");
    const archivePath = `${rawPath}.zst`;
    const raw = Buffer.from(
      `${JSON.stringify({
        schema_version: "raw-solana-v1",
        event_idempotency_key: "event-1",
        canonical_metadata_available: false,
        payload_sha256: "b".repeat(64),
        payload: {}
      })}\n`,
      "utf8"
    );
    await writeFile(rawPath, raw);
    await execFileAsync("zstd", [
      "-q",
      "-3",
      "--single-thread",
      "--check",
      "-o",
      archivePath,
      rawPath
    ]);

    await expect(
      validateArchiveArtifact({
        filePath: archivePath,
        expected: {
          sourceRowCount: 2,
          canonicalMetadataRowCount: 0,
          recordTypeCounts: { chain_event_payload: 2 },
          sourceBytes: raw.byteLength,
          sourceSha256: createHash("sha256").update(raw).digest("hex")
        }
      })
    ).rejects.toThrow("does not match the PostgreSQL manifest");
  });

  it("builds a revisioned append-only object key", () => {
    const segment = {
      sourceKind: "chain-event-payloads",
      rangeStart: "2026-08-02T00:00:00.000Z",
      revision: 7,
      formatVersion: "raw-solana-v1"
    } as ArchiveSegment;
    expect(buildArchiveObjectKey(segment)).toBe(
      "raw-solana/date=2026-08-02/revision=000007/raw-solana-v1.jsonl.zst"
    );
  });

  it("validates full wallet evidence envelopes and uses an isolated object prefix", async () => {
    const directory = await mkdtemp(join(tmpdir(), "walletscanner-wallet-evidence-"));
    temporaryDirectories.push(directory);
    const rawPath = join(directory, "wallet.jsonl");
    const archivePath = `${rawPath}.zst`;
    const envelope = {
      schema_version: "wallet-evidence-daily-v1",
      record_type: "wallet_trade_event",
      idempotency_key: "trade-1",
      canonical_metadata_available: true,
      observed_at: "2026-08-02T01:02:03.000Z",
      record: { idempotency_key: "trade-1", raw: { exact: true } }
    };
    const raw = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
    await writeFile(rawPath, raw);
    await execFileAsync("zstd", [
      "-q",
      "-3",
      "--single-thread",
      "--check",
      "-o",
      archivePath,
      rawPath
    ]);

    await expect(
      validateArchiveArtifact({
        filePath: archivePath,
        expected: {
          sourceRowCount: 1,
          canonicalMetadataRowCount: 1,
          recordTypeCounts: { wallet_trade_event: 1 },
          sourceBytes: raw.byteLength,
          sourceSha256: createHash("sha256").update(raw).digest("hex")
        }
      })
    ).resolves.toMatchObject({
      recordTypeCounts: { wallet_trade_event: 1 }
    });

    const segment = {
      sourceKind: "wallet-evidence",
      rangeStart: "2026-08-02T00:00:00.000Z",
      revision: 3,
      formatVersion: "wallet-evidence-daily-v1"
    } as ArchiveSegment;
    expect(buildArchiveObjectKey(segment)).toBe(
      "wallet-evidence/date=2026-08-02/revision=000003/wallet-evidence-daily-v1.jsonl.zst"
    );
  });
});
