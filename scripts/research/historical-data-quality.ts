import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import pg from "pg";
import { loadRuntimeConfig } from "@memecoin-alpha/config";

interface CountRow {
  market_observation_legs: string;
  market_observations: string;
  unique_tokens: string;
  unique_pairs: string;
  resolved_pools: string;
  unique_traders: string;
  metadata_tokens: string;
  balanced_entries: string;
  repeat_balanced_entries: string;
  mature_fixed: string;
  unresolved_fixed: string;
  earliest_observation: Date | null;
  latest_observation: Date | null;
  observed_days: string;
  high_confidence: string;
  resolved_pool_observations: string;
}

interface DataQualityReport {
  generatedAt: string;
  mode: "historical-data-quality";
  researchOnly: true;
  coverage: {
    marketObservationLegs: number;
    marketObservations: number;
    uniqueTokens: number;
    uniquePairs: number;
    resolvedPools: number;
    uniqueTraders: number;
    metadataTokens: number;
    balancedFlowEntries: number;
    repeatBalancedFlowEntries: number;
    matureFixedOutcomes: number;
    unresolvedFixedOutcomes: number;
    earliestObservation?: string;
    latestObservation?: string;
    observedDays: number;
  };
  quality: {
    highConfidenceObservationRate: number;
    resolvedPoolObservationRate: number;
    matureOutcomeRate: number;
  };
  windowStatus: Array<Record<string, unknown>>;
  priceSources: Array<Record<string, unknown>>;
  dailyCoverage: Array<Record<string, unknown>>;
  leadingPairsByEvidence: Array<Record<string, unknown>>;
  notes: string[];
  reports: string[];
}

const generatedAt = new Date().toISOString();
const config = loadRuntimeConfig();
const pool = new pg.Pool({ connectionString: config.databaseUrl });

const [countsResult, windowResult, sourceResult, dailyResult, pairResult] =
  await Promise.all([
    pool.query<CountRow>(`
      SELECT
        (SELECT COUNT(*) FROM historical_market_observations
         WHERE provider='helius-history') AS market_observation_legs,
        (SELECT COUNT(*) FROM canonical_historical_market_observations
         WHERE provider='helius-history') AS market_observations,
        (SELECT COUNT(DISTINCT token_address) FROM canonical_historical_market_observations
         WHERE provider='helius-history') AS unique_tokens,
        (SELECT COUNT(DISTINCT COALESCE(
           pool_address,
           'unresolved:' || token_address || ':' || quote_token_address
         )) FROM canonical_historical_market_observations
         WHERE provider='helius-history') AS unique_pairs,
        (SELECT COUNT(DISTINCT pool_address) FROM canonical_historical_market_observations
         WHERE provider='helius-history' AND pool_address IS NOT NULL) AS resolved_pools,
        (SELECT COUNT(DISTINCT trader_address) FROM canonical_historical_market_observations
         WHERE provider='helius-history' AND trader_address IS NOT NULL) AS unique_traders,
        (SELECT COUNT(*) FROM tokens
         WHERE metadata ? 'heliusAssetEnrichedAt') AS metadata_tokens,
        (SELECT COUNT(*) FROM wallet_entry_signals
         WHERE provider='helius-history'
           AND flow_evidence->>'balancedFlow'='true') AS balanced_entries,
        (SELECT COUNT(*) FROM wallet_entry_signals
         WHERE provider='helius-history'
           AND cohort='repeat-wallet+balanced-flow') AS repeat_balanced_entries,
        (SELECT COUNT(*)
         FROM wallet_signal_outcomes o
         JOIN wallet_entry_signals e ON e.idempotency_key=o.entry_idempotency_key
         WHERE e.provider='helius-history'
           AND o.exit_strategy='fixed-horizon'
           AND o.status='mature') AS mature_fixed,
        (SELECT COUNT(*)
         FROM wallet_signal_outcomes o
         JOIN wallet_entry_signals e ON e.idempotency_key=o.entry_idempotency_key
         WHERE e.provider='helius-history'
           AND o.exit_strategy='fixed-horizon'
           AND o.status='unresolved') AS unresolved_fixed,
        (SELECT MIN(observed_at) FROM canonical_historical_market_observations
         WHERE provider='helius-history') AS earliest_observation,
        (SELECT MAX(observed_at) FROM canonical_historical_market_observations
         WHERE provider='helius-history') AS latest_observation,
        (SELECT COUNT(DISTINCT observed_at::date) FROM canonical_historical_market_observations
         WHERE provider='helius-history') AS observed_days,
        (SELECT COUNT(*) FROM canonical_historical_market_observations
         WHERE provider='helius-history' AND confidence >= 0.8) AS high_confidence,
        (SELECT COUNT(*) FROM canonical_historical_market_observations
         WHERE provider='helius-history' AND pool_address IS NOT NULL)
          AS resolved_pool_observations
    `),
    pool.query(`
      SELECT run_id, stage, status, COUNT(*)::int AS windows,
             SUM(pages_fetched)::int AS pages,
             SUM(transactions_fetched)::int AS transactions
      FROM historical_backfill_windows
      GROUP BY run_id, stage, status
      ORDER BY run_id, stage, status
    `),
    pool.query(`
      SELECT price_source,
             COUNT(*)::int AS observations,
             COUNT(DISTINCT token_address)::int AS tokens,
             AVG(confidence)::float AS average_confidence
      FROM canonical_historical_market_observations
      WHERE provider='helius-history'
      GROUP BY price_source
      ORDER BY observations DESC
    `),
    pool.query(`
      SELECT observed_at::date::text AS day,
             COUNT(*)::int AS observations,
             COUNT(DISTINCT token_address)::int AS tokens,
             COUNT(DISTINCT trader_address)::int AS traders,
             COUNT(*) FILTER (WHERE confidence >= 0.8)::int AS high_confidence
      FROM canonical_historical_market_observations
      WHERE provider='helius-history'
      GROUP BY observed_at::date
      ORDER BY observed_at::date
    `),
    pool.query(`
      SELECT
        COALESCE(pool_address, 'unresolved:' || token_address || ':' || quote_token_address)
          AS pair_key,
        token_address,
        quote_token_address,
        pool_address,
        COUNT(*)::int AS observations,
        COUNT(DISTINCT trader_address)::int AS traders,
        COUNT(DISTINCT observed_at::date)::int AS days,
        SUM(quote_amount)::float AS volume_quote,
        AVG(confidence)::float AS average_confidence
      FROM canonical_historical_market_observations
      WHERE provider='helius-history'
      GROUP BY token_address, quote_token_address, pool_address
      ORDER BY observations DESC, traders DESC
      LIMIT 50
    `)
  ]);
await pool.end();

const counts = countsResult.rows[0]!;
const marketObservations = Number(counts.market_observations);
const matureFixed = Number(counts.mature_fixed);
const unresolvedFixed = Number(counts.unresolved_fixed);
const report: DataQualityReport = {
  generatedAt,
  mode: "historical-data-quality",
  researchOnly: true,
  coverage: {
    marketObservationLegs: Number(counts.market_observation_legs),
    marketObservations,
    uniqueTokens: Number(counts.unique_tokens),
    uniquePairs: Number(counts.unique_pairs),
    resolvedPools: Number(counts.resolved_pools),
    uniqueTraders: Number(counts.unique_traders),
    metadataTokens: Number(counts.metadata_tokens),
    balancedFlowEntries: Number(counts.balanced_entries),
    repeatBalancedFlowEntries: Number(counts.repeat_balanced_entries),
    matureFixedOutcomes: matureFixed,
    unresolvedFixedOutcomes: unresolvedFixed,
    ...(counts.earliest_observation
      ? { earliestObservation: counts.earliest_observation.toISOString() }
      : {}),
    ...(counts.latest_observation
      ? { latestObservation: counts.latest_observation.toISOString() }
      : {}),
    observedDays: Number(counts.observed_days)
  },
  quality: {
    highConfidenceObservationRate:
      marketObservations > 0 ? Number(counts.high_confidence) / marketObservations : 0,
    resolvedPoolObservationRate:
      marketObservations > 0
        ? Number(counts.resolved_pool_observations) / marketObservations
        : 0,
    matureOutcomeRate:
      matureFixed + unresolvedFixed > 0
        ? matureFixed / (matureFixed + unresolvedFixed)
        : 0
  },
  windowStatus: windowResult.rows,
  priceSources: sourceResult.rows,
  dailyCoverage: dailyResult.rows,
  leadingPairsByEvidence: pairResult.rows,
  notes: [
    "Pair ranking measures evidence volume and trader diversity, not profitability.",
    "SOL-denominated price and volume are authoritative within this dataset; USD values remain estimates until historical SOL/USD is joined.",
    "Saturated windows are sampled but not exhaustive and must not be presented as complete market coverage.",
    "Research and paper mode only. No live-trade decision is produced by this report."
  ],
  reports: [
    "reports/historical-data-quality-latest.json",
    "reports/historical-data-quality-latest.md"
  ]
};

await mkdir("reports", { recursive: true });
await writeFile(
  "reports/historical-data-quality-latest.json",
  JSON.stringify(report, null, 2)
);
await writeFile("reports/historical-data-quality-latest.md", renderMarkdown(report));

console.log(
  JSON.stringify(
    {
      generatedAt,
      coverage: report.coverage,
      quality: report.quality,
      reports: report.reports
    },
    null,
    2
  )
);

function renderMarkdown(value: DataQualityReport): string {
  return [
    "# Historical Data Quality",
    "",
    `Generated: ${value.generatedAt}`,
    "",
    "Research and paper mode only. This is not financial advice.",
    "",
    "## Coverage",
    "",
    `Market observations: ${value.coverage.marketObservations} canonical / ${value.coverage.marketObservationLegs} raw legs`,
    `Unique tokens: ${value.coverage.uniqueTokens}`,
    `Unique pairs: ${value.coverage.uniquePairs}`,
    `Resolved pools: ${value.coverage.resolvedPools}`,
    `Unique traders: ${value.coverage.uniqueTraders}`,
    `Metadata-enriched tokens: ${value.coverage.metadataTokens}`,
    `Balanced-flow entries: ${value.coverage.balancedFlowEntries}`,
    `Repeat-wallet balanced-flow entries: ${value.coverage.repeatBalancedFlowEntries}`,
    `Observed days: ${value.coverage.observedDays}`,
    `Range: ${value.coverage.earliestObservation ?? "none"} to ${value.coverage.latestObservation ?? "none"}`,
    `Mature fixed outcomes: ${value.coverage.matureFixedOutcomes}`,
    `Unresolved fixed outcomes: ${value.coverage.unresolvedFixedOutcomes}`,
    "",
    "## Quality",
    "",
    `High-confidence observation rate: ${formatPercent(value.quality.highConfidenceObservationRate)}`,
    `Resolved-pool observation rate: ${formatPercent(value.quality.resolvedPoolObservationRate)}`,
    `Mature outcome rate: ${formatPercent(value.quality.matureOutcomeRate)}`,
    "",
    "## Price Sources",
    "",
    "| Source | Observations | Tokens | Avg confidence |",
    "|---|---:|---:|---:|",
    ...value.priceSources.map((row) =>
      [
        row.price_source,
        row.observations,
        row.tokens,
        Number(row.average_confidence ?? 0).toFixed(2)
      ].join(" | ")
    ),
    "",
    "## Backfill Windows",
    "",
    "| Run | Stage | Status | Windows | Pages | Transactions |",
    "|---|---|---|---:|---:|---:|",
    ...value.windowStatus.map((row) =>
      [
        row.run_id,
        row.stage,
        row.status,
        row.windows,
        row.pages,
        row.transactions
      ].join(" | ")
    ),
    "",
    "## Notes",
    "",
    ...value.notes.map((note) => `- ${note}`)
  ].join("\n");
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}
