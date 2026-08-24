import { hostname } from "node:os";
import type { ArchiveSegment } from "@memecoin-alpha/db/archive-store";

export function archiveWorkerId(role: "writer" | "verifier"): string {
  return `archive-${role}:${hostname()}:${process.pid}`;
}

export function archiveMetadata(segment: ArchiveSegment): Record<string, string> {
  if (
    segment.sourceRowCount === undefined ||
    segment.canonicalMetadataRowCount === undefined ||
    segment.sourceBytes === undefined ||
    !segment.sourceSha256
  ) {
    throw new Error("Archive segment is missing its source manifest");
  }
  return {
    "source-sha256": segment.sourceSha256,
    "source-row-count": segment.sourceRowCount.toString(),
    "canonical-metadata-row-count": segment.canonicalMetadataRowCount.toString(),
    "source-bytes": segment.sourceBytes.toString(),
    "source-start": segment.rangeStart,
    "source-end": segment.rangeEnd,
    "segment-revision": segment.revision.toString()
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("$metadata" in error)) return undefined;
  const metadata = error.$metadata;
  if (!metadata || typeof metadata !== "object" || !("httpStatusCode" in metadata))
    return undefined;
  return typeof metadata.httpStatusCode === "number" ? metadata.httpStatusCode : undefined;
}

export function resolveObjectLockEvidence(options: {
  evidenceMode: "api-verified" | "attested-default-policy";
  apiMode?: "GOVERNANCE" | "COMPLIANCE";
  apiRetainUntil?: string;
  defaultMode: "GOVERNANCE" | "COMPLIANCE";
  defaultDays: number;
  uploadedAt?: string;
}): {
  objectLockMode: "GOVERNANCE" | "COMPLIANCE";
  objectLockEvidence: "api-verified" | "attested-default-policy";
  retainUntil: string;
} {
  if (options.evidenceMode === "api-verified") {
    if (!options.apiMode || !options.apiRetainUntil) {
      throw new Error("Object Lock API evidence is missing after remote restore");
    }
    return {
      objectLockMode: options.apiMode,
      objectLockEvidence: "api-verified",
      retainUntil: options.apiRetainUntil
    };
  }
  const uploadedAt = options.uploadedAt ? new Date(options.uploadedAt) : undefined;
  if (
    !uploadedAt ||
    Number.isNaN(uploadedAt.getTime()) ||
    !Number.isSafeInteger(options.defaultDays) ||
    options.defaultDays <= 0
  ) {
    throw new Error("Attested Object Lock policy is missing a valid upload time or duration");
  }
  return {
    objectLockMode: options.defaultMode,
    objectLockEvidence: "attested-default-policy",
    retainUntil: new Date(uploadedAt.getTime() + options.defaultDays * 86_400_000).toISOString()
  };
}

export function startLeaseHeartbeat(options: {
  intervalSeconds: number;
  heartbeat: () => Promise<boolean>;
  onFailure: (error: unknown) => void;
}): () => void {
  let active = true;
  let running = false;
  const timer = setInterval(
    () => {
      if (!active || running) return;
      running = true;
      options
        .heartbeat()
        .then((current) => {
          if (!current)
            options.onFailure(new Error("Archive lease or revision is no longer current"));
        })
        .catch(options.onFailure)
        .finally(() => {
          running = false;
        });
    },
    Math.max(10, options.intervalSeconds) * 1_000
  );
  timer.unref();
  return () => {
    active = false;
    clearInterval(timer);
  };
}
