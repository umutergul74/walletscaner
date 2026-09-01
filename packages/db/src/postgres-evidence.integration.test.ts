import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
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
import { ensurePayloadPartitions } from "../../../scripts/maintenance/partition-maintenance";
import { PostgresRepository } from "./postgres-repository";
import { TelegramNotificationStore } from "./telegram-notification-store";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = databaseUrl ? describe : describe.skip;

function qualifiedIntegrationScore(
  walletAddress: string,
  strategyVersion: string
): WalletAlphaScoreSnapshot {
  return {
    chain: "solana",
    walletAddress,
    strategyVersion,
    calculatedAt: new Date(Date.now() - 1_000).toISOString(),
    status: "watch",
    profitabilityScore: 70,
    followabilityScore: 70,
    overallScore: 70,
    completedPositions: 10,
    uniqueTokens: 10,
    activeDays: 5,
    metrics: {} as WalletAlphaScoreSnapshot["metrics"],
    gates: { observed: true, watch: true, candidate: false, validatedPaper: false },
    reasons: ["integration-qualified"]
  };
}

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

  it("records source revisions once per producer statement and never loses a locked invalidation", async () => {
    const strategyVersion = "fifo-continuation-cas-integration-v1";
    const walletAddress = "FifoContinuationWallet111";
    const baseTrade = (index: number) => ({
      idempotencyKey: `fifo-continuation-trade-${index}`,
      chain: "solana" as const,
      walletAddress,
      tokenAddress: "FifoContinuationMint111",
      poolAddress: "FifoContinuationPool111",
      side: "buy" as const,
      baseAmount: 10,
      baseTokenAmount: { rawAmount: `${10_000_000 + index}`, decimals: 6 },
      dataQuality: "observed-balance" as const,
      signature: `fifo-continuation-signature-${index}`,
      slot: 40_000 + index,
      provider: "integration-test",
      observedAt: `2026-08-30T00:0${index}:00.000Z`,
      strategyVersion,
      raw: {}
    });

    expect(
      await repository.getWalletFifoContinuationState(
        "solana",
        walletAddress,
        strategyVersion
      )
    ).toEqual({
      chain: "solana",
      walletAddress,
      strategyVersion,
      tradeRevision: 0,
      realizations: []
    });

    expect(await repository.saveWalletTradeEvent(baseTrade(1))).toBe(true);
    expect(await repository.saveWalletTradeEvent(baseTrade(2))).toBe(true);
    expect(await repository.saveWalletTradeEvent(baseTrade(2))).toBe(false);
    expect(
      await repository.saveWalletTradeEvent({
        ...baseTrade(2),
        raw: { providerDiagnosticOnly: true }
      })
    ).toBe(true);

    const revisionBeforeEnrichment = await testPool.query<{
      revision: string;
      dirty_min_slot: string;
    }>(
      `SELECT revision, dirty_min_slot
       FROM wallet_trade_revisions
       WHERE chain = 'solana' AND wallet_address = $1 AND strategy_version = $2`,
      [walletAddress, strategyVersion]
    );
    expect(revisionBeforeEnrichment.rows[0]).toMatchObject({
      revision: "2",
      dirty_min_slot: "40001"
    });
    expect(
      (await repository.listWalletTradeLedgerInputsForWallets([walletAddress], strategyVersion))[0]
        ?.baseTokenAmount
    ).toEqual({ rawAmount: "10000001", decimals: 6 });
    expect(
      await repository.listWalletTradeLedgerInputsAfter(
        "solana",
        walletAddress,
        strategyVersion,
        {
          slot: 40_001,
          observedAt: "2026-08-30T00:01:00.000Z",
          signature: "fifo-continuation-signature-1",
          idempotencyKey: "fifo-continuation-trade-1"
        }
      )
    ).toEqual([
      expect.objectContaining({
        idempotencyKey: "fifo-continuation-trade-2",
        baseTokenAmount: { rawAmount: "10000002", decimals: 6 },
        raw: {}
      })
    ]);

    const initialPayload = JSON.stringify({ checkpoint: "initial" });
    expect(
      await repository.commitWalletFifoContinuation({
        chain: "solana",
        walletAddress,
        strategyVersion,
        expectedTradeRevision: 2,
        mode: "full-rebuild",
        checkpoint: {
          version: "fifo-continuation-v1",
          payload: initialPayload,
          sha256: createHash("sha256").update(initialPayload).digest("hex"),
          lastOrder: {
            slot: 40_002,
            observedAt: "2026-08-30T00:02:00.000Z",
            signature: "fifo-continuation-signature-2",
            idempotencyKey: "fifo-continuation-trade-2"
          }
        },
        calculatedAt: "2026-08-30T01:00:00.000Z",
        realizations: []
      })
    ).toBe(true);
    expect(
      await repository.getWalletFifoContinuationState(
        "solana",
        walletAddress,
        strategyVersion
      )
    ).toMatchObject({
      tradeRevision: 2,
      realizations: [],
      continuation: {
        version: "fifo-continuation-v1",
        payload: initialPayload,
        sha256: createHash("sha256").update(initialPayload).digest("hex"),
        tradeRevision: 2,
        generation: 1,
        lastOrder: {
          slot: 40_002,
          observedAt: "2026-08-30T00:02:00.000Z",
          signature: "fifo-continuation-signature-2",
          idempotencyKey: "fifo-continuation-trade-2"
        }
      }
    });

    expect(
      await repository.enrichWalletTradePrices({
        idempotencyKey: "fifo-continuation-price-1",
        chain: "solana",
        tokenAddress: "FifoContinuationMint111",
        poolAddress: "FifoContinuationPool111",
        priceUsd: 2,
        liquidityUsd: 25_000,
        rugged: false,
        signature: "fifo-continuation-price-signature-1",
        slot: 40_010,
        provider: "integration-test",
        observedAt: "2026-08-30T00:04:00.000Z",
        strategyVersion,
        raw: {}
      })
    ).toBe(2);

    const revisionAfterEnrichment = await testPool.query<{
      revision: string;
      dirty_order_known: boolean;
      dirty_min_slot: string;
    }>(
      `SELECT revision, dirty_order_known, dirty_min_slot
       FROM wallet_trade_revisions
       WHERE chain = 'solana' AND wallet_address = $1 AND strategy_version = $2`,
      [walletAddress, strategyVersion]
    );
    expect(revisionAfterEnrichment.rows[0]).toMatchObject({
      revision: "3",
      dirty_order_known: true,
      dirty_min_slot: "40001"
    });

    const stalePayload = JSON.stringify({ checkpoint: "stale" });
    expect(
      await repository.commitWalletFifoContinuation({
        chain: "solana",
        walletAddress,
        strategyVersion,
        expectedTradeRevision: 2,
        mode: "append",
        checkpoint: {
          version: "fifo-continuation-v1",
          payload: stalePayload,
          sha256: createHash("sha256").update(stalePayload).digest("hex"),
          lastOrder: {
            slot: 40_002,
            observedAt: "2026-08-30T00:02:00.000Z",
            signature: "fifo-continuation-signature-2",
            idempotencyKey: "fifo-continuation-trade-2"
          }
        },
        calculatedAt: "2026-08-30T01:01:00.000Z",
        realizations: []
      })
    ).toBe(false);

    const lockClient = await testPool.connect();
    const producerClient = await testPool.connect();
    try {
      await lockClient.query("BEGIN");
      await lockClient.query(
        `SELECT revision FROM wallet_trade_revisions
         WHERE chain = 'solana' AND wallet_address = $1 AND strategy_version = $2
         FOR UPDATE`,
        [walletAddress, strategyVersion]
      );

      let producerFinished = false;
      const producerRevision = producerClient
        .query<{ revision: string }>(
          `SELECT record_wallet_trade_revision(
             'solana', $1, $2, 40003, '2026-08-30T00:03:00.000Z',
             'fifo-continuation-signature-3', 'fifo-continuation-trade-3'
           ) AS revision`,
          [walletAddress, strategyVersion]
        )
        .then((result) => {
          producerFinished = true;
          return result;
        });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(producerFinished).toBe(false);

      const acceptedPayload = JSON.stringify({ checkpoint: "accepted" });
      expect(
        (
          await lockClient.query<{ committed: boolean }>(
            `SELECT commit_wallet_fifo_continuation(
               'solana', $1, $2, 3, 'fifo-continuation-v1', $3,
               digest($3, 'sha256'), 40002, '2026-08-30T00:02:00.000Z',
               'fifo-continuation-signature-2', 'fifo-continuation-trade-2',
               '2026-08-30T01:02:00.000Z'
             ) AS committed`,
            [walletAddress, strategyVersion, acceptedPayload]
          )
        ).rows[0]?.committed
      ).toBe(true);
      await lockClient.query("COMMIT");
      expect((await producerRevision).rows[0]?.revision).toBe("4");
    } catch (error) {
      await lockClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      lockClient.release();
      producerClient.release();
    }

    expect(
      (
        await testPool.query<{
          revision: string;
          dirty_order_known: boolean;
          dirty_min_slot: string;
        }>(
          `SELECT revision, dirty_order_known, dirty_min_slot
           FROM wallet_trade_revisions
           WHERE chain = 'solana' AND wallet_address = $1 AND strategy_version = $2`,
          [walletAddress, strategyVersion]
        )
      ).rows[0]
    ).toMatchObject({ revision: "4", dirty_order_known: true, dirty_min_slot: "40003" });
    expect(
      (
        await testPool.query<{ trade_revision: string; generation: string }>(
          `SELECT trade_revision, generation
           FROM wallet_fifo_continuations
           WHERE chain = 'solana' AND wallet_address = $1 AND strategy_version = $2`,
          [walletAddress, strategyVersion]
        )
      ).rows[0]
    ).toMatchObject({ trade_revision: "3", generation: "2" });

    const finalPayload = JSON.stringify({ checkpoint: "final" });
    expect(
      await repository.commitWalletFifoContinuation({
        chain: "solana",
        walletAddress,
        strategyVersion,
        expectedTradeRevision: 4,
        mode: "append",
        checkpoint: {
          version: "fifo-continuation-v1",
          payload: finalPayload,
          sha256: createHash("sha256").update(finalPayload).digest("hex"),
          lastOrder: {
            slot: 40_003,
            observedAt: "2026-08-30T00:03:00.000Z",
            signature: "fifo-continuation-signature-3",
            idempotencyKey: "fifo-continuation-trade-3"
          }
        },
        calculatedAt: "2026-08-30T01:03:00.000Z",
        realizations: [
          {
            realizationId: "fifo-realization-1",
            episodeId: "fifo-episode-1",
            chain: "solana",
            walletAddress,
            tokenAddress: "FifoContinuationMint111",
            strategyVersion,
            roundTripIndex: 1,
            sellEventIdempotencyKey: "fifo-continuation-trade-3",
            openedAt: "2026-08-30T00:01:00.000Z",
            closedAt: "2026-08-30T00:03:00.000Z",
            realizedRawAmount: "1000000",
            remainingRawAmount: "9000000",
            tokenDecimals: 6,
            investedUsd: 2,
            proceedsUsd: 3,
            netPnlUsd: 1,
            netReturnPct: 50,
            highQuality: true,
            priceQuality: "observed-execution",
            exact: true,
            sourceTradeRevision: 4
          }
        ]
      })
    ).toBe(true);
    expect(
      (
        await repository.getWalletFifoContinuationState(
          "solana",
          walletAddress,
          strategyVersion
        )
      ).realizations
    ).toEqual([
      expect.objectContaining({
        realizationId: "fifo-realization-1",
        episodeId: "fifo-episode-1",
        realizedRawAmount: "1000000",
        remainingRawAmount: "9000000",
        tokenDecimals: 6,
        sourceTradeRevision: 4,
        exact: true
      })
    ]);
    expect(
      await testPool.query(
        `SELECT dirty_order_known FROM wallet_trade_revisions
         WHERE chain = 'solana' AND wallet_address = $1 AND strategy_version = $2`,
        [walletAddress, strategyVersion]
      )
    ).toMatchObject({ rows: [{ dirty_order_known: false }] });
    const beforeNoop = await testPool.query(
      `SELECT continuation.ctid::text AS checkpoint_ctid, continuation.generation,
              revision.ctid::text AS revision_ctid
       FROM wallet_fifo_continuations continuation
       JOIN wallet_trade_revisions revision USING (chain, wallet_address, strategy_version)
       WHERE chain='solana' AND wallet_address=$1 AND strategy_version=$2`,
      [walletAddress, strategyVersion]
    );
    expect(
      await repository.commitWalletFifoContinuation({
        chain: "solana",
        walletAddress,
        strategyVersion,
        expectedTradeRevision: 4,
        mode: "append",
        checkpoint: {
          version: "fifo-continuation-v1",
          payload: finalPayload,
          sha256: createHash("sha256").update(finalPayload).digest("hex"),
          lastOrder: {
            slot: 40_003,
            observedAt: "2026-08-30T00:03:00.000Z",
            signature: "fifo-continuation-signature-3",
            idempotencyKey: "fifo-continuation-trade-3"
          }
        },
        calculatedAt: "2026-08-30T01:04:00.000Z",
        realizations: []
      })
    ).toBe(true);
    const afterNoop = await testPool.query(
      `SELECT continuation.ctid::text AS checkpoint_ctid, continuation.generation,
              revision.ctid::text AS revision_ctid
       FROM wallet_fifo_continuations continuation
       JOIN wallet_trade_revisions revision USING (chain, wallet_address, strategy_version)
       WHERE chain='solana' AND wallet_address=$1 AND strategy_version=$2`,
      [walletAddress, strategyVersion]
    );
    expect(afterNoop.rows).toEqual(beforeNoop.rows);
  });

  it("invalidates direct legacy trade statements and ignores raw/provider-only updates", async () => {
    const walletAddress = "LegacyFifoProducerWallet111";
    const strategyVersion = "legacy-fifo-producer-v1";
    await testPool.query(
      `INSERT INTO wallet_trade_events (
         idempotency_key, chain, wallet_address, token_address, side, base_amount,
         data_quality, signature, slot, provider, observed_at, strategy_version, raw
       ) VALUES
         ('legacy-fifo-trade-1', 'solana', $1, 'LegacyFifoMint111', 'buy', 10,
          'observed-balance', 'legacy-fifo-signature-1', 45001, 'legacy-v1',
          '2026-08-30T02:01:00.000Z', $2, '{}'),
         ('legacy-fifo-trade-2', 'solana', $1, 'LegacyFifoMint111', 'sell', 10,
          'observed-balance', 'legacy-fifo-signature-2', 45002, 'legacy-v1',
          '2026-08-30T02:02:00.000Z', $2, '{}')`,
      [walletAddress, strategyVersion]
    );
    expect(
      await testPool.query(
        `SELECT revision, dirty_order_known, dirty_min_slot
         FROM wallet_trade_revisions
         WHERE chain='solana' AND wallet_address=$1 AND strategy_version=$2`,
        [walletAddress, strategyVersion]
      )
    ).toMatchObject({
      rows: [{ revision: "1", dirty_order_known: true, dirty_min_slot: "45001" }]
    });

    const payload = JSON.stringify({ legacyProducer: true });
    expect(
      await repository.commitWalletFifoContinuation({
        chain: "solana",
        walletAddress,
        strategyVersion,
        expectedTradeRevision: 1,
        mode: "full-rebuild",
        checkpoint: {
          version: "fifo-continuation-v1",
          payload,
          sha256: createHash("sha256").update(payload).digest("hex"),
          lastOrder: {
            slot: 45_002,
            observedAt: "2026-08-30T02:02:00.000Z",
            signature: "legacy-fifo-signature-2",
            idempotencyKey: "legacy-fifo-trade-2"
          }
        },
        calculatedAt: "2026-08-30T03:00:00.000Z",
        realizations: []
      })
    ).toBe(true);

    await testPool.query(
      `UPDATE wallet_trade_events
       SET raw = raw || '{"diagnostic":true}'::jsonb,
           provider = 'legacy-v2'
       WHERE wallet_address=$1 AND strategy_version=$2`,
      [walletAddress, strategyVersion]
    );
    expect(
      await testPool.query(
        `SELECT revision, dirty_order_known FROM wallet_trade_revisions
         WHERE chain='solana' AND wallet_address=$1 AND strategy_version=$2`,
        [walletAddress, strategyVersion]
      )
    ).toMatchObject({ rows: [{ revision: "1", dirty_order_known: false }] });

    await testPool.query(
      `UPDATE wallet_trade_events
       SET execution_price_usd = 2, quote_value_usd = base_amount * 2
       WHERE wallet_address=$1 AND strategy_version=$2`,
      [walletAddress, strategyVersion]
    );
    expect(
      await testPool.query(
        `SELECT revision, dirty_order_known, dirty_min_slot
         FROM wallet_trade_revisions
         WHERE chain='solana' AND wallet_address=$1 AND strategy_version=$2`,
        [walletAddress, strategyVersion]
      )
    ).toMatchObject({
      rows: [{ revision: "2", dirty_order_known: true, dirty_min_slot: "45001" }]
    });

    await testPool.query(
      `DELETE FROM wallet_trade_events WHERE wallet_address=$1 AND strategy_version=$2`,
      [walletAddress, strategyVersion]
    );
    expect(
      await testPool.query(
        `SELECT revision, dirty_min_slot FROM wallet_trade_revisions
         WHERE chain='solana' AND wallet_address=$1 AND strategy_version=$2`,
        [walletAddress, strategyVersion]
      )
    ).toMatchObject({ rows: [{ revision: "3", dirty_min_slot: "45001" }] });
  });

  it("pages same-slot FIFO evidence in C order and bounds only the remaining suffix", async () => {
    const strategyVersion = "fifo-page-order-integration-v1";
    const walletAddress = "FifoPageOrderWallet111";
    const observedAt = "2026-08-30T01:00:00.000Z";
    const values = [
      { signature: "b-signature", idempotencyKey: "fifo-page-0" },
      { signature: "a-signature", idempotencyKey: "fifo-page-A" },
      { signature: "Z-signature", idempotencyKey: "fifo-page-z" }
    ];
    for (const value of values) {
      await repository.saveWalletTradeEvent({
        ...value,
        chain: "solana",
        walletAddress,
        tokenAddress: "FifoPageMint111",
        poolAddress: "FifoPagePool111",
        side: "buy",
        baseAmount: 1,
        dataQuality: "observed-balance",
        slot: 50_000,
        provider: "integration-test",
        observedAt,
        strategyVersion,
        raw: { providerPayload: "not-in-scalar-page" }
      });
    }
    const first = await repository.listWalletTradeLedgerInputPage(
      "solana", walletAddress, strategyVersion, undefined, 1
    );
    expect(first.map((trade) => trade.signature)).toEqual(["Z-signature"]);
    expect(first[0]?.raw).toEqual({});
    const second = await repository.listWalletTradeLedgerInputPage(
      "solana", walletAddress, strategyVersion, first[0], 1
    );
    expect(second.map((trade) => trade.signature)).toEqual(["a-signature"]);
    const third = await repository.listWalletTradeLedgerInputPage(
      "solana", walletAddress, strategyVersion, second[0], 1
    );
    expect(third.map((trade) => trade.signature)).toEqual(["b-signature"]);
    const [item] = await repository.claimWalletAlphaWork({
      strategyVersion,
      workerId: "fifo-page-test",
      limit: 1,
      leaseSeconds: 30
    });
    expect(item).toBeDefined();
    expect(
      await repository.probeWalletAlphaEvidenceBounds(item!, observedAt, 1, 1, 1)
    ).toMatchObject({ tradeEventsExceeded: true });
    expect(
      await repository.probeWalletAlphaEvidenceBounds(item!, observedAt, 1, 1, 1, second[0])
    ).toMatchObject({ tradeEventsExceeded: false });
  });

  it("coalesces historical materialization changes into one wallet source revision", async () => {
    const strategyVersion = "fifo-historical-revision-integration-v1";
    const walletAddress = "FifoHistoricalWallet111";
    await testPool.query(
      `INSERT INTO historical_market_observations (
         idempotency_key, chain, token_address, quote_token_address, pool_address,
         trader_address, side, base_amount, quote_amount, price_quote,
         price_usd_estimate, volume_usd_estimate, price_source, confidence,
         signature, slot, provider, observed_at, strategy_version, raw
       ) VALUES
         ('fifo-historical-source-1', 'solana', 'FifoHistoricalMint111', 'So111', NULL,
          $1, 'buy', 10, 20, 2, 2, 20, 'fixture', 0.9,
          'fifo-historical-signature-1', 50001, 'integration-test',
          '2026-08-30T02:01:00.000Z', $2, '{}'),
         ('fifo-historical-source-2', 'solana', 'FifoHistoricalMint111', 'So111', NULL,
          $1, 'sell', 5, 15, 3, 3, 15, 'fixture', 0.9,
          'fifo-historical-signature-2', 50002, 'integration-test',
          '2026-08-30T02:02:00.000Z', $2, '{}')`,
      [walletAddress, strategyVersion]
    );

    expect(await repository.materializeHistoricalWalletTrades(strategyVersion)).toBe(2);
    expect(await repository.materializeHistoricalWalletTrades(strategyVersion)).toBe(0);
    expect(
      (
        await testPool.query<{ revision: string; dirty_min_slot: string }>(
          `SELECT revision, dirty_min_slot
           FROM wallet_trade_revisions
           WHERE chain = 'solana' AND wallet_address = $1 AND strategy_version = $2`,
          [walletAddress, strategyVersion]
        )
      ).rows[0]
    ).toMatchObject({ revision: "1", dirty_min_slot: "50001" });
    expect(
      await testPool.query<{ exact_count: number }>(
        `SELECT COUNT(*) FILTER (
           WHERE base_raw_amount IS NOT NULL OR base_token_decimals IS NOT NULL
         )::int AS exact_count
         FROM wallet_trade_events
         WHERE wallet_address = $1 AND strategy_version = $2`,
        [walletAddress, strategyVersion]
      )
    ).toMatchObject({ rows: [{ exact_count: 0 }] });

    await testPool.query(
      `UPDATE historical_market_observations
       SET price_usd_estimate = price_usd_estimate + 0.5,
           volume_usd_estimate = volume_usd_estimate + 1
       WHERE trader_address = $1 AND strategy_version = $2`,
      [walletAddress, strategyVersion]
    );
    expect(await repository.materializeHistoricalWalletTrades(strategyVersion)).toBe(2);
    expect(
      (
        await testPool.query<{ revision: string; dirty_min_slot: string }>(
          `SELECT revision, dirty_min_slot
           FROM wallet_trade_revisions
           WHERE chain = 'solana' AND wallet_address = $1 AND strategy_version = $2`,
          [walletAddress, strategyVersion]
        )
      ).rows[0]
    ).toMatchObject({ revision: "2", dirty_min_slot: "50001" });
  });

  it("atomically replaces an episode whose deterministic id changed but natural key did not", async () => {
    const strategyVersion = "ledger-natural-key-regression-v1";
    const walletAddress = "LedgerNaturalKeyWallet111";
    const tokenAddress = "LedgerNaturalKeyMint111";
    const openedAt = "2026-08-28T20:00:00.000Z";
    const baseEpisode = {
      chain: "solana" as const,
      walletAddress,
      tokenAddress,
      strategyVersion,
      episodeIndex: 0,
      status: "open" as const,
      openedAt,
      costBasisUsd: 10,
      proceedsUsd: 0,
      realizedPnlUsd: 0,
      remainingRawAmount: "1000",
      tokenDecimals: 6,
      realizedLotCount: 0,
      highQualityPriceCoverage: 1,
      metadata: {}
    };
    const snapshot = (episodeId: string, lotId: string) => ({
      chain: "solana" as const,
      strategyVersion,
      generatedAt: "2026-08-28T20:01:00.000Z",
      walletAddresses: [walletAddress],
      episodes: [{ ...baseEpisode, id: episodeId }],
      lots: [
        {
          id: lotId,
          episodeId,
          sourceEventIdempotencyKey: `${lotId}-source`,
          lotSequence: 0,
          rawAmount: "1000",
          remainingRawAmount: "1000",
          tokenDecimals: 6,
          quoteCostUsd: 10,
          feesUsd: 0,
          slippageUsd: 0,
          openedAt,
          status: "open" as const,
          metadata: {}
        }
      ]
    });

    await expect(
      repository.replaceWalletPositionLedger(snapshot("episode-old", "lot-old"))
    ).resolves.toEqual({ episodeCount: 1, lotCount: 1 });
    await expect(
      repository.replaceWalletPositionLedger(snapshot("episode-new", "lot-new"))
    ).resolves.toEqual({ episodeCount: 1, lotCount: 1 });

    expect(
      await testPool.query<{ id: string }>(
        `SELECT id
         FROM wallet_position_episodes
         WHERE chain = 'solana'
           AND wallet_address = $1
           AND strategy_version = $2`,
        [walletAddress, strategyVersion]
      )
    ).toMatchObject({ rows: [{ id: "episode-new" }] });
    expect(
      await testPool.query<{ id: string; episode_id: string }>(
        `SELECT id, episode_id
         FROM wallet_position_lots
         WHERE episode_id IN ('episode-old', 'episode-new')`
      )
    ).toMatchObject({ rows: [{ id: "lot-new", episode_id: "episode-new" }] });
  });

  it("merges one FIFO suffix without deleting prior closed episodes", async () => {
    const strategyVersion = "ledger-suffix-merge-v1";
    const walletAddress = "LedgerSuffixWallet111";
    const tokenAddress = "LedgerSuffixMint111";
    const episode = (
      id: string,
      episodeIndex: number,
      status: "open" | "realized",
      openedAt: string,
      closedAt?: string
    ) => ({
      id,
      chain: "solana" as const,
      walletAddress,
      tokenAddress,
      strategyVersion,
      episodeIndex,
      status,
      openedAt,
      ...(closedAt ? { closedAt } : {}),
      costBasisUsd: 10,
      proceedsUsd: status === "realized" ? 12 : 0,
      realizedPnlUsd: status === "realized" ? 2 : 0,
      ...(status === "realized" ? { returnPct: 20 } : {}),
      remainingRawAmount: status === "open" ? "1000" : "0",
      tokenDecimals: 6,
      realizedLotCount: status === "realized" ? 1 : 0,
      highQualityPriceCoverage: 1,
      metadata: {}
    });
    const lot = (
      id: string,
      episodeId: string,
      openedAt: string,
      status: "open" | "realized" = "open",
      closedAt?: string
    ) => ({
      id,
      episodeId,
      sourceEventIdempotencyKey: `${id}-source`,
      lotSequence: 1,
      rawAmount: "1000",
      remainingRawAmount: status === "realized" ? "0" : "1000",
      tokenDecimals: 6,
      quoteCostUsd: 10,
      feesUsd: 0,
      slippageUsd: 0,
      openedAt,
      ...(closedAt ? { closedAt } : {}),
      status,
      metadata: {}
    });
    await repository.replaceWalletPositionLedger({
      chain: "solana",
      strategyVersion,
      generatedAt: "2026-08-30T03:00:00.000Z",
      walletAddresses: [walletAddress],
      episodes: [
        episode(
          "ledger-suffix-closed",
          1,
          "realized",
          "2026-08-30T02:00:00.000Z",
          "2026-08-30T02:10:00.000Z"
        ),
        episode("ledger-suffix-open", 2, "open", "2026-08-30T02:20:00.000Z")
      ],
      lots: [
        lot(
          "ledger-suffix-closed-lot",
          "ledger-suffix-closed",
          "2026-08-30T02:00:00.000Z",
          "realized",
          "2026-08-30T02:10:00.000Z"
        ),
        lot("ledger-suffix-old-lot", "ledger-suffix-open", "2026-08-30T02:20:00.000Z")
      ]
    });

    await expect(
      repository.mergeWalletPositionLedger({
        chain: "solana",
        strategyVersion,
        generatedAt: "2026-08-30T03:05:00.000Z",
        walletAddresses: [walletAddress],
        episodes: [
          episode(
            "ledger-suffix-open",
            2,
            "realized",
            "2026-08-30T02:20:00.000Z",
            "2026-08-30T02:30:00.000Z"
          ),
          episode("ledger-suffix-new", 3, "open", "2026-08-30T02:40:00.000Z")
        ],
        lots: [
          lot(
            "ledger-suffix-old-lot",
            "ledger-suffix-open",
            "2026-08-30T02:20:00.000Z",
            "realized",
            "2026-08-30T02:30:00.000Z"
          ),
          lot("ledger-suffix-new-lot", "ledger-suffix-new", "2026-08-30T02:40:00.000Z")
        ]
      })
    ).resolves.toEqual({ episodeCount: 2, lotCount: 1 });

    expect(
      await testPool.query(
        `SELECT id, status FROM wallet_position_episodes
         WHERE wallet_address = $1 AND strategy_version = $2 ORDER BY id`,
        [walletAddress, strategyVersion]
      )
    ).toMatchObject({
      rows: [
        { id: "ledger-suffix-closed", status: "realized" },
        { id: "ledger-suffix-new", status: "open" },
        { id: "ledger-suffix-open", status: "realized" }
      ]
    });
    expect(
      await testPool.query(
        `SELECT id, episode_id FROM wallet_position_lots
         WHERE episode_id LIKE 'ledger-suffix-%' ORDER BY id`
      )
    ).toMatchObject({
      rows: [{ id: "ledger-suffix-new-lot", episode_id: "ledger-suffix-new" }]
    });
  });

  it("creates a missing payload partition without inverting the canonical inbox lock order", async () => {
    const event = {
      idempotencyKey: "partition-lock-order-event",
      chain: "solana" as const,
      signature: "partition-lock-order-signature",
      slot: 1,
      eventType: "swap",
      occurredAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      commitment: "confirmed" as const,
      source: "integration-test",
      decoderVersion: "integration-v1",
      payload: { address: "PartitionLockAddress", transaction: {} }
    };
    expect(await repository.insertChainEvent(event)).toBe(true);
    const blocker = await testPool.connect();
    const partitionName = "chain_event_payloads_20361231";
    await testPool.query(`DROP TABLE IF EXISTS ${partitionName}`);
    try {
      await blocker.query("BEGIN");
      await blocker.query("SET LOCAL lock_timeout = '2s'");
      await blocker.query(
        `UPDATE chain_event_inbox SET last_error = NULL WHERE idempotency_key = $1`,
        [event.idempotencyKey]
      );

      const partitionCreation = ensurePayloadPartitions(testPool, -1, {
        now: new Date("2037-01-01T12:00:00.000Z"),
        lockTimeoutMs: 5_000,
        statementTimeoutMs: 5_000
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      // This parent read would deadlock with the previous payload-parent ->
      // inbox DDL order. It remains immediately available because creation is
      // waiting on the inbox before acquiring the payload-parent lock.
      await expect(
        blocker.query("SELECT 1 FROM chain_event_payloads WHERE FALSE")
      ).resolves.toBeDefined();
      await blocker.query("COMMIT");
      await expect(partitionCreation).resolves.toMatchObject({ created: 1 });
    } finally {
      try {
        await blocker.query("ROLLBACK");
      } catch {
        // The successful path already committed.
      }
      blocker.release();
      await testPool.query(`DROP TABLE IF EXISTS ${partitionName}`);
      await testPool.query("DELETE FROM chain_event_inbox WHERE idempotency_key = $1", [
        event.idempotencyKey
      ]);
    }
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

  it("persists sub-threshold trade pricing without producing premature alpha work", async () => {
    const strategyVersion = "producer-admission-v1";
    const walletAddress = "ProducerAdmissionWallet111";
    const admission = { minimumTradeEvents: 6, minimumEntries: 3, sourceWindowDays: 30 };
    const trade = (index: number) => ({
      idempotencyKey: `producer-admission-trade-${index}`,
      chain: "solana" as const,
      walletAddress,
      tokenAddress: "ProducerAdmissionMint111",
      poolAddress: "ProducerAdmissionPool111",
      side: "buy" as const,
      baseAmount: 10,
      dataQuality: "observed-balance" as const,
      signature: `producer-admission-signature-${index}`,
      slot: 20_000 + index,
      provider: "integration-test",
      observedAt: `2026-08-29T00:0${index}:00.000Z`,
      strategyVersion,
      raw: {}
    });

    for (let index = 0; index < 5; index += 1) {
      expect(await repository.saveWalletTradeEvent(trade(index))).toBe(true);
    }
    const [initialWork] = await repository.claimWalletAlphaWork({
      strategyVersion,
      workerId: "producer-admission-initial",
      limit: 1
    });
    expect(initialWork).toBeDefined();
    expect(await repository.completeWalletAlphaWork(initialWork!)).toBe(true);
    expect(
      await repository.enrichWalletTradePrices(
        {
          idempotencyKey: "producer-admission-price-1",
          chain: "solana",
          tokenAddress: "ProducerAdmissionMint111",
          poolAddress: "ProducerAdmissionPool111",
          priceUsd: 2,
          liquidityUsd: 25_000,
          rugged: false,
          signature: "producer-admission-price-signature-1",
          slot: 20_010,
          provider: "integration-test",
          observedAt: "2026-08-29T00:04:30.000Z",
          strategyVersion,
          raw: {}
        },
        admission
      )
    ).toBe(5);
    expect(await repository.getWalletAlphaWorkSummary(strategyVersion)).toMatchObject({
      pending: 0
    });
    expect(await repository.listWalletTradeEvents(walletAddress)).toHaveLength(5);

    expect(await repository.saveWalletTradeEvent(trade(5))).toBe(true);
    expect(await repository.getWalletAlphaWorkSummary(strategyVersion)).toMatchObject({
      pending: 1,
      backgroundPending: 1
    });
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

  it("bulk-completes only the exact measured wallet-alpha revision", async () => {
    const strategyVersion = "batch-complete-cas-v1";
    await testPool.query(
      `INSERT INTO wallet_alpha_work_queue (
         chain, wallet_address, strategy_version, revision, completed_revision,
         priority, priority_reason, pending_since
       ) VALUES
         ('solana', 'BatchStableWallet', $1, 1, 0, 0, 'test', NOW()),
         ('solana', 'BatchAdvancedWallet', $1, 1, 0, 0, 'test', NOW())`,
      [strategyVersion]
    );
    const measured = await repository.listWalletAlphaWorkCandidates(strategyVersion, 2);
    expect(measured).toHaveLength(2);
    await testPool.query(
      `UPDATE wallet_alpha_work_queue
       SET revision = revision + 1,
           priority = 1,
           priority_reason = 'new-evidence'
       WHERE wallet_address = 'BatchAdvancedWallet'
         AND strategy_version = $1`,
      [strategyVersion]
    );

    expect(await repository.completeWalletAlphaWorkCandidates(measured)).toBe(1);
    const result = await testPool.query(
      `SELECT wallet_address, revision, completed_revision, priority
       FROM wallet_alpha_work_queue
       WHERE strategy_version = $1
       ORDER BY wallet_address`,
      [strategyVersion]
    );
    expect(result.rows).toEqual([
      expect.objectContaining({
        wallet_address: "BatchAdvancedWallet",
        revision: "2",
        completed_revision: "0",
        priority: 1
      }),
      expect.objectContaining({
        wallet_address: "BatchStableWallet",
        revision: "1",
        completed_revision: "1",
        priority: 0
      })
    ]);
  });

  it("uses a payload-free scalar projection for the FIFO scorer hot path", async () => {
    const strategyVersion = "ledger-scalar-projection-v1";
    const walletAddress = "LedgerScalarWallet111";
    await repository.saveWalletTradeEvent({
      idempotencyKey: "ledger-scalar-trade-1",
      chain: "solana",
      walletAddress,
      tokenAddress: "LedgerScalarMint111",
      poolAddress: "LedgerScalarPool111",
      side: "buy",
      baseAmount: 12.5,
      executionPriceUsd: 2,
      quoteValueUsd: 25,
      poolCreatedAt: "2026-08-29T00:00:00.000Z",
      poolAgeMinutes: 1,
      dataQuality: "observed-execution",
      signature: "ledger-scalar-signature-1",
      slot: 99_001,
      provider: "integration-test",
      observedAt: "2026-08-29T00:01:00.000Z",
      strategyVersion,
      raw: { providerPayload: "must-not-enter-alpha-hot-reader" }
    });

    const [canonical] = await repository.listWalletTradeEventsForWallets(
      [walletAddress],
      strategyVersion
    );
    const [ledgerInput] = await repository.listWalletTradeLedgerInputsForWallets(
      [walletAddress],
      strategyVersion
    );
    expect(canonical?.raw).toEqual({ providerPayload: "must-not-enter-alpha-hot-reader" });
    expect(ledgerInput).toMatchObject({
      idempotencyKey: canonical?.idempotencyKey,
      walletAddress,
      tokenAddress: "LedgerScalarMint111",
      baseAmount: 12.5,
      executionPriceUsd: 2,
      quoteValueUsd: 25,
      raw: {}
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

  it("bounds pathological wallet evidence before full load and preserves its quarantine", async () => {
    const strategyVersion = "evidence-quarantine-v1";
    const walletAddress = "EvidenceQuarantineWallet";
    const rows = Array.from({ length: 101 }, (_, index) => ({
      idempotency_key: `quarantine-trade-${index}`,
      chain: "solana",
      wallet_address: walletAddress,
      token_address: `QuarantineToken${index}`,
      side: "buy",
      base_amount: "1",
      execution_price_usd: 1,
      quote_value_usd: 1,
      data_quality: "observed-execution",
      signature: `quarantine-signature-${index}`,
      slot: index + 1,
      provider: "integration-test",
      observed_at: "2026-08-25T00:00:00.000Z",
      strategy_version: strategyVersion,
      raw: {}
    }));
    await testPool.query(
      `INSERT INTO wallet_trade_events (
         idempotency_key, chain, wallet_address, token_address, side,
         base_amount, execution_price_usd, quote_value_usd, data_quality, signature, slot, provider,
         observed_at, strategy_version, raw
       )
       SELECT *
       FROM jsonb_to_recordset($1::jsonb) AS trade(
         idempotency_key text, chain text, wallet_address text, token_address text,
         side text, base_amount numeric, execution_price_usd numeric,
         quote_value_usd numeric, data_quality text,
         signature text, slot bigint, provider text, observed_at timestamptz,
         strategy_version text, raw jsonb
       )`,
      [JSON.stringify(rows)]
    );
    await testPool.query(
      `SELECT enqueue_wallet_alpha_work(
         'solana', $1, $2, 0::smallint, 'quarantine-integration'
       )`,
      [walletAddress, strategyVersion]
    );

    const [item] = await repository.claimWalletAlphaWork({
      strategyVersion,
      workerId: "quarantine-worker",
      limit: 1,
      leaseSeconds: 60
    });
    expect(item).toBeDefined();
    await expect(
      repository.probeWalletAlphaEvidenceBounds(item!, "2026-08-24T00:00:00.000Z", 100, 100, 100)
    ).resolves.toMatchObject({ tradeEventsExceeded: true });
    expect(
      await repository.failWalletAlphaWork(item!, "evidence ceiling", 3_600, "evidence_limit")
    ).toBe(true);

    const before = await testPool.query<{ revision: string; not_before: Date }>(
      `SELECT revision, not_before
       FROM wallet_alpha_work_queue
       WHERE wallet_address = $1 AND strategy_version = $2`,
      [walletAddress, strategyVersion]
    );
    await testPool.query(
      `SELECT enqueue_wallet_alpha_work(
         'solana', $1, $2, 2::smallint, 'risk-passed-source-entry'
       )`,
      [walletAddress, strategyVersion]
    );
    const after = await testPool.query<{
      revision: string;
      not_before: Date;
      quarantine_reason: string;
    }>(
      `SELECT revision, not_before, quarantine_reason
       FROM wallet_alpha_work_queue
       WHERE wallet_address = $1 AND strategy_version = $2`,
      [walletAddress, strategyVersion]
    );
    expect(Number(after.rows[0]?.revision)).toBe(Number(before.rows[0]?.revision) + 1);
    expect(after.rows[0]?.not_before).toEqual(before.rows[0]?.not_before);
    expect(after.rows[0]?.quarantine_reason).toBe("evidence_limit");
    expect(
      await repository.claimWalletAlphaWork({
        strategyVersion,
        workerId: "quarantine-bypass-probe",
        limit: 1
      })
    ).toEqual([]);
  });

  it("preserves an active transient retry delay when new wallet evidence coalesces", async () => {
    const strategyVersion = "transient-retry-v1";
    const walletAddress = "TransientRetryWallet";
    await testPool.query(
      `SELECT enqueue_wallet_alpha_work(
         'solana', $1, $2, 1::smallint, 'entry-evidence'
       )`,
      [walletAddress, strategyVersion]
    );

    const [item] = await repository.claimWalletAlphaWork({
      strategyVersion,
      workerId: "transient-retry-worker",
      limit: 1,
      leaseSeconds: 60
    });
    expect(item).toBeDefined();
    expect(await repository.failWalletAlphaWork(item!, "transient timeout", 3_600)).toBe(true);

    const before = await testPool.query<{
      revision: string;
      not_before: Date;
      last_error: string;
    }>(
      `SELECT revision, not_before, last_error
       FROM wallet_alpha_work_queue
       WHERE wallet_address = $1 AND strategy_version = $2`,
      [walletAddress, strategyVersion]
    );
    await testPool.query(
      `SELECT enqueue_wallet_alpha_work(
         'solana', $1, $2, 1::smallint, 'risk-passed-unqualified-wallet-entry'
       )`,
      [walletAddress, strategyVersion]
    );
    const after = await testPool.query<{
      revision: string;
      not_before: Date;
      last_error: string;
      quarantine_reason: string | null;
    }>(
      `SELECT revision, not_before, last_error, quarantine_reason
       FROM wallet_alpha_work_queue
       WHERE wallet_address = $1 AND strategy_version = $2`,
      [walletAddress, strategyVersion]
    );

    expect(Number(after.rows[0]?.revision)).toBe(Number(before.rows[0]?.revision) + 1);
    expect(after.rows[0]?.not_before).toEqual(before.rows[0]?.not_before);
    expect(after.rows[0]?.last_error).toBe("transient timeout");
    expect(after.rows[0]?.quarantine_reason).toBeNull();
    expect(
      await repository.claimWalletAlphaWork({
        strategyVersion,
        workerId: "transient-retry-bypass-probe",
        limit: 1
      })
    ).toEqual([]);
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

  it("durably defers one-position evidence below the production alpha prerequisites", async () => {
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
      completedPositions: 0
    });
    expect(report.mode).toBe("observe-only");
    expect(report.livePaperSignals).toEqual([]);
    expect(await repository.listWalletTradeEvents("LedgerWallet111")).toHaveLength(2);
    expect(
      (await repository.listWalletTradeEventsForWallets(["LedgerWallet111"], "evidence-v1")).map(
        (trade) => trade.idempotencyKey
      )
    ).toEqual(["ledger-buy", "ledger-sell"]);
  });

  it("checkpoints unready evidence revisions and promotes them when watch prerequisites arrive", async () => {
    const strategyVersion = "evidence-v1";
    const deferredWallet = `AdmissionDeferred${Date.now()}`;
    const legacyWallet = `AdmissionLegacy${Date.now()}`;
    const qualifiedWallet = `AdmissionQualified${Date.now()}`;

    await testPool.query(
      `INSERT INTO wallet_trade_events (
         idempotency_key, chain, wallet_address, token_address, side,
         base_amount, execution_price_usd, quote_value_usd, data_quality,
         signature, slot, provider, observed_at, strategy_version, raw
       )
       SELECT
         'admission-sell-' || $1 || '-' || value,
         'solana', $1, 'AdmissionSellMint' || value, 'sell',
         1, 1, 1, 'observed-execution',
         'admission-sell-signature-' || $1 || '-' || value,
         50000 + value, 'integration-test', NOW() - INTERVAL '1 hour', $2, '{}'::jsonb
       FROM generate_series(1, 8) value`,
      [deferredWallet, strategyVersion]
    );
    expect(
      (
        await testPool.query<{ enqueue_wallet_alpha_work: boolean }>(
          `SELECT enqueue_wallet_alpha_work('solana', $1, $2, 1::smallint, 'sell-trade')`,
          [deferredWallet, strategyVersion]
        )
      ).rows[0]?.enqueue_wallet_alpha_work
    ).toBe(false);
    expect(
      (
        await testPool.query(
          `SELECT revision, completed_revision, admission_status, admission_reason
           FROM wallet_alpha_work_queue
           WHERE chain='solana' AND wallet_address=$1 AND strategy_version=$2`,
          [deferredWallet, strategyVersion]
        )
      ).rows[0]
    ).toMatchObject({
      revision: "1",
      completed_revision: "1",
      admission_status: "deferred",
      admission_reason: "insufficient-watch-upper-bound"
    });

    await testPool.query(
      `INSERT INTO wallet_entry_signals (
         idempotency_key, chain, wallet_address, token_address,
         source_swap_idempotency_key, observed_entry_price_usd,
         observed_liquidity_usd, cohort, repeat_wallet_count, flow_evidence,
         signature, slot, provider, observed_at, strategy_version
       )
       SELECT
         'admission-entry-' || $1 || '-' || value,
         'solana', $1, 'AdmissionEntryMint' || value,
         'admission-swap-' || $1 || '-' || value, 1, 25000,
         'controlled-flow-control', 1,
         '{"controlledFlow":true,"tokenRiskKnown":true,"tokenRiskPassed":true,"poolAgeMinutes":5}'::jsonb,
         'admission-entry-signature-' || $1 || '-' || value,
         51000 + value, 'integration-test', NOW() - INTERVAL '30 minutes', $2
       FROM generate_series(1, 8) value`,
      [deferredWallet, strategyVersion]
    );
    await testPool.query(
      `INSERT INTO wallet_signal_outcomes (
         idempotency_key, entry_idempotency_key, chain, horizon_minutes, status,
         outcome_price_usd, frozen_at, gross_return_pct, net_return_pct,
         estimated_round_trip_cost_pct, exit_strategy, rugged, signature, slot,
         provider, observed_at, strategy_version, raw
       )
       SELECT
         'admission-outcome-' || $1 || '-' || value,
         'admission-entry-' || $1 || '-' || value,
         'solana', 20, 'mature', 1.1, NOW() - INTERVAL '5 minutes', 10, 7,
         3, 'fixed-horizon', FALSE,
         'admission-outcome-signature-' || $1 || '-' || value,
         52000 + value, 'integration-test', NOW() - INTERVAL '5 minutes', $2, '{}'::jsonb
       FROM generate_series(1, 8) value`,
      [deferredWallet, strategyVersion]
    );
    expect(
      (
        await testPool.query<{ enqueue_wallet_alpha_work: boolean }>(
          `SELECT enqueue_wallet_alpha_work('solana', $1, $2, 1::smallint, 'signal-outcome')`,
          [deferredWallet, strategyVersion]
        )
      ).rows[0]?.enqueue_wallet_alpha_work
    ).toBe(true);
    expect(
      (
        await testPool.query(
          `SELECT revision, completed_revision, priority, admission_status
           FROM wallet_alpha_work_queue
           WHERE chain='solana' AND wallet_address=$1 AND strategy_version=$2`,
          [deferredWallet, strategyVersion]
        )
      ).rows[0]
    ).toMatchObject({
      revision: "2",
      completed_revision: "1",
      priority: 1,
      admission_status: "ready"
    });

    await testPool.query(
      `INSERT INTO wallet_alpha_work_queue (
         chain, wallet_address, strategy_version, revision, completed_revision,
         priority, priority_reason, pending_since, admission_status
       ) VALUES ('solana',$1,$2,7,3,0,'legacy-seed',NOW(),'unchecked')`,
      [legacyWallet, strategyVersion]
    );
    await expect(repository.reconcileWalletAlphaAdmission(strategyVersion, 5_000)).resolves.toEqual(
      expect.objectContaining({ examined: expect.any(Number), deferred: expect.any(Number) })
    );
    expect(
      (
        await testPool.query(
          `SELECT revision, completed_revision, admission_status
           FROM wallet_alpha_work_queue
           WHERE chain='solana' AND wallet_address=$1 AND strategy_version=$2`,
          [legacyWallet, strategyVersion]
        )
      ).rows[0]
    ).toMatchObject({ revision: "7", completed_revision: "7", admission_status: "deferred" });

    await repository.saveWalletAlphaScore(qualifiedIntegrationScore(qualifiedWallet, strategyVersion));
    expect(
      (
        await testPool.query<{ enqueue_wallet_alpha_work: boolean }>(
          `SELECT enqueue_wallet_alpha_work('solana', $1, $2, 2::smallint, 'qualified-refresh')`,
          [qualifiedWallet, strategyVersion]
        )
      ).rows[0]?.enqueue_wallet_alpha_work
    ).toBe(true);
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
    await repository.saveWalletAlphaScore(
      qualifiedIntegrationScore("PrioritySafeWallet", strategyVersion)
    );
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

  it("keeps a risk-passed entry from an unqualified wallet out of the signal lane", async () => {
    const strategyVersion = "priority-unqualified-integration-v1";
    await repository.saveWalletAlphaScore({
      ...qualifiedIntegrationScore("PriorityObservedWallet", strategyVersion),
      status: "observed",
      gates: { observed: true, watch: false, candidate: false, validatedPaper: false }
    });
    await repository.saveWalletEntrySignal({
      idempotencyKey: "priority-observed-entry",
      chain: "solana",
      walletAddress: "PriorityObservedWallet",
      tokenAddress: "PriorityObservedMint",
      poolAddress: "PriorityObservedPool",
      sourceSwapIdempotencyKey: "priority-observed-swap",
      observedEntryPriceUsd: 1,
      observedLiquidityUsd: 25_000,
      cohort: "controlled-flow-control",
      repeatWalletCount: 1,
      flowEvidence: {
        controlledFlow: true,
        tokenRiskKnown: true,
        tokenRiskPassed: true
      },
      signature: "priority-observed-signature",
      slot: 10_004,
      provider: "integration-test",
      observedAt: new Date().toISOString(),
      strategyVersion
    });

    const work = await testPool.query<{ priority: number; priority_reason: string }>(
      `SELECT priority, priority_reason
       FROM wallet_alpha_work_queue
       WHERE chain = 'solana' AND wallet_address = $1 AND strategy_version = $2`,
      ["PriorityObservedWallet", strategyVersion]
    );
    expect(work.rows).toEqual([
      {
        priority: 1,
        priority_reason: "risk-passed-unqualified-wallet-entry"
      }
    ]);
  });

  it("reclassifies legacy P2 rows from the latest wallet status without changing revisions", async () => {
    const strategyVersion = "priority-migration-integration-v1";
    await repository.saveWalletAlphaScore(
      qualifiedIntegrationScore("PriorityMigrationQualified", strategyVersion)
    );
    await repository.saveWalletAlphaScore({
      ...qualifiedIntegrationScore("PriorityMigrationObserved", strategyVersion),
      status: "observed",
      gates: { observed: true, watch: false, candidate: false, validatedPaper: false }
    });
    await testPool.query(
      `INSERT INTO wallet_alpha_work_queue (
         chain, wallet_address, strategy_version, revision, completed_revision,
         priority, priority_reason, pending_since
       ) VALUES
         ('solana', 'PriorityMigrationQualified', $1, 7, 3, 2,
          'risk-passed-source-entry', NOW()),
         ('solana', 'PriorityMigrationObserved', $1, 9, 4, 2,
          'risk-passed-source-entry', NOW()),
         ('solana', 'PriorityMigrationNew', $1, 11, 5, 2,
          'risk-passed-source-entry', NOW())`,
      [strategyVersion]
    );

    const migration = await readFile(
      "scripts/migrations/048_wallet_alpha_qualified_signal_lane.sql",
      "utf8"
    );
    const migrationClient = await testPool.connect();
    try {
      await migrationClient.query("BEGIN");
      await migrationClient.query(migration);
      await migrationClient.query("COMMIT");
    } catch (error) {
      await migrationClient.query("ROLLBACK");
      throw error;
    } finally {
      migrationClient.release();
    }

    const rows = await testPool.query<{
      wallet_address: string;
      revision: string;
      completed_revision: string;
      priority: number;
      priority_reason: string;
    }>(
      `SELECT wallet_address, revision, completed_revision, priority, priority_reason
       FROM wallet_alpha_work_queue
       WHERE strategy_version = $1
       ORDER BY wallet_address`,
      [strategyVersion]
    );
    expect(rows.rows).toEqual([
      {
        wallet_address: "PriorityMigrationNew",
        revision: "11",
        completed_revision: "5",
        priority: 1,
        priority_reason: "risk-passed-unqualified-wallet-entry"
      },
      {
        wallet_address: "PriorityMigrationObserved",
        revision: "9",
        completed_revision: "4",
        priority: 1,
        priority_reason: "risk-passed-unqualified-wallet-entry"
      },
      {
        wallet_address: "PriorityMigrationQualified",
        revision: "7",
        completed_revision: "3",
        priority: 2,
        priority_reason: "risk-passed-qualified-wallet-entry"
      }
    ]);
  });

  it("emits a transaction-bound wake hint for signal-relevant work", async () => {
    await repository.saveWalletAlphaScore(
      qualifiedIntegrationScore("PriorityNotifyWallet", "priority-notify-v1")
    );
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
