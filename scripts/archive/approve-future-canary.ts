import "dotenv/config";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for archive retirement approval");

const approval = process.env.ARCHIVE_RETIREMENT_APPROVAL?.trim();
if (approval !== "approve-future-only-chain-payload-retirement") {
  throw new Error("Explicit ARCHIVE_RETIREMENT_APPROVAL is required");
}

const canaryDay = process.env.ARCHIVE_FUTURE_CANARY_DAY?.trim();
if (!canaryDay || !/^\d{4}-\d{2}-\d{2}$/.test(canaryDay)) {
  throw new Error("ARCHIVE_FUTURE_CANARY_DAY must be YYYY-MM-DD");
}
const parsedDay = new Date(`${canaryDay}T00:00:00.000Z`);
if (Number.isNaN(parsedDay.getTime()) || parsedDay.toISOString().slice(0, 10) !== canaryDay) {
  throw new Error("ARCHIVE_FUTURE_CANARY_DAY is not a valid UTC calendar day");
}

const minimumRemainingDays = positiveInt(
  process.env.ARCHIVE_OBJECT_LOCK_MIN_REMAINING_DAYS,
  7
);
const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, statement_timeout: 15_000 });

try {
  const result = await pool.query<{ segment_id: string }>(
    `SELECT approve_chain_event_payload_retirement($1, $2)::text AS segment_id`,
    [parsedDay.toISOString(), minimumRemainingDays]
  );
  console.log(
    JSON.stringify({
      type: "archive-retirement-approval",
      status: "approved",
      canaryDay,
      segmentId: result.rows[0]?.segment_id,
      minimumRemainingDays,
      approvedAt: new Date().toISOString()
    })
  );
} finally {
  await pool.end();
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}
