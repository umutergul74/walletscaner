import "dotenv/config";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { parseDatabaseBackupVerificationReceipt } from "@memecoin-alpha/db/immutable-file-archive";

if (process.env.ENABLE_LIVE_EXECUTION?.trim().toLowerCase() !== "false") {
  throw new Error("Derived ledger reclaim requires ENABLE_LIVE_EXECUTION=false");
}
if (
  process.env.DERIVED_LEDGER_RECLAIM_APPROVAL?.trim() !==
  "truncate-derived-ledger-cache-after-verified-b2-backup"
) {
  throw new Error("Explicit derived ledger reclaim approval is required");
}
const databaseUrl = required("DATABASE_URL");
const expectedBackupSha256 = required("ARCHIVE_DATABASE_BACKUP_SHA256").toLowerCase();
const receipt = parseDatabaseBackupVerificationReceipt(
  JSON.parse(await readFile(required("ARCHIVE_DATABASE_BACKUP_VERIFICATION_PATH"), "utf8"))
);
if (receipt.sha256 !== expectedBackupSha256) {
  throw new Error("Derived ledger reclaim receipt does not match the approved backup SHA-256");
}
if (new Date(receipt.retainUntil).getTime() < Date.now() + 7 * 86_400_000) {
  throw new Error("Derived ledger reclaim backup has insufficient Object Lock reserve");
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, statement_timeout: 30_000 });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL max_parallel_workers_per_gather = 0");
  await client.query("SELECT pg_advisory_xact_lock(874213401)");
  const preflight = await client.query<{
    trade_rows: string;
    episode_rows: string;
    lot_rows: string;
    episode_bytes: string;
    lot_bytes: string;
    qualified_wallets: string;
  }>(
    `WITH latest_scores AS MATERIALIZED (
       SELECT DISTINCT ON (strategy_version, chain, wallet_address) status
       FROM wallet_alpha_scores
       ORDER BY strategy_version, chain, wallet_address, calculated_at DESC
     )
     SELECT
       (SELECT COUNT(*) FROM wallet_trade_events)::text AS trade_rows,
       (SELECT COUNT(*) FROM wallet_position_episodes)::text AS episode_rows,
       (SELECT COUNT(*) FROM wallet_position_lots)::text AS lot_rows,
       pg_total_relation_size('wallet_position_episodes'::regclass)::text AS episode_bytes,
       pg_total_relation_size('wallet_position_lots'::regclass)::text AS lot_bytes,
       COUNT(*) FILTER (WHERE status IN ('watch','candidate','validated-paper'))::text
         AS qualified_wallets
     FROM latest_scores`
  );
  const before = preflight.rows[0];
  if (!before || Number(before.trade_rows) <= 0) {
    throw new Error("Canonical wallet trade source is empty; refusing ledger reclaim");
  }
  if (Number(before.qualified_wallets) !== 0) {
    throw new Error("Qualified wallets exist; refusing bulk derived-ledger reclaim");
  }

  await client.query("TRUNCATE TABLE wallet_position_lots, wallet_position_episodes");
  const requeued = await client.query(
    `WITH latest_scores AS MATERIALIZED (
       SELECT DISTINCT ON (strategy_version, chain, wallet_address)
         strategy_version, chain, wallet_address, status
       FROM wallet_alpha_scores
       ORDER BY strategy_version, chain, wallet_address, calculated_at DESC
     )
     UPDATE wallet_alpha_work_queue AS work
     SET revision = work.revision + 1,
         not_before = NOW(),
         locked_by = NULL,
         locked_at = NULL,
         lock_expires_at = NULL,
         last_error = NULL
     FROM latest_scores AS score
     WHERE score.status = 'observed'
       AND work.strategy_version = score.strategy_version
       AND work.chain = score.chain
       AND work.wallet_address = score.wallet_address`
  );
  await client.query("COMMIT");
  console.log(
    JSON.stringify({
      type: "derived-ledger-reclaim",
      status: "completed",
      backupSha256: receipt.sha256,
      backupVerifiedAt: receipt.verifiedAt,
      before: {
        tradeRows: Number(before.trade_rows),
        episodeRows: Number(before.episode_rows),
        lotRows: Number(before.lot_rows),
        episodeBytes: Number(before.episode_bytes),
        lotBytes: Number(before.lot_bytes),
        qualifiedWallets: Number(before.qualified_wallets)
      },
      requeuedObservedWallets: requeued.rowCount ?? 0
    })
  );
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
