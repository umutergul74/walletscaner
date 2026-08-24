import pg from "pg";

export type ArchiveSegmentStatus =
  | "pending"
  | "exporting"
  | "verify_pending"
  | "verifying"
  | "verified"
  | "retry_export"
  | "retry_verify"
  | "dead_letter";

export interface ArchiveSegment {
  id: number;
  sourceKind: "chain-event-payloads";
  rangeStart: string;
  rangeEnd: string;
  revision: number;
  formatVersion: string;
  compression: string;
  status: ArchiveSegmentStatus;
  notBefore: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  exportAttemptCount: number;
  verifyAttemptCount: number;
  objectKey?: string;
  sourceRowCount?: number;
  canonicalMetadataRowCount?: number;
  sourceBytes?: number;
  sourceSha256?: string;
  archiveBytes?: number;
  archiveSha256?: string;
  contentMd5Base64?: string;
  etag?: string;
  objectVersionId?: string;
  objectLockMode?: "GOVERNANCE" | "COMPLIANCE";
  objectLockEvidence?: "api-verified" | "attested-default-policy";
  retainUntil?: string;
  uploadedAt?: string;
  verifiedAt?: string;
  lastError?: string;
}

export interface ArchiveArtifactManifest {
  objectKey: string;
  sourceRowCount: number;
  canonicalMetadataRowCount: number;
  sourceBytes: number;
  sourceSha256: string;
  archiveBytes: number;
  archiveSha256: string;
  contentMd5Base64: string;
}

export interface ArchiveVerificationReceipt {
  etag?: string;
  objectVersionId?: string;
  objectLockMode: "GOVERNANCE" | "COMPLIANCE";
  objectLockEvidence: "api-verified" | "attested-default-policy";
  retainUntil: string;
}

export interface ArchivePartitionPlan {
  rangeStart: string;
  rangeEnd: string;
  existingStatus?: ArchiveSegmentStatus;
  revision?: number;
}

interface ArchiveSegmentRow {
  id: string;
  source_kind: "chain-event-payloads";
  range_start: Date;
  range_end: Date;
  revision: number;
  format_version: string;
  compression: string;
  status: ArchiveSegmentStatus;
  not_before: Date;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  export_attempt_count: number;
  verify_attempt_count: number;
  object_key: string | null;
  source_row_count: string | null;
  canonical_metadata_row_count: string | null;
  source_bytes: string | null;
  source_sha256: string | null;
  archive_bytes: string | null;
  archive_sha256: string | null;
  content_md5_base64: string | null;
  etag: string | null;
  object_version_id: string | null;
  object_lock_mode: "GOVERNANCE" | "COMPLIANCE" | null;
  object_lock_evidence: "api-verified" | "attested-default-policy" | null;
  retain_until: Date | null;
  uploaded_at: Date | null;
  verified_at: Date | null;
  last_error: string | null;
}

interface Queryable {
  query: pg.Pool["query"];
  connect?: () => Promise<pg.PoolClient>;
}

interface FailureOptions {
  segment: ArchiveSegment;
  workerId: string;
  error: string;
  retrySeconds: number;
  maxAttempts: number;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

export class ArchiveStore {
  private readonly pool: Queryable;

  constructor(databaseUrl: string | Queryable) {
    this.pool =
      typeof databaseUrl === "string"
        ? new pg.Pool({ connectionString: databaseUrl, max: 1 })
        : databaseUrl;
  }

  async seedEligibleDailySegments(settleHours: number, limit: number): Promise<number> {
    requirePositiveInteger(settleHours, "settleHours");
    requirePositiveInteger(limit, "limit");
    const result = await this.pool.query(
      `WITH eligible AS (
         SELECT
           to_date(substring(child.relname FROM '([0-9]{8})$'), 'YYYYMMDD')::timestamp
             AT TIME ZONE 'UTC'
             AS range_start
         FROM pg_inherits
         JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
         JOIN pg_class child ON child.oid = pg_inherits.inhrelid
         WHERE parent.oid = 'chain_event_payloads'::regclass
           AND child.relname ~ '^chain_event_payloads_[0-9]{8}$'
           AND to_date(substring(child.relname FROM '([0-9]{8})$'), 'YYYYMMDD') + 1
               <= (NOW() AT TIME ZONE 'UTC') - make_interval(hours => $1::integer)
           AND NOT EXISTS (
             SELECT 1
             FROM archive_segments AS existing
             WHERE existing.source_kind = 'chain-event-payloads'
               AND existing.range_start =
                   to_date(substring(child.relname FROM '([0-9]{8})$'), 'YYYYMMDD')::timestamp
                     AT TIME ZONE 'UTC'
               AND existing.range_end =
                   (to_date(substring(child.relname FROM '([0-9]{8})$'), 'YYYYMMDD')::timestamp
                     AT TIME ZONE 'UTC') + INTERVAL '1 day'
           )
         ORDER BY range_start
         LIMIT $2
       )
       INSERT INTO archive_segments (
         source_kind, range_start, range_end, format_version, compression
       )
       SELECT
         'chain-event-payloads', range_start, range_start + INTERVAL '1 day',
         'raw-solana-v1', 'zstd-3'
       FROM eligible
       ON CONFLICT (source_kind, range_start, range_end) DO NOTHING`,
      [settleHours, limit]
    );
    return result.rowCount ?? 0;
  }

  async previewEligiblePartitions(
    settleHours: number,
    limit: number
  ): Promise<ArchivePartitionPlan[]> {
    requirePositiveInteger(settleHours, "settleHours");
    requirePositiveInteger(limit, "limit");
    const result = await this.pool.query<{
      range_start: Date;
      range_end: Date;
      status: ArchiveSegmentStatus | null;
      revision: number | null;
    }>(
      `WITH eligible AS (
         SELECT
           to_date(substring(child.relname FROM '([0-9]{8})$'), 'YYYYMMDD')::timestamp
             AT TIME ZONE 'UTC'
             AS range_start
         FROM pg_inherits
         JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
         JOIN pg_class child ON child.oid = pg_inherits.inhrelid
         WHERE parent.oid = 'chain_event_payloads'::regclass
           AND child.relname ~ '^chain_event_payloads_[0-9]{8}$'
           AND to_date(substring(child.relname FROM '([0-9]{8})$'), 'YYYYMMDD') + 1
               <= (NOW() AT TIME ZONE 'UTC') - make_interval(hours => $1::integer)
         ORDER BY range_start
         LIMIT $2
       )
       SELECT
         eligible.range_start,
         eligible.range_start + INTERVAL '1 day' AS range_end,
         segment.status,
         segment.revision
       FROM eligible
       LEFT JOIN archive_segments AS segment
         ON segment.source_kind = 'chain-event-payloads'
        AND segment.range_start = eligible.range_start
        AND segment.range_end = eligible.range_start + INTERVAL '1 day'
       ORDER BY eligible.range_start`,
      [settleHours, limit]
    );
    return result.rows.map((row) => ({
      rangeStart: row.range_start.toISOString(),
      rangeEnd: row.range_end.toISOString(),
      ...(row.status ? { existingStatus: row.status } : {}),
      ...(row.revision !== null ? { revision: row.revision } : {})
    }));
  }

  async previewEligibleDailySegments(
    settleHours: number,
    limit: number
  ): Promise<ArchiveSegment[]> {
    requirePositiveInteger(settleHours, "settleHours");
    requirePositiveInteger(limit, "limit");
    const result = await this.pool.query<ArchiveSegmentRow>(
      `SELECT segment.*
       FROM archive_segments AS segment
       WHERE segment.range_end <= NOW() - make_interval(hours => $1::integer)
       ORDER BY
         CASE segment.status
           WHEN 'dead_letter' THEN 2
           WHEN 'verified' THEN 1
           ELSE 0
         END,
         segment.range_start,
         segment.id
       LIMIT $2`,
      [settleHours, limit]
    );
    return result.rows.map(mapSegment);
  }

  async claimWriter(options: {
    workerId: string;
    leaseSeconds: number;
  }): Promise<ArchiveSegment | undefined> {
    return this.claim(options, "writer");
  }

  async claimVerifier(options: {
    workerId: string;
    leaseSeconds: number;
  }): Promise<ArchiveSegment | undefined> {
    return this.claim(options, "verifier");
  }

  async heartbeat(options: {
    segment: ArchiveSegment;
    workerId: string;
    leaseSeconds: number;
    stage: "writer" | "verifier";
  }): Promise<boolean> {
    requirePositiveInteger(options.leaseSeconds, "leaseSeconds");
    const expectedStatus = options.stage === "writer" ? "exporting" : "verifying";
    const result = await this.pool.query(
      `UPDATE archive_segments
       SET lease_expires_at = NOW() + make_interval(secs => $4::integer),
           updated_at = NOW()
       WHERE id = $1
         AND revision = $2
         AND status = $5
         AND lease_owner = $3`,
      [
        options.segment.id,
        options.segment.revision,
        options.workerId,
        options.leaseSeconds,
        expectedStatus
      ]
    );
    return result.rowCount === 1;
  }

  async isCurrentLease(options: {
    segment: ArchiveSegment;
    workerId: string;
    stage: "writer" | "verifier";
  }): Promise<boolean> {
    const expectedStatus = options.stage === "writer" ? "exporting" : "verifying";
    const result = await this.pool.query<{ current: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM archive_segments
         WHERE id = $1
           AND revision = $2
           AND status = $4
           AND lease_owner = $3
           AND lease_expires_at > NOW()
       ) AS current`,
      [options.segment.id, options.segment.revision, options.workerId, expectedStatus]
    );
    return Boolean(result.rows[0]?.current);
  }

  async markUploadForVerification(options: {
    segment: ArchiveSegment;
    workerId: string;
    artifact: ArchiveArtifactManifest;
    uploadSucceeded: boolean;
    etag?: string;
    objectVersionId?: string;
    error?: string;
  }): Promise<boolean> {
    assertArtifact(options.artifact);
    const result = await this.pool.query(
      `WITH updated AS (
         UPDATE archive_segments
         SET status = 'verify_pending',
             not_before = NOW(),
             lease_owner = NULL,
             lease_expires_at = NULL,
             object_key = $4,
             source_row_count = $5,
             canonical_metadata_row_count = $6,
             source_bytes = $7,
             source_sha256 = $8,
             archive_bytes = $9,
             archive_sha256 = $10,
             content_md5_base64 = $11,
             etag = $12,
             object_version_id = $13,
             uploaded_at = CASE WHEN $14::boolean THEN NOW() ELSE uploaded_at END,
             last_error = $15,
             updated_at = NOW()
         WHERE id = $1
           AND revision = $2
           AND status = 'exporting'
           AND lease_owner = $3
         RETURNING id
       )
       INSERT INTO archive_attempts (
         segment_id, segment_revision, stage, attempt_number, worker_id, outcome, error, details
       )
       SELECT $1, $2, 'upload', $16, $3,
              CASE WHEN $14::boolean THEN 'success' ELSE 'retry' END,
              $15,
              jsonb_build_object('objectKey', $4, 'uploadSucceeded', $14::boolean)
       FROM updated`,
      [
        options.segment.id,
        options.segment.revision,
        options.workerId,
        options.artifact.objectKey,
        options.artifact.sourceRowCount,
        options.artifact.canonicalMetadataRowCount,
        options.artifact.sourceBytes,
        options.artifact.sourceSha256,
        options.artifact.archiveBytes,
        options.artifact.archiveSha256,
        options.artifact.contentMd5Base64,
        options.etag ?? null,
        options.objectVersionId ?? null,
        options.uploadSucceeded,
        boundedError(options.error),
        options.segment.exportAttemptCount
      ]
    );
    return result.rowCount === 1;
  }

  async failExport(options: FailureOptions): Promise<ArchiveSegmentStatus | "stale_revision"> {
    return this.fail(options, "export");
  }

  async completeVerification(options: {
    segment: ArchiveSegment;
    workerId: string;
    receipt: ArchiveVerificationReceipt;
    minimumRetainUntil: string;
    details?: Record<string, unknown>;
  }): Promise<boolean> {
    const retainUntil = new Date(options.receipt.retainUntil);
    const minimum = new Date(options.minimumRetainUntil);
    if (
      Number.isNaN(retainUntil.getTime()) ||
      Number.isNaN(minimum.getTime()) ||
      retainUntil.getTime() < minimum.getTime()
    ) {
      throw new Error("Archive Object Lock retention does not meet the required minimum");
    }
    if (!["GOVERNANCE", "COMPLIANCE"].includes(options.receipt.objectLockMode)) {
      throw new Error("Archive Object Lock mode is not visible or supported");
    }
    if (
      !["api-verified", "attested-default-policy"].includes(
        options.receipt.objectLockEvidence
      )
    ) {
      throw new Error("Archive Object Lock evidence source is unsupported");
    }

    const result = await this.pool.query(
      `WITH updated AS (
         UPDATE archive_segments
         SET status = 'verified',
             not_before = NOW(),
             lease_owner = NULL,
             lease_expires_at = NULL,
             etag = COALESCE($4, etag),
             object_version_id = COALESCE($5, object_version_id),
             object_lock_mode = $6,
             object_lock_evidence = $7,
             retain_until = $8,
             verified_at = NOW(),
             last_error = NULL,
             updated_at = NOW()
         WHERE id = $1
           AND revision = $2
           AND status = 'verifying'
           AND lease_owner = $3
         RETURNING id
       )
       INSERT INTO archive_attempts (
         segment_id, segment_revision, stage, attempt_number, worker_id, outcome, details
       )
       SELECT $1, $2, 'restore', $9, $3, 'success', $10::jsonb
       FROM updated`,
      [
        options.segment.id,
        options.segment.revision,
        options.workerId,
        options.receipt.etag ?? null,
        options.receipt.objectVersionId ?? null,
        options.receipt.objectLockMode,
        options.receipt.objectLockEvidence,
        options.receipt.retainUntil,
        options.segment.verifyAttemptCount,
        JSON.stringify(options.details ?? {})
      ]
    );
    return result.rowCount === 1;
  }

  async failVerification(
    options: FailureOptions & { disposition: "retry_export" | "retry_verify" | "dead_letter" }
  ): Promise<ArchiveSegmentStatus | "stale_revision"> {
    const error = boundedError(options.error);
    const status =
      options.disposition === "dead_letter" ||
      options.segment.verifyAttemptCount >= options.maxAttempts
        ? "dead_letter"
        : options.disposition;
    const result = await this.pool.query(
      `WITH updated AS (
         UPDATE archive_segments
         SET status = $4,
             not_before = CASE
               WHEN $4 = 'dead_letter' THEN NOW()
               ELSE NOW() + make_interval(secs => $5::integer)
             END,
             lease_owner = NULL,
             lease_expires_at = NULL,
             last_error = $6,
             updated_at = NOW()
         WHERE id = $1
           AND revision = $2
           AND status = 'verifying'
           AND lease_owner = $3
         RETURNING id
       )
       INSERT INTO archive_attempts (
         segment_id, segment_revision, stage, attempt_number, worker_id, outcome, error,
         details
       )
       SELECT $1, $2, 'verify', $7, $3,
              CASE WHEN $4 = 'dead_letter' THEN 'dead_letter' ELSE 'retry' END,
              $6, jsonb_build_object('disposition', $4)
       FROM updated`,
      [
        options.segment.id,
        options.segment.revision,
        options.workerId,
        status,
        options.retrySeconds,
        error,
        options.segment.verifyAttemptCount
      ]
    );
    return result.rowCount === 1 ? status : "stale_revision";
  }

  async summary(): Promise<Record<ArchiveSegmentStatus, number>> {
    const result = await this.pool.query<{ status: ArchiveSegmentStatus; count: string }>(
      `SELECT status, COUNT(*)::text AS count
       FROM archive_segments
       GROUP BY status`
    );
    const summary = Object.fromEntries(
      [
        "pending",
        "exporting",
        "verify_pending",
        "verifying",
        "verified",
        "retry_export",
        "retry_verify",
        "dead_letter"
      ].map((status) => [status, 0])
    ) as Record<ArchiveSegmentStatus, number>;
    for (const row of result.rows) summary[row.status] = Number(row.count);
    return summary;
  }

  private async claim(
    options: { workerId: string; leaseSeconds: number },
    role: "writer" | "verifier"
  ): Promise<ArchiveSegment | undefined> {
    requireWorkerId(options.workerId);
    requirePositiveInteger(options.leaseSeconds, "leaseSeconds");
    const eligibleStatuses =
      role === "writer"
        ? ["pending", "retry_export", "exporting"]
        : ["verify_pending", "retry_verify", "verifying"];
    const processingStatus = role === "writer" ? "exporting" : "verifying";
    const attemptColumn = role === "writer" ? "export_attempt_count" : "verify_attempt_count";
    const stage = role === "writer" ? "export" : "verify";

    return this.withTransaction(async (client) => {
      const result = await client.query<ArchiveSegmentRow>(
        `WITH candidate AS (
           SELECT id
           FROM archive_segments
           WHERE status = ANY($1::text[])
             AND not_before <= NOW()
             AND (status <> $2 OR lease_expires_at <= NOW())
           ORDER BY range_start, id
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE archive_segments AS segment
         SET status = $2,
             lease_owner = $3,
             lease_expires_at = NOW() + make_interval(secs => $4::integer),
             ${attemptColumn} = ${attemptColumn} + 1,
             last_error = NULL,
             updated_at = NOW()
         FROM candidate
         WHERE segment.id = candidate.id
         RETURNING segment.*`,
        [eligibleStatuses, processingStatus, options.workerId, options.leaseSeconds]
      );
      const row = result.rows[0];
      if (!row) return undefined;
      const attemptNumber = role === "writer" ? row.export_attempt_count : row.verify_attempt_count;
      await client.query(
        `INSERT INTO archive_attempts (
           segment_id, segment_revision, stage, attempt_number, worker_id, outcome
         ) VALUES ($1, $2, $3, $4, $5, 'claimed')`,
        [row.id, row.revision, stage, attemptNumber, options.workerId]
      );
      return mapSegment(row);
    });
  }

  private async fail(
    options: FailureOptions,
    stage: "export"
  ): Promise<ArchiveSegmentStatus | "stale_revision"> {
    const attemptCount = options.segment.exportAttemptCount;
    const status: ArchiveSegmentStatus =
      attemptCount >= options.maxAttempts ? "dead_letter" : "retry_export";
    const error = boundedError(options.error);
    const result = await this.pool.query(
      `WITH updated AS (
         UPDATE archive_segments
         SET status = $4,
             not_before = CASE
               WHEN $4 = 'dead_letter' THEN NOW()
               ELSE NOW() + make_interval(secs => $5::integer)
             END,
             lease_owner = NULL,
             lease_expires_at = NULL,
             last_error = $6,
             updated_at = NOW()
         WHERE id = $1
           AND revision = $2
           AND status = 'exporting'
           AND lease_owner = $3
         RETURNING id
       )
       INSERT INTO archive_attempts (
         segment_id, segment_revision, stage, attempt_number, worker_id, outcome, error
       )
       SELECT $1, $2, $7, $8, $3,
              CASE WHEN $4 = 'dead_letter' THEN 'dead_letter' ELSE 'retry' END,
              $6
       FROM updated`,
      [
        options.segment.id,
        options.segment.revision,
        options.workerId,
        status,
        options.retrySeconds,
        error,
        stage,
        attemptCount
      ]
    );
    return result.rowCount === 1 ? status : "stale_revision";
  }

  private async withTransaction<T>(operation: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    if (!this.pool.connect)
      throw new Error("Archive store requires transaction-capable PostgreSQL");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function mapSegment(row: ArchiveSegmentRow): ArchiveSegment {
  return {
    id: Number(row.id),
    sourceKind: row.source_kind,
    rangeStart: row.range_start.toISOString(),
    rangeEnd: row.range_end.toISOString(),
    revision: row.revision,
    formatVersion: row.format_version,
    compression: row.compression,
    status: row.status,
    notBefore: row.not_before.toISOString(),
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at.toISOString() } : {}),
    exportAttemptCount: row.export_attempt_count,
    verifyAttemptCount: row.verify_attempt_count,
    ...(row.object_key ? { objectKey: row.object_key } : {}),
    ...(row.source_row_count !== null ? { sourceRowCount: Number(row.source_row_count) } : {}),
    ...(row.canonical_metadata_row_count !== null
      ? { canonicalMetadataRowCount: Number(row.canonical_metadata_row_count) }
      : {}),
    ...(row.source_bytes !== null ? { sourceBytes: Number(row.source_bytes) } : {}),
    ...(row.source_sha256 ? { sourceSha256: row.source_sha256 } : {}),
    ...(row.archive_bytes !== null ? { archiveBytes: Number(row.archive_bytes) } : {}),
    ...(row.archive_sha256 ? { archiveSha256: row.archive_sha256 } : {}),
    ...(row.content_md5_base64 ? { contentMd5Base64: row.content_md5_base64 } : {}),
    ...(row.etag ? { etag: row.etag } : {}),
    ...(row.object_version_id ? { objectVersionId: row.object_version_id } : {}),
    ...(row.object_lock_mode ? { objectLockMode: row.object_lock_mode } : {}),
    ...(row.object_lock_evidence
      ? { objectLockEvidence: row.object_lock_evidence }
      : {}),
    ...(row.retain_until ? { retainUntil: row.retain_until.toISOString() } : {}),
    ...(row.uploaded_at ? { uploadedAt: row.uploaded_at.toISOString() } : {}),
    ...(row.verified_at ? { verifiedAt: row.verified_at.toISOString() } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {})
  };
}

function assertArtifact(artifact: ArchiveArtifactManifest): void {
  requirePositiveInteger(artifact.archiveBytes, "archiveBytes");
  if (!Number.isSafeInteger(artifact.sourceBytes) || artifact.sourceBytes < 0) {
    throw new Error("sourceBytes must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(artifact.sourceRowCount) || artifact.sourceRowCount < 0) {
    throw new Error("sourceRowCount must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(artifact.canonicalMetadataRowCount) ||
    artifact.canonicalMetadataRowCount < 0 ||
    artifact.canonicalMetadataRowCount > artifact.sourceRowCount
  ) {
    throw new Error("canonicalMetadataRowCount must be bounded by sourceRowCount");
  }
  if (!SHA256_HEX.test(artifact.sourceSha256) || !SHA256_HEX.test(artifact.archiveSha256)) {
    throw new Error("Archive artifact SHA-256 values must be lowercase hexadecimal digests");
  }
  if (!/^[A-Za-z0-9+/]{22}==$/.test(artifact.contentMd5Base64)) {
    throw new Error("Archive artifact MD5 must be a base64 digest");
  }
  if (!artifact.objectKey) throw new Error("Archive artifact object key is required");
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
}

function requireWorkerId(workerId: string): void {
  if (!workerId || workerId.length > 200) throw new Error("workerId is required and bounded");
}

function boundedError(error: string | undefined): string | null {
  if (!error) return null;
  return error.slice(0, 4_096);
}
