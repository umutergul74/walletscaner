import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "pg";
import {
  buildTokenAlphaV4Audit,
  type TokenAlphaV4AuditResult,
  type TokenAlphaV4MarketRecord,
  type TokenAlphaV4WindowStats
} from "./token-alpha-v4-audit-builder.js";

interface MarketRow {
  token_address: string;
  pool_address: string;
  dex: string | null;
  creator_address: string | null;
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
  supporter_count: number;
  scored_supporter_count: number;
  causal_safe_wallets_3: number;
  causal_safe_wallets_6: number;
}

interface DelayRow {
  delay_m: number;
  entries: number;
  coverage_pct: string;
  average_return_pct: string;
  median_return_pct: string;
  average_return_ex_best_pct: string;
  hit_rate_pct: string;
  rugged_rate_pct: string;
  catastrophic_loss_rate_pct: string;
  worst_return_pct: string;
}

interface PaperRow {
  trade_id: string;
  token_address: string;
  status: string;
  opened_at: Date;
  closed_at: Date | null;
  pnl_usd: string | null;
  reason: string | null;
}

interface DelaySensitivityResult {
  delayMinutes: number;
  entries: number;
  coveragePct: number;
  averageReturnPct: number;
  medianReturnPct: number;
  averageReturnExBestPct: number;
  hitRatePct: number;
  ruggedRatePct: number;
  catastrophicLossRatePct: number;
  worstReturnPct: number;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  const generatedAt = new Date().toISOString();
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "token-alpha-v4-audit"
  });
  await client.connect();

  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '240s'");
    await client.query("SET LOCAL max_parallel_workers_per_gather = 0");

    const marketResult = await client.query<MarketRow>(marketSql);
    const records = marketResult.rows.map(mapMarketRow);
    const audit = buildTokenAlphaV4Audit(records);
    const delayResult = await client.query<DelayRow>(delaySql);
    const paperResult = await client.query<PaperRow>(paperSql, [
      "qualified-pool-paper-v3-strict-flow"
    ]);
    await client.query("COMMIT");

    const report = {
      generatedAt,
      source: {
        databaseMode: "read-only restored PostgreSQL 16 dump",
        marketDefinition:
          "First source-linked, exact-pool, managed-outcome entry that met frozen strict-flow-v2 decision features.",
        causalWalletDefinition:
          "Wallet outcome history frozen before the candidate timestamp; supporters must enter the exact pool during the preceding ten minutes.",
        modeledRoundTripCostPct: 7.1,
        limitations: [
          "The historical pool path is not retained long enough to replay every candidate at arbitrary timestamps.",
          "Delay results use the next source-linked exact-pool wallet entry within 90 seconds as a fill proxy and therefore have survivorship/coverage bias.",
          "Candidate search is model-selection evidence; even a four-window pass can authorize only a future shadow cohort."
        ]
      },
      currentPaper: {
        strategyVersion: "qualified-pool-paper-v3-strict-flow",
        trades: paperResult.rows.map((row) => ({
          tradeId: row.trade_id,
          tokenAddress: row.token_address,
          status: row.status,
          openedAt: row.opened_at.toISOString(),
          ...(row.closed_at ? { closedAt: row.closed_at.toISOString() } : {}),
          pnlUsd: number(row.pnl_usd),
          reason: row.reason
        }))
      },
      delaySensitivity: delayResult.rows.map((row) => ({
        delayMinutes: Number(row.delay_m),
        entries: Number(row.entries),
        coveragePct: number(row.coverage_pct),
        averageReturnPct: number(row.average_return_pct),
        medianReturnPct: number(row.median_return_pct),
        averageReturnExBestPct: number(row.average_return_ex_best_pct),
        hitRatePct: number(row.hit_rate_pct),
        ruggedRatePct: number(row.rugged_rate_pct),
        catastrophicLossRatePct: number(row.catastrophic_loss_rate_pct),
        worstReturnPct: number(row.worst_return_pct)
      })),
      audit
    };

    await mkdir("reports", { recursive: true });
    const json = JSON.stringify(report, null, 2);
    const markdown = renderMarkdown(report);
    const html = renderHtml(report);
    await Promise.all([
      writeFile("reports/token-alpha-v4-audit-20260822.json", json),
      writeFile("reports/token-alpha-v4-audit-20260822.md", markdown),
      writeFile("reports/token-alpha-v4-audit-20260822.html", html),
      writeFile("reports/token-alpha-v4-audit-latest.json", json),
      writeFile("reports/token-alpha-v4-audit-latest.md", markdown),
      writeFile("reports/token-alpha-v4-audit-latest.html", html)
    ]);
    console.log(
      JSON.stringify(
        {
          generatedAt,
          markets: records.length,
          candidatesEvaluated: audit.candidatesEvaluated,
          verdict: audit.verdict,
          lockedCandidate: audit.lockedCandidate,
          delaySensitivity: report.delaySensitivity,
          paperTrades: report.currentPaper.trades
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

function mapMarketRow(row: MarketRow): TokenAlphaV4MarketRecord {
  return {
    tokenAddress: row.token_address,
    poolAddress: row.pool_address,
    dex: row.dex ?? "unknown",
    ...(row.creator_address ? { creatorAddress: row.creator_address } : {}),
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
    supporterCount: Number(row.supporter_count),
    scoredSupporterCount: Number(row.scored_supporter_count),
    causalSafeWallets3: Number(row.causal_safe_wallets_3),
    causalSafeWallets6: Number(row.causal_safe_wallets_6)
  };
}

function renderMarkdown(report: {
  generatedAt: string;
  currentPaper: { trades: Array<{ tokenAddress: string; pnlUsd: number; reason: string | null }> };
  delaySensitivity: DelaySensitivityResult[];
  audit: TokenAlphaV4AuditResult;
}): string {
  const { audit } = report;
  const locked = audit.lockedCandidate;
  return [
    "# Token Alpha V4 Causal Audit",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Decision",
    "",
    `- Verdict: **${audit.verdict}**`,
    `- Exact strict-flow markets: ${audit.records.length}`,
    `- Candidate grid: ${audit.candidatesEvaluated}`,
    `- Locked candidate: ${locked?.candidate.id ?? "none"}`,
    "- Live execution: prohibited; this report cannot authorize capital deployment.",
    "",
    "## Current V3 Paper Incidents",
    "",
    ...report.currentPaper.trades.map(
      (trade) =>
        `- ${trade.tokenAddress}: ${format(trade.pnlUsd, 4)} USD (${trade.reason ?? "unknown"})`
    ),
    "",
    "## Frozen Strict-V2 Baseline",
    "",
    windowTable(audit.baseline),
    "",
    "## Locked Causal-Wallet Candidate",
    "",
    locked ? candidateMarkdown(locked) : "No candidate passed both train and validation.",
    "",
    "## Exact-Pool Delay Sensitivity",
    "",
    "| Delay | Entries | Coverage | Median | Avg ex-best | Hit | Rug | Catastrophic | Worst |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.delaySensitivity.map(
      (row) =>
        `| ${row.delayMinutes}m | ${row.entries} | ${format(row.coveragePct)}% | ${format(row.medianReturnPct)}% | ${format(row.averageReturnExBestPct)}% | ${format(row.hitRatePct)}% | ${format(row.ruggedRatePct)}% | ${format(row.catastrophicLossRatePct)}% | ${format(row.worstReturnPct)}% |`
    ),
    "",
    "Delay rows use the next source-linked exact-pool wallet entry within 90 seconds. Missing fills are excluded, so these figures are diagnostic rather than executable backtest proof.",
    "",
    "## Required Next Gate",
    "",
    "A new version may run only as an isolated future shadow. Paper entry requires at least 30 future distinct markets, seven complete UTC days, exact-pool fill replay, creator/funder independence, median and ex-best average above zero, hit rate at least 60%, profit factor at least 1.2, catastrophic/rug rate at most 5%, worst outcome at least -35%, and best-winner share at most 40%."
  ].join("\n");
}

function renderHtml(report: {
  generatedAt: string;
  currentPaper: { trades: Array<{ tokenAddress: string; pnlUsd: number; reason: string | null }> };
  delaySensitivity: DelaySensitivityResult[];
  audit: TokenAlphaV4AuditResult;
}): string {
  const { audit } = report;
  const locked = audit.lockedCandidate;
  const verdictClass = audit.verdict === "future-shadow-only" ? "watch" : "reject";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Token Alpha V4 Audit</title><style>
  :root{color-scheme:dark;--bg:#09111b;--panel:#101c2a;--line:#26384d;--text:#e7eef7;--muted:#95a7bb;--good:#42d392;--bad:#ff6b72;--warn:#f5c451}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top right,#16344a 0,#09111b 38%);font:14px/1.55 Inter,Segoe UI,sans-serif;color:var(--text)}main{max-width:1180px;margin:auto;padding:40px 24px 80px}h1{font-size:38px;margin:0 0 6px}h2{margin-top:34px;font-size:22px}.muted{color:var(--muted)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}.card{background:rgba(16,28,42,.92);border:1px solid var(--line);border-radius:14px;padding:18px}.metric{font-size:26px;font-weight:700}.badge{display:inline-block;padding:5px 10px;border-radius:999px;font-weight:700}.reject{background:#4a2027;color:#ff9ca1}.watch{background:#463a18;color:#f8d36d}table{width:100%;border-collapse:collapse;background:rgba(16,28,42,.9);border-radius:12px;overflow:hidden}th,td{padding:10px;border-bottom:1px solid var(--line);text-align:right}th:first-child,td:first-child{text-align:left}th{color:#aecaeb;font-size:12px;text-transform:uppercase}.negative{color:var(--bad)}.positive{color:var(--good)}code{color:#a9d8ff;word-break:break-all}.callout{border-left:4px solid var(--warn);padding:12px 16px;background:#282416;border-radius:8px}.small{font-size:12px}</style></head><body><main>
  <p class="muted">Walletscaner · causal, exact-pool research review</p><h1>Token Alpha V4 Audit</h1><p class="muted">${escapeHtml(report.generatedAt)}</p>
  <section class="grid"><div class="card"><div class="muted">Verdict</div><div class="metric"><span class="badge ${verdictClass}">${escapeHtml(audit.verdict)}</span></div></div><div class="card"><div class="muted">Strict markets</div><div class="metric">${audit.records.length}</div></div><div class="card"><div class="muted">Candidate grid</div><div class="metric">${audit.candidatesEvaluated.toLocaleString()}</div></div><div class="card"><div class="muted">Locked candidate</div><div class="metric small"><code>${escapeHtml(locked?.candidate.id ?? "none")}</code></div></div></section>
  <h2>Finding</h2><div class="callout">V3's primary failure is admission quality: token-risk evidence did not measure liquidity-withdrawal risk, and entry did not require causally proven wallet support. Exit tuning cannot recover liquidity after a rug. No result here authorizes live capital.</div>
  <h2>Current V3 paper incidents</h2><table><thead><tr><th>Token</th><th>PnL USD</th><th>Reason</th></tr></thead><tbody>${report.currentPaper.trades.map((trade) => `<tr><td><code>${escapeHtml(trade.tokenAddress)}</code></td><td class="${trade.pnlUsd < 0 ? "negative" : "positive"}">${format(trade.pnlUsd, 4)}</td><td>${escapeHtml(trade.reason ?? "unknown")}</td></tr>`).join("")}</tbody></table>
  <h2>Chronological robustness</h2>${windowHtml(audit.baseline, "Strict-v2 baseline")}${locked ? windowHtml({ train: locked.train, validation: locked.validation, holdout1: locked.holdout1!, holdout2: locked.holdout2! }, "Locked causal-wallet candidate") : '<p class="muted">No candidate passed both train and validation.</p>'}
  <h2>Delay sensitivity</h2><table><thead><tr><th>Delay</th><th>Entries</th><th>Coverage</th><th>Median</th><th>Avg ex-best</th><th>Hit</th><th>Rug</th><th>Catastrophic</th><th>Worst</th></tr></thead><tbody>${report.delaySensitivity.map((row) => `<tr><td>${row.delayMinutes}m</td><td>${row.entries}</td><td>${format(row.coveragePct)}%</td><td>${format(row.medianReturnPct)}%</td><td>${format(row.averageReturnExBestPct)}%</td><td>${format(row.hitRatePct)}%</td><td>${format(row.ruggedRatePct)}%</td><td>${format(row.catastrophicLossRatePct)}%</td><td>${format(row.worstReturnPct)}%</td></tr>`).join("")}</tbody></table><p class="muted">The next source-linked exact-pool wallet entry within 90 seconds is a fill proxy. Coverage loss creates survivorship bias; this is not execution proof.</p>
  <h2>Security and capital boundary</h2><div class="grid"><div class="card"><strong>Live execution</strong><p class="negative">Disabled and prohibited.</p></div><div class="card"><strong>Data leakage</strong><p>Creator and wallet evidence is frozen before each decision.</p></div><div class="card"><strong>Promotion</strong><p>Future-only shadow first; paper requires all frozen gates.</p></div><div class="card"><strong>Production writes</strong><p>None. Audit ran on a read-only restored clone.</p></div></div>
  </main></body></html>`;
}

function candidateMarkdown(
  candidate: NonNullable<TokenAlphaV4AuditResult["lockedCandidate"]>
): string {
  return [
    `- ID: ${candidate.candidate.id}`,
    `- Wallet evidence: ${candidate.candidate.walletEvidence}, minimum ${candidate.candidate.minimumSafeWallets}`,
    `- Liquidity: >= $${candidate.candidate.minimumLiquidityUsd}`,
    `- Buy share: [${candidate.candidate.minimumBuyShare5m}, ${candidate.candidate.maximumBuyShare5mExclusive})`,
    `- Volume/liquidity: < ${candidate.candidate.maximumVolumeLiquidityRatioExclusive}`,
    `- Pool age: ${candidate.candidate.minimumPoolAgeMinutes}-${candidate.candidate.maximumPoolAgeMinutes} minutes`,
    `- Top-10 holders: < ${candidate.candidate.maximumTop10HolderPercentExclusive}%`,
    `- Creator prior markets: >= ${candidate.candidate.minimumCreatorPriorMarkets}; max rug rate ${candidate.candidate.maximumCreatorPriorRugRate}`,
    "",
    windowTable({
      train: candidate.train,
      validation: candidate.validation,
      holdout1: candidate.holdout1!,
      holdout2: candidate.holdout2!
    })
  ].join("\n");
}

function windowTable(windows: Record<string, TokenAlphaV4WindowStats>): string {
  return [
    "| Window | N | Median | Avg ex-best | Hit | PF | Rug | Catastrophic | Worst | Pass |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|:---:|",
    ...Object.entries(windows).map(
      ([name, value]) =>
        `| ${name} | ${value.count} | ${format(value.medianReturnPct)}% | ${format(value.averageReturnExBestPct)}% | ${format(value.hitRate * 100)}% | ${format(value.profitFactor)} | ${format(value.ruggedRate * 100)}% | ${format(value.catastrophicLossRate * 100)}% | ${format(value.worstReturnPct)}% | ${value.passed ? "yes" : "no"} |`
    )
  ].join("\n");
}

function windowHtml(windows: Record<string, TokenAlphaV4WindowStats>, title: string): string {
  return `<h3>${escapeHtml(title)}</h3><table><thead><tr><th>Window</th><th>N</th><th>Median</th><th>Avg ex-best</th><th>Hit</th><th>PF</th><th>Rug</th><th>Catastrophic</th><th>Worst</th><th>Pass</th></tr></thead><tbody>${Object.entries(
    windows
  )
    .map(
      ([name, value]) =>
        `<tr><td>${escapeHtml(name)}</td><td>${value.count}</td><td>${format(value.medianReturnPct)}%</td><td>${format(value.averageReturnExBestPct)}%</td><td>${format(value.hitRate * 100)}%</td><td>${format(value.profitFactor)}</td><td>${format(value.ruggedRate * 100)}%</td><td>${format(value.catastrophicLossRate * 100)}%</td><td>${format(value.worstReturnPct)}%</td><td class="${value.passed ? "positive" : "negative"}">${value.passed ? "PASS" : "FAIL"}</td></tr>`
    )
    .join("")}</tbody></table>`;
}

function number(value: string | number | null): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function format(value: number, digits = 2): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!
  );
}

const marketSql = String.raw`
WITH history AS MATERIALIZED (
  SELECT entry.wallet_address, outcome.frozen_at,
         CASE WHEN outcome.rugged THEN -100
              ELSE outcome.net_return_pct - GREATEST(0, 7.1 - outcome.estimated_round_trip_cost_pct) END AS modeled_return,
         outcome.rugged
  FROM wallet_entry_signals entry
  JOIN wallet_signal_outcomes outcome ON outcome.entry_idempotency_key = entry.idempotency_key
  WHERE entry.strategy_version = 'evidence-v1'
    AND entry.source_swap_idempotency_key IS NOT NULL
    AND entry.cohort <> 'excluded'
    AND outcome.strategy_version = 'evidence-v1'
    AND outcome.exit_strategy = 'tp15-sl20-20m'
    AND outcome.status = 'mature'
    AND outcome.net_return_pct IS NOT NULL
), managed AS MATERIALIZED (
  SELECT entry.*, outcome.frozen_at, outcome.net_return_pct,
         outcome.estimated_round_trip_cost_pct, outcome.rugged,
         COALESCE((entry.flow_evidence->>'buys5m')::integer, 0) AS buys_5m,
         COALESCE((entry.flow_evidence->>'sells5m')::integer, 0) AS sells_5m,
         COALESCE((entry.flow_evidence->>'swaps5m')::integer, 0) AS swaps_5m,
         COALESCE((entry.flow_evidence->>'buyShare5m')::numeric, 0) AS buy_share_5m,
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
), markets AS MATERIALIZED (
  SELECT DISTINCT ON (token_address, pool_address) managed.*
  FROM managed
  WHERE flow_evidence->>'controlledFlow' = 'true'
    AND flow_evidence->>'tokenRiskKnown' = 'true'
    AND flow_evidence->>'tokenRiskPassed' = 'true'
    AND flow_evidence->>'mintAuthorityRevoked' = 'true'
    AND flow_evidence->>'freezeAuthorityRevoked' = 'true'
    AND liquidity_usd >= 10000
    AND volume_5m_usd >= 5000
    AND pool_age_minutes >= 5
    AND GREATEST(swaps_5m, buys_5m + sells_5m) >= 20
    AND buy_share_5m >= 0.5 AND buy_share_5m < 0.6
    AND volume_liquidity_ratio < 0.5
    AND top10_holder_percent < 20
  ORDER BY token_address, pool_address, observed_at
), supporters AS MATERIALIZED (
  SELECT DISTINCT market.token_address, market.pool_address, market.observed_at AS market_at,
                  entry.wallet_address
  FROM markets market
  JOIN wallet_entry_signals entry
    ON entry.token_address = market.token_address
   AND entry.pool_address = market.pool_address
   AND entry.observed_at BETWEEN market.observed_at - INTERVAL '10 minutes' AND market.observed_at
  WHERE entry.strategy_version = 'evidence-v1'
    AND entry.source_swap_idempotency_key IS NOT NULL
    AND entry.cohort <> 'excluded'
), wallet_stats AS MATERIALIZED (
  SELECT supporter.token_address, supporter.pool_address, supporter.wallet_address,
         COUNT(history.*) AS sample_count,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY history.modeled_return) AS median_return,
         COUNT(*) FILTER (WHERE history.modeled_return > 0)::numeric / GREATEST(COUNT(history.*), 1) AS hit_rate,
         SUM(history.modeled_return) FILTER (WHERE history.modeled_return > 0) /
           NULLIF(ABS(SUM(history.modeled_return) FILTER (WHERE history.modeled_return < 0)), 0) AS profit_factor,
         COUNT(*) FILTER (WHERE history.modeled_return <= -50)::numeric / GREATEST(COUNT(history.*), 1) AS catastrophic_rate,
         COUNT(*) FILTER (WHERE history.rugged)::numeric / GREATEST(COUNT(history.*), 1) AS rugged_rate,
         MIN(history.modeled_return) AS worst_return
  FROM supporters supporter
  LEFT JOIN history
    ON history.wallet_address = supporter.wallet_address
   AND history.frozen_at < supporter.market_at
  GROUP BY supporter.token_address, supporter.pool_address, supporter.wallet_address
), support_aggregate AS MATERIALIZED (
  SELECT token_address, pool_address, COUNT(*)::integer AS supporter_count,
         COUNT(*) FILTER (WHERE sample_count > 0)::integer AS scored_supporter_count,
         COUNT(*) FILTER (
           WHERE sample_count >= 3 AND median_return > 0
             AND catastrophic_rate = 0 AND rugged_rate = 0
         )::integer AS causal_safe_wallets_3,
         COUNT(*) FILTER (
           WHERE sample_count >= 6 AND median_return > 0 AND hit_rate >= 0.55
             AND COALESCE(profit_factor, 999) >= 1.2
             AND catastrophic_rate <= 0.05 AND rugged_rate <= 0.05
             AND worst_return >= -35
         )::integer AS causal_safe_wallets_6
  FROM wallet_stats
  GROUP BY token_address, pool_address
)
SELECT market.token_address, market.pool_address, pool.dex, token.creator_address,
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
       market.top10_holder_percent, COALESCE(support.supporter_count, 0) AS supporter_count,
       COALESCE(support.scored_supporter_count, 0) AS scored_supporter_count,
       COALESCE(support.causal_safe_wallets_3, 0) AS causal_safe_wallets_3,
       COALESCE(support.causal_safe_wallets_6, 0) AS causal_safe_wallets_6
FROM markets market
LEFT JOIN support_aggregate support USING (token_address, pool_address)
LEFT JOIN pools pool ON pool.chain = 'solana' AND pool.pool_address = market.pool_address
LEFT JOIN tokens token ON token.chain = 'solana' AND token.address = market.token_address
ORDER BY market.observed_at, market.token_address, market.pool_address`;

const delaySql = String.raw`
WITH managed AS MATERIALIZED (
  SELECT entry.token_address, entry.pool_address, entry.observed_at, entry.flow_evidence,
         entry.observed_liquidity_usd, outcome.net_return_pct,
         outcome.estimated_round_trip_cost_pct, outcome.rugged,
         COALESCE((entry.flow_evidence->>'buys5m')::integer, 0) AS buys_5m,
         COALESCE((entry.flow_evidence->>'sells5m')::integer, 0) AS sells_5m,
         COALESCE((entry.flow_evidence->>'swaps5m')::integer, 0) AS swaps_5m,
         COALESCE((entry.flow_evidence->>'buyShare5m')::numeric, 0) AS buy_share_5m,
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
), anchors AS MATERIALIZED (
  SELECT DISTINCT ON (token_address, pool_address) managed.*
  FROM managed
  WHERE flow_evidence->>'controlledFlow' = 'true'
    AND flow_evidence->>'tokenRiskKnown' = 'true'
    AND flow_evidence->>'tokenRiskPassed' = 'true'
    AND flow_evidence->>'mintAuthorityRevoked' = 'true'
    AND flow_evidence->>'freezeAuthorityRevoked' = 'true'
    AND liquidity_usd >= 10000 AND volume_5m_usd >= 5000 AND pool_age_minutes >= 5
    AND GREATEST(swaps_5m, buys_5m + sells_5m) >= 20
    AND buy_share_5m >= 0.5 AND buy_share_5m < 0.6
    AND volume_liquidity_ratio < 0.5 AND top10_holder_percent < 20
  ORDER BY token_address, pool_address, observed_at
), delays(delay_minutes) AS (VALUES (0), (2), (5), (10)), picked AS (
  SELECT delay.delay_minutes, anchor.token_address, anchor.pool_address, later.observed_at AS entry_at,
         later.net_return_pct, later.estimated_round_trip_cost_pct, later.rugged
  FROM delays delay CROSS JOIN anchors anchor
  LEFT JOIN LATERAL (
    SELECT managed.observed_at, managed.net_return_pct, managed.estimated_round_trip_cost_pct, managed.rugged
    FROM managed
    WHERE managed.token_address = anchor.token_address AND managed.pool_address = anchor.pool_address
      AND managed.observed_at >= anchor.observed_at + make_interval(mins => delay.delay_minutes)
      AND managed.observed_at <= anchor.observed_at + make_interval(mins => delay.delay_minutes) + INTERVAL '90 seconds'
    ORDER BY managed.observed_at LIMIT 1
  ) later ON true
), modeled AS (
  SELECT *, CASE WHEN rugged THEN -100
                 ELSE net_return_pct - GREATEST(0, 7.1 - estimated_round_trip_cost_pct) END AS modeled_return
  FROM picked WHERE entry_at IS NOT NULL
), ranked AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY delay_minutes ORDER BY modeled_return DESC) AS rank,
            COUNT(*) OVER (PARTITION BY delay_minutes) AS total
  FROM modeled
)
SELECT delay_minutes AS delay_m, COUNT(*)::integer AS entries,
       ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM anchors), 2) AS coverage_pct,
       ROUND(AVG(modeled_return), 4) AS average_return_pct,
       ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY modeled_return)::numeric, 4) AS median_return_pct,
       ROUND(AVG(modeled_return) FILTER (WHERE rank > 1), 4) AS average_return_ex_best_pct,
       ROUND(100.0 * COUNT(*) FILTER (WHERE modeled_return > 0) / COUNT(*), 2) AS hit_rate_pct,
       ROUND(100.0 * COUNT(*) FILTER (WHERE rugged) / COUNT(*), 2) AS rugged_rate_pct,
       ROUND(100.0 * COUNT(*) FILTER (WHERE modeled_return <= -50) / COUNT(*), 2) AS catastrophic_loss_rate_pct,
       ROUND(MIN(modeled_return), 4) AS worst_return_pct
FROM ranked GROUP BY delay_minutes ORDER BY delay_minutes`;

const paperSql = String.raw`
SELECT trade.id AS trade_id, trade.token_address, trade.status, trade.opened_at,
       trade.closed_at, trade.pnl_usd, trade.reason
FROM paper_trades trade
WHERE trade.strategy_version = $1
ORDER BY trade.opened_at`;

await main();
