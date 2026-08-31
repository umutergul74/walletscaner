import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { PostgresRepository } from "@memecoin-alpha/db";
import {
  advanceWalletLedger,
  buildWalletAlphaScores,
  buildWalletLedger,
  walletLedgerCheckpointOrder,
  type WalletLedger
} from "@memecoin-alpha/core";
import type { WalletTradeEvidence } from "@memecoin-alpha/shared";

const databaseUrl = process.env.DATABASE_URL;
const walletAddress = process.argv[2];
const strategyVersion = process.argv[3] ?? "evidence-v1";
const suffixCount = positiveInt(process.argv[4], 100);
const maximumTrades = positiveInt(process.env.WALLET_FIFO_BENCHMARK_MAX_TRADES, 10_000);

if (!databaseUrl) throw new Error("DATABASE_URL is required.");
if (!walletAddress) {
  throw new Error(
    "Usage: tsx scripts/test/benchmark-wallet-fifo-populated.ts <wallet> [strategy] [suffix]"
  );
}
const parsedUrl = new URL(databaseUrl);
if (
  !["127.0.0.1", "localhost", "::1"].includes(parsedUrl.hostname) ||
  !parsedUrl.pathname.slice(1).startsWith("walletscaner_populated_")
) {
  throw new Error("Populated FIFO benchmark refuses non-local or non-validation databases.");
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 2,
  application_name: "walletscaner-populated-fifo-benchmark"
});
const repository = new PostgresRepository(pool);

try {
  const fullReadStarted = performance.now();
  const trades = await repository.listWalletTradeLedgerInputsForWallets(
    [walletAddress],
    strategyVersion,
    undefined,
    maximumTrades + 1
  );
  const fullReadMs = performance.now() - fullReadStarted;
  if (trades.length === 0) throw new Error(`No trades found for ${walletAddress}.`);
  if (trades.length > maximumTrades) {
    throw new Error(`Wallet ${walletAddress} exceeds safety limit ${maximumTrades}.`);
  }
  if (trades.length <= suffixCount) {
    throw new Error(`Wallet ${walletAddress} needs more than ${suffixCount} trades.`);
  }
  const ordered = [...trades].sort(compareTradeOrder);
  const prefix = ordered.slice(0, -suffixCount);
  const expectedSuffix = ordered.slice(-suffixCount);

  const fullBuildStarted = performance.now();
  const fullLedger = buildWalletLedger(ordered);
  const fullBuildMs = performance.now() - fullBuildStarted;

  const prefixBuildStarted = performance.now();
  const first = advanceWalletLedger(prefix);
  const prefixBuildMs = performance.now() - prefixBuildStarted;
  const boundary = walletLedgerCheckpointOrder(first.checkpoint);

  const suffixReadStarted = performance.now();
  const suffix = await repository.listWalletTradeLedgerInputsAfter(
    "solana",
    walletAddress,
    strategyVersion,
    boundary,
    maximumTrades
  );
  const suffixReadMs = performance.now() - suffixReadStarted;
  assert.deepEqual(
    suffix.map((trade) => trade.idempotencyKey),
    expectedSuffix.map((trade) => trade.idempotencyKey),
    "Exact PostgreSQL suffix differs from the full-reader boundary."
  );

  const suffixBuildStarted = performance.now();
  const second = advanceWalletLedger(suffix, first.checkpoint);
  const suffixBuildMs = performance.now() - suffixBuildStarted;
  const continuedLedger = mergeDeltas([first.ledger, second.ledger]);
  assert.deepEqual(
    normalized(continuedLedger),
    normalized(fullLedger),
    "Continuation ledger differs from a full rebuild."
  );

  const [entries, outcomes] = await Promise.all([
    repository.listWalletEntrySignalsForWallets(
      [walletAddress],
      strategyVersion,
      undefined,
      maximumTrades
    ),
    repository.listWalletSignalOutcomesForWallets(
      [walletAddress],
      strategyVersion,
      undefined,
      maximumTrades
    )
  ]);
  const calculatedAt = "2026-08-29T23:59:59.999Z";
  const scoreInput = { entries, outcomes, strategyVersion, calculatedAt, trades: [] };
  const fullScoreStarted = performance.now();
  const fullScore = buildWalletAlphaScores({
    ...scoreInput,
    prebuiltLedgers: new Map([[walletAddress, fullLedger]])
  });
  const fullScoreMs = performance.now() - fullScoreStarted;
  const continuedScoreStarted = performance.now();
  const continuedScore = buildWalletAlphaScores({
    ...scoreInput,
    prebuiltLedgers: new Map([[walletAddress, continuedLedger]])
  });
  const continuedScoreMs = performance.now() - continuedScoreStarted;
  assert.deepEqual(continuedScore, fullScore, "Continuation score differs from a full rebuild.");

  console.log(
    JSON.stringify({
      type: "wallet-fifo-populated-benchmark",
      database: parsedUrl.pathname.slice(1),
      walletAddress,
      strategyVersion,
      tradeCount: ordered.length,
      prefixCount: prefix.length,
      suffixCount: suffix.length,
      entryCount: entries.length,
      outcomeCount: outcomes.length,
      realizationCount: fullLedger.realizedEpisodes.length,
      openMarketCount: fullLedger.openInventory.length,
      checkpointBytes: Buffer.byteLength(first.checkpoint.payload),
      parity: {
        ledger: true,
        score: true,
        ledgerSha256: sha256(normalized(fullLedger)),
        scoreSha256: sha256(fullScore)
      },
      timingsMs: rounded({
        fullRead: fullReadMs,
        fullBuild: fullBuildMs,
        prefixBuild: prefixBuildMs,
        suffixRead: suffixReadMs,
        suffixBuild: suffixBuildMs,
        fullScore: fullScoreMs,
        continuedScore: continuedScoreMs
      }),
      memoryMiB: rounded({
        rss: process.memoryUsage().rss / 1024 / 1024,
        heapUsed: process.memoryUsage().heapUsed / 1024 / 1024
      })
    })
  );
} finally {
  await pool.end();
}

function mergeDeltas(ledgers: WalletLedger[]): WalletLedger {
  const realized = new Map(
    ledgers.flatMap((ledger) =>
      ledger.realizedEpisodes.map((position) => [position.episodeId, position] as const)
    )
  );
  const episodes = new Map(
    ledgers.flatMap((ledger) =>
      ledger.positionEpisodes.map((episode) => [episode.episodeId, episode] as const)
    )
  );
  const lots = new Map(
    ledgers.flatMap((ledger) => ledger.positionLots.map((lot) => [lot.lotId, lot] as const))
  );
  return {
    realizedEpisodes: [...realized.values()],
    openInventory: ledgers.at(-1)!.openInventory,
    positionEpisodes: [...episodes.values()],
    positionLots: [...lots.values()]
  };
}

function normalized(ledger: WalletLedger) {
  return {
    realizedEpisodes: [...ledger.realizedEpisodes].sort(compareBy("episodeId")),
    openInventory: [...ledger.openInventory].sort(compareBy("tokenAddress")),
    positionEpisodes: [...ledger.positionEpisodes].sort(compareBy("episodeId")),
    positionLots: [...ledger.positionLots].sort(compareBy("lotId"))
  };
}

function compareTradeOrder(a: WalletTradeEvidence, b: WalletTradeEvidence): number {
  return (
    a.slot - b.slot ||
    Date.parse(a.observedAt) - Date.parse(b.observedAt) ||
    compareString(a.signature, b.signature) ||
    compareString(a.idempotencyKey, b.idempotencyKey)
  );
}

function compareBy<Key extends string>(key: Key) {
  return (a: Record<Key, string>, b: Record<Key, string>) => compareString(a[key], b[key]);
}

function compareString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function rounded<T extends Record<string, number>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).map(([key, number]) => [key, Math.round(number * 100) / 100])
  ) as T;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
