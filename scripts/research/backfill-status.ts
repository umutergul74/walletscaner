import "dotenv/config";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { loadRuntimeConfig } from "@memecoin-alpha/config";

interface BackfillProgressSnapshot {
  runId: string;
  status: "running" | "partial" | "completed" | "paused-credit-budget" | "error";
  generatedAt: string;
  updatedAt: string;
  window?: {
    startTime: string;
    endTime: string;
  };
  totals?: {
    pagesFetched: number;
    transactionsFetched: number;
    insertedPriceObservations: number;
    insertedMarketObservations?: number;
    insertedSwaps: number;
    insertedWalletEntries: number;
    windowsCompleted?: number;
    windowsSaturated?: number;
  };
  creditUsage?: {
    budget: number;
    estimatedUsed: number;
    remaining: number;
  };
  current?: Record<string, unknown>;
  error?: string;
}

interface BackfillStatusReport {
  generatedAt: string;
  database: {
    heliusPrices: number;
    heliusSwaps: number;
    heliusEntries: number;
    heliusMatureFixed: number;
    heliusMaturePaperExit: number;
    heliusCursors: number;
    marketObservationLegs: number;
    marketObservations: number;
    marketBuckets5m: number;
    uniqueTokens: number;
    uniqueWallets: number;
    metadataEnrichedTokens: number;
    observedDays: number;
    earliestObservation?: string;
    latestObservation?: string;
    completedWindows: number;
    saturatedWindows: number;
    runningWindows: number;
    errorWindows: number;
  };
  progressFiles: BackfillProgressSnapshot[];
  latestDecision: {
    mode?: string;
    methodDecision?: string;
    passedCandidates?: number;
  };
  reports: string[];
}

type JsonRecord = Record<string, unknown>;

const generatedAt = new Date().toISOString();
const config = loadRuntimeConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });

const [counts, progressFiles, latestDecision] = await Promise.all([
  readCounts(),
  readProgressFiles(),
  readLatestDecision()
]);
await pool.end();

const report: BackfillStatusReport = {
  generatedAt,
  database: counts,
  progressFiles,
  latestDecision,
  reports: [
    "reports/backfill-status-latest.json",
    "reports/backfill-status-latest.md"
  ]
};

await mkdir("reports", { recursive: true });
await writeFile("reports/backfill-status-latest.json", JSON.stringify(report, null, 2));
await writeFile("reports/backfill-status-latest.md", renderMarkdown(report));

console.log(
  JSON.stringify(
    {
      generatedAt,
      database: report.database,
      latestRun: report.progressFiles[0]
        ? {
            runId: report.progressFiles[0].runId,
            status: report.progressFiles[0].status,
            updatedAt: report.progressFiles[0].updatedAt,
            totals: report.progressFiles[0].totals
          }
        : null,
      latestDecision: report.latestDecision,
      reports: report.reports
    },
    null,
    2
  )
);

async function readCounts(): Promise<BackfillStatusReport["database"]> {
  const result = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM price_observations WHERE provider='helius-history') AS helius_prices,
      (SELECT COUNT(*)::int FROM swaps WHERE provider='helius-history') AS helius_swaps,
      (SELECT COUNT(*)::int FROM wallet_entry_signals WHERE provider='helius-history') AS helius_entries,
      (SELECT COUNT(*)::int
       FROM wallet_signal_outcomes o
       JOIN wallet_entry_signals e ON e.idempotency_key=o.entry_idempotency_key
       WHERE e.provider='helius-history'
         AND o.status='mature'
         AND o.exit_strategy='fixed-horizon') AS helius_mature_fixed,
      (SELECT COUNT(*)::int
       FROM wallet_signal_outcomes o
       JOIN wallet_entry_signals e ON e.idempotency_key=o.entry_idempotency_key
       WHERE e.provider='helius-history'
         AND o.status='mature'
         AND o.exit_strategy='tp15-sl20-20m') AS helius_mature_paper_exit,
      (SELECT COUNT(*)::int FROM ingestion_cursors WHERE source LIKE 'helius-history-%') AS helius_cursors
      ,
      (SELECT COUNT(*)::int FROM historical_market_observations
       WHERE provider='helius-history') AS market_observation_legs,
      (SELECT COUNT(*)::int FROM canonical_historical_market_observations
       WHERE provider='helius-history') AS market_observations,
      (SELECT COUNT(*)::int FROM historical_market_buckets
       WHERE interval_minutes=5) AS market_buckets_5m,
      (SELECT COUNT(DISTINCT token_address)::int FROM canonical_historical_market_observations
       WHERE provider='helius-history') AS unique_tokens,
      (SELECT COUNT(DISTINCT wallet_address)::int FROM wallet_entry_signals
       WHERE provider='helius-history') AS unique_wallets,
      (SELECT COUNT(*)::int FROM tokens
       WHERE metadata ? 'heliusAssetEnrichedAt') AS metadata_enriched_tokens,
      (SELECT COUNT(DISTINCT observed_at::date)::int FROM canonical_historical_market_observations
       WHERE provider='helius-history') AS observed_days,
      (SELECT MIN(observed_at) FROM canonical_historical_market_observations
       WHERE provider='helius-history') AS earliest_observation,
      (SELECT MAX(observed_at) FROM canonical_historical_market_observations
       WHERE provider='helius-history') AS latest_observation,
      (SELECT COUNT(*)::int FROM historical_backfill_windows
       WHERE status='completed') AS completed_windows,
      (SELECT COUNT(*)::int FROM historical_backfill_windows
       WHERE status='saturated') AS saturated_windows,
      (SELECT COUNT(*)::int FROM historical_backfill_windows
       WHERE status='running') AS running_windows,
      (SELECT COUNT(*)::int FROM historical_backfill_windows
       WHERE status='error') AS error_windows
  `);
  const row = result.rows[0] as Record<string, unknown>;
  return {
    heliusPrices: Number(row.helius_prices ?? 0),
    heliusSwaps: Number(row.helius_swaps ?? 0),
    heliusEntries: Number(row.helius_entries ?? 0),
    heliusMatureFixed: Number(row.helius_mature_fixed ?? 0),
    heliusMaturePaperExit: Number(row.helius_mature_paper_exit ?? 0),
    heliusCursors: Number(row.helius_cursors ?? 0),
    marketObservationLegs: Number(row.market_observation_legs ?? 0),
    marketObservations: Number(row.market_observations ?? 0),
    marketBuckets5m: Number(row.market_buckets_5m ?? 0),
    uniqueTokens: Number(row.unique_tokens ?? 0),
    uniqueWallets: Number(row.unique_wallets ?? 0),
    metadataEnrichedTokens: Number(row.metadata_enriched_tokens ?? 0),
    observedDays: Number(row.observed_days ?? 0),
    ...(row.earliest_observation
      ? { earliestObservation: new Date(String(row.earliest_observation)).toISOString() }
      : {}),
    ...(row.latest_observation
      ? { latestObservation: new Date(String(row.latest_observation)).toISOString() }
      : {}),
    completedWindows: Number(row.completed_windows ?? 0),
    saturatedWindows: Number(row.saturated_windows ?? 0),
    runningWindows: Number(row.running_windows ?? 0),
    errorWindows: Number(row.error_windows ?? 0)
  };
}

async function readProgressFiles(): Promise<BackfillProgressSnapshot[]> {
  const dir = "reports/backfills";
  try {
    const files = await readdir(dir);
    const snapshots = await Promise.all(
      files
        .filter((file) => file.endsWith("-progress.json"))
        .map(async (file) => {
          const raw = await readFile(join(dir, file), "utf8");
          return JSON.parse(raw) as BackfillProgressSnapshot;
        })
    );
    return snapshots.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  } catch {
    return [];
  }
}

async function readLatestDecision(): Promise<BackfillStatusReport["latestDecision"]> {
  const [evidence, search] = await Promise.all([
    readJsonIfExists("reports/evidence-latest.json"),
    readJsonIfExists("reports/evidence-strategy-search-latest.json")
  ]);
  const decision: BackfillStatusReport["latestDecision"] = {};
  const mode = stringValue(evidence?.mode) ?? stringValue(nestedValue(evidence, "decisionStatus", "recommendedMode"));
  const methodDecision = stringValue(search?.methodDecision);
  if (mode) decision.mode = mode;
  if (methodDecision) decision.methodDecision = methodDecision;
  if (Array.isArray(search?.passedCandidates)) {
    decision.passedCandidates = search.passedCandidates.length;
  }
  return decision;
}

async function readJsonIfExists(path: string): Promise<JsonRecord | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as JsonRecord;
  } catch {
    return undefined;
  }
}

function nestedValue(record: JsonRecord | undefined, key: string, nestedKey: string): unknown {
  const nested = record?.[key];
  return typeof nested === "object" && nested !== null
    ? (nested as JsonRecord)[nestedKey]
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function renderMarkdown(report: BackfillStatusReport): string {
  return [
    "# Backfill Status",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "Research and paper mode only. This is not financial advice.",
    "",
    "## Database",
    "",
    `Helius prices: ${report.database.heliusPrices}`,
    `Helius swaps: ${report.database.heliusSwaps}`,
    `Helius wallet entries: ${report.database.heliusEntries}`,
    `Helius mature fixed-horizon: ${report.database.heliusMatureFixed}`,
    `Helius mature paper-exit: ${report.database.heliusMaturePaperExit}`,
    `Helius cursors: ${report.database.heliusCursors}`,
    `SOL-based market observations: ${report.database.marketObservations} canonical / ${report.database.marketObservationLegs} raw legs`,
    `5m market buckets: ${report.database.marketBuckets5m}`,
    `Unique tokens: ${report.database.uniqueTokens}`,
    `Unique wallets: ${report.database.uniqueWallets}`,
    `Metadata-enriched tokens: ${report.database.metadataEnrichedTokens}`,
    `Observed calendar days: ${report.database.observedDays}`,
    `Observation range: ${report.database.earliestObservation ?? "none"} to ${report.database.latestObservation ?? "none"}`,
    `Backfill windows: ${report.database.completedWindows} completed / ${report.database.saturatedWindows} saturated / ${report.database.runningWindows} running / ${report.database.errorWindows} error`,
    "",
    "## Latest Decision",
    "",
    `Mode: ${report.latestDecision.mode ?? "unknown"}`,
    `Strategy search: ${report.latestDecision.methodDecision ?? "unknown"}`,
    `Passed candidates: ${report.latestDecision.passedCandidates ?? 0}`,
    "",
    "## Backfill Runs",
    "",
    "| Run | Status | Updated | Txs | Prices | Market | Swaps | Entries | Credit |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|",
    ...report.progressFiles.slice(0, 20).map((progress) =>
      [
        progress.runId,
        progress.status,
        progress.updatedAt,
        progress.totals?.transactionsFetched ?? 0,
        progress.totals?.insertedPriceObservations ?? 0,
        progress.totals?.insertedMarketObservations ?? 0,
        progress.totals?.insertedSwaps ?? 0,
        progress.totals?.insertedWalletEntries ?? 0,
        progress.creditUsage?.estimatedUsed ?? 0
      ].join(" | ")
    )
  ].join("\n");
}
