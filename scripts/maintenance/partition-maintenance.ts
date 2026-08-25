import type pg from "pg";

export interface PartitionEnsureResult {
  existing: number;
  created: number;
  deferred: number;
}

export interface PartitionEnsureOptions {
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  now?: Date;
}

interface PartitionState {
  relation_exists: boolean;
  attached: boolean;
}

/**
 * Precreate the raw-payload partitions without taking parent-table DDL locks
 * during every maintenance cycle. The rare creation path locks the referenced
 * inbox before the payload parent, matching canonical claim order and removing
 * the payload-parent -> inbox side of the former deadlock cycle.
 */
export async function ensurePayloadPartitions(
  pool: pg.Pool,
  futureDays: number,
  options: PartitionEnsureOptions = {}
): Promise<PartitionEnsureResult> {
  const today = utcDayStart(options.now ?? new Date());
  const result = emptyResult();
  for (let offset = -1; offset <= futureDays; offset += 1) {
    const lower = addUtcDays(today, offset);
    const upper = addUtcDays(lower, 1);
    const name = payloadPartitionName(lower);
    const state = await inspectPartition(pool, "chain_event_payloads", name);
    if (state.attached) {
      result.existing += 1;
      continue;
    }
    assertNoOrphanRelation(name, state);
    const created = await createPartitionWithLockOrder(pool, {
      parent: "chain_event_payloads",
      name,
      lower,
      upper,
      lockInboxFirst: true,
      lockTimeoutMs: positiveTimeout(options.lockTimeoutMs, 1_500),
      statementTimeoutMs: positiveTimeout(options.statementTimeoutMs, 5_000)
    });
    if (created) result.created += 1;
    else if ((await inspectPartition(pool, "chain_event_payloads", name)).attached) {
      result.existing += 1;
    } else if (offset <= 0) {
      throw new Error(`Critical payload partition ${name} could not be created safely.`);
    } else {
      result.deferred += 1;
    }
  }
  return result;
}

/** Price partitions have no inbox foreign key, but still avoid repeated DDL. */
export async function ensurePricePartitions(
  pool: pg.Pool,
  futureDays: number,
  options: PartitionEnsureOptions = {}
): Promise<PartitionEnsureResult> {
  const today = utcDayStart(options.now ?? new Date());
  const result = emptyResult();
  for (let offset = 0; offset <= futureDays; offset += 1) {
    const lower = addUtcDays(today, offset);
    const upper = addUtcDays(lower, 1);
    const name = pricePartitionName(lower);
    const state = await inspectPartition(pool, "price_observations", name);
    if (state.attached) {
      result.existing += 1;
      continue;
    }
    assertNoOrphanRelation(name, state);
    const created = await createPartitionWithLockOrder(pool, {
      parent: "price_observations",
      name,
      lower,
      upper,
      lockInboxFirst: false,
      lockTimeoutMs: positiveTimeout(options.lockTimeoutMs, 1_500),
      statementTimeoutMs: positiveTimeout(options.statementTimeoutMs, 5_000),
      afterCreateSql: `ALTER TABLE ${name} SET (
        autovacuum_vacuum_scale_factor = 0.03,
        autovacuum_analyze_scale_factor = 0.02,
        autovacuum_vacuum_threshold = 2000,
        autovacuum_analyze_threshold = 1000
      )`
    });
    if (created) result.created += 1;
    else if ((await inspectPartition(pool, "price_observations", name)).attached) {
      result.existing += 1;
    } else if (offset === 0) {
      throw new Error(`Critical price partition ${name} could not be created safely.`);
    } else {
      result.deferred += 1;
    }
  }
  return result;
}

async function inspectPartition(
  client: Pick<pg.Pool, "query">,
  parent: string,
  child: string
): Promise<PartitionState> {
  const state = await client.query<PartitionState>(
    `SELECT
       to_regclass($2) IS NOT NULL AS relation_exists,
       EXISTS (
         SELECT 1
         FROM pg_inherits
         WHERE inhparent = to_regclass($1)
           AND inhrelid = to_regclass($2)
       ) AS attached`,
    [parent, child]
  );
  return state.rows[0] ?? { relation_exists: false, attached: false };
}

async function createPartitionWithLockOrder(
  pool: pg.Pool,
  input: {
    parent: string;
    name: string;
    lower: Date;
    upper: Date;
    lockInboxFirst: boolean;
    lockTimeoutMs: number;
    statementTimeoutMs: number;
    afterCreateSql?: string;
  }
): Promise<boolean> {
  assertIdentifier(input.parent);
  assertIdentifier(input.name);
  const client = await pool.connect();
  let destroyClient = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('lock_timeout', $1, true)", [`${input.lockTimeoutMs}ms`]);
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      `${input.statementTimeoutMs}ms`
    ]);
    if (input.lockInboxFirst) {
      await client.query("LOCK TABLE chain_event_inbox IN SHARE ROW EXCLUSIVE MODE");
    }
    await client.query(
      `CREATE TABLE ${input.name}
         PARTITION OF ${input.parent}
         FOR VALUES FROM ('${timestampBoundary(input.lower)}')
                    TO ('${timestampBoundary(input.upper)}')`
    );
    if (input.afterCreateSql) await client.query(input.afterCreateSql);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      destroyClient = true;
    }
    if (isBoundedLockFailure(error) || postgresCode(error) === "42P07") return false;
    throw error;
  } finally {
    client.release(destroyClient);
  }
}

function assertNoOrphanRelation(name: string, state: PartitionState): void {
  if (state.relation_exists && !state.attached) {
    throw new Error(`Relation ${name} exists but is not attached to its expected parent.`);
  }
}

function assertIdentifier(value: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${value}`);
  }
}

function emptyResult(): PartitionEnsureResult {
  return { existing: 0, created: 0, deferred: 0 };
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Math.trunc(Number(value)) : fallback;
}

function isBoundedLockFailure(error: unknown): boolean {
  return ["55P03", "57014"].includes(postgresCode(error));
}

function postgresCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "unknown";
}

function payloadPartitionName(date: Date): string {
  return `chain_event_payloads_${date.toISOString().slice(0, 10).replaceAll("-", "")}`;
}

function pricePartitionName(date: Date): string {
  return `price_observations_${date.toISOString().slice(0, 10).replaceAll("-", "")}`;
}

function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1_000);
}

function timestampBoundary(date: Date): string {
  return `${date.toISOString().slice(0, 10)} 00:00:00+00`;
}
