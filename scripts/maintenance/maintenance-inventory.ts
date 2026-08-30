import type pg from "pg";

export interface MaintenanceProbe {
  key: string;
  sql: string;
  parameters?: unknown[];
}

export interface MaintenanceInventory {
  values: Record<string, boolean | null>;
  timedOut: string[];
  deferred: string[];
}

/** Advisory inventory is not a deletion gate. Each probe has its own read-only transaction;
 * one expensive EXISTS must not prevent independent bounded retention jobs from running. */
export async function collectMaintenanceProbes(
  pool: pg.Pool,
  probes: MaintenanceProbe[],
  options: { budgetMs: number; probeTimeoutMs: number; now?: () => number }
): Promise<MaintenanceInventory> {
  if (
    !Number.isFinite(options.budgetMs) ||
    options.budgetMs <= 0 ||
    !Number.isFinite(options.probeTimeoutMs) ||
    options.probeTimeoutMs <= 0 ||
    probes.length > 16 ||
    new Set(probes.map((probe) => probe.key)).size !== probes.length
  )
    throw new Error("Invalid maintenance inventory budget or probe set");
  const now = options.now ?? Date.now;
  const deadline = now() + Math.min(5_000, options.budgetMs);
  const result: MaintenanceInventory = { values: {}, timedOut: [], deferred: [] };
  for (const probe of probes) {
    result.values[probe.key] = null;
    const remaining = Math.floor(deadline - now());
    if (remaining <= 0) {
      result.deferred.push(probe.key);
      continue;
    }
    const client = await pool.connect();
    let destroy = false;
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SELECT set_config('statement_timeout', $1, true)", [
        `${Math.max(1, Math.min(1_000, options.probeTimeoutMs, remaining))}ms`
      ]);
      const observed = await client.query<{ eligible: boolean }>(probe.sql, probe.parameters);
      if (typeof observed.rows[0]?.eligible !== "boolean") {
        throw new Error("Maintenance inventory returned invalid evidence");
      }
      await client.query("COMMIT");
      result.values[probe.key] = observed.rows[0].eligible;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        destroy = true;
      }
      if (
        !destroy &&
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "57014"
      ) {
        result.timedOut.push(probe.key);
      } else {
        throw error;
      }
    } finally {
      client.release(destroy);
    }
  }
  return result;
}

export function payloadCompactionHasPriority(inventory: MaintenanceInventory): boolean {
  // Unknown is not proof of spare capacity for competing inbox retirement.
  return inventory.values.chain_event_payloads_overdue !== false;
}
