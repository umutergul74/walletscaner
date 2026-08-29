import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ALPHA_DECISION_TAPE_VERSION,
  AlphaDecisionTapeStore,
  type AlphaExecutionQuoteEvidence
} from "./alpha-decision-tape-store";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = databaseUrl ? describe : describe.skip;
const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

integrationDescribe("PostgreSQL future alpha decision tape", () => {
  const adminPool = new pg.Pool({ connectionString: databaseUrl });
  const schema = `alpha_tape_test_${Date.now()}`;
  let testPool: pg.Pool;
  let store: AlphaDecisionTapeStore;
  let populatedUpgradeDurationMs = 0;
  let populatedPoolsRelFileBefore = "";
  let populatedPoolsRelFileAfter = "";

  beforeAll(async () => {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    testPool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`
    });
    const migrations = (await readdir("scripts/migrations"))
      .filter((filename) => /^\d+.*\.sql$/u.test(filename))
      .sort();
    for (const migration of migrations) {
      if (migration === "052_future_alpha_decision_tape.sql") {
        await seedPopulatedUpgrade();
        const before = await testPool.query<{ relfilenode: string }>(
          `SELECT pg_relation_filenode('pools'::regclass)::text AS relfilenode`
        );
        populatedPoolsRelFileBefore = String(before.rows[0]?.relfilenode);
        const startedAt = Date.now();
        await testPool.query(await readFile(`scripts/migrations/${migration}`, "utf8"));
        populatedUpgradeDurationMs = Date.now() - startedAt;
        const after = await testPool.query<{ relfilenode: string }>(
          `SELECT pg_relation_filenode('pools'::regclass)::text AS relfilenode`
        );
        populatedPoolsRelFileAfter = String(after.rows[0]?.relfilenode);
        continue;
      }
      await testPool.query(await readFile(`scripts/migrations/${migration}`, "utf8"));
    }
    store = new AlphaDecisionTapeStore(testPool);
    await testPool.query(
      `UPDATE alpha_decision_tape_runs
       SET activated_at = NOW() - INTERVAL '10 minutes'
       WHERE strategy_version = $1`,
      [ALPHA_DECISION_TAPE_VERSION]
    );
  }, 120_000);

  afterAll(async () => {
    if (testPool) await testPool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  });

  it("applies additively over populated relations without rewriting or importing history", async () => {
    expect(populatedPoolsRelFileAfter).toBe(populatedPoolsRelFileBefore);
    expect(populatedUpgradeDurationMs).toBeLessThan(5_000);
    const result = await testPool.query<{
      old_pools: number;
      imported_decisions: number;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM pools WHERE pool_address LIKE 'PopulatedUpgradePool%')::integer
           AS old_pools,
         (SELECT COUNT(*) FROM alpha_decision_tape)::integer AS imported_decisions`
    );
    expect(result.rows[0]).toEqual({ old_pools: 1_000, imported_decisions: 0 });
  });

  it("records only future exact-pool decisions and creates bounded work for eligible evidence", async () => {
    await seedPool({
      tokenAddress: "TapeEligibleMint111",
      poolAddress: "TapeEligiblePool111",
      creatorAddress: "TapeCreator111",
      riskKnown: true
    });
    await seedPool({
      tokenAddress: "TapeUnknownRiskMint111",
      poolAddress: "TapeUnknownRiskPool111",
      riskKnown: false
    });
    await seedPool({
      tokenAddress: "TapeCreatorMint111",
      poolAddress: "TapeCreatorPool111",
      creatorAddress: "TapeCreatorBuyer111",
      riskKnown: true,
      createdMinutesAgo: 8,
      creatorTradeMinutesAgo: 7
    });
    await seedPool({
      tokenAddress: "TapeGapMint111",
      poolAddress: "TapeGapPool111",
      creatorAddress: "TapeGapCreator111",
      riskKnown: true,
      createdMinutesAgo: 8,
      dex: "TapeGapProgram111"
    });
    await testPool.query(
      `INSERT INTO ingestion_coverage_incidents (
         idempotency_key, chain, provider, program_address, reason,
         gap_started_at, opened_at, subscription_ack_timeout_count,
         successful_subscription_ack_count, open_metadata
       ) VALUES (
         'alpha-tape-gap-after-creation', 'solana', 'integration', 'TapeGapProgram111',
         'head_slot_lag', NOW() - INTERVAL '4 minutes', NOW() - INTERVAL '4 minutes',
         0, 1, '{}'::jsonb
       )`
    );

    await expect(store.seedFutureDecisions()).resolves.toMatchObject({
      inserted: 4,
      researchEligible: 1
    });
    await expect(store.seedFutureDecisions()).resolves.toMatchObject({ inserted: 0 });

    const rows = await testPool.query<{
      pool_address: string;
      research_eligible: boolean;
      paper_eligible: boolean;
      coverage_status: string;
      risk_status: string;
      identity_independence_status: string;
      missing_evidence: string[];
    }>(
      `SELECT pool_address, research_eligible, paper_eligible, coverage_status,
              risk_status, identity_independence_status, missing_evidence
       FROM alpha_decision_tape
       ORDER BY pool_address`
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({
        pool_address: "TapeCreatorPool111",
        research_eligible: false,
        paper_eligible: false,
        risk_status: "passed",
        missing_evidence: expect.arrayContaining(["direct-creator-buy-observed"])
      }),
      expect.objectContaining({
        pool_address: "TapeEligiblePool111",
        research_eligible: true,
        paper_eligible: false,
        coverage_status: "passed",
        risk_status: "passed",
        identity_independence_status: "unknown",
        missing_evidence: expect.arrayContaining(["funder-cluster-bundle-independence-unknown"])
      }),
      expect.objectContaining({
        pool_address: "TapeGapPool111",
        research_eligible: false,
        coverage_status: "failed",
        missing_evidence: expect.arrayContaining(["open-discovery-coverage-incident"])
      }),
      expect.objectContaining({
        pool_address: "TapeUnknownRiskPool111",
        research_eligible: false,
        paper_eligible: false,
        risk_status: "unknown"
      })
    ]);
    const checkpoints = await testPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM alpha_decision_checkpoints`
    );
    expect(checkpoints.rows[0]?.count).toBe("6");
  });

  it("claims and completes a checkpoint atomically with exact-pool quote evidence", async () => {
    const [claim] = await store.claimDueCheckpoints({ workerId: "alpha-tape-worker" });
    expect(claim).toMatchObject({
      poolAddress: "TapeEligiblePool111",
      horizonSeconds: 0,
      entryRawAmounts: {}
    });
    if (!claim) throw new Error("Expected the due zero-second checkpoint.");

    const quotes = [600, 2500, 10000].flatMap((notional) => [
      quote({ direction: "buy", notional: notional as 600 | 2500 | 10000 }),
      quote({ direction: "sell", notional: notional as 600 | 2500 | 10000 })
    ]);
    await expect(
      store.completeCheckpoint(claim, "alpha-tape-worker", {
        exactPairStatus: "live",
        priceUsd: 0.001,
        liquidityUsd: 20_000,
        buys5m: 20,
        sells5m: 10,
        uniqueBuyersSinceDecision: 3,
        uniqueSellersSinceDecision: 1,
        identityIndependenceStatus: "unknown",
        liquidityRemoved: false,
        marketObservedAt: new Date().toISOString(),
        marketProvider: "dexscreener-exact-pair",
        marketProviderLatencyMs: 20,
        quotes
      })
    ).resolves.toBe(true);
    await expect(
      store.completeCheckpoint(claim, "alpha-tape-worker", {
        exactPairStatus: "provider-error",
        identityIndependenceStatus: "unknown",
        quotes
      })
    ).resolves.toBe(false);

    const summary = await store.getSummary();
    expect(summary).toMatchObject({
      decisions: 4,
      researchEligible: 1,
      paperEligible: 0,
      completedCheckpoints: 1,
      quoteRows: 6,
      quotedRows: 6,
      identityUnknownDecisions: 4
    });
  });

  it("rejects nullable passed-risk and quoted-route evidence at the database boundary", async () => {
    await expect(
      testPool.query(
        `UPDATE alpha_decision_tape
         SET mint_authority_revoked = NULL
         WHERE pool_address = 'TapeEligiblePool111'`
      )
    ).rejects.toThrow();
    await expect(
      testPool.query(
        `UPDATE alpha_execution_quote_evidence
         SET route_pool_address = NULL
         WHERE status = 'quoted-not-filled'`
      )
    ).rejects.toThrow();

    const preserved = await testPool.query<{
      risk_rows: number;
      quote_rows: number;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM alpha_decision_tape
          WHERE risk_status = 'passed' AND mint_authority_revoked IS TRUE)::integer AS risk_rows,
         (SELECT COUNT(*) FROM alpha_execution_quote_evidence
          WHERE status = 'quoted-not-filled'
            AND route_pool_address = expected_pool_address)::integer AS quote_rows`
    );
    expect(preserved.rows[0]).toEqual({ risk_rows: 3, quote_rows: 6 });
  });

  async function seedPool(input: {
    tokenAddress: string;
    poolAddress: string;
    creatorAddress?: string;
    riskKnown: boolean;
    createdMinutesAgo?: number;
    creatorTradeMinutesAgo?: number;
    dex?: string;
  }): Promise<void> {
    const createdAt = new Date(Date.now() - (input.createdMinutesAgo ?? 3) * 60_000).toISOString();
    await testPool.query(
      `INSERT INTO tokens (
         chain, address, symbol, name, decimals, creator_address, first_seen_at, metadata
       ) VALUES (
         'solana', $1, 'TAPE', 'Tape token', 6, $2, $3,
         CASE WHEN $4::boolean THEN jsonb_build_object(
           'tokenRiskKnown', true,
           'tokenRiskPassed', true,
           'mintAuthorityRevoked', true,
           'freezeAuthorityRevoked', true,
           'top10HolderPercent', 10,
           'tokenProgram', 'spl-token',
           'tokenExtensionEvidenceKnown', true,
           'blockingTokenExtensions', '[]'::jsonb
         ) ELSE '{}'::jsonb END
       )`,
      [input.tokenAddress, input.creatorAddress ?? null, createdAt, input.riskKnown]
    );
    await testPool.query(
      `INSERT INTO pools (
         chain, pool_address, dex, base_token_address, quote_token_address,
         created_at, liquidity_usd, volume_5m_usd, price_usd, raw
       ) VALUES (
         'solana', $1, $5, $2, $3, $4, 20000, 5000, 0.001,
         jsonb_build_object(
           'buys5m', 20,
           'sells5m', 10,
           'tradeCoverage', jsonb_build_object('complete', true)
         )
       )`,
      [input.poolAddress, input.tokenAddress, usdcMint, createdAt, input.dex ?? "TapeProgram111"]
    );
    if (input.creatorTradeMinutesAgo !== undefined && input.creatorAddress) {
      const observedAt = new Date(Date.now() - input.creatorTradeMinutesAgo * 60_000).toISOString();
      await testPool.query(
        `INSERT INTO wallet_trade_events (
           idempotency_key, chain, wallet_address, token_address, quote_token_address,
           pool_address, side, base_amount, quote_amount, execution_price_usd,
           quote_value_usd, data_quality, signature, slot, provider, observed_at,
           strategy_version, raw
         ) VALUES (
           $1, 'solana', $2, $3, $4, $5, 'buy', 1000, 1, 0.001,
           1, 'observed-execution', $6, 440999999, 'integration', $7,
           'evidence-v1', '{}'::jsonb
         )`,
        [
          `creator-trade:${input.poolAddress}`,
          input.creatorAddress,
          input.tokenAddress,
          usdcMint,
          input.poolAddress,
          `creator-signature:${input.poolAddress}`,
          observedAt
        ]
      );
    }
    await testPool.query(
      `INSERT INTO chain_event_inbox (
         idempotency_key, chain, signature, slot, event_type, token_address,
         pool_address, occurred_at, received_at, processed_at, finalized_at,
         commitment, source, decoder_version, status, payload
       ) VALUES (
         $1, 'solana', $2, 441000000, 'pool_created', $3, $4, $5, NOW(), NOW(), NOW(),
         'finalized', 'integration', 'integration-v1', 'processed', '{}'::jsonb
       )`,
      [
        `event:${input.poolAddress}`,
        `signature:${input.poolAddress}`,
        input.tokenAddress,
        input.poolAddress,
        createdAt
      ]
    );
    if (input.riskKnown) {
      await testPool.query(
        `INSERT INTO token_risk_assessments (
           chain, token_address, calculated_at, score, risk_score, confidence,
           sub_scores, reasons, warnings
         ) VALUES (
           'solana', $1, NOW(), 100, 0, 90,
           '{"authoritySafety":100,"holderDistribution":90}'::jsonb,
           '["Required token safety evidence passed."]'::jsonb,
           '[]'::jsonb
         )`,
        [input.tokenAddress]
      );
    }
  }

  async function seedPopulatedUpgrade(): Promise<void> {
    await testPool.query(
      `INSERT INTO tokens (
         chain, address, symbol, name, decimals, first_seen_at, metadata
       )
       SELECT 'solana', 'PopulatedUpgradeMint' || value::text,
              'OLD', 'Pre-052 token', 6, NOW() - INTERVAL '1 day', '{}'::jsonb
       FROM generate_series(1, 1000) value`
    );
    await testPool.query(
      `INSERT INTO pools (
         chain, pool_address, dex, base_token_address, quote_token_address,
         created_at, liquidity_usd, volume_5m_usd, price_usd, raw
       )
       SELECT 'solana', 'PopulatedUpgradePool' || value::text, 'OldProgram111',
              'PopulatedUpgradeMint' || value::text, $1,
              NOW() - INTERVAL '1 day', 20000, 5000, 0.001,
              '{"buys5m":20,"sells5m":10,"tradeCoverage":{"complete":true}}'::jsonb
       FROM generate_series(1, 1000) value`,
      [usdcMint]
    );
  }
});

function quote(input: {
  direction: "buy" | "sell";
  notional: 600 | 2500 | 10000;
}): AlphaExecutionQuoteEvidence {
  return {
    direction: input.direction,
    notionalUsdCents: input.notional,
    positionSource: "new-buy",
    status: "quoted-not-filled",
    inputMint: input.direction === "buy" ? usdcMint : "TapeEligibleMint111",
    outputMint: input.direction === "buy" ? "TapeEligibleMint111" : usdcMint,
    rawInputAmount: "6000000",
    rawExpectedOutputAmount: "1200000000",
    rawMinimumOutputAmount: "1152000000",
    slippageBps: 400,
    priceImpactPercent: 0.03,
    expectedPoolAddress: "TapeEligiblePool111",
    routePoolAddress: "TapeEligiblePool111",
    provider: "jupiter-swap-v2-order",
    observedAt: new Date().toISOString()
  };
}
