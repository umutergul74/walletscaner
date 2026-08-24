import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calculateWalletSignalOutcome, recordFirstWalletEntry } from "@memecoin-alpha/core";
import type {
  PaperTrade,
  WalletAlphaScoreSnapshot,
  WalletAlphaSignalEvidence,
  WalletSignalOutcomeEvidence
} from "@memecoin-alpha/shared";
import {
  createParsedInstructionPoolDecoder,
  decodePoolDiscoveries
} from "@memecoin-alpha/providers";
import { buildCanonicalEvidenceReport } from "../../../scripts/research/evidence-report-builder";
import {
  buildWalletAlphaReport,
  processWalletAlphaQueue
} from "../../../scripts/research/wallet-alpha-report-builder";
import { PostgresRepository } from "./postgres-repository";
import { TelegramNotificationStore } from "./telegram-notification-store";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = databaseUrl ? describe : describe.skip;

integrationDescribe("PostgreSQL evidence pipeline", () => {
  const adminPool = new pg.Pool({ connectionString: databaseUrl });
  const schema = `evidence_test_${Date.now()}`;
  let testPool: pg.Pool;
  let repository: PostgresRepository;
  let telegramStore: TelegramNotificationStore;

  beforeAll(async () => {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    testPool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`
    });
    const migrations = (await readdir("scripts/migrations"))
      .filter((filename) => /^\d+.*\.sql$/.test(filename))
      .sort();
    for (const migration of migrations) {
      await testPool.query(await readFile(`scripts/migrations/${migration}`, "utf8"));
    }
    repository = new PostgresRepository(testPool);
    telegramStore = new TelegramNotificationStore(testPool);
  });

  it("persists one Telegram notifier start watermark across restarts", async () => {
    const first = await telegramStore.initializeStartedAt(5);
    const second = await telegramStore.initializeStartedAt(0);
    expect(second).toBe(first);
  });

  it("delivers one risk-passed, liquid pool notification exactly once", async () => {
    const createdAt = new Date(Date.now() - 6 * 60_000).toISOString();
    await testPool.query(
      `INSERT INTO tokens (chain, address, symbol, name, first_seen_at)
       VALUES ('solana', 'MintQualified111', 'MEME', 'Meme Token', $1)`,
      [createdAt]
    );
    await testPool.query(
      `INSERT INTO pools (
         chain, pool_address, dex, base_token_address, quote_token_address,
         created_at, liquidity_usd, token_symbol, token_name, volume_5m_usd,
         price_usd, market_cap_usd, raw
       ) VALUES (
         'solana', 'PoolQualified111', 'test-dex', 'MintQualified111',
         'So11111111111111111111111111111111111111112', $1, 25000, 'MEME',
         'Meme Token', 8000, 0.001, 100000, $2::jsonb
       )`,
      [
        createdAt,
        JSON.stringify({
          source: "dexscreener-compact-v2",
          priceUsd: "0.001",
          marketCap: 100_000,
          volume5mUsd: 8_000,
          buys5m: 11,
          sells5m: 9,
          tradeCoverage: { complete: true }
        })
      ]
    );
    await testPool.query(
      `INSERT INTO token_risk_assessments (
         chain, token_address, calculated_at, score, risk_score, confidence,
         sub_scores, reasons, warnings
       ) VALUES (
         'solana', 'MintQualified111', $1, 100, 0, 90,
         '{"authoritySafety":100,"holderDistribution":82}', '["passed"]', '[]'
       )`,
      [createdAt]
    );

    const options = {
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      maxAgeMinutes: 30,
      minimumLiquidityUsd: 10_000,
      minimumVolume5mUsd: 5_000,
      excludedTokenAddresses: ["So11111111111111111111111111111111111111112"]
    };
    expect((await telegramStore.enqueueQualifiedPools(options)).inserted).toBe(1);
    expect((await telegramStore.enqueueQualifiedPools(options)).inserted).toBe(0);

    const claimed = await telegramStore.claim({
      workerId: "telegram-test-worker",
      limit: 5,
      leaseSeconds: 60
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      eventType: "qualified-pool",
      sourceKey: "strict-flow-v2-20260817:MintQualified111",
      payload: {
        qualificationVersion: "strict-flow-v2-20260817",
        tokenAddress: "MintQualified111",
        liquidityUsd: 25_000,
        volume5mUsd: 8_000,
        buys5m: 11,
        sells5m: 9,
        transactions5m: 20,
        top10HolderPercent: 18
      }
    });
    expect(await telegramStore.complete(claimed[0]!.id, "telegram-test-worker")).toBe(true);
  });

  it("deduplicates Telegram status buckets", async () => {
    const status = await telegramStore.getPipelineStatus("status-empty-v1");
    expect(await telegramStore.enqueueStatus("periodic:1", status)).toBe(true);
    expect(await telegramStore.enqueueStatus("periodic:1", status)).toBe(false);
  });

  it("reports wallet-alpha backlog only for the active strategy", async () => {
    await testPool.query(
      `INSERT INTO wallet_alpha_work_queue (
         chain, wallet_address, strategy_version, revision, completed_revision
       ) VALUES
         ('solana', 'StatusActivePending', 'status-active-v1', 2, 1),
         ('solana', 'StatusActiveComplete', 'status-active-v1', 1, 1),
         ('solana', 'StatusStalePending', 'status-stale-v2', 9, 0)`
    );

    const status = await telegramStore.getPipelineStatus("status-active-v1");
    expect(status.alphaQueuePending).toBe(1);
  });

  it("preserves work arriving during an incremental wallet-alpha lease", async () => {
    const firstTrade = {
      idempotencyKey: "queue-trade-1",
      chain: "solana" as const,
      walletAddress: "QueueWallet111",
      tokenAddress: "QueueToken111",
      side: "buy" as const,
      baseAmount: 10,
      executionPriceUsd: 1,
      quoteValueUsd: 10,
      poolCreatedAt: "2026-07-15T00:00:00.000Z",
      poolAgeMinutes: 1,
      dataQuality: "observed-execution" as const,
      signature: "queue-signature-1",
      slot: 1,
      provider: "test",
      observedAt: "2026-07-15T00:01:00.000Z",
      strategyVersion: "queue-v1",
      raw: {}
    };
    expect(await repository.saveWalletTradeEvent(firstTrade)).toBe(true);
    const firstClaim = await repository.claimWalletAlphaWork({
      strategyVersion: "queue-v1",
      workerId: "worker-1",
      limit: 1,
      leaseSeconds: 60
    });
    expect(firstClaim).toHaveLength(1);

    expect(
      await repository.saveWalletTradeEvent({
        ...firstTrade,
        idempotencyKey: "queue-trade-2",
        signature: "queue-signature-2",
        slot: 2,
        observedAt: "2026-07-15T00:02:00.000Z"
      })
    ).toBe(true);
    expect(await repository.completeWalletAlphaWork(firstClaim[0]!)).toBe(true);
    expect(await repository.getWalletAlphaWorkSummary("queue-v1")).toMatchObject({ pending: 1 });

    const secondClaim = await repository.claimWalletAlphaWork({
      strategyVersion: "queue-v1",
      workerId: "worker-2",
      limit: 1,
      leaseSeconds: 60
    });
    expect(secondClaim[0]?.revision).toBeGreaterThan(firstClaim[0]!.revision);
    expect(await repository.completeWalletAlphaWork(secondClaim[0]!)).toBe(true);
    expect(await repository.getWalletAlphaWorkSummary("queue-v1")).toEqual({
      pending: 0,
      processing: 0,
      failed: 0,
      backgroundPending: 0,
      elevatedPending: 0,
      signalPending: 0
    });
  });

  it("orders ready wallet-alpha work by the indexed retry boundary", async () => {
    await testPool.query(
      `INSERT INTO wallet_alpha_work_queue (
         chain, wallet_address, strategy_version, revision, completed_revision,
         not_before, updated_at
       ) VALUES
         ('solana', 'IndexedReadyEarlier', 'claim-order-v1', 1, 0,
          NOW() - INTERVAL '2 hours', NOW()),
         ('solana', 'IndexedReadyLater', 'claim-order-v1', 1, 0,
          NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 day')`
    );

    const candidates = await repository.listWalletAlphaWorkCandidates("claim-order-v1", 2);
    expect(candidates.map((candidate) => candidate.walletAddress)).toEqual([
      "IndexedReadyEarlier",
      "IndexedReadyLater"
    ]);

    const claimed = await repository.claimWalletAlphaWork({
      strategyVersion: "claim-order-v1",
      workerId: "indexed-claim-worker",
      limit: 1,
      leaseSeconds: 60
    });
    expect(claimed[0]?.walletAddress).toBe("IndexedReadyEarlier");
    expect(await repository.completeWalletAlphaWork(claimed[0]!)).toBe(true);
  });

  it("does not join wallet outcomes across strategy boundaries", async () => {
    await testPool.query(
      `INSERT INTO wallet_entry_signals (
         idempotency_key, chain, wallet_address, token_address,
         observed_entry_price_usd, observed_liquidity_usd, cohort,
         repeat_wallet_count, flow_evidence, signature, slot, provider,
         observed_at, strategy_version
       ) VALUES (
         'cross-strategy-entry', 'solana', 'CrossStrategyWallet', 'CrossStrategyToken',
         1, 10000, 'integration', 1, '{}'::jsonb, 'cross-strategy-signature',
         1, 'integration', '2026-08-23T00:00:00.000Z', 'entry-strategy-v1'
       );
       INSERT INTO wallet_signal_outcomes (
         idempotency_key, entry_idempotency_key, chain, horizon_minutes, status,
         estimated_round_trip_cost_pct, exit_strategy, rugged, signature, slot,
         provider, observed_at, strategy_version, raw
       ) VALUES (
         'cross-strategy-outcome', 'cross-strategy-entry', 'solana', 5, 'provisional',
         3, 'fixed-horizon', FALSE, 'cross-strategy-outcome-signature', 2,
         'integration', '2026-08-23T00:05:00.000Z', 'outcome-strategy-v1', '{}'::jsonb
       )`
    );

    expect(
      await repository.listWalletSignalOutcomesForWallets(
        ["CrossStrategyWallet"],
        "outcome-strategy-v1",
        "2026-08-22T00:00:00.000Z",
        10
      )
    ).toEqual([]);
  });

  it("queues only successfully superseded wallet scores and cascades queue cleanup", async () => {
    const firstAt = "2026-08-20T00:00:00.000Z";
    const unchangedAt = "2026-08-20T00:01:00.000Z";
    const outOfOrderAt = "2026-08-20T00:01:30.000Z";
    const changedAt = "2026-08-20T00:02:00.000Z";
    const first: WalletAlphaScoreSnapshot = {
      chain: "solana",
      walletAddress: "SupersessionWallet111",
      strategyVersion: "score-supersession-v1",
      calculatedAt: firstAt,
      status: "observed",
      profitabilityScore: 1,
      followabilityScore: 1,
      overallScore: 1,
      completedPositions: 1,
      uniqueTokens: 1,
      activeDays: 1,
      metrics: {} as WalletAlphaScoreSnapshot["metrics"],
      gates: { observed: true, watch: false, candidate: false, validatedPaper: false },
      reasons: ["initial"]
    };

    await repository.saveWalletAlphaScore(first);
    await repository.saveWalletAlphaScore({ ...first, calculatedAt: unchangedAt });
    expect(
      await testPool.query(
        `SELECT 1 FROM wallet_alpha_scores
         WHERE wallet_address = $1 AND strategy_version = $2`,
        [first.walletAddress, first.strategyVersion]
      )
    ).toHaveProperty("rowCount", 1);
    expect(
      await testPool.query(
        `SELECT 1 FROM wallet_alpha_score_supersessions
         WHERE wallet_address = $1 AND strategy_version = $2`,
        [first.walletAddress, first.strategyVersion]
      )
    ).toHaveProperty("rowCount", 0);

    const changed = {
      ...first,
      calculatedAt: changedAt,
      profitabilityScore: 2,
      overallScore: 2,
      reasons: ["changed"]
    };
    await repository.saveWalletAlphaScore(changed);
    await repository.saveWalletAlphaScore(changed);

    const afterChanged = await testPool.query<{
      calculated_at: Date;
      superseded_at: Date;
    }>(
      `SELECT calculated_at, superseded_at
       FROM wallet_alpha_score_supersessions
       WHERE wallet_address = $1 AND strategy_version = $2
       ORDER BY calculated_at`,
      [first.walletAddress, first.strategyVersion]
    );
    expect(afterChanged.rows).toEqual([
      {
        calculated_at: new Date(firstAt),
        superseded_at: new Date(changedAt)
      }
    ]);
    expect(
      await testPool.query(
        `SELECT 1 FROM wallet_alpha_scores
         WHERE wallet_address = $1 AND strategy_version = $2`,
        [first.walletAddress, first.strategyVersion]
      )
    ).toHaveProperty("rowCount", 2);

    await repository.saveWalletAlphaScore({
      ...changed,
      calculatedAt: outOfOrderAt,
      profitabilityScore: 3,
      overallScore: 3,
      reasons: ["out-of-order"]
    });
    const outOfOrderQueue = await testPool.query<{
      calculated_at: Date;
      superseded_at: Date;
    }>(
      `SELECT calculated_at, superseded_at
       FROM wallet_alpha_score_supersessions
       WHERE wallet_address = $1 AND strategy_version = $2
       ORDER BY calculated_at`,
      [first.walletAddress, first.strategyVersion]
    );
    expect(outOfOrderQueue.rows).toEqual([
      { calculated_at: new Date(firstAt), superseded_at: new Date(changedAt) },
      { calculated_at: new Date(outOfOrderAt), superseded_at: new Date(changedAt) }
    ]);

    await testPool.query(
      `DELETE FROM wallet_alpha_scores
       WHERE chain = $1 AND wallet_address = $2 AND strategy_version = $3
         AND calculated_at = $4`,
      [first.chain, first.walletAddress, first.strategyVersion, firstAt]
    );
    const afterCascade = await testPool.query<{ calculated_at: Date }>(
      `SELECT calculated_at
       FROM wallet_alpha_score_supersessions
       WHERE wallet_address = $1 AND strategy_version = $2`,
      [first.walletAddress, first.strategyVersion]
    );
    expect(afterCascade.rows).toEqual([{ calculated_at: new Date(outOfOrderAt) }]);
  });

  it("reads operational health from bounded working-set queries", async () => {
    await expect(repository.getPipelineHealth()).resolves.toMatchObject({
      database: "ok",
      processedCountEstimated: true,
      inbox: { pending: 0, processing: 0, retry: 0, dead_letter: 0 }
    });
  });

  it("persists immutable discovery gaps and enqueues opened/recovered Telegram transitions once", async () => {
    const openedAt = "2026-08-21T00:01:00.000Z";
    const input = {
      idempotencyKey: "coverage-incident-integration-1",
      chain: "solana" as const,
      provider: "solana-rpc-discovery",
      programAddress: "CoverageProgram111",
      reason: "head_slot_lag" as const,
      gapStartedAt: "2026-08-21T00:00:00.000Z",
      openedAt,
      clusterSlot: 1_000,
      sourceSlot: 700,
      slotLag: 300,
      lastWebsocketMessageAt: "2026-08-21T00:00:00.000Z",
      silenceMs: 60_000,
      subscriptionAckTimeoutCount: 0,
      successfulSubscriptionAckCount: 1,
      metadata: {
        breachReasons: ["head_slot_lag"],
        coverageDisposition: "alpha_excluded_unreconciled"
      }
    };
    const opened = await repository.openIngestionCoverageIncident(input);
    const duplicate = await repository.openIngestionCoverageIncident({
      ...input,
      idempotencyKey: "coverage-incident-integration-duplicate"
    });
    expect(duplicate.idempotencyKey).toBe(opened.idempotencyKey);
    expect(await repository.listOpenIngestionCoverageIncidents(input.provider)).toEqual([
      expect.objectContaining({
        idempotencyKey: input.idempotencyKey,
        programAddress: input.programAddress,
        slotLag: 300
      })
    ]);

    const degraded = await telegramStore.getPipelineStatus("coverage-status-v1");
    expect(degraded).toMatchObject({
      pipelineStatus: "degraded",
      openCoverageIncidentCount: 1,
      openCoverageIncidents: [
        {
          incidentId: input.idempotencyKey,
          programAddress: input.programAddress,
          gapStartedAt: input.gapStartedAt,
          coverageDisposition: "alpha_excluded_unreconciled"
        }
      ]
    });
    expect(await telegramStore.enqueueCoverageIncidentTransitions("coverage-status-v1")).toBe(1);
    expect(await telegramStore.enqueueCoverageIncidentTransitions("coverage-status-v1")).toBe(0);

    expect(
      await repository.markIngestionCoverageIncidentRestart(
        input.idempotencyKey,
        "attempted",
        "2026-08-21T00:01:01.000Z"
      )
    ).toBe(true);
    expect(
      await repository.markIngestionCoverageIncidentRestart(
        input.idempotencyKey,
        "completed",
        "2026-08-21T00:01:02.000Z"
      )
    ).toBe(true);
    expect(
      await repository.closeIngestionCoverageIncident(input.idempotencyKey, {
        closedAt: "2026-08-21T00:03:00.000Z",
        clusterSlot: 1_100,
        sourceSlot: 1_099,
        metadata: {
          healthySamples: 2,
          coverageDisposition: "alpha_excluded_unreconciled"
        }
      })
    ).toBe(true);
    expect(await repository.listOpenIngestionCoverageIncidents(input.provider)).toHaveLength(0);
    expect(await telegramStore.enqueueCoverageIncidentTransitions("coverage-status-v1")).toBe(1);
    expect(await telegramStore.enqueueCoverageIncidentTransitions("coverage-status-v1")).toBe(0);

    const durable = await testPool.query<{
      reason: string;
      resolution: string;
      opened_messages: number;
      recovered_messages: number;
    }>(
      `SELECT
         incident.reason,
         incident.resolution,
         COUNT(*) FILTER (
           WHERE message.source_key = 'coverage-incident:opened:' || incident.idempotency_key
         )::integer AS opened_messages,
         COUNT(*) FILTER (
           WHERE message.source_key =
             'coverage-incident:transport-recovered:' || incident.idempotency_key
         )::integer AS recovered_messages
       FROM ingestion_coverage_incidents AS incident
       LEFT JOIN telegram_notification_outbox AS message
         ON message.event_type = 'status'
        AND message.source_key LIKE 'coverage-incident:%:' || incident.idempotency_key
       WHERE incident.idempotency_key = $1
       GROUP BY incident.reason, incident.resolution`,
      [input.idempotencyKey]
    );
    expect(durable.rows[0]).toEqual({
      reason: "head_slot_lag",
      resolution: "transport_recovered_gap_unreconciled",
      opened_messages: 1,
      recovered_messages: 1
    });
    await expect(
      testPool.query(
        `UPDATE ingestion_coverage_incidents SET gap_started_at = opened_at
         WHERE idempotency_key = $1`,
        [input.idempotencyKey]
      )
    ).rejects.toThrow(/opening evidence is immutable/);
    await expect(
      testPool.query(`DELETE FROM ingestion_coverage_incidents WHERE idempotency_key = $1`, [
        input.idempotencyKey
      ])
    ).rejects.toThrow(/history is append-only/);
  });

  it("coalesces stopped-notifier coverage churn to the latest state per program", async () => {
    const programAddress = "CoverageChurnProgram111";
    const first = await repository.openIngestionCoverageIncident({
      idempotencyKey: "coverage-churn-first",
      chain: "solana",
      provider: "coverage-churn-provider",
      programAddress,
      reason: "backfill_truncated",
      gapStartedAt: "2026-08-21T01:00:00.000Z",
      openedAt: "2026-08-21T01:01:00.000Z",
      subscriptionAckTimeoutCount: 0,
      successfulSubscriptionAckCount: 0,
      metadata: { coverageDisposition: "alpha_excluded_unreconciled" }
    });
    await repository.closeIngestionCoverageIncident(first.idempotencyKey, {
      closedAt: "2026-08-21T01:02:00.000Z",
      metadata: { coverageDisposition: "alpha_excluded_unreconciled" }
    });
    const second = await repository.openIngestionCoverageIncident({
      idempotencyKey: "coverage-churn-second",
      chain: "solana",
      provider: "coverage-churn-provider",
      programAddress,
      reason: "backfill_truncated",
      gapStartedAt: "2026-08-21T01:03:00.000Z",
      openedAt: "2026-08-21T01:04:00.000Z",
      subscriptionAckTimeoutCount: 0,
      successfulSubscriptionAckCount: 0,
      metadata: { coverageDisposition: "alpha_excluded_unreconciled" }
    });
    await repository.closeIngestionCoverageIncident(second.idempotencyKey, {
      closedAt: "2026-08-21T01:05:00.000Z",
      metadata: { coverageDisposition: "alpha_excluded_unreconciled" }
    });

    expect(await telegramStore.enqueueCoverageIncidentTransitions("coverage-status-v1")).toBe(1);
    expect(await telegramStore.enqueueCoverageIncidentTransitions("coverage-status-v1")).toBe(0);
    expect(
      await testPool.query<{ source_key: string }>(
        `SELECT source_key
         FROM telegram_notification_outbox
         WHERE event_type = 'status'
           AND payload#>>'{coverageTransition,programAddress}' = $1
         ORDER BY created_at`,
        [programAddress]
      )
    ).toMatchObject({
      rows: [
        {
          source_key: "coverage-incident:transport-recovered:coverage-churn-second"
        }
      ]
    });
  });

  afterAll(async () => {
    if (testPool) {
      await testPool.end();
    }
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  });

  it("persists 200 outcome lifecycle changes in one bounded batch", async () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({
      idempotency_key: `batch-entry-${index}`,
      chain: "solana",
      wallet_address: `BatchWallet${index}`,
      token_address: `BatchToken${index}`,
      pool_address: `BatchPool${index}`,
      observed_entry_price_usd: 1,
      observed_liquidity_usd: 25_000,
      cohort: "repeat-wallet+controlled-flow",
      repeat_wallet_count: 2,
      flow_evidence: { controlledFlow: true, tokenRiskKnown: true, tokenRiskPassed: true },
      signature: `batch-entry-signature-${index}`,
      slot: index + 1,
      provider: "test",
      observed_at: "2026-08-16T00:00:00.000Z",
      strategy_version: "batch-evidence-v1"
    }));
    await testPool.query(
      `INSERT INTO wallet_entry_signals (
         idempotency_key, chain, wallet_address, token_address, pool_address,
         observed_entry_price_usd, observed_liquidity_usd, cohort,
         repeat_wallet_count, flow_evidence, signature, slot, provider,
         observed_at, strategy_version
       )
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS entry(
         idempotency_key text, chain text, wallet_address text, token_address text,
         pool_address text, observed_entry_price_usd numeric,
         observed_liquidity_usd numeric, cohort text, repeat_wallet_count integer,
         flow_evidence jsonb, signature text, slot bigint, provider text,
         observed_at timestamptz, strategy_version text
       )`,
      [JSON.stringify(entries)]
    );
    const outcomes: WalletSignalOutcomeEvidence[] = entries.flatMap((entry, index) =>
      (["fixed-horizon", "tp15-sl20-20m"] as const).map((exitStrategy) => ({
        idempotencyKey: `batch-outcome-${index}-${exitStrategy}`,
        entryIdempotencyKey: entry.idempotency_key,
        chain: "solana" as const,
        horizonMinutes: 20,
        status: "provisional" as const,
        estimatedRoundTripCostPct: 3,
        exitStrategy,
        rugged: false,
        signature: entry.signature,
        slot: entry.slot,
        provider: "test",
        observedAt: "2026-08-16T00:01:00.000Z",
        strategyVersion: entry.strategy_version,
        raw: {}
      }))
    );

    const startedAt = performance.now();
    expect(await repository.saveWalletSignalOutcomes(outcomes)).toBe(200);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    expect(await repository.saveWalletSignalOutcomes(outcomes)).toBe(0);
    const queue = await testPool.query(
      `SELECT COUNT(*)::integer AS rows, MIN(revision)::integer AS min_revision,
              MAX(revision)::integer AS max_revision
       FROM wallet_alpha_work_queue
       WHERE strategy_version = 'batch-evidence-v1'`
    );
    expect(queue.rows[0]).toMatchObject({ rows: 100, min_revision: 1, max_revision: 1 });
  });

  it("serializes concurrent quote replays across primary and natural identities", async () => {
    const primaryObservation = {
      idempotencyKey: "concurrent-quote-primary",
      chain: "solana" as const,
      quoteTokenAddress: "ConcurrentQuotePrimary",
      priceUsd: 144.25,
      confidenceUsd: 0.08,
      source: "pyth-benchmarks",
      quality: "oracle-historical" as const,
      publishTime: "2026-08-20T00:00:01.000Z",
      observedAt: "2026-08-20T00:00:02.000Z",
      stalenessSeconds: 1,
      raw: { feedId: "primary-feed", tradeSignature: "primary-a" }
    };
    const primaryResults = await Promise.all([
      repository.saveQuotePriceObservation(primaryObservation),
      repository.saveQuotePriceObservation({
        ...primaryObservation,
        observedAt: "2026-08-20T00:00:03.000Z",
        stalenessSeconds: 2,
        raw: { feedId: "primary-feed", tradeSignature: "primary-b" }
      })
    ]);
    expect(primaryResults.sort()).toEqual([false, true]);

    const naturalObservation = {
      ...primaryObservation,
      idempotencyKey: "concurrent-quote-natural-a",
      quoteTokenAddress: "ConcurrentQuoteNatural",
      publishTime: "2026-08-20T00:01:01.000Z",
      raw: { feedId: "natural-feed", tradeSignature: "natural-a" }
    };
    const naturalResults = await Promise.all([
      repository.saveQuotePriceObservation(naturalObservation),
      repository.saveQuotePriceObservation({
        ...naturalObservation,
        idempotencyKey: "concurrent-quote-natural-b",
        observedAt: "2026-08-20T00:01:03.000Z",
        stalenessSeconds: 2,
        raw: { feedId: "natural-feed", tradeSignature: "natural-b" }
      })
    ]);
    expect(naturalResults.sort()).toEqual([false, true]);
    expect(
      Number(
        (
          await testPool.query(
            `SELECT COUNT(*) AS count
             FROM quote_price_observations
             WHERE quote_token_address IN ('ConcurrentQuotePrimary', 'ConcurrentQuoteNatural')`
          )
        ).rows[0]?.count
      )
    ).toBe(2);

    await expect(
      repository.saveQuotePriceObservation({ ...primaryObservation, priceUsd: 145.25 })
    ).rejects.toThrow("price_usd");
    await expect(
      repository.saveQuotePriceObservation({
        ...naturalObservation,
        idempotencyKey: "concurrent-quote-natural-mismatch",
        confidenceUsd: 0.09
      })
    ).rejects.toThrow("confidence_usd");
  });

  it("runs mocked discovery through outcome and canonical decision reporting", async () => {
    const decoder = createParsedInstructionPoolDecoder({
      programId: "Dex111",
      instructionTypes: ["initializePool"]
    });
    const discoveries = decodePoolDiscoveries(
      {
        address: "Dex111",
        signature: "discovery-sig",
        slot: 100,
        observedAt: "2026-07-05T00:00:00.000Z",
        transaction: {
          transaction: {
            message: {
              instructions: [
                {
                  programId: "Dex111",
                  parsed: {
                    type: "initializePool",
                    info: {
                      pool: "Pool111",
                      baseMint: "Mint111",
                      quoteMint: "So111"
                    }
                  }
                }
              ]
            }
          }
        }
      },
      [decoder]
    );
    const discovery = discoveries[0]!;
    await repository.upsertToken({
      chain: "solana",
      address: discovery.baseTokenAddress,
      symbol: "MOCK",
      name: "Mock token",
      firstSeenAt: discovery.observedAt,
      metadata: {}
    });
    await repository.upsertPool({
      chain: "solana",
      poolAddress: discovery.poolAddress,
      dex: discovery.programId,
      baseTokenAddress: discovery.baseTokenAddress,
      createdAt: discovery.createdAt,
      liquidityUsd: 20_000,
      priceUsd: 1,
      marketCapUsd: 90_000,
      volume5mUsd: 5_000,
      volume1hUsd: 5_000,
      txns5m: { buys: 20, sells: 10 },
      raw: {
        source: "dexscreener-compact-v2",
        volume1hUsd: 5_000,
        buys5m: 20,
        sells5m: 10,
        marketCap: 90_000
      }
    });
    await expect(repository.getPool("solana", discovery.poolAddress)).resolves.toMatchObject({
      poolAddress: discovery.poolAddress,
      baseTokenAddress: discovery.baseTokenAddress,
      marketCapUsd: 90_000,
      volume1hUsd: 5_000,
      txns5m: { buys: 20, sells: 10 }
    });
    const quoteObservation = {
      idempotencyKey: "pyth-sol-usd-quote-1",
      chain: "solana" as const,
      quoteTokenAddress: "So111",
      priceUsd: 150,
      confidenceUsd: 0.1,
      source: "pyth-benchmarks",
      quality: "oracle-historical" as const,
      publishTime: "2026-07-05T00:00:59.000Z",
      observedAt: "2026-07-05T00:01:01.000Z",
      stalenessSeconds: 1,
      raw: { feedId: "sol-usd" }
    };
    expect(await repository.saveQuotePriceObservation(quoteObservation)).toBe(true);
    expect(await repository.saveQuotePriceObservation(quoteObservation)).toBe(false);
    const primaryReplay = {
      ...quoteObservation,
      observedAt: "2026-07-05T00:01:02.000Z",
      stalenessSeconds: 2,
      raw: { feedId: "sol-usd", tradeSignature: "primary-retry" }
    };
    const naturalReplay = {
      ...quoteObservation,
      idempotencyKey: "pyth-sol-usd-quote-natural-retry",
      observedAt: "2026-07-05T00:01:03.000Z",
      stalenessSeconds: 3,
      raw: { feedId: "sol-usd", tradeSignature: "natural-retry" }
    };
    await expect(
      Promise.all([
        repository.saveQuotePriceObservation(primaryReplay),
        repository.saveQuotePriceObservation(naturalReplay)
      ])
    ).resolves.toEqual([false, false]);
    await expect(
      repository.saveQuotePriceObservation({
        ...quoteObservation,
        idempotencyKey: "pyth-sol-usd-quote-conflicting-price",
        priceUsd: 151
      })
    ).rejects.toThrow("price_usd");
    expect(
      await repository.findQuotePriceObservationNear(
        "solana",
        "So111",
        "2026-07-05T00:01:20.000Z",
        60
      )
    ).toEqual(quoteObservation);
    expect(
      await repository.findQuotePriceObservationNear(
        "solana",
        "So111",
        "2026-07-05T00:03:00.000Z",
        30
      )
    ).toBeUndefined();
    expect(
      Number(
        (
          await testPool.query(
            `SELECT COUNT(*) AS count
             FROM quote_price_observations
             WHERE chain = 'solana'
               AND quote_token_address = 'So111'
               AND source = 'pyth-benchmarks'
               AND publish_time = '2026-07-05T00:00:59.000Z'`
          )
        ).rows[0]?.count
      )
    ).toBe(1);
    await repository.saveOnchainSwap({
      idempotencyKey: "entry-source-swap",
      chain: "solana",
      signature: "entry-sig",
      slot: 101,
      poolAddress: "Pool111",
      traderAddress: "Wallet111",
      inputTokenAddress: "So111",
      outputTokenAddress: "Mint111",
      observedAt: "2026-07-05T00:01:00.000Z",
      provider: "mock-solana-rpc",
      strategyVersion: "evidence-v1",
      raw: {}
    });
    const entry = await recordFirstWalletEntry(repository, {
      chain: "solana",
      walletAddress: "Wallet111",
      tokenAddress: "Mint111",
      poolAddress: "Pool111",
      sourceSwapIdempotencyKey: "entry-source-swap",
      observedEntryPriceUsd: 1,
      observedLiquidityUsd: 20_000,
      cohort: "repeat-wallet+controlled-flow",
      repeatWalletCount: 2,
      flowEvidence: { controlledFlow: true },
      signature: "entry-sig",
      slot: 101,
      provider: "mock-solana-rpc",
      observedAt: "2026-07-05T00:01:00.000Z",
      strategyVersion: "evidence-v1"
    });
    expect(
      (await testPool.query("DELETE FROM swaps WHERE idempotency_key = $1", ["entry-source-swap"]))
        .rowCount
    ).toBe(1);
    expect(await repository.listWalletEntrySignals("Wallet111")).toContainEqual(
      expect.objectContaining({ sourceSwapIdempotencyKey: "entry-source-swap" })
    );
    const price = {
      idempotencyKey: "price-22",
      chain: "solana" as const,
      tokenAddress: "Mint111",
      poolAddress: "Pool111",
      priceUsd: 1.1,
      liquidityUsd: 22_000,
      rugged: false,
      signature: "price-sig",
      slot: 102,
      provider: "mock-dexscreener",
      observedAt: "2026-07-05T00:23:00.000Z",
      strategyVersion: "evidence-v1",
      raw: {}
    };
    await repository.savePriceObservation(price);
    const provisionalOutcome = calculateWalletSignalOutcome(
      entry.signal,
      [],
      "2026-07-05T00:05:00.000Z"
    );
    const managedProvisionalOutcome = calculateWalletSignalOutcome(
      entry.signal,
      [],
      "2026-07-05T00:05:00.000Z",
      { exitStrategy: "tp15-sl20-20m" }
    );
    const revisionBeforeBatch = Number(
      (
        await testPool.query(
          `SELECT revision FROM wallet_alpha_work_queue
           WHERE chain = 'solana'
             AND wallet_address = 'Wallet111'
             AND strategy_version = 'evidence-v1'`
        )
      ).rows[0]?.revision ?? 0
    );
    expect(
      await repository.saveWalletSignalOutcomes([provisionalOutcome, managedProvisionalOutcome])
    ).toBe(2);
    const revisionAfterBatch = Number(
      (
        await testPool.query(
          `SELECT revision FROM wallet_alpha_work_queue
           WHERE chain = 'solana'
             AND wallet_address = 'Wallet111'
             AND strategy_version = 'evidence-v1'`
        )
      ).rows[0]?.revision ?? 0
    );
    expect(revisionAfterBatch - revisionBeforeBatch).toBe(1);
    expect(
      await repository.saveWalletSignalOutcome({
        ...provisionalOutcome,
        outcomePriceUsd: 1.05,
        signature: "provisional-price",
        observedAt: "2026-07-05T00:10:00.000Z"
      })
    ).toBe(false);
    const matureOutcome = calculateWalletSignalOutcome(
      entry.signal,
      [price],
      "2026-07-05T00:25:00.000Z"
    );
    expect(await repository.saveWalletSignalOutcome(matureOutcome)).toBe(true);
    expect(
      await repository.saveWalletSignalOutcome({
        ...matureOutcome,
        observedAt: "2026-07-05T00:26:00.000Z",
        raw: { shouldNotRewriteFrozenOutcome: true }
      })
    ).toBe(false);
    await repository.saveHypothesisRun({
      idempotencyKey: "hypothesis-run",
      runId: "run-1",
      chain: "solana",
      hypothesisKey: "repeat-wallet+controlled-flow",
      cohort: "primary",
      verdict: "watch",
      signalKeys: ["Mint111"],
      metrics: {
        signalCount: 1,
        averageReturnPct: 7,
        medianReturnPct: 7,
        averageReturnExBestPct: 0,
        bestWinnerShare: 1,
        hitRate: 1,
        averageDrawdownPct: 0,
        worstReturnPct: 7,
        canonicalSourceLinked: 1,
        replayPassed: 0
      },
      decisionReason: "Mock integration evidence.",
      signature: "derived:run-1",
      slot: 102,
      provider: "evidence-strategy-search",
      observedAt: "2026-07-05T00:25:00.000Z",
      strategyVersion: "evidence-v1"
    });

    const report = await buildCanonicalEvidenceReport(
      repository,
      "evidence-v1",
      { providerStatus: "ok" },
      "2026-07-05T00:25:00.000Z"
    );

    expect(report.funnel).toMatchObject({
      discoveredPools: 1,
      observedEntries: 1,
      matureOutcomes: 1
    });
    expect(report.recommendedMode).toBe("paper-watch");
    expect(report.goalCompletionAudit.completed).toBe(false);
  });

  it("promotes a legacy exploratory entry without retaining its stale outcome", async () => {
    const exploratory = await recordFirstWalletEntry(repository, {
      chain: "solana",
      walletAddress: "PromotionWallet111",
      tokenAddress: "PromotionMint111",
      observedEntryPriceUsd: 1,
      observedLiquidityUsd: 15_000,
      cohort: "excluded-uncontrolled-flow",
      repeatWalletCount: 0,
      flowEvidence: {},
      signature: "exploratory-entry",
      slot: 0,
      provider: "dexscreener",
      observedAt: "2026-07-05T01:00:00.000Z",
      strategyVersion: "evidence-v1"
    });
    await repository.saveWalletSignalOutcome(
      calculateWalletSignalOutcome(
        exploratory.signal,
        [
          {
            idempotencyKey: "promotion-stale-price",
            chain: "solana",
            tokenAddress: "PromotionMint111",
            priceUsd: 2,
            liquidityUsd: 20_000,
            rugged: false,
            signature: "promotion-stale-price",
            slot: 0,
            provider: "dexscreener",
            observedAt: "2026-07-05T01:20:00.000Z",
            strategyVersion: "evidence-v1",
            raw: {}
          }
        ],
        "2026-07-05T01:21:00.000Z"
      )
    );
    await repository.saveOnchainSwap({
      idempotencyKey: "promotion-swap-111",
      chain: "solana",
      signature: "promotion-swap-signature",
      slot: 200,
      poolAddress: "PromotionPool111",
      traderAddress: "PromotionWallet111",
      inputTokenAddress: "So111",
      outputTokenAddress: "PromotionMint111",
      observedAt: "2026-07-05T02:00:00.000Z",
      provider: "mock-solana-rpc",
      strategyVersion: "evidence-v1",
      raw: {}
    });

    const promoted = await recordFirstWalletEntry(repository, {
      chain: "solana",
      walletAddress: "PromotionWallet111",
      tokenAddress: "PromotionMint111",
      poolAddress: "PromotionPool111",
      sourceSwapIdempotencyKey: "promotion-swap-111",
      observedEntryPriceUsd: 1.25,
      observedLiquidityUsd: 25_000,
      cohort: "controlled-flow-control",
      repeatWalletCount: 1,
      flowEvidence: { controlledFlow: true },
      signature: "promotion-entry-price",
      slot: 201,
      provider: "mock-dexscreener",
      observedAt: "2026-07-05T02:01:00.000Z",
      strategyVersion: "evidence-v1"
    });

    expect(promoted.inserted).toBe(true);
    expect(await repository.listWalletEntrySignals("PromotionWallet111")).toEqual([
      expect.objectContaining({
        idempotencyKey: exploratory.signal.idempotencyKey,
        sourceSwapIdempotencyKey: "promotion-swap-111",
        observedEntryPriceUsd: 1.25,
        observedAt: "2026-07-05T02:01:00.000Z"
      })
    ]);
    expect(
      (await repository.listWalletSignalOutcomes()).filter(
        (outcome) => outcome.entryIdempotencyKey === exploratory.signal.idempotencyKey
      )
    ).toEqual([]);
  });

  it("persists a wallet buy/sell ledger and keeps one-position evidence below signal gates", async () => {
    await repository.saveWalletTradeEvent({
      idempotencyKey: "ledger-buy",
      chain: "solana",
      walletAddress: "LedgerWallet111",
      tokenAddress: "LedgerMint111",
      poolAddress: "LedgerPool111",
      side: "buy",
      baseAmount: 100,
      executionPriceUsd: 1,
      poolCreatedAt: "2026-07-05T03:00:00.000Z",
      poolAgeMinutes: 5,
      dataQuality: "observed-execution",
      signature: "ledger-buy-sig",
      slot: 300,
      provider: "mock-solana-rpc",
      observedAt: "2026-07-05T03:05:00.000Z",
      strategyVersion: "evidence-v1",
      raw: {}
    });
    await repository.saveWalletTradeEvent({
      idempotencyKey: "ledger-sell",
      chain: "solana",
      walletAddress: "LedgerWallet111",
      tokenAddress: "LedgerMint111",
      poolAddress: "LedgerPool111",
      side: "sell",
      baseAmount: 100,
      executionPriceUsd: 1.5,
      poolCreatedAt: "2026-07-05T03:00:00.000Z",
      poolAgeMinutes: 15,
      dataQuality: "observed-execution",
      signature: "ledger-sell-sig",
      slot: 301,
      provider: "mock-solana-rpc",
      observedAt: "2026-07-05T03:15:00.000Z",
      strategyVersion: "evidence-v1",
      raw: {}
    });

    const report = await buildWalletAlphaReport(
      repository,
      "evidence-v1",
      "2026-07-10T00:00:00.000Z",
      30
    );

    expect(report.coverage).toMatchObject({
      tradeEvents: 2,
      completedPositions: 1
    });
    expect(report.mode).toBe("observe-only");
    expect(report.livePaperSignals).toEqual([]);
    expect(await repository.listWalletTradeEvents("LedgerWallet111")).toHaveLength(2);
  });

  it("admits only evidence-mature wallets to production alpha claims", async () => {
    const saveTrade = (walletAddress: string, index: number) =>
      repository.saveWalletTradeEvent({
        idempotencyKey: `admission-${walletAddress}-${index}`,
        chain: "solana",
        walletAddress,
        tokenAddress: `AdmissionMint${index}`,
        poolAddress: `AdmissionPool${index}`,
        side: "buy",
        baseAmount: 100,
        executionPriceUsd: 1,
        dataQuality: "observed-execution",
        signature: `admission-signature-${walletAddress}-${index}`,
        slot: 350 + index,
        provider: "integration-test",
        observedAt: new Date(Date.now() + index * 1_000).toISOString(),
        strategyVersion: "admission-integration-v1",
        raw: {}
      });

    await saveTrade("AdmissionSingleTrade", 0);
    for (let index = 0; index < 6; index += 1) {
      await saveTrade("AdmissionSixTrades", index + 1);
    }

    const candidates = await repository.listWalletAlphaWorkCandidates(
      "admission-integration-v1",
      100
    );
    const probes = await repository.probeWalletAlphaAdmission(
      candidates,
      new Date(Date.now() - 90 * 24 * 60 * 60 * 1_000).toISOString(),
      6,
      3
    );
    expect(probes).toHaveLength(2);
    expect(
      Object.fromEntries(
        probes.map((probe) => [
          probe.walletAddress,
          { trades: probe.tradeEventCount, entries: probe.entryCount }
        ])
      )
    ).toEqual({
      AdmissionSingleTrade: { trades: 1, entries: 0 },
      AdmissionSixTrades: { trades: 6, entries: 0 }
    });

    const result = await processWalletAlphaQueue(
      repository,
      "admission-integration-v1",
      new Date(Date.now() + 60_000).toISOString(),
      30,
      {
        materializeHistorical: false,
        workBatchSize: 2,
        maxWorkBatches: 1,
        minimumTradeEvents: 6,
        minimumEntries: 3
      }
    );

    expect(result).toMatchObject({
      processedWallets: 1,
      skippedLowEvidenceWallets: 1,
      failedWallets: 0
    });
  });

  it("prioritizes safe source entries and preserves an elevated revision arriving during a lease", async () => {
    const strategyVersion = "priority-integration-v1";
    await repository.saveWalletTradeEvent({
      idempotencyKey: "priority-background-buy",
      chain: "solana",
      walletAddress: "PriorityBackgroundWallet",
      tokenAddress: "PriorityBackgroundMint",
      poolAddress: "PriorityBackgroundPool",
      side: "buy",
      baseAmount: 1,
      executionPriceUsd: 1,
      dataQuality: "observed-execution",
      signature: "priority-background-signature",
      slot: 10_001,
      provider: "integration-test",
      observedAt: new Date().toISOString(),
      strategyVersion,
      raw: {}
    });
    await repository.saveWalletEntrySignal({
      idempotencyKey: "priority-safe-entry",
      chain: "solana",
      walletAddress: "PrioritySafeWallet",
      tokenAddress: "PrioritySafeMint",
      poolAddress: "PrioritySafePool",
      sourceSwapIdempotencyKey: "priority-safe-swap",
      observedEntryPriceUsd: 1,
      observedLiquidityUsd: 25_000,
      cohort: "controlled-flow-control",
      repeatWalletCount: 1,
      flowEvidence: {
        controlledFlow: true,
        tokenRiskKnown: true,
        tokenRiskPassed: true
      },
      signature: "priority-safe-signature",
      slot: 10_002,
      provider: "integration-test",
      observedAt: new Date().toISOString(),
      strategyVersion
    });

    expect(await repository.listWalletAlphaWorkCandidates(strategyVersion, 2)).toEqual([
      expect.objectContaining({ walletAddress: "PrioritySafeWallet", priority: 2 }),
      expect.objectContaining({ walletAddress: "PriorityBackgroundWallet", priority: 0 })
    ]);
    const [claimed] = await repository.claimWalletAlphaWork({
      strategyVersion,
      workerId: "priority-worker-1",
      limit: 1
    });
    expect(claimed).toEqual(
      expect.objectContaining({ walletAddress: "PrioritySafeWallet", revision: 1, priority: 2 })
    );

    await repository.saveWalletTradeEvent({
      idempotencyKey: "priority-safe-late-buy",
      chain: "solana",
      walletAddress: "PrioritySafeWallet",
      tokenAddress: "PrioritySafeMint",
      poolAddress: "PrioritySafePool",
      side: "buy",
      baseAmount: 1,
      executionPriceUsd: 1.1,
      dataQuality: "observed-execution",
      signature: "priority-safe-late-signature",
      slot: 10_003,
      provider: "integration-test",
      observedAt: new Date().toISOString(),
      strategyVersion,
      raw: {}
    });
    expect(await repository.completeWalletAlphaWork(claimed!)).toBe(true);
    expect(await repository.getWalletAlphaWorkSummary(strategyVersion)).toMatchObject({
      pending: 2,
      backgroundPending: 1,
      signalPending: 1
    });

    const [reclaimed] = await repository.claimWalletAlphaWork({
      strategyVersion,
      workerId: "priority-worker-2",
      limit: 1
    });
    expect(reclaimed).toEqual(
      expect.objectContaining({ walletAddress: "PrioritySafeWallet", revision: 2, priority: 2 })
    );
    expect(await repository.completeWalletAlphaWork(reclaimed!)).toBe(true);
    expect(await repository.getWalletAlphaWorkSummary(strategyVersion)).toMatchObject({
      pending: 1,
      backgroundPending: 1,
      signalPending: 0
    });
  });

  it("emits a transaction-bound wake hint for signal-relevant work", async () => {
    const listener = await testPool.connect();
    await listener.query("LISTEN wallet_alpha_work");
    const notification = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("wallet-alpha notification timed out")),
        2_000
      );
      listener.once("notification", (message) => {
        clearTimeout(timeout);
        resolve(message.payload ?? "");
      });
    });
    try {
      await repository.saveWalletEntrySignal({
        idempotencyKey: "priority-notify-entry",
        chain: "solana",
        walletAddress: "PriorityNotifyWallet",
        tokenAddress: "PriorityNotifyMint",
        poolAddress: "PriorityNotifyPool",
        sourceSwapIdempotencyKey: "priority-notify-swap",
        observedEntryPriceUsd: 1,
        observedLiquidityUsd: 25_000,
        cohort: "controlled-flow-control",
        repeatWalletCount: 1,
        flowEvidence: {
          controlledFlow: true,
          tokenRiskKnown: true,
          tokenRiskPassed: true
        },
        signature: "priority-notify-signature",
        slot: 10_004,
        provider: "integration-test",
        observedAt: new Date().toISOString(),
        strategyVersion: "priority-notify-v1"
      });
      expect(JSON.parse(await notification)).toEqual({
        strategyVersion: "priority-notify-v1",
        priority: 2
      });
    } finally {
      listener.removeAllListeners("notification");
      await listener.query("UNLISTEN wallet_alpha_work");
      listener.release();
    }
  });

  it("normalizes pending age for an old-release upsert during migration rollout", async () => {
    await testPool.query(
      `INSERT INTO wallet_alpha_work_queue (
         chain, wallet_address, strategy_version, revision, completed_revision
       ) VALUES ('solana', 'LegacyQueueWallet', 'legacy-queue-v1', 1, 1)`
    );
    await testPool.query(
      `INSERT INTO wallet_alpha_work_queue (
         chain, wallet_address, strategy_version, revision, updated_at, not_before
       ) VALUES ('solana', 'LegacyQueueWallet', 'legacy-queue-v1', 1, NOW(), NOW())
       ON CONFLICT (chain, wallet_address, strategy_version) DO UPDATE SET
         revision = wallet_alpha_work_queue.revision + 1,
         updated_at = NOW(),
         not_before = LEAST(wallet_alpha_work_queue.not_before, NOW())`
    );
    const result = await testPool.query(
      `SELECT revision, completed_revision, priority, pending_since
       FROM wallet_alpha_work_queue
       WHERE wallet_address = 'LegacyQueueWallet' AND strategy_version = 'legacy-queue-v1'`
    );
    expect(result.rows[0]).toMatchObject({
      revision: "2",
      completed_revision: "1",
      priority: 0
    });
    expect(result.rows[0]?.pending_since).toBeInstanceOf(Date);
  });

  it("claims canonical events idempotently and records terminal failures", async () => {
    const receivedAt = new Date().toISOString();
    const event = {
      idempotencyKey: "canonical-event-1",
      chain: "solana" as const,
      signature: "canonical-sig-1",
      slot: 500,
      eventType: "swap",
      occurredAt: "2026-07-11T10:00:00.000Z",
      receivedAt,
      commitment: "confirmed" as const,
      source: "integration-test",
      decoderVersion: "test-v1",
      payload: { swap: true }
    };
    expect(await repository.insertChainEvent(event)).toBe(true);
    expect(await repository.insertChainEvent(event)).toBe(false);
    const payloadAudit = await testPool.query<{
      payload_sha256: string;
      calculated_sha256: string;
      payload_compacted_at: Date | null;
    }>(
      `SELECT
         inbox.payload_sha256,
         encode(digest(payload.payload::text, 'sha256'), 'hex') AS calculated_sha256,
         inbox.payload_compacted_at
       FROM chain_event_inbox AS inbox
       JOIN chain_event_payloads AS payload
         ON payload.event_idempotency_key = inbox.idempotency_key
       WHERE inbox.idempotency_key = $1`,
      [event.idempotencyKey]
    );
    expect(payloadAudit.rows[0]?.payload_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(payloadAudit.rows[0]?.payload_sha256).toBe(payloadAudit.rows[0]?.calculated_sha256);
    expect(payloadAudit.rows[0]?.payload_compacted_at).toBeNull();
    const claimed = await repository.claimChainEvents({ workerId: "parser-1", limit: 10 });
    expect(claimed).toEqual([
      expect.objectContaining({
        idempotencyKey: event.idempotencyKey,
        attemptCount: 1,
        payload: event.payload
      })
    ]);
    expect(
      await repository.failChainEvent(event.idempotencyKey, "parser-1", "fixture failure", {
        maxAttempts: 1
      })
    ).toMatchObject({ status: "dead_letter" });
    expect(await repository.getPipelineHealth()).toMatchObject({
      deadLetterCount: 1,
      backlog: 0
    });
  });

  it("returns only currently qualified wallet-alpha rankings", async () => {
    const calculatedAt = new Date().toISOString();
    const earlierAt = new Date(new Date(calculatedAt).getTime() - 60_000).toISOString();
    const insertScore = async (
      walletAddress: string,
      scoreAt: string,
      status: string,
      overallScore: number
    ) => {
      await testPool.query(
        `INSERT INTO wallet_alpha_scores (
           chain, wallet_address, strategy_version, calculated_at, status,
           profitability_score, followability_score, overall_score,
           completed_positions, unique_tokens, active_days, metrics, gates, reasons
         ) VALUES (
           'solana', $1, 'ranking-fast-path-v1', $2, $3,
           $4, $4, $4, 10, 5, 3, '{}', '{}', '[]'
         )`,
        [walletAddress, scoreAt, status, overallScore]
      );
    };

    await insertScore("RankingWalletDemoted", earlierAt, "candidate", 99);
    await insertScore("RankingWalletDemoted", calculatedAt, "observed", 10);
    await insertScore("RankingWalletQualified", calculatedAt, "watch", 80);

    const rankings = await repository.listWalletAlphaRankings({
      strategyVersion: "ranking-fast-path-v1",
      statuses: ["watch", "candidate", "validated-paper"],
      limit: 100
    });

    expect(rankings.map((score) => score.walletAddress)).toEqual(["RankingWalletQualified"]);
  });

  it("keeps later canonical events behind a retrying partition head", async () => {
    const receivedAt = new Date().toISOString();
    const event = (id: string, slot: number, address: string) => ({
      idempotencyKey: id,
      chain: "solana" as const,
      signature: `${id}-signature`,
      slot,
      eventType: "swap",
      occurredAt: receivedAt,
      receivedAt,
      commitment: "confirmed" as const,
      source: "contiguous-integration-test",
      decoderVersion: "test-v2",
      payload: { address }
    });
    await repository.insertChainEvents([
      event("pg-pool-a-1", 601, "PgPoolA"),
      event("pg-pool-a-2", 602, "PgPoolA"),
      event("pg-pool-b-1", 603, "PgPoolB")
    ]);

    const first = await repository.claimChainEvents({ workerId: "parser-order", limit: 10 });
    expect(first.map((item) => item.idempotencyKey)).toEqual(["pg-pool-a-1", "pg-pool-b-1"]);
    await repository.completeChainEvent("pg-pool-b-1", "parser-order");
    await repository.failChainEvent("pg-pool-a-1", "parser-order", "retrying head", {
      maxAttempts: 3,
      retryAt: new Date(Date.now() + 60_000).toISOString()
    });

    expect(await repository.claimChainEvents({ workerId: "parser-order", limit: 10 })).toEqual([]);
  });

  it("durably marks and escapes PostgreSQL-incompatible NUL payload text", async () => {
    const suffix = Date.now().toString();
    const idempotencyKey = `pg-nul-payload-${suffix}`;
    const receivedAt = new Date().toISOString();
    await expect(
      repository.insertChainEvent({
        idempotencyKey,
        chain: "solana",
        signature: `pg-nul-signature-${suffix}`,
        slot: 650,
        eventType: "swap",
        occurredAt: receivedAt,
        receivedAt,
        commitment: "confirmed",
        source: "nul-integration-test",
        decoderVersion: "test-v1",
        payload: {
          address: "PgNulPool111",
          transaction: {
            parsed: "TRADE\u0000suffix",
            nested: ["A\u0000B"],
            ["key\u0000suffix"]: "value"
          }
        }
      })
    ).resolves.toBe(true);

    const stored = await testPool.query<{
      payload: {
        transaction: { parsed: string; nested: string[]; "key\\u0000suffix": string };
        _walletscanerPayloadEncoding: {
          version: string;
          replacement: string;
          occurrenceCount: number;
          originalPayloadSha256: string;
        };
      };
    }>(
      `SELECT payload
       FROM chain_event_payloads
       WHERE event_idempotency_key = $1`,
      [idempotencyKey]
    );
    expect(stored.rows[0]?.payload.transaction).toEqual({
      parsed: "TRADE\\u0000suffix",
      nested: ["A\\u0000B"],
      "key\\u0000suffix": "value"
    });
    expect(stored.rows[0]?.payload._walletscanerPayloadEncoding).toMatchObject({
      version: "postgres-json-nul-v1",
      replacement: "literal-\\u0000",
      occurrenceCount: 3,
      originalPayloadSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    await testPool.query(
      `UPDATE chain_event_inbox
       SET status = 'processed', processed_at = NOW()
       WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
  });

  it("persists live signatures and gates future canonical events on finalized evidence", async () => {
    const suffix = Date.now().toString();
    const signature = `pg-finality-signature-${suffix}`;
    const address = `PgFinalityProgram${suffix}`;
    const receivedAt = new Date(Date.now() - 10_000).toISOString();
    expect(
      await repository.admitSolanaSignature({
        provider: "integration-rpc",
        address,
        signature,
        slot: 700,
        notifiedAt: receivedAt
      })
    ).toBe(true);
    expect(await repository.listPendingSolanaSignatures("integration-rpc", address, 10)).toEqual([
      expect.objectContaining({ signature, slot: 700 })
    ]);
    expect(await repository.completeSolanaSignature("integration-rpc", address, signature)).toBe(
      true
    );

    await repository.insertChainEvent({
      idempotencyKey: `pg-finality-event-${suffix}`,
      chain: "solana",
      signature,
      slot: 700,
      eventType: "pool_created",
      occurredAt: receivedAt,
      receivedAt,
      commitment: "confirmed",
      requiresFinality: true,
      source: "integration-rpc",
      decoderVersion: "integration-finality-v1",
      payload: { address }
    });
    expect(await repository.claimChainEvents({ workerId: "finality-parser", limit: 10 })).toEqual(
      []
    );
    expect(await repository.listPendingSolanaFinalities(10, 1)).toEqual(
      expect.arrayContaining([expect.objectContaining({ signature, slot: 700 })])
    );
    expect(
      await repository.recordSolanaFinalities([
        {
          signature,
          result: {
            status: "finalized",
            checkedAt: new Date().toISOString(),
            confirmationStatus: "finalized"
          }
        }
      ])
    ).toMatchObject({ checkedSignatures: 1, finalizedEvents: 1, rolledBackEvents: 0 });
    expect(
      (await repository.claimChainEvents({ workerId: "finality-parser", limit: 10 }))[0]
    ).toMatchObject({
      idempotencyKey: `pg-finality-event-${suffix}`,
      commitment: "finalized",
      requiresFinality: true
    });
  });

  it("reconciles an event arriving after its signature was already finalized", async () => {
    const suffix = Date.now().toString();
    const signature = `pg-late-finality-signature-${suffix}`;
    const receivedAt = new Date(Date.now() - 10_000).toISOString();
    const initialKey = `pg-late-finality-initial-${suffix}`;
    const lateKey = `pg-late-finality-event-${suffix}`;
    const event = (idempotencyKey: string, eventType: string) => ({
      idempotencyKey,
      chain: "solana" as const,
      signature,
      slot: 701,
      eventType,
      occurredAt: receivedAt,
      receivedAt,
      commitment: "confirmed" as const,
      requiresFinality: true,
      source: "integration-rpc",
      decoderVersion: "integration-finality-v1",
      payload: { address: `PgLateFinality${suffix}` }
    });

    await repository.insertChainEvent(event(initialKey, "pool_created"));
    await repository.recordSolanaFinalities([
      {
        signature,
        result: {
          status: "finalized",
          checkedAt: new Date().toISOString(),
          confirmationStatus: "finalized"
        }
      }
    ]);
    const initial = await repository.claimChainEvents({
      workerId: "late-finality-parser",
      limit: 1
    });
    expect(initial[0]?.idempotencyKey).toBe(initialKey);
    await repository.completeChainEvent(initialKey, "late-finality-parser");

    await repository.insertChainEvent(event(lateKey, "swap"));
    expect(
      await repository.claimChainEvents({ workerId: "late-finality-parser", limit: 1 })
    ).toEqual([]);
    expect(await repository.reconcileTerminalSolanaFinalityEvents(256)).toEqual({
      checkedSignatures: 0,
      finalizedEvents: 1,
      rolledBackEvents: 0
    });
    expect(
      (await repository.claimChainEvents({ workerId: "late-finality-parser", limit: 1 }))[0]
    ).toMatchObject({
      idempotencyKey: lateKey,
      commitment: "finalized",
      requiresFinality: true
    });
  });

  it("delivers each wallet-alpha signal independently and returns current paper fills", async () => {
    const signal: WalletAlphaSignalEvidence = {
      id: "outbox-alpha-signal",
      chain: "solana",
      tokenAddress: "OutboxMint111",
      strategyVersion: "wallet-alpha-v2",
      detectedAt: "2026-07-11T11:00:00.000Z",
      observedPriceUsd: 1,
      observedLiquidityUsd: 25_000,
      confidence: 75,
      status: "paper-watch",
      walletAddresses: ["OutboxWallet111"],
      evidence: {}
    };
    expect(await repository.saveWalletAlphaSignal(signal)).toBe(true);
    const paperMessage = (
      await repository.claimSignalOutbox({ destination: "paper", workerId: "paper-1" })
    )[0]!;
    const alertMessage = (
      await repository.claimSignalOutbox({ destination: "alert", workerId: "alert-1" })
    )[0]!;
    expect(paperMessage.signalId).toBe(signal.id);
    expect(alertMessage.signalId).toBe(signal.id);
    expect(await repository.completeSignalOutbox(paperMessage.id, "paper-1")).toBe(true);
    expect(await repository.completeSignalOutbox(alertMessage.id, "alert-1")).toBe(true);

    const opened: PaperTrade = {
      id: "paper-fill-1",
      signalId: signal.id,
      strategyVersion: signal.strategyVersion,
      chain: "solana",
      tokenAddress: signal.tokenAddress,
      side: "buy",
      status: "open",
      quantity: 10,
      priceUsd: 1,
      notionalUsd: 10,
      feesUsd: 0.1,
      slippageBps: 100,
      openedAt: "2026-07-11T11:00:01.000Z",
      reason: "paper fill"
    };
    await repository.savePaperTrade(opened);
    await repository.savePaperTrade({
      ...opened,
      side: "sell",
      status: "closed",
      priceUsd: 1.5,
      feesUsd: 0.2,
      closedAt: "2026-07-11T11:10:00.000Z",
      pnlUsd: 4.7,
      reason: "take profit"
    });
    expect(await repository.listPaperTrades()).toContainEqual(
      expect.objectContaining({
        id: opened.id,
        side: "sell",
        status: "closed",
        priceUsd: 1.5,
        feesUsd: 0.2,
        reason: "take profit"
      })
    );
  });
});
