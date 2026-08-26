import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import {
  GetObjectCommand,
  GetObjectRetentionCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type PutObjectCommandOutput
} from "@aws-sdk/client-s3";

const SHA256_HEX = /^[a-f0-9]{64}$/;

export interface S3CompatibleArchiveConfig {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  requestTimeoutMs?: number;
  maxAttempts?: number;
}

export interface ArchiveFileUpload {
  relativeKey: string;
  filePath: string;
  contentLength: number;
  sha256: string;
  contentMd5Base64: string;
  schemaVersion: string;
  metadata?: Record<string, string>;
  contentType?: string;
}

export interface ArchiveObjectExpectation {
  relativeKey: string;
  contentLength: number;
  sha256: string;
  metadata?: Record<string, string>;
  requireObjectLock?: boolean;
  minimumRetainUntil?: Date;
}

export interface ArchiveObjectReceipt {
  bucket: string;
  key: string;
  contentLength: number;
  sha256: string;
  etag?: string;
  versionId?: string;
  objectLockMode?: "GOVERNANCE" | "COMPLIANCE";
  retainUntil?: string;
}

export class ArchiveIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveIntegrityError";
  }
}

function normalizePrefix(prefix: string): string {
  const normalized = prefix.replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("\\") || normalized.split("/").includes("..")) {
    throw new Error("Archive prefix must be a non-empty, normalized object-key prefix");
  }
  return normalized;
}

function normalizeRelativeKey(relativeKey: string): string {
  if (
    !relativeKey ||
    relativeKey.startsWith("/") ||
    relativeKey.endsWith("/") ||
    relativeKey.includes("\\")
  ) {
    throw new Error("Archive object key must be a non-empty relative key");
  }

  const segments = relativeKey.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Archive object key contains an unsafe path segment");
  }

  return segments.join("/");
}

function normalizeSha256(sha256: string): string {
  const normalized = sha256.toLowerCase();
  if (!SHA256_HEX.test(normalized)) {
    throw new Error("Archive SHA-256 must be a 64-character hexadecimal digest");
  }
  return normalized;
}

function normalizeContentMd5(contentMd5Base64: string): string {
  if (!/^[A-Za-z0-9+/]{22}==$/.test(contentMd5Base64)) {
    throw new Error("Archive Content-MD5 must be a base64 digest");
  }
  return contentMd5Base64;
}

function normalizeMetadata(metadata: Record<string, string> | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    const normalizedKey = key.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(normalizedKey) || !value || value.length > 1_024) {
      throw new Error("Archive metadata keys and values must be non-empty and bounded");
    }
    normalized[normalizedKey] = value;
  }
  return normalized;
}

function canonicalRecordTypeCounts(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return undefined;
    const entries = Object.entries(parsed);
    if (
      entries.length === 0 ||
      entries.length > 32 ||
      entries.some(
        ([key, count]) =>
          !/^[a-z][a-z0-9_]{0,127}$/.test(key) ||
          typeof count !== "number" ||
          !Number.isSafeInteger(count) ||
          count < 0
      )
    ) {
      return undefined;
    }
    return JSON.stringify(entries.sort(([left], [right]) => left.localeCompare(right)));
  } catch {
    return undefined;
  }
}

function metadataValueMatches(key: string, expected: string, actual: string | undefined): boolean {
  if (actual === expected) return true;
  if (key !== "record-type-counts") return false;
  const expectedCanonical = canonicalRecordTypeCounts(expected);
  return (
    expectedCanonical !== undefined && expectedCanonical === canonicalRecordTypeCounts(actual)
  );
}

function requirePositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return value;
}

async function hashBody(
  body: unknown,
  expectedLength: number,
  abortController: AbortController
): Promise<{ bytes: number; sha256: string }> {
  if (
    !body ||
    (typeof body !== "object" && typeof body !== "function") ||
    !(Symbol.asyncIterator in body)
  ) {
    throw new ArchiveIntegrityError("Archive GET response is not a streaming body");
  }

  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength;
    if (bytes > expectedLength) {
      abortController.abort();
      throw new ArchiveIntegrityError("Archive GET response exceeded its expected byte length");
    }
    digest.update(chunk);
  }

  return { bytes, sha256: digest.digest("hex") };
}

/**
 * Low-memory S3-compatible archive transport.
 *
 * Instantiate separate writer and verifier instances with role-specific credentials. The writer
 * streams a pre-hashed local file and cannot prove remote readability by itself. The verifier uses
 * an independent read credential and performs both metadata and full streamed SHA-256 checks.
 */
export class S3CompatibleArchiveStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly requestTimeoutMs: number;

  constructor(config: S3CompatibleArchiveConfig, client?: S3Client) {
    this.bucket = config.bucket;
    this.prefix = normalizePrefix(config.prefix);
    this.requestTimeoutMs = requirePositiveSafeInteger(
      config.requestTimeoutMs ?? 60_000,
      "Archive request timeout"
    );
    this.client =
      client ??
      new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        forcePathStyle: true,
        maxAttempts: config.maxAttempts ?? 3,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey
        }
      });
  }

  objectKey(relativeKey: string): string {
    return `${this.prefix}/${normalizeRelativeKey(relativeKey)}`;
  }

  async uploadFile(input: ArchiveFileUpload): Promise<ArchiveObjectReceipt> {
    const contentLength = requirePositiveSafeInteger(input.contentLength, "Archive content length");
    const sha256 = normalizeSha256(input.sha256);
    const contentMd5Base64 = normalizeContentMd5(input.contentMd5Base64);
    const metadata = normalizeMetadata(input.metadata);
    const file = await stat(input.filePath);
    if (!file.isFile() || file.size !== contentLength) {
      throw new ArchiveIntegrityError(
        `Archive source size mismatch: expected ${contentLength}, found ${file.size}`
      );
    }

    const key = this.objectKey(input.relativeKey);
    const body = createReadStream(input.filePath);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    let output: PutObjectCommandOutput;
    try {
      output = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentLength: contentLength,
          ContentMD5: contentMd5Base64,
          ContentType: input.contentType ?? "application/zstd",
          Metadata: {
            ...metadata,
            sha256,
            "schema-version": input.schemaVersion
          }
        }),
        { abortSignal: controller.signal }
      );
    } finally {
      clearTimeout(timeout);
      body.destroy();
    }

    return {
      bucket: this.bucket,
      key,
      contentLength,
      sha256,
      ...(output.ETag ? { etag: output.ETag } : {}),
      ...(output.VersionId ? { versionId: output.VersionId } : {})
    };
  }

  async verifyObject(input: ArchiveObjectExpectation): Promise<ArchiveObjectReceipt> {
    return this.readAndVerify(input);
  }

  async downloadVerifiedObject(
    input: ArchiveObjectExpectation,
    destinationPath: string
  ): Promise<ArchiveObjectReceipt> {
    return this.readAndVerify(input, destinationPath);
  }

  private async readAndVerify(
    input: ArchiveObjectExpectation,
    destinationPath?: string
  ): Promise<ArchiveObjectReceipt> {
    const contentLength = requirePositiveSafeInteger(input.contentLength, "Archive content length");
    const sha256 = normalizeSha256(input.sha256);
    const metadata = normalizeMetadata(input.metadata);
    const key = this.objectKey(input.relativeKey);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal: controller.signal }
      );
      const remoteSha256 = head.Metadata?.sha256?.toLowerCase();
      const mismatches = [
        ...(head.ContentLength === contentLength ? [] : ["content-length"]),
        ...(remoteSha256 === sha256 ? [] : ["sha256"]),
        ...Object.entries(metadata)
          .filter(
            ([metadataKey, value]) =>
              !metadataValueMatches(metadataKey, value, head.Metadata?.[metadataKey])
          )
          .map(([metadataKey]) => `metadata:${metadataKey}`)
      ];
      if (mismatches.length > 0) {
        throw new ArchiveIntegrityError(
          `Archive HEAD metadata does not match the local manifest (${mismatches.join(", ")})`
        );
      }
      let objectLockMode =
        head.ObjectLockMode === "GOVERNANCE" || head.ObjectLockMode === "COMPLIANCE"
          ? head.ObjectLockMode
          : undefined;
      let retainUntil = head.ObjectLockRetainUntilDate;
      if (input.requireObjectLock) {
        const retention = await this.client.send(
          new GetObjectRetentionCommand({
            Bucket: this.bucket,
            Key: key,
            ...(head.VersionId ? { VersionId: head.VersionId } : {})
          }),
          { abortSignal: controller.signal }
        );
        objectLockMode =
          retention.Retention?.Mode === "GOVERNANCE" ||
          retention.Retention?.Mode === "COMPLIANCE"
            ? retention.Retention.Mode
            : undefined;
        retainUntil = retention.Retention?.RetainUntilDate;
        if (!objectLockMode || !retainUntil) {
          throw new ArchiveIntegrityError(
            "Archive Object Lock retention is not visible to the verifier credential"
          );
        }
        if (
          input.minimumRetainUntil &&
          retainUntil.getTime() < input.minimumRetainUntil.getTime()
        ) {
          throw new ArchiveIntegrityError(
            "Archive Object Lock retention ends before the safety gate"
          );
        }
      }

      const get = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
        abortSignal: controller.signal
      });
      const streamed = destinationPath
        ? await hashBodyToFile(get.Body, contentLength, controller, destinationPath)
        : await hashBody(get.Body, contentLength, controller);
      if (streamed.bytes !== contentLength || streamed.sha256 !== sha256) {
        throw new ArchiveIntegrityError("Archive GET content does not match the local manifest");
      }

      return {
        bucket: this.bucket,
        key,
        contentLength,
        sha256,
        ...(head.ETag ? { etag: head.ETag } : {}),
        ...(head.VersionId ? { versionId: head.VersionId } : {}),
        ...(objectLockMode ? { objectLockMode } : {}),
        ...(retainUntil ? { retainUntil: retainUntil.toISOString() } : {})
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function hashBodyToFile(
  body: unknown,
  expectedLength: number,
  abortController: AbortController,
  destinationPath: string
): Promise<{ bytes: number; sha256: string }> {
  if (
    !body ||
    (typeof body !== "object" && typeof body !== "function") ||
    !(Symbol.asyncIterator in body)
  ) {
    throw new ArchiveIntegrityError("Archive GET response is not a streaming body");
  }

  const digest = createHash("sha256");
  let bytes = 0;
  const file = await open(destinationPath, "wx", 0o600);
  try {
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > expectedLength) {
        abortController.abort();
        throw new ArchiveIntegrityError("Archive GET response exceeded its expected byte length");
      }
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const written = await file.write(chunk, offset, chunk.byteLength - offset);
        offset += written.bytesWritten;
      }
    }
    await file.sync();
  } catch (error) {
    await file.close();
    await rm(destinationPath, { force: true });
    throw error;
  }
  await file.close();
  return { bytes, sha256: digest.digest("hex") };
}
