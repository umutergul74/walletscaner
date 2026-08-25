import "dotenv/config";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { parseDatabaseBackupVerificationReceipt } from "@memecoin-alpha/db/immutable-file-archive";
import { reclaimDerivedLedgerCache } from "./derived-ledger-reclaim-core.js";

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
  const result = await reclaimDerivedLedgerCache(client);
  console.log(
    JSON.stringify({
      type: "derived-ledger-reclaim",
      status: "completed",
      backupSha256: receipt.sha256,
      backupVerifiedAt: receipt.verifiedAt,
      before: {
        tradeSourcePresent: result.tradeSourcePresent,
        episodeRowsEstimate: result.episodeRowsEstimate,
        lotRowsEstimate: result.lotRowsEstimate,
        episodeBytes: result.episodeBytes,
        lotBytes: result.lotBytes,
        qualifiedWallets: result.qualifiedWallets,
      },
      requeuedObservedWallets: result.requeuedObservedWallets,
    })
  );
} finally {
  client.release();
  await pool.end();
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
