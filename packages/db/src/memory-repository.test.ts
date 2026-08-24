import { describe, expect, it } from "vitest";
import {
  SAMPLE_POOL,
  SAMPLE_TOKEN,
  type WalletAlphaScoreSnapshot,
  type WalletEntrySignalEvidence,
  type WalletSignalOutcomeEvidence
} from "@memecoin-alpha/shared";
import { MemoryRepository } from "./memory-repository";

const thresholds = {
  minimumLiquidityUsd: 10000,
  minimumVolume5mUsd: 5000,
  maximumTopHolderPercent: 35,
  maximumRugRisk: 70,
  minimumSmartWalletScore: 60,
  alertMinimumConfidence: 65,
  paperPositionSizeUsd: 100,
  maxOpenPaperPositions: 5,
  stopLossPercent: 35,
  takeProfitPercent: 150,
  timeExitMinutes: 240
};

describe("MemoryRepository", () => {
  it("finds the nearest persisted quote observation within the requested distance", async () => {
    const repo = new MemoryRepository();
    const observation = {
      idempotencyKey: "memory-sol-quote",
      chain: "solana" as const,
      quoteTokenAddress: "So111",
      priceUsd: 150,
      confidenceUsd: 0.1,
      source: "pyth-benchmarks",
      quality: "oracle-historical" as const,
      publishTime: "2026-07-16T09:00:15.000Z",
      observedAt: "2026-07-16T09:00:16.000Z",
      stalenessSeconds: 1,
      raw: { feedId: "sol-usd" }
    };
    await repo.saveQuotePriceObservation(observation);

    await expect(
      repo.findQuotePriceObservationNear("solana", "So111", "2026-07-16T09:00:00.000Z", 30)
    ).resolves.toEqual(observation);
    await expect(
      repo.findQuotePriceObservationNear("solana", "So111", "2026-07-16T09:02:00.000Z", 30)
    ).resolves.toBeUndefined();
  });

  it("deduplicates quote observations by both identities and rejects immutable mismatches", async () => {
    const repo = new MemoryRepository();
    const observation = {
      idempotencyKey: "memory-quote-primary",
      chain: "solana" as const,
      quoteTokenAddress: "So111",
      priceUsd: 150,
      confidenceUsd: 0.1,
      source: "pyth-benchmarks",
      quality: "oracle-historical" as const,
      publishTime: "2026-07-16T09:00:15.000Z",
      observedAt: "2026-07-16T09:00:16.000Z",
      stalenessSeconds: 1,
      raw: { feedId: "sol-usd", tradeSignature: "first" }
    };

    await expect(repo.saveQuotePriceObservation(observation)).resolves.toBe(true);
    await expect(
      repo.saveQuotePriceObservation({
        ...observation,
        observedAt: "2026-07-16T09:00:17.000Z",
        stalenessSeconds: 2,
        raw: { feedId: "sol-usd", tradeSignature: "primary-retry" }
      })
    ).resolves.toBe(false);
    await expect(
      repo.saveQuotePriceObservation({
        ...observation,
        idempotencyKey: "memory-quote-natural",
        observedAt: "2026-07-16T09:00:18.000Z",
        stalenessSeconds: 3,
        raw: { feedId: "sol-usd", tradeSignature: "natural-retry" }
      })
    ).resolves.toBe(false);
    await expect(
      repo.saveQuotePriceObservation({
        ...observation,
        idempotencyKey: "memory-quote-conflict",
        priceUsd: 151
      })
    ).rejects.toThrow("conflicts with stored immutable evidence");
  });

  it("upserts tokens idempotently", async () => {
    const repo = MemoryRepository.seeded(thresholds);
    await repo.upsertToken(SAMPLE_TOKEN);
    await repo.upsertToken({ ...SAMPLE_TOKEN, symbol: "ALPHA2" });

    const tokens = await repo.listRecentTokens();
    expect(tokens.filter((token) => token.address === SAMPLE_TOKEN.address)).toHaveLength(1);
    expect(await repo.getToken("solana", SAMPLE_TOKEN.address)).toMatchObject({ symbol: "ALPHA2" });
  });

  it("returns a pool by canonical chain and address", async () => {
    const repo = MemoryRepository.seeded(thresholds);
    await expect(repo.getPool("solana", SAMPLE_POOL.poolAddress)).resolves.toEqual(SAMPLE_POOL);
    await expect(repo.getPool("solana", "missing-pool")).resolves.toBeUndefined();
  });

  it("persists wallet outcomes only when their lifecycle status advances", async () => {
    const repo = new MemoryRepository();
    const provisional: WalletSignalOutcomeEvidence = {
      idempotencyKey: "bounded-outcome",
      entryIdempotencyKey: "bounded-entry",
      chain: "solana",
      horizonMinutes: 20,
      status: "provisional",
      outcomePriceUsd: 1,
      estimatedRoundTripCostPct: 3,
      exitStrategy: "fixed-horizon",
      rugged: false,
      signature: "price-1",
      slot: 1,
      provider: "dexscreener",
      observedAt: "2026-07-16T00:01:00.000Z",
      strategyVersion: "evidence-v1",
      raw: {}
    };

    await expect(repo.saveWalletSignalOutcomes([provisional])).resolves.toBe(1);
    await expect(repo.saveWalletSignalOutcomes([provisional])).resolves.toBe(0);
    await expect(
      repo.saveWalletSignalOutcome({
        ...provisional,
        outcomePriceUsd: 1.1,
        signature: "price-2",
        observedAt: "2026-07-16T00:03:00.000Z"
      })
    ).resolves.toBe(false);
    await expect(
      repo.saveWalletSignalOutcome({
        ...provisional,
        status: "mature",
        outcomePriceUsd: 1.2,
        frozenAt: "2026-07-16T00:20:00.000Z",
        grossReturnPct: 20,
        netReturnPct: 17,
        signature: "price-final",
        observedAt: "2026-07-16T00:20:00.000Z"
      })
    ).resolves.toBe(true);
    await expect(
      repo.saveWalletSignalOutcome({
        ...provisional,
        status: "unresolved",
        observedAt: "2026-07-16T00:21:00.000Z"
      })
    ).resolves.toBe(false);
  });

  it("promotes an exploratory wallet entry and discards its stale outcomes", async () => {
    const repo = new MemoryRepository();
    const exploratory: WalletEntrySignalEvidence = {
      idempotencyKey: "wallet-token-first-buy",
      chain: "solana",
      walletAddress: "Wallet111",
      tokenAddress: "Token111",
      observedEntryPriceUsd: 1,
      observedLiquidityUsd: 20_000,
      cohort: "excluded-uncontrolled-flow",
      repeatWalletCount: 0,
      flowEvidence: {},
      signature: "exploratory-entry",
      slot: 0,
      provider: "dexscreener",
      observedAt: "2026-07-10T00:00:00.000Z",
      strategyVersion: "evidence-v1"
    };
    const staleOutcome: WalletSignalOutcomeEvidence = {
      idempotencyKey: "stale-outcome",
      entryIdempotencyKey: exploratory.idempotencyKey,
      chain: "solana",
      horizonMinutes: 20,
      status: "mature",
      outcomePriceUsd: 2,
      frozenAt: "2026-07-10T00:20:00.000Z",
      grossReturnPct: 100,
      netReturnPct: 97,
      estimatedRoundTripCostPct: 3,
      exitStrategy: "fixed-horizon",
      rugged: false,
      signature: "stale-price",
      slot: 0,
      provider: "dexscreener",
      observedAt: "2026-07-10T00:20:00.000Z",
      strategyVersion: "evidence-v1",
      raw: {}
    };

    expect(await repo.saveWalletEntrySignal(exploratory)).toBe(true);
    expect(await repo.saveWalletSignalOutcome(staleOutcome)).toBe(true);
    expect(
      await repo.saveWalletEntrySignal({
        ...exploratory,
        sourceSwapIdempotencyKey: "swap-111",
        observedEntryPriceUsd: 1.25,
        cohort: "controlled-flow-control",
        signature: "onchain-entry",
        slot: 123,
        provider: "solana-rpc",
        observedAt: "2026-07-10T01:00:00.000Z"
      })
    ).toBe(true);

    expect(await repo.listWalletEntrySignals()).toEqual([
      expect.objectContaining({
        idempotencyKey: exploratory.idempotencyKey,
        sourceSwapIdempotencyKey: "swap-111",
        observedEntryPriceUsd: 1.25,
        observedAt: "2026-07-10T01:00:00.000Z"
      })
    ]);
    expect(await repo.listWalletSignalOutcomes()).toEqual([]);
  });

  it("returns only the earliest still-linkable swap per wallet and token", async () => {
    const repo = new MemoryRepository();
    const swap = (id: string, observedAt: string) => ({
      idempotencyKey: id,
      chain: "solana" as const,
      signature: `${id}-signature`,
      slot: 1,
      poolAddress: "Pool111",
      traderAddress: "Wallet111",
      inputTokenAddress: "So111",
      outputTokenAddress: "Token111",
      observedAt,
      provider: "mock",
      strategyVersion: "evidence-v1",
      raw: {}
    });
    await repo.saveOnchainSwap(swap("swap-first", "2026-07-10T00:00:00.000Z"));
    await repo.saveOnchainSwap(swap("swap-repeat", "2026-07-10T00:01:00.000Z"));

    expect(await repo.listPendingOnchainBuySwaps("Token111")).toEqual([
      expect.objectContaining({ idempotencyKey: "swap-first" })
    ]);

    await repo.saveWalletEntrySignal({
      idempotencyKey: "entry-111",
      chain: "solana",
      walletAddress: "Wallet111",
      tokenAddress: "Token111",
      poolAddress: "Pool111",
      sourceSwapIdempotencyKey: "swap-first",
      observedEntryPriceUsd: 1,
      observedLiquidityUsd: 20_000,
      cohort: "controlled-flow-control",
      repeatWalletCount: 0,
      flowEvidence: { controlledFlow: true, tokenRiskKnown: true },
      signature: "entry-signature",
      slot: 2,
      provider: "mock",
      observedAt: "2026-07-10T00:02:00.000Z",
      strategyVersion: "evidence-v1"
    });

    expect(await repo.listPendingOnchainBuySwaps("Token111")).toEqual([]);
  });

  it("atomically replaces the durable FIFO ledger without duplicate episodes or lots", async () => {
    const repo = new MemoryRepository();
    const strategyVersion = "wallet-alpha-v2";
    await repo.saveWalletAlphaScore({
      chain: "solana",
      walletAddress: "LedgerWallet",
      strategyVersion,
      calculatedAt: "2026-07-11T00:00:00.000Z",
      status: "observed",
      profitabilityScore: 1,
      followabilityScore: 1,
      overallScore: 1,
      completedPositions: 1,
      uniqueTokens: 1,
      activeDays: 1,
      metrics: {} as WalletAlphaScoreSnapshot["metrics"],
      gates: { observed: true, watch: false, candidate: false, validatedPaper: false },
      reasons: []
    });
    const openEpisode = {
      id: "episode-1",
      chain: "solana" as const,
      walletAddress: "LedgerWallet",
      tokenAddress: "LedgerMint",
      strategyVersion,
      episodeIndex: 1,
      status: "open" as const,
      openedAt: "2026-07-10T00:00:00.000Z",
      costBasisUsd: 100,
      proceedsUsd: 50,
      realizedPnlUsd: 10,
      returnPct: 25,
      remainingRawAmount: "50000000",
      tokenDecimals: 6,
      realizedLotCount: 1,
      highQualityPriceCoverage: 1,
      metadata: { realizations: ["sell-1"] }
    };
    const openLot = {
      id: "lot-1",
      episodeId: openEpisode.id,
      sourceEventIdempotencyKey: "buy-1",
      lotSequence: 1,
      rawAmount: "100000000",
      remainingRawAmount: "50000000",
      tokenDecimals: 6,
      quoteCostUsd: 98,
      feesUsd: 1,
      slippageUsd: 1,
      openedAt: openEpisode.openedAt,
      status: "partially_realized" as const,
      metadata: {}
    };
    const snapshot = {
      chain: "solana" as const,
      strategyVersion,
      generatedAt: "2026-07-11T00:00:00.000Z",
      episodes: [openEpisode],
      lots: [openLot]
    };

    await expect(repo.replaceWalletPositionLedger(snapshot)).resolves.toEqual({
      episodeCount: 1,
      lotCount: 1
    });
    await expect(repo.replaceWalletPositionLedger(snapshot)).resolves.toEqual({
      episodeCount: 1,
      lotCount: 1
    });
    expect(await repo.getWalletAlphaDetail("LedgerWallet", strategyVersion)).toMatchObject({
      episodes: [{ id: "episode-1", status: "open" }],
      lots: [{ id: "lot-1", status: "partially_realized" }]
    });

    await repo.replaceWalletPositionLedger({
      ...snapshot,
      generatedAt: "2026-07-11T01:00:00.000Z",
      episodes: [
        {
          ...openEpisode,
          status: "realized",
          closedAt: "2026-07-11T01:00:00.000Z",
          proceedsUsd: 130,
          realizedPnlUsd: 30,
          returnPct: 30,
          remainingRawAmount: "0"
        }
      ],
      lots: [
        {
          ...openLot,
          remainingRawAmount: "0",
          closedAt: "2026-07-11T01:00:00.000Z",
          status: "realized"
        }
      ]
    });
    expect(await repo.getWalletAlphaDetail("LedgerWallet", strategyVersion)).toMatchObject({
      episodes: [{ id: "episode-1", status: "realized", remainingRawAmount: "0" }],
      lots: [{ id: "lot-1", status: "realized", remainingRawAmount: "0" }]
    });

    await repo.replaceWalletPositionLedger({ ...snapshot, episodes: [], lots: [] });
    expect(await repo.getWalletAlphaDetail("LedgerWallet", strategyVersion)).toMatchObject({
      episodes: [],
      lots: []
    });
  });

  it("claims only the contiguous head of each canonical partition", async () => {
    const repo = new MemoryRepository();
    const receivedAt = new Date(Date.now() - 1_000).toISOString();
    const event = (id: string, slot: number, address: string) => ({
      idempotencyKey: id,
      chain: "solana" as const,
      signature: `${id}-signature`,
      slot,
      eventType: "swap",
      occurredAt: receivedAt,
      receivedAt,
      commitment: "confirmed" as const,
      source: "helius-transaction-subscribe",
      decoderVersion: "test-v2",
      payload: { address }
    });
    await repo.insertChainEvents([
      event("pool-a-1", 1, "PoolA"),
      event("pool-a-2", 2, "PoolA"),
      event("pool-b-1", 3, "PoolB")
    ]);

    const first = await repo.claimChainEvents({ workerId: "parser", limit: 10 });
    expect(first.map((item) => item.idempotencyKey)).toEqual(["pool-a-1", "pool-b-1"]);
    await repo.completeChainEvent("pool-b-1", "parser");
    await repo.failChainEvent("pool-a-1", "parser", "retry me", {
      maxAttempts: 2,
      retryAt: new Date(Date.now() - 1).toISOString()
    });

    const retry = await repo.claimChainEvents({ workerId: "parser", limit: 10 });
    expect(retry.map((item) => item.idempotencyKey)).toEqual(["pool-a-1"]);
    await repo.failChainEvent("pool-a-1", "parser", "terminal", { maxAttempts: 2 });

    expect(await repo.claimChainEvents({ workerId: "parser", limit: 10 })).toEqual([]);
  });

  it("holds future-only canonical evidence until its signature is finalized", async () => {
    const repo = new MemoryRepository();
    const receivedAt = new Date(Date.now() - 10_000).toISOString();
    await repo.insertChainEvent({
      idempotencyKey: "finality-gated-event",
      chain: "solana",
      signature: "finality-gated-signature",
      slot: 900,
      eventType: "pool_created",
      occurredAt: receivedAt,
      receivedAt,
      commitment: "confirmed",
      requiresFinality: true,
      source: "solana-rpc-discovery",
      decoderVersion: "test-finality-v1",
      payload: { address: "ProgramFinality111" }
    });

    expect(await repo.claimChainEvents({ workerId: "parser", limit: 10 })).toEqual([]);
    expect(await repo.listPendingSolanaFinalities(10, 1)).toEqual([
      expect.objectContaining({ signature: "finality-gated-signature", slot: 900 })
    ]);
    expect(
      await repo.recordSolanaFinalities([
        {
          signature: "finality-gated-signature",
          result: {
            status: "finalized",
            checkedAt: new Date().toISOString(),
            confirmationStatus: "finalized"
          }
        }
      ])
    ).toMatchObject({ checkedSignatures: 1, finalizedEvents: 1, rolledBackEvents: 0 });
    expect(
      (await repo.claimChainEvents({ workerId: "parser", limit: 10 }))[0]
    ).toMatchObject({
      idempotencyKey: "finality-gated-event",
      commitment: "finalized",
      requiresFinality: true
    });
  });
});
