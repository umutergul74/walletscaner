import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required.");

const admin = new pg.Client({ connectionString: databaseUrl });
const schema = `alpha_tape_benchmark_${randomUUID().replaceAll("-", "")}`;
await admin.connect();

try {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`SET search_path TO "${schema}", public`);
  const migrationSql = await readFile(
    "scripts/migrations/052_future_alpha_decision_tape.sql",
    "utf8"
  );
  const migrationStartedAt = Date.now();
  await admin.query(migrationSql);
  await admin.query(await readFile("scripts/migrations/053_alpha_collection_timing.sql", "utf8"));
  const migrationDurationMs = Date.now() - migrationStartedAt;
  const beforeWal = await currentWal();

  await admin.query(`
    INSERT INTO alpha_decision_tape (
      id, strategy_version, chain, token_address, quote_token_address, pool_address, dex,
      pool_created_at, decided_at, retain_until, source_strategy_version, source_slot,
      price_usd, liquidity_usd, volume_5m_usd, buys_5m, sells_5m,
      unique_buyers_5m, unique_sellers_5m, creator_buys_before_decision,
      trade_coverage_complete, coverage_status, coverage_reason,
      risk_status, risk_score, risk_confidence, risk_assessed_at,
      mint_authority_revoked, freeze_authority_revoked, top_10_holder_percent,
      token_program, token_extension_evidence_known, blocking_token_extension_count,
      creator_address, creator_status, identity_independence_status,
      research_eligible, paper_eligible, missing_evidence
    )
    SELECT
      md5('decision-' || value::text),
      'survival-execution-tape-v2-20260830', 'solana',
      'BenchmarkMint' || value::text,
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'BenchmarkPool' || value::text, 'BenchmarkProgram111',
      NOW() - INTERVAL '3 minutes', NOW(),
      NOW() + INTERVAL '60 days', 'evidence-v1', 441000000 + value,
      0.001, 20000, 5000, 20, 10, 10, 4, 0,
      TRUE, 'passed', 'canonical-finalized-and-gap-free',
      'passed', 0, 90, NOW() - INTERVAL '2 minutes',
      TRUE, TRUE, 10, 'spl-token', TRUE, 0,
      'BenchmarkCreator' || value::text, 'passed', 'unknown',
      TRUE, FALSE,
      ARRAY['funder-cluster-bundle-independence-unknown',
            'priority-and-landing-fee-evidence-unknown']::text[]
    FROM generate_series(1, 100) value;

    INSERT INTO alpha_decision_checkpoints (
      decision_id, horizon_seconds, due_at, status, attempt_count, available_at,
      exact_pair_status, price_usd, liquidity_usd, buys_5m, sells_5m,
      unique_buyers_since_decision, unique_sellers_since_decision,
      identity_independence_status, liquidity_removed, market_observed_at,
      market_provider, market_provider_latency_ms, completed_at
    )
    SELECT decision.id, horizon.seconds, decision.decided_at + make_interval(secs => horizon.seconds),
           'completed', 1, decision.decided_at + make_interval(secs => horizon.seconds),
           'live', 0.001, 20000, 20, 10, 4, 2, 'unknown', FALSE,
           decision.decided_at + make_interval(secs => horizon.seconds),
           'dexscreener-exact-pair', 50, NOW()
    FROM alpha_decision_tape decision
    CROSS JOIN (VALUES (0), (15), (30), (60), (120), (300)) horizon(seconds);

    INSERT INTO alpha_execution_quote_evidence (
      checkpoint_id, direction, notional_usd_cents, position_source, status,
      input_mint, output_mint, raw_input_amount, raw_expected_output_amount,
      raw_minimum_output_amount, slippage_bps, price_impact_percent,
      expected_pool_address, route_pool_address, route_label, route_router,
      provider_fee_bps, provider_fee_mint, platform_fee_raw_amount,
      platform_fee_bps, platform_fee_mint, context_slot,
      provider, provider_time_ms, http_latency_ms,
      observed_at, failure_reason
    )
    SELECT checkpoint.id, direction.value, notional.value,
           CASE WHEN checkpoint.horizon_seconds = 0 THEN 'new-buy' ELSE 'decision-entry' END,
           'quoted-not-filled',
           CASE WHEN direction.value = 'buy' THEN decision.quote_token_address
                ELSE decision.token_address END,
           CASE WHEN direction.value = 'buy' THEN decision.token_address
                ELSE decision.quote_token_address END,
           6000000, 1200000000, 1152000000, 400, 0.03,
           decision.pool_address, decision.pool_address, 'benchmark-direct',
           'metis', 50, decision.quote_token_address, 1250,
           50, decision.quote_token_address, 441000000,
           'jupiter-swap-v2-order', 12, 20, checkpoint.due_at, NULL
    FROM alpha_decision_checkpoints checkpoint
    JOIN alpha_decision_tape decision ON decision.id = checkpoint.decision_id
    CROSS JOIN (VALUES (600), (2500), (10000)) notional(value)
    CROSS JOIN (VALUES ('buy'), ('sell')) direction(value)
    WHERE checkpoint.horizon_seconds = 0 OR direction.value = 'sell';
  `);
  await admin.query(`ANALYZE alpha_decision_tape`);
  await admin.query(`ANALYZE alpha_decision_checkpoints`);
  await admin.query(`ANALYZE alpha_execution_quote_evidence`);
  const afterWal = await currentWal();
  const sizes = await admin.query<{ relation: string; total_bytes: string }>(`
    SELECT relation, pg_total_relation_size(relation::regclass)::text AS total_bytes
    FROM unnest(ARRAY[
      'alpha_decision_tape',
      'alpha_decision_checkpoints',
      'alpha_execution_quote_evidence'
    ]) relation
    ORDER BY relation
  `);
  // Exercise real due/expired rows, not empty partial indexes.
  await admin.query(`UPDATE alpha_decision_checkpoints SET status = 'pending', completed_at = NULL
    WHERE horizon_seconds = 0`);
  const claimPlan = await explain(`
    SELECT checkpoint.id
    FROM alpha_decision_checkpoints checkpoint
    JOIN alpha_decision_tape decision ON decision.id = checkpoint.decision_id
    WHERE decision.strategy_version = 'survival-execution-tape-v2-20260830'
      AND decision.research_eligible
      AND checkpoint.status IN ('pending', 'retry')
      AND checkpoint.available_at <= NOW()
      AND checkpoint.due_at <= NOW()
    ORDER BY checkpoint.due_at, checkpoint.id
    LIMIT 1
  `);
  await admin.query(`UPDATE alpha_decision_checkpoints SET status = 'completed', completed_at = NOW();
    UPDATE alpha_decision_tape SET pool_created_at = pool_created_at - INTERVAL '61 days',
      decided_at = decided_at - INTERVAL '61 days', retain_until = NOW() - INTERVAL '1 second'`);
  const retentionPlan = await explain(`
    SELECT decision.id
    FROM alpha_decision_tape decision
    WHERE decision.retain_until < NOW()
      AND NOT EXISTS (
        SELECT 1 FROM alpha_decision_checkpoints checkpoint
        WHERE checkpoint.decision_id = decision.id
          AND checkpoint.status NOT IN ('completed', 'dead_letter')
      )
    ORDER BY decision.retain_until, decision.id
    LIMIT 5000
  `);
  const totalBytes = sizes.rows.reduce((sum, row) => sum + Number(row.total_bytes), 0);
  console.log(
    JSON.stringify(
      {
        benchmark: "alpha-decision-tape-hard-daily-ceiling-v2",
        migrationDurationMs,
        rows: { decisions: 100, checkpoints: 600, quotes: 2100 },
        relationBytes: Object.fromEntries(
          sizes.rows.map((row) => [row.relation, Number(row.total_bytes)])
        ),
        totalBytes,
        conservativeSteadyState60DayBytes: totalBytes * 60,
        walBytes: Number(afterWal - beforeWal),
        claimPlan,
        retentionPlan
      },
      null,
      2
    )
  );
} finally {
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
}

async function currentWal(): Promise<bigint> {
  const result = await admin.query<{ bytes: string }>(
    `SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')::text AS bytes`
  );
  return BigInt(result.rows[0]?.bytes ?? "0");
}

async function explain(sql: string): Promise<unknown> {
  const result = await admin.query<{ "QUERY PLAN": unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, WAL, FORMAT JSON) ${sql}`
  );
  return result.rows[0]?.["QUERY PLAN"];
}
