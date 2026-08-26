import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  GetObjectRetentionCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client
} from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchiveIntegrityError, S3CompatibleArchiveStore } from "./object-storage";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

function config() {
  return {
    endpoint: "https://s3.example.invalid",
    region: "test-region-1",
    bucket: "walletscaner",
    prefix: "walletscanner-prod",
    accessKeyId: "test-id",
    secretAccessKey: "test-secret",
    requestTimeoutMs: 5_000,
    maxAttempts: 1
  };
}

describe("S3CompatibleArchiveStore", () => {
  it("streams a pre-hashed file with immutable integrity metadata", async () => {
    const directory = await mkdtemp(join(tmpdir(), "walletscanner-archive-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "events.jsonl.zst");
    const content = Buffer.from("bounded archive fixture");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const contentMd5Base64 = createHash("md5").update(content).digest("base64");
    await writeFile(filePath, content);

    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(PutObjectCommand);
      return { ETag: '"etag"', VersionId: "version-1" };
    });
    const store = new S3CompatibleArchiveStore(config(), { send } as unknown as S3Client);

    const receipt = await store.uploadFile({
      relativeKey: "raw-solana/date=2026-08-02/hour=03/events.jsonl.zst",
      filePath,
      contentLength: content.length,
      sha256,
      contentMd5Base64,
      schemaVersion: "raw-solana-v1"
    });

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect((command as PutObjectCommand).input).toMatchObject({
      Bucket: "walletscaner",
      Key: "walletscanner-prod/raw-solana/date=2026-08-02/hour=03/events.jsonl.zst",
      ContentLength: content.length,
      ContentMD5: contentMd5Base64,
      ContentType: "application/zstd",
      Metadata: { sha256, "schema-version": "raw-solana-v1" }
    });
    expect(receipt).toMatchObject({
      sha256,
      contentLength: content.length,
      versionId: "version-1"
    });
  });

  it("verifies HEAD metadata and hashes the GET stream without buffering the object", async () => {
    const chunks = [Buffer.from("bounded "), Buffer.from("archive fixture")];
    const content = Buffer.concat(chunks);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        return { ContentLength: content.length, Metadata: { sha256 }, ETag: '"etag"' };
      }
      if (command instanceof GetObjectCommand) {
        return { Body: Readable.from(chunks) };
      }
      throw new Error("unexpected command");
    });
    const store = new S3CompatibleArchiveStore(config(), { send } as unknown as S3Client);

    await expect(
      store.verifyObject({
        relativeKey: "raw-solana/test.jsonl.zst",
        contentLength: content.length,
        sha256
      })
    ).resolves.toMatchObject({ contentLength: content.length, sha256 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("requires visible Object Lock retention and writes a bounded verified download", async () => {
    const directory = await mkdtemp(join(tmpdir(), "walletscanner-archive-download-"));
    temporaryDirectories.push(directory);
    const destinationPath = join(directory, "verified.jsonl.zst");
    const content = Buffer.from("locked archive fixture");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const retainUntil = new Date("2026-09-13T00:00:00.000Z");
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        return {
          ContentLength: content.length,
          Metadata: { sha256, "source-sha256": "a".repeat(64) },
          VersionId: "version-locked"
        };
      }
      if (command instanceof GetObjectRetentionCommand) {
        expect(command.input.VersionId).toBe("version-locked");
        return { Retention: { Mode: "GOVERNANCE", RetainUntilDate: retainUntil } };
      }
      if (command instanceof GetObjectCommand) return { Body: Readable.from([content]) };
      throw new Error("unexpected command");
    });
    const store = new S3CompatibleArchiveStore(config(), { send } as unknown as S3Client);

    await expect(
      store.downloadVerifiedObject(
        {
          relativeKey: "raw-solana/test.jsonl.zst",
          contentLength: content.length,
          sha256,
          metadata: { "source-sha256": "a".repeat(64) },
          requireObjectLock: true,
          minimumRetainUntil: new Date("2026-08-20T00:00:00.000Z")
        },
        destinationPath
      )
    ).resolves.toMatchObject({
      objectLockMode: "GOVERNANCE",
      retainUntil: retainUntil.toISOString()
    });
    await expect(
      import("node:fs/promises").then(({ readFile }) => readFile(destinationPath))
    ).resolves.toEqual(content);
  });

  it("fails closed when the verifier cannot see Object Lock evidence", async () => {
    const content = Buffer.from("archive fixture");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        return { ContentLength: content.length, Metadata: { sha256 } };
      }
      if (command instanceof GetObjectRetentionCommand) return { Retention: {} };
      throw new Error("GET must not run without lock evidence");
    });
    const store = new S3CompatibleArchiveStore(config(), { send } as unknown as S3Client);

    await expect(
      store.verifyObject({
        relativeKey: "raw-solana/test.jsonl.zst",
        contentLength: content.length,
        sha256,
        requireObjectLock: true
      })
    ).rejects.toThrow("Object Lock retention is not visible");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("fails closed before GET when remote metadata differs", async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(HeadObjectCommand);
      return { ContentLength: 4, Metadata: { sha256: "0".repeat(64) } };
    });
    const store = new S3CompatibleArchiveStore(config(), { send } as unknown as S3Client);

    await expect(
      store.verifyObject({
        relativeKey: "raw-solana/test.jsonl.zst",
        contentLength: 4,
        sha256: "1".repeat(64)
      })
    ).rejects.toBeInstanceOf(ArchiveIntegrityError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("accepts semantically equal record-type counts regardless of JSON key order", async () => {
    const content = Buffer.from("archive fixture");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const send = vi.fn(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) {
        return {
          ContentLength: content.length,
          Metadata: {
            sha256,
            "record-type-counts":
              '{"wallet_signal_outcome":2,"wallet_entry_signal":1}'
          }
        };
      }
      if (command instanceof GetObjectCommand) return { Body: Readable.from([content]) };
      throw new Error("unexpected command");
    });
    const store = new S3CompatibleArchiveStore(config(), { send } as unknown as S3Client);

    await expect(
      store.verifyObject({
        relativeKey: "wallet-evidence/test.jsonl.zst",
        contentLength: content.length,
        sha256,
        metadata: {
          "record-type-counts":
            '{"wallet_entry_signal":1,"wallet_signal_outcome":2}'
        }
      })
    ).resolves.toMatchObject({ contentLength: content.length, sha256 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("still fails closed when record-type counts differ semantically", async () => {
    const send = vi.fn(async (command: unknown) => {
      expect(command).toBeInstanceOf(HeadObjectCommand);
      return {
        ContentLength: 4,
        Metadata: {
          sha256: "1".repeat(64),
          "record-type-counts": '{"wallet_entry_signal":2}'
        }
      };
    });
    const store = new S3CompatibleArchiveStore(config(), { send } as unknown as S3Client);

    await expect(
      store.verifyObject({
        relativeKey: "wallet-evidence/test.jsonl.zst",
        contentLength: 4,
        sha256: "1".repeat(64),
        metadata: { "record-type-counts": '{"wallet_entry_signal":1}' }
      })
    ).rejects.toThrow("metadata:record-type-counts");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["", "/absolute", "../escape", "safe/../escape", "safe\\escape", "safe//empty"])(
    "rejects an unsafe relative key: %s",
    (relativeKey) => {
      const store = new S3CompatibleArchiveStore(config(), {
        send: vi.fn()
      } as unknown as S3Client);
      expect(() => store.objectKey(relativeKey)).toThrow();
    }
  );
});
