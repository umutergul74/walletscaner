import pg from "pg";

export interface PayloadPartitionRetirementResult {
  partitions: number;
  heldPayloads: number;
  blockedPartitions: number;
  runtimeEnabled: boolean;
  policyReady: boolean;
}

export interface ArchiveRetirementPolicyStatus {
  ready: boolean;
  activatedAt?: string;
  futureCanaryRangeStart?: string;
  retirementEnabledAt?: string;
}

/**
 * Retires whole raw-payload partitions only while the matching independently
 * restored archive is still protected by Object Lock. Unresolved payloads are
 * copied into the bounded hold table in the same transaction as the DROP.
 */
export async function retireVerifiedPayloadPartitions(
  pool: pg.Pool,
  retentionHours: number,
  runtimeEnabled = false,
  minimumArchiveRemainingDays = 7
): Promise<PayloadPartitionRetirementResult> {
  if (!Number.isSafeInteger(retentionHours) || retentionHours <= 0) {
    throw new Error("Payload partition retention hours must be positive");
  }
  if (!Number.isSafeInteger(minimumArchiveRemainingDays) || minimumArchiveRemainingDays <= 0) {
    throw new Error("Minimum archive retention days must be positive");
  }
  const result = await pool.query<{ relname: string }>(
    `SELECT child.relname
     FROM pg_inherits
     JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
     JOIN pg_class child ON child.oid = pg_inherits.inhrelid
     WHERE parent.oid = 'chain_event_payloads'::regclass
     ORDER BY child.relname`
  );
  const policy = await archiveRetirementPolicyStatus(pool, minimumArchiveRemainingDays);
  let partitions = 0;
  let heldPayloads = 0;
  let blockedPartitions = 0;
  for (const row of result.rows) {
    const lower = payloadPartitionDate(row.relname);
    if (!lower || !payloadPartitionOutsideHotWindow(row.relname, retentionHours)) continue;
    if (!runtimeEnabled || !policy.ready) {
      blockedPartitions += 1;
      continue;
    }
    const partition = pg.escapeIdentifier(row.relname);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const archive = await client.query(
        `SELECT id
         FROM archive_segments
         WHERE source_kind = 'chain-event-payloads'
           AND range_start = $1
           AND range_end = $2
           AND status = 'verified'
           AND object_lock_evidence IN ('api-verified', 'attested-default-policy')
           AND retain_until > NOW() + make_interval(days => $3::integer)
         FOR SHARE`,
        [
          lower.toISOString(),
          addUtcDays(lower, 1).toISOString(),
          minimumArchiveRemainingDays
        ]
      );
      if (archive.rowCount !== 1) {
        await client.query("ROLLBACK");
        blockedPartitions += 1;
        continue;
      }
      const held = await client.query(
        `INSERT INTO chain_event_payload_holds (
           event_idempotency_key, received_at, payload, payload_sha256
         )
         SELECT payload.event_idempotency_key, payload.received_at,
                payload.payload, payload.payload_sha256
         FROM ${partition} AS payload
         JOIN chain_event_inbox AS event
           ON event.idempotency_key = payload.event_idempotency_key
         WHERE event.status NOT IN ('processed', 'rolled_back')
         ON CONFLICT (event_idempotency_key) DO NOTHING`
      );
      await client.query(`DROP TABLE ${partition}`);
      await client.query("COMMIT");
      partitions += 1;
      heldPayloads += held.rowCount ?? 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  return {
    partitions,
    heldPayloads,
    blockedPartitions,
    runtimeEnabled,
    policyReady: policy.ready
  };
}

export function payloadPartitionOutsideHotWindow(
  partitionName: string,
  retentionHours: number,
  now = new Date()
): boolean {
  if (!Number.isSafeInteger(retentionHours) || retentionHours <= 0) {
    throw new Error("Payload partition retention hours must be positive");
  }
  const lower = payloadPartitionDate(partitionName);
  if (!lower) return false;
  const partitionEnd = addUtcDays(lower, 1);
  return partitionEnd.getTime() <= now.getTime() - retentionHours * 3_600_000;
}

export async function archiveRetirementPolicyStatus(
  pool: pg.Pool,
  minimumArchiveRemainingDays = 1
): Promise<ArchiveRetirementPolicyStatus> {
  if (!Number.isSafeInteger(minimumArchiveRemainingDays) || minimumArchiveRemainingDays <= 0) {
    throw new Error("Minimum archive retention days must be positive");
  }
  const result = await pool.query<{
    ready: boolean;
    activated_at: Date | null;
    future_canary_range_start: Date | null;
    retirement_enabled_at: Date | null;
  }>(
    `SELECT
       archive_retirement_policy_ready($1::integer) AS ready,
       policy.activated_at,
       segment.range_start AS future_canary_range_start,
       policy.retirement_enabled_at
     FROM archive_retirement_policies AS policy
     LEFT JOIN archive_segments AS segment
       ON segment.id = policy.future_canary_segment_id
     WHERE policy.source_kind = 'chain-event-payloads'`,
    [minimumArchiveRemainingDays]
  );
  const row = result.rows[0];
  if (!row) return { ready: false };
  return {
    ready: row.ready,
    ...(row.activated_at ? { activatedAt: row.activated_at.toISOString() } : {}),
    ...(row.future_canary_range_start
      ? { futureCanaryRangeStart: row.future_canary_range_start.toISOString() }
      : {}),
    ...(row.retirement_enabled_at
      ? { retirementEnabledAt: row.retirement_enabled_at.toISOString() }
      : {})
  };
}

function payloadPartitionDate(name: string): Date | undefined {
  const match = /^chain_event_payloads_(\d{4})(\d{2})(\d{2})$/.exec(name);
  if (!match) return undefined;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}
