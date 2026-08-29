import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "pg";
import {
  CONTEXTUAL_SURVIVAL_V1,
  buildContextualSurvivalAudit,
  type ContextualSupporter,
  type ContextualSurvivalAudit,
  type ContextualSurvivalPolicyStats,
  type ContextualSurvivalRecord,
  type ContextualSurvivalWindowStats
} from "./contextual-survival-v1-builder.js";

interface MarketRow {
  token_address: string;
  pool_address: string;
  dex: string | null;
  observed_at: Date;
  frozen_at: Date;
  net_return_pct: string;
  estimated_round_trip_cost_pct: string;
  rugged: boolean;
  controlled_flow: boolean;
  token_risk_known: boolean;
  token_risk_passed: boolean;
  mint_authority_revoked: boolean;
  freeze_authority_revoked: boolean;
  liquidity_usd: string;
  volume_5m_usd: string;
  transactions_5m: number;
  buy_share_5m: string;
  volume_liquidity_ratio: string;
  pool_age_minutes: string;
  top10_holder_percent: string;
  supporters: ContextualSupporter[];
}

interface AuditReport {
  generatedAt: string;
  strategyVersion: typeof CONTEXTUAL_SURVIVAL_V1;
  source: {
    databaseMode: string;
    outcomeContract: string;
    supporterContract: string;
    recordCount: number;
    firstDecisionAt: string | null;
    lastDecisionAt: string | null;
    decisionHash: string;
  };
  audit: ContextualSurvivalAudit;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the contextual survival audit.");
  }

  const client = new Client({
    connectionString: databaseUrl,
    application_name: "contextual-survival-v1-audit"
  });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '240s'");
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL max_parallel_workers_per_gather = 0");
    const result = await client.query<MarketRow>(marketSql);
    await client.query("COMMIT");

    const records = result.rows.map(mapMarketRow);
    const audit = buildContextualSurvivalAudit(records);
    const generatedAt = new Date().toISOString();
    const report: AuditReport = {
      generatedAt,
      strategyVersion: CONTEXTUAL_SURVIVAL_V1,
      source: {
        databaseMode: "read-only restored PostgreSQL 16 dump",
        outcomeContract:
          "First source-linked evidence-v1 entry per exact pool at age >=5m, with a mature tp15-sl20-20m outcome; outcome is admitted to learning only after frozen_at.",
        supporterContract:
          "Distinct non-creator, non-pool wallet entries in the same exact pool during the ten minutes up to the decision; wallet identifiers are used in memory and never written to this report.",
        recordCount: records.length,
        firstDecisionAt: audit.decisions[0]?.observedAt ?? null,
        lastDecisionAt: audit.decisions.at(-1)?.observedAt ?? null,
        decisionHash: hashDecisions(audit)
      },
      audit
    };

    await mkdir("reports", { recursive: true });
    const json = JSON.stringify(report, null, 2);
    const markdown = renderMarkdown(report);
    await Promise.all([
      writeFile("reports/contextual-survival-v1-audit-20260829.json", json),
      writeFile("reports/contextual-survival-v1-audit-20260829.md", markdown),
      writeFile("reports/contextual-survival-v1-audit-latest.json", json),
      writeFile("reports/contextual-survival-v1-audit-latest.md", markdown)
    ]);
    console.log(
      JSON.stringify(
        {
          generatedAt,
          strategyVersion: report.strategyVersion,
          records: records.length,
          decisionHash: report.source.decisionHash,
          verdict: audit.verdict,
          selected: {
            marketOnly: audit.marketOnlyControl.all.count,
            shuffledWallet: audit.walletShuffleControl.all.count,
            contextualWallet: audit.contextualWalletPolicy.all.count
          },
          contextualWalletPolicy: audit.contextualWalletPolicy
        },
        null,
        2
      )
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

function mapMarketRow(row: MarketRow): ContextualSurvivalRecord {
  return {
    marketKey: `${row.token_address}:${row.pool_address}`,
    tokenAddress: row.token_address,
    poolAddress: row.pool_address,
    dex: row.dex ?? "unknown",
    observedAt: row.observed_at.toISOString(),
    frozenAt: row.frozen_at.toISOString(),
    netReturnPct: number(row.net_return_pct),
    estimatedRoundTripCostPct: number(row.estimated_round_trip_cost_pct),
    rugged: row.rugged,
    controlledFlow: row.controlled_flow,
    tokenRiskKnown: row.token_risk_known,
    tokenRiskPassed: row.token_risk_passed,
    mintAuthorityRevoked: row.mint_authority_revoked,
    freezeAuthorityRevoked: row.freeze_authority_revoked,
    liquidityUsd: number(row.liquidity_usd),
    volume5mUsd: number(row.volume_5m_usd),
    transactions5m: Number(row.transactions_5m),
    buyShare5m: number(row.buy_share_5m),
    volumeLiquidityRatio: number(row.volume_liquidity_ratio),
    poolAgeMinutes: number(row.pool_age_minutes),
    top10HolderPercent: number(row.top10_holder_percent),
    supporters: Array.isArray(row.supporters)
      ? row.supporters.map((supporter) => ({
          walletAddress: String(supporter.walletAddress),
          priorTokenCount: Math.max(0, Number(supporter.priorTokenCount))
        }))
      : []
  };
}

function hashDecisions(audit: ContextualSurvivalAudit): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        audit.decisions.map((decision) => ({
          marketKey: decision.marketKey,
          marketContext: decision.marketContext,
          decisionFeatures: decision.decisionFeatures,
          observedAt: decision.observedAt,
          modeledReturnPct: decision.modeledReturnPct,
          rugged: decision.rugged,
          marketScore: decision.marketScore,
          walletScore: decision.walletScore,
          selectedByMarketControl: decision.selectedByMarketControl,
          selectedByContextualWallet: decision.selectedByContextualWallet
        }))
      )
    )
    .digest("hex");
}

function renderMarkdown(report: AuditReport): string {
  const { audit } = report;
  return [
    "# Contextual Wallet Survival V1 Audit",
    "",
    `Generated: ${report.generatedAt}`,
    `Decision hash: \`${report.source.decisionHash}\``,
    "",
    "## Decision",
    "",
    `- Verdict: **${audit.verdict}**`,
    `- Eligible exact-pool markets: ${audit.records}`,
    `- Decision range: ${report.source.firstDecisionAt ?? "n/a"} -> ${report.source.lastDecisionAt ?? "n/a"}`,
    "- This result can never authorize live execution. A pass permits only a future-only isolated shadow cohort.",
    "",
    "## Policy comparison",
    "",
    policyTable({
      broad: audit.broadBaseline,
      marketOnly: audit.marketOnlyControl,
      shuffledWallet: audit.walletShuffleControl,
      contextualWallet: audit.contextualWalletPolicy
    }),
    "",
    "## Fixed acceptance contract",
    "",
    "Every all/train/validation/holdout window needs enough distinct markets and days, positive median, average excluding the best winner above 2%, hit rate >=60%, profit factor >=1.30, rug and catastrophic-loss rates <=3%, and best-winner share <=30%. The contextual policy must also beat market-only and wallet-identity-shuffle controls in every later window.",
    "",
    "## Limitations",
    "",
    ...audit.limitations.map((limitation) => `- ${limitation}`),
    ""
  ].join("\n");
}

function policyTable(policies: Record<string, ContextualSurvivalPolicyStats>): string {
  const rows = Object.entries(policies).flatMap(([policy, stats]) =>
    (["all", "train", "validation", "holdout1", "holdout2"] as const).map((window) =>
      windowRow(policy, window, stats[window])
    )
  );
  return [
    "| Policy | Window | N | Days | Avg | Median | Avg ex-best | Hit | PF | Rug | Catastrophic | Best share | Pass |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ...rows
  ].join("\n");
}

function windowRow(policy: string, window: string, stats: ContextualSurvivalWindowStats): string {
  return `| ${policy} | ${window} | ${stats.count} | ${stats.activeDays} | ${format(stats.averageReturnPct)}% | ${format(stats.medianReturnPct)}% | ${format(stats.averageReturnExBestPct)}% | ${format(stats.hitRate * 100)}% | ${format(stats.profitFactor)} | ${format(stats.ruggedRate * 100)}% | ${format(stats.catastrophicLossRate * 100)}% | ${format(stats.bestWinnerShare * 100)}% | ${stats.passed ? "yes" : stats.failureReasons.join(", ")} |`;
}

function number(value: string | number | null): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function format(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

const marketSql = String.raw`
WITH mature AS MATERIALIZED (
  SELECT entry.*, outcome.frozen_at, outcome.net_return_pct,
         outcome.estimated_round_trip_cost_pct, outcome.rugged,
         COALESCE((entry.flow_evidence->>'buys5m')::integer, 0) AS buys_5m,
         COALESCE((entry.flow_evidence->>'sells5m')::integer, 0) AS sells_5m,
         COALESCE((entry.flow_evidence->>'swaps5m')::integer, 0) AS swaps_5m,
         COALESCE((entry.flow_evidence->>'buyShare5m')::numeric, -1) AS buy_share_5m,
         COALESCE((entry.flow_evidence->>'volumeLiquidityRatio')::numeric, 999999) AS volume_liquidity_ratio,
         COALESCE((entry.flow_evidence->>'poolAgeMinutes')::numeric, 0) AS pool_age_minutes,
         COALESCE((entry.flow_evidence->>'liquidityUsd')::numeric, entry.observed_liquidity_usd) AS liquidity_usd,
         COALESCE((entry.flow_evidence->>'volume5mUsd')::numeric, 0) AS volume_5m_usd,
         COALESCE((entry.flow_evidence->>'top10HolderPercent')::numeric, 999) AS top10_holder_percent
  FROM wallet_entry_signals entry
  JOIN wallet_signal_outcomes outcome ON outcome.entry_idempotency_key = entry.idempotency_key
  WHERE entry.strategy_version = 'evidence-v1'
    AND entry.source_swap_idempotency_key IS NOT NULL
    AND entry.pool_address IS NOT NULL
    AND entry.cohort <> 'excluded'
    AND outcome.strategy_version = 'evidence-v1'
    AND outcome.exit_strategy = 'tp15-sl20-20m'
    AND outcome.status = 'mature'
    AND outcome.net_return_pct IS NOT NULL
    AND outcome.frozen_at IS NOT NULL
), markets AS MATERIALIZED (
  SELECT DISTINCT ON (token_address, pool_address) mature.*
  FROM mature
  WHERE flow_evidence->>'controlledFlow' = 'true'
    AND flow_evidence->>'tokenRiskKnown' = 'true'
    AND flow_evidence->>'tokenRiskPassed' = 'true'
    AND flow_evidence->>'mintAuthorityRevoked' = 'true'
    AND flow_evidence->>'freezeAuthorityRevoked' = 'true'
    AND pool_age_minutes >= 5
    AND liquidity_usd > 0
    AND GREATEST(swaps_5m, buys_5m + sells_5m) > 0
    AND buy_share_5m BETWEEN 0 AND 1
  ORDER BY token_address, pool_address, observed_at
), supporter_rows AS MATERIALIZED (
  SELECT market.token_address, market.pool_address, market.observed_at,
         entry.wallet_address, MAX(entry.repeat_wallet_count)::integer AS prior_token_count
  FROM markets market
  JOIN wallet_entry_signals entry
    ON entry.token_address = market.token_address
   AND entry.pool_address = market.pool_address
   AND entry.observed_at BETWEEN market.observed_at - INTERVAL '10 minutes' AND market.observed_at
  LEFT JOIN tokens token
    ON token.chain = 'solana' AND token.address = market.token_address
  WHERE entry.strategy_version = 'evidence-v1'
    AND entry.source_swap_idempotency_key IS NOT NULL
    AND entry.cohort <> 'excluded'
    AND entry.wallet_address <> market.pool_address
    AND (token.creator_address IS NULL OR entry.wallet_address <> token.creator_address)
  GROUP BY market.token_address, market.pool_address, market.observed_at, entry.wallet_address
), supporter_aggregate AS MATERIALIZED (
  SELECT token_address, pool_address, observed_at,
         jsonb_agg(
           jsonb_build_object(
             'walletAddress', wallet_address,
             'priorTokenCount', prior_token_count
           ) ORDER BY wallet_address
         ) AS supporters
  FROM supporter_rows
  GROUP BY token_address, pool_address, observed_at
)
SELECT market.token_address, market.pool_address, pool.dex,
       market.observed_at, market.frozen_at, market.net_return_pct,
       market.estimated_round_trip_cost_pct, market.rugged,
       (market.flow_evidence->>'controlledFlow')::boolean AS controlled_flow,
       (market.flow_evidence->>'tokenRiskKnown')::boolean AS token_risk_known,
       (market.flow_evidence->>'tokenRiskPassed')::boolean AS token_risk_passed,
       (market.flow_evidence->>'mintAuthorityRevoked')::boolean AS mint_authority_revoked,
       (market.flow_evidence->>'freezeAuthorityRevoked')::boolean AS freeze_authority_revoked,
       market.liquidity_usd, market.volume_5m_usd,
       GREATEST(market.swaps_5m, market.buys_5m + market.sells_5m)::integer AS transactions_5m,
       market.buy_share_5m, market.volume_liquidity_ratio, market.pool_age_minutes,
       market.top10_holder_percent, COALESCE(support.supporters, '[]'::jsonb) AS supporters
FROM markets market
LEFT JOIN supporter_aggregate support
  USING (token_address, pool_address, observed_at)
LEFT JOIN pools pool
  ON pool.chain = 'solana' AND pool.pool_address = market.pool_address
ORDER BY market.observed_at, market.token_address, market.pool_address`;

await main();
