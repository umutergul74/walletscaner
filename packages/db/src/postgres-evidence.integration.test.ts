import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calculateWalletSignalOutcome, recordFirstWalletEntry } from "@memecoin-alpha/core";
import type { PaperTrade, WalletAlphaSignalEvidence } from "@memecoin-alpha/shared";
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
    const createdAt = new Date().toISOString();
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
          baseToken: { symbol: "MEME", name: "Meme Token" },
          priceUsd: "0.001",
          marketCap: 100_000,
          volume: { m5: 8_000 }
        })
      ]
    );
    await testPool.query(
      `INSERT INTO token_risk_assessments (
         chain, token_address, calculated_at, score, risk_score, confidence,
         sub_scores, reasons, warnings
       ) VALUES ('solana', 'MintQualified111', $1, 100, 0, 90, '{}', '["passed"]', '[]')`,
      [createdAt]
    );

    const options = {
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      maxAgeMinutes: 30,
      minimumLiquidityUsd: 10_000,
      minimumVolume5mUsd: 5_000,
      excludedTokenAddresses: ["So11111111111111111111111111111111111111112"]
    };
    expect(await telegramStore.enqueueQualifiedPools(options)).toBe(1);
    expect(await telegramStore.enqueueQualifiedPools(options)).toBe(0);

    const claimed = await telegramStore.claim({
      workerId: "telegram-test-worker",
      limit: 5,
      leaseSeconds: 60
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      eventType: "qualified-pool",
      sourceKey: "PoolQualified111",
      payload: {
        tokenAddress: "MintQualified111",
        liquidityUsd: 25_000,
        volume5mUsd: 8_000
      }
    });
    expect(await telegramStore.complete(claimed[0]!.id, "telegram-test-worker")).toBe(true);
  });

  it("deduplicates Telegram status buckets", async () => {
    const status = await telegramStore.getPipelineStatus();
    expect(await telegramStore.enqueueStatus("periodic:1", status)).toBe(true);
    expect(await telegramStore.enqueueStatus("periodic:1", status)).toBe(false);
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
      failed: 0
    });
  });

  it("reads operational health from bounded working-set queries", async () => {
    await expect(repository.getPipelineHealth()).resolves.toMatchObject({
      database: "ok",
      processedCountEstimated: true,
      inbox: { pending: 0, processing: 0, retry: 0, dead_letter: 0 }
    });
  });

  afterAll(async () => {
    if (testPool) {
      await testPool.end();
    }
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
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
        (await testPool.query("SELECT COUNT(*) AS count FROM quote_price_observations")).rows[0]
          ?.count
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
      (await testPool.query("DELETE FROM swaps WHERE idempotency_key = $1", [
        "entry-source-swap"
      ])).rowCount
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
    expect(await repository.saveWalletSignalOutcome(provisionalOutcome)).toBe(true);
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
    expect(payloadAudit.rows[0]?.payload_sha256).toBe(
      payloadAudit.rows[0]?.calculated_sha256
    );
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
