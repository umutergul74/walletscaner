import "dotenv/config";
import pg from "pg";
import { fetchJson } from "@memecoin-alpha/providers";

const SOURCE = "solana-program-discovery";
const APPLY = process.env.CURSOR_CHAIN_TIME_APPLY === "true";
const MAX_ROUNDS = 5;

interface ProgramDefinition {
  programId?: unknown;
}

interface CursorRow {
  address: string;
  last_signature: string;
  last_slot: string | number;
  observed_at: string | Date;
  last_event_occurred_at: string | Date | null;
}

interface BlockTimeResponse {
  result?: number | null;
  error?: { code?: number; message?: string };
}

const databaseUrl = process.env.DATABASE_URL;
const rpcUrl = process.env.SOLANA_RPC_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
if (!rpcUrl) throw new Error("SOLANA_RPC_URL is required.");

const programAddresses = parseProgramAddresses(process.env.SOLANA_POOL_PROGRAMS_JSON);
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });

try {
  let repaired = 0;
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    const rows = await readCursors();
    const byAddress = new Map(rows.map((row) => [row.address, row]));
    const missing = programAddresses.filter((address) => !byAddress.has(address));
    if (missing.length > 0) {
      throw new Error(`Missing durable discovery cursors: ${missing.join(", ")}`);
    }
    const unresolved = rows.filter((row) => row.last_event_occurred_at === null);
    if (unresolved.length === 0) {
      console.log(
        JSON.stringify({
          type: "ingestion-cursor-chain-time",
          mode: APPLY ? "apply" : "dry-run",
          status: "verified",
          source: SOURCE,
          configuredProgramCount: programAddresses.length,
          unresolvedCount: 0,
          repairedCount: repaired,
          rounds: round
        })
      );
      break;
    }

    const plans = [];
    for (const cursor of unresolved) {
      const slot = Number(cursor.last_slot);
      if (!Number.isSafeInteger(slot) || slot < 0) {
        throw new Error(`Invalid cursor slot for ${cursor.address}.`);
      }
      const blockTime = await fetchBlockTime(slot);
      const occurredAt = new Date(blockTime * 1_000);
      const observedAt = new Date(cursor.observed_at);
      if (
        !Number.isFinite(occurredAt.getTime()) ||
        !Number.isFinite(observedAt.getTime()) ||
        occurredAt.getTime() > observedAt.getTime() + 5 * 60_000
      ) {
        throw new Error(`Implausible chain time for ${cursor.address} at slot ${slot}.`);
      }
      plans.push({ cursor, occurredAt: occurredAt.toISOString() });
    }

    if (!APPLY) {
      console.log(
        JSON.stringify({
          type: "ingestion-cursor-chain-time",
          mode: "dry-run",
          status: "repair-required",
          source: SOURCE,
          configuredProgramCount: programAddresses.length,
          unresolvedCount: plans.length,
          plans: plans.map(({ cursor, occurredAt }) => ({
            address: cursor.address,
            slot: Number(cursor.last_slot),
            occurredAt
          }))
        })
      );
      break;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const { cursor, occurredAt } of plans) {
        const updated = await client.query(
          `UPDATE ingestion_cursors
           SET last_event_occurred_at = $5::timestamptz
           WHERE source = $1
             AND address = $2
             AND last_signature = $3
             AND last_slot = $4
             AND last_event_occurred_at IS NULL`,
          [SOURCE, cursor.address, cursor.last_signature, cursor.last_slot, occurredAt]
        );
        repaired += updated.rowCount ?? 0;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    if (round === MAX_ROUNDS) {
      const remaining = (await readCursors()).filter((row) => row.last_event_occurred_at === null);
      if (remaining.length > 0) {
        throw new Error(
          `Discovery cursors kept moving or remained unresolved: ${remaining
            .map((row) => row.address)
            .join(", ")}`
        );
      }
    }
  }
} finally {
  await pool.end();
}

async function readCursors(): Promise<CursorRow[]> {
  const result = await pool.query<CursorRow>(
    `SELECT address, last_signature, last_slot, observed_at, last_event_occurred_at
     FROM ingestion_cursors
     WHERE source = $1
       AND address = ANY($2::text[])
     ORDER BY address`,
    [SOURCE, programAddresses]
  );
  return result.rows;
}

async function fetchBlockTime(slot: number): Promise<number> {
  const response = await fetchJson<BlockTimeResponse>("solana-rpc", rpcUrl!, {
    method: "POST",
    body: { jsonrpc: "2.0", id: 1, method: "getBlockTime", params: [slot] },
    timeoutMs: 10_000,
    retries: 2
  });
  if (response.error) {
    throw new Error(
      `getBlockTime RPC error ${response.error.code ?? "unknown"}: ${response.error.message ?? "unknown error"}`
    );
  }
  if (!Number.isSafeInteger(response.result) || (response.result ?? -1) < 0) {
    throw new Error(`getBlockTime returned no valid timestamp for slot ${slot}.`);
  }
  return response.result!;
}

function parseProgramAddresses(raw: string | undefined): string[] {
  if (!raw) throw new Error("SOLANA_POOL_PROGRAMS_JSON is required.");
  const parsed = JSON.parse(raw) as ProgramDefinition[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("SOLANA_POOL_PROGRAMS_JSON must contain at least one program.");
  }
  const addresses = parsed.map((program) =>
    typeof program.programId === "string" ? program.programId.trim() : ""
  );
  if (addresses.some((address) => !address) || new Set(addresses).size !== addresses.length) {
    throw new Error("SOLANA_POOL_PROGRAMS_JSON contains an invalid or duplicate program id.");
  }
  return addresses;
}
