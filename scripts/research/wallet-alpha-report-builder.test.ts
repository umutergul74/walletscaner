import { describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@memecoin-alpha/db";
import { buildWalletAlphaScores } from "@memecoin-alpha/core";
import type {
  WalletAlphaScoreSnapshot,
  WalletEntrySignalEvidence,
  WalletTradeEvidence
} from "@memecoin-alpha/shared";
import {
  buildWalletAlphaReport,
  processWalletAlphaQueue,
  renderWalletAlphaMarkdown
} from "./wallet-alpha-report-builder";

describe("wallet alpha report", () => {
  it("stays observe-only when token outcomes are not backed by completed wallet trades", async () => {
    const repository = new MemoryRepository();
    const report = await buildWalletAlphaReport(
      repository,
      "evidence-v1",
      "2026-07-10T00:00:00.000Z",
      30
    );

    expect(report.mode).toBe("observe-only");
    expect(report.sourceWindowDays).toBe(90);
    expect(report.livePaperSignals).toEqual([]);
    expect(renderWalletAlphaMarkdown(report)).toContain(
      "do not treat token outcomes alone as wallet profit"
    );
  });

  it("reports source-linked entries blocked by unknown token risk", async () => {
    const repository = new MemoryRepository();
    await repository.saveWalletEntrySignal(unknownRiskEntry());

    const report = await buildWalletAlphaReport(
      repository,
      "evidence-v1",
      "2026-07-10T00:00:00.000Z",
      30
    );

    expect(report.coverage.sourceLinkedFollowerEntries).toBe(1);
    expect(report.coverage.riskPassedEntries).toBe(0);
    expect(report.coverage.unknownRiskBlockedEntries).toBe(1);
    expect(report.livePaperSignals).toEqual([]);
    expect(renderWalletAlphaMarkdown(report)).toContain(
      "Eligible entries blocked by unknown risk: 1"
    );
  });

  it("separates uncontrolled-flow baseline rows from eligible risk coverage", async () => {
    const repository = new MemoryRepository();
    await repository.saveWalletEntrySignal({
      ...unknownRiskEntry(),
      idempotencyKey: "excluded-entry",
      sourceSwapIdempotencyKey: "excluded-source-swap",
      cohort: "excluded-uncontrolled-flow"
    });

    const report = await buildWalletAlphaReport(
      repository,
      "evidence-v1",
      "2026-07-10T00:00:00.000Z",
      30
    );

    expect(report.coverage.sourceLinkedFollowerEntries).toBe(1);
    expect(report.coverage.eligibleSourceLinkedFollowerEntries).toBe(0);
    expect(report.coverage.excludedUncontrolledFlowEntries).toBe(1);
    expect(report.coverage.unknownRiskBlockedEntries).toBe(0);
  });

  it("bounds each run and reports incremental catch-up honestly", async () => {
    const repository = new MemoryRepository();
    for (let index = 0; index < 3; index += 1) {
      await repository.saveWalletEntrySignal({
        ...unknownRiskEntry(),
        idempotencyKey: `bounded-entry-${index}`,
        walletAddress: `BoundedWallet${index}`,
        tokenAddress: `BoundedToken${index}`,
        sourceSwapIdempotencyKey: `bounded-swap-${index}`,
        signature: `bounded-signature-${index}`
      });
    }
    const fullTradeLoad = vi.spyOn(repository, "listWalletTradeEvents");
    const fullEntryLoad = vi.spyOn(repository, "listWalletEntrySignals");
    const fullOutcomeLoad = vi.spyOn(repository, "listWalletSignalOutcomes");

    const report = await buildWalletAlphaReport(
      repository,
      "evidence-v1",
      "2026-07-10T00:00:00.000Z",
      30,
      { workBatchSize: 1, maxWorkBatches: 1 }
    );

    expect(report.workQueue).toMatchObject({ processed: 1, pending: 2 });
    expect(report.decision).toContain("not yet a complete ranking snapshot");
    expect(fullTradeLoad).not.toHaveBeenCalled();
    expect(fullEntryLoad).not.toHaveBeenCalled();
    expect(fullOutcomeLoad).not.toHaveBeenCalled();
  });

  it("quarantines one oversized wallet without blocking the next wallet", async () => {
    const repository = new MemoryRepository();
    for (let index = 0; index < 101; index += 1) {
      await repository.saveWalletTradeEvent(
        walletTrade("AHeavyWallet", `heavy-${index}`, index + 1)
      );
    }
    await repository.saveWalletTradeEvent(walletTrade("ZHealthyWallet", "healthy", 1_000));
    const scopedLoads = vi.spyOn(repository, "listWalletTradeLedgerInputPage");
    const boundedProbes = vi.spyOn(repository, "probeWalletAlphaEvidenceBounds");

    const result = await processWalletAlphaQueue(
      repository,
      "evidence-v1",
      "2026-07-10T00:00:00.000Z",
      30,
      {
        materializeHistorical: false,
        workBatchSize: 2,
        maxWorkBatches: 1,
        maximumTradeEventsPerWallet: 100,
        oversizedRetrySeconds: 300
      }
    );

    expect(result).toMatchObject({
      processedWallets: 1,
      failedWallets: 1,
      oversizedWallets: 1
    });
    expect(await repository.getWalletAlphaWorkSummary("evidence-v1")).toEqual({
      pending: 1,
      processing: 0,
      failed: 1,
      backgroundPending: 1,
      elevatedPending: 0,
      signalPending: 0,
      oldestPendingAt: expect.any(String)
    });
    expect(boundedProbes).toHaveBeenCalledTimes(2);
    // The pathological wallet is rejected by an index-bounded count probe;
    // its 101 full rows are never sorted/materialized into the worker heap.
    expect(scopedLoads.mock.calls.map((call) => call[1])).toEqual(["ZHealthyWallet"]);
    expect(await repository.listWalletAlphaScores("evidence-v1")).toHaveLength(1);

    await repository.saveWalletTradeEvent(walletTrade("AHeavyWallet", "heavy-new", 2_000));
    expect(
      await repository.claimWalletAlphaWork({
        strategyVersion: "evidence-v1",
        workerId: "quarantine-probe",
        limit: 1
      })
    ).toEqual([]);
  });

  it("completes low-evidence work without scoring it", async () => {
    const repository = new MemoryRepository();
    const candidatePrefetch = vi.spyOn(repository, "listWalletAlphaWorkCandidates");
    const admissionPrefetch = vi.spyOn(repository, "probeWalletAlphaAdmission");
    const batchCompletion = vi.spyOn(repository, "completeWalletAlphaWorkCandidates");
    const scopedTradeLoads = vi.spyOn(repository, "listWalletTradeEventsForWallets");
    const ledgerTradeLoads = vi.spyOn(repository, "listWalletTradeLedgerInputsForWallets");
    const pageLoads = vi.spyOn(repository, "listWalletTradeLedgerInputPage");
    await repository.saveWalletTradeEvent(walletTrade("SingleTradeWallet", "single", 1));
    for (let index = 0; index < 3; index += 1) {
      await repository.saveWalletEntrySignal({
        ...unknownRiskEntry(),
        idempotencyKey: `eligible-entry-${index}`,
        walletAddress: "ThreeEntryWallet",
        tokenAddress: `EligibleToken${index}`,
        sourceSwapIdempotencyKey: `eligible-swap-${index}`,
        signature: `eligible-signature-${index}`
      });
    }

    const result = await processWalletAlphaQueue(
      repository,
      "evidence-v1",
      "2026-07-10T00:00:00.000Z",
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
    expect(
      (await repository.listWalletAlphaScores("evidence-v1")).map((score) => score.walletAddress)
    ).toEqual(["ThreeEntryWallet"]);
    expect(await repository.getWalletAlphaWorkSummary("evidence-v1")).toMatchObject({ pending: 0 });
    expect(candidatePrefetch).toHaveBeenCalledTimes(1);
    expect(admissionPrefetch).toHaveBeenCalledTimes(1);
    expect(batchCompletion).toHaveBeenCalledWith([
      expect.objectContaining({ walletAddress: "SingleTradeWallet", revision: 1 })
    ]);
    // Only the admitted wallet reaches the bounded page load. The low-evidence
    // wallet is completed from the revision-bound batch probe.
    expect(scopedTradeLoads).not.toHaveBeenCalled();
    expect(ledgerTradeLoads).not.toHaveBeenCalled();
    expect(pageLoads.mock.calls.map((call) => call[1])).toEqual(["ThreeEntryWallet"]);
  });

  it("does not lease another wallet without a complete per-wallet time budget", async () => {
    const repository = new MemoryRepository();
    await repository.saveWalletTradeEvent(walletTrade("BudgetGuardWallet", "budget-guard", 1));
    const claims = vi.spyOn(repository, "claimWalletAlphaWork");

    const result = await processWalletAlphaQueue(
      repository,
      "evidence-v1",
      "2026-07-10T00:00:00.000Z",
      30,
      {
        materializeHistorical: false,
        workBatchSize: 1,
        maxWorkBatches: 1,
        maximumRunSeconds: 30,
        minimumWorkItemBudgetSeconds: 300
      }
    );

    expect(result).toMatchObject({ processedWallets: 0, failedWallets: 0 });
    expect(claims).not.toHaveBeenCalled();
    expect(await repository.getWalletAlphaWorkSummary("evidence-v1")).toMatchObject({
      pending: 1
    });
  });

  it("falls back to a fresh probe when evidence advances the queued revision", async () => {
    const repository = new MemoryRepository();
    await repository.saveWalletTradeEvent(walletTrade("RevisionWallet", "revision-1", 1));
    const originalProbe = repository.probeWalletAlphaAdmission.bind(repository);
    const batchCompletion = vi.spyOn(repository, "completeWalletAlphaWorkCandidates");
    vi.spyOn(repository, "probeWalletAlphaAdmission").mockImplementation(async (...args) => {
      const probes = await originalProbe(...args);
      await repository.saveWalletTradeEvent(walletTrade("RevisionWallet", "revision-2", 2));
      return probes;
    });
    const scopedTradeLoads = vi.spyOn(repository, "listWalletTradeEventsForWallets");

    const result = await processWalletAlphaQueue(
      repository,
      "evidence-v1",
      "2026-07-10T00:00:00.000Z",
      30,
      {
        materializeHistorical: false,
        workBatchSize: 1,
        maxWorkBatches: 1,
        minimumTradeEvents: 6,
        minimumEntries: 3
      }
    );

    expect(result.skippedLowEvidenceWallets).toBe(1);
    await expect(batchCompletion.mock.results[0]?.value).resolves.toBe(0);
    expect(scopedTradeLoads).toHaveBeenCalledTimes(1);
  });

  it("processes a risk-passed source entry before historical backlog", async () => {
    const repository = new MemoryRepository();
    await repository.saveWalletTradeEvent(walletTrade("HistoricalWallet", "historical-buy", 1));
    await repository.saveWalletAlphaScore(qualifiedScore("SafePriorityWallet"));
    await repository.saveWalletEntrySignal({
      ...unknownRiskEntry(),
      idempotencyKey: "safe-priority-entry",
      walletAddress: "SafePriorityWallet",
      tokenAddress: "SafePriorityToken",
      cohort: "controlled-flow-control",
      flowEvidence: {
        controlledFlow: true,
        tokenRiskKnown: true,
        tokenRiskPassed: true
      }
    });
    const onSignalRelevantWalletProcessed = vi.fn();

    const result = await processWalletAlphaQueue(
      repository,
      "evidence-v1",
      "2026-07-10T00:00:00.000Z",
      30,
      {
        materializeHistorical: false,
        workBatchSize: 1,
        maxWorkBatches: 1,
        minimumTradeEvents: 6,
        minimumEntries: 1,
        onSignalRelevantWalletProcessed
      }
    );

    expect(result).toMatchObject({
      processedWallets: 1,
      signalRelevantWallets: 1,
      signalRefreshFailures: 0
    });
    expect(onSignalRelevantWalletProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ walletAddress: "SafePriorityWallet", priority: 2 }),
      false
    );
    expect(await repository.getWalletAlphaWorkSummary("evidence-v1")).toMatchObject({
      pending: 1,
      backgroundPending: 1,
      signalPending: 0
    });
  });

  it("uses a suffix after the first FIFO seed and rebuilds on an old source correction", async () => {
    const repository = new MemoryRepository();
    const walletAddress = "ContinuationWallet";
    const pageLoads = vi.spyOn(repository, "listWalletTradeLedgerInputPage");
    await repository.saveWalletTradeEvent(fifoTrade(walletAddress, 1, "buy", 100, 100));
    await repository.saveWalletTradeEvent(fifoTrade(walletAddress, 2, "sell", 100, 150));

    const options = {
      materializeHistorical: false,
      workBatchSize: 1,
      maxWorkBatches: 1,
      minimumTradeEvents: 1,
      minimumEntries: 1
    };
    expect(
      await processWalletAlphaQueue(
        repository,
        "evidence-v1",
        "2026-07-10T00:00:00.000Z",
        30,
        options
      )
    ).toMatchObject({ processedWallets: 1, failedWallets: 0 });
    expect(
      await repository.getWalletFifoContinuationState(
        "solana",
        walletAddress,
        "evidence-v1"
      )
    ).toMatchObject({
      tradeRevision: 2,
      realizations: [expect.objectContaining({ sellEventIdempotencyKey: "fifo-2" })],
      continuation: { tradeRevision: 2, generation: 1 }
    });

    await repository.saveWalletTradeEvent(fifoTrade(walletAddress, 3, "buy", 50, 50));
    await repository.saveWalletTradeEvent(fifoTrade(walletAddress, 4, "sell", 50, 80));
    expect(
      await processWalletAlphaQueue(
        repository,
        "evidence-v1",
        "2026-07-10T00:01:00.000Z",
        30,
        options
      )
    ).toMatchObject({ processedWallets: 1, failedWallets: 0 });
    expect(pageLoads).toHaveBeenCalledTimes(2);
    expect(pageLoads.mock.calls[0]![3]).toBeUndefined();
    expect(pageLoads.mock.calls[1]![3]).toBeDefined();
    expect(
      await repository.getWalletFifoContinuationState(
        "solana",
        walletAddress,
        "evidence-v1"
      )
    ).toMatchObject({
      tradeRevision: 4,
      realizations: [
        expect.objectContaining({ sellEventIdempotencyKey: "fifo-2" }),
        expect.objectContaining({ sellEventIdempotencyKey: "fifo-4" })
      ],
      continuation: { tradeRevision: 4, generation: 2 }
    });
    expect(await repository.listWalletAlphaScores("evidence-v1")).toEqual(
      buildWalletAlphaScores({
        trades: await repository.listWalletTradeEvents(walletAddress, "evidence-v1"),
        entries: [],
        outcomes: [],
        strategyVersion: "evidence-v1",
        calculatedAt: "2026-07-10T00:01:00.000Z"
      })
    );

    expect(
      await repository.saveWalletTradeEvent({
        ...fifoTrade(walletAddress, 1, "buy", 100, 100),
        baseTokenAmount: { rawAmount: "100000000", decimals: 6 }
      })
    ).toBe(true);
    expect(
      await processWalletAlphaQueue(
        repository,
        "evidence-v1",
        "2026-07-10T00:02:00.000Z",
        30,
        options
      )
    ).toMatchObject({ processedWallets: 1, failedWallets: 0 });
    expect(pageLoads).toHaveBeenCalledTimes(3);
    expect(pageLoads.mock.calls[2]![3]).toBeUndefined();
    expect(
      await repository.getWalletFifoContinuationState(
        "solana",
        walletAddress,
        "evidence-v1"
      )
    ).toMatchObject({ tradeRevision: 5, continuation: { tradeRevision: 5, generation: 3 } });
  });

  it("seeds a large wallet in bounded pages and checks only its suffix after seeding", async () => {
    const repository = new MemoryRepository();
    const walletAddress = "PagedContinuationWallet";
    for (let index = 1; index <= 150; index += 1) {
      await repository.saveWalletTradeEvent(
        fifoTrade(walletAddress, index, index % 2 === 1 ? "buy" : "sell", 100, 100)
      );
    }
    const pageLoads = vi.spyOn(repository, "listWalletTradeLedgerInputPage");
    const options = {
      materializeHistorical: false,
      workBatchSize: 1,
      maxWorkBatches: 1,
      maximumTradeEventsPerWallet: 100,
      maximumSeedTradeEventsPerWallet: 200,
      fifoTradePageSize: 25
    };
    expect(
      await processWalletAlphaQueue(
        repository,
        "evidence-v1",
        "2026-07-10T00:00:00.000Z",
        30,
        options
      )
    ).toMatchObject({ processedWallets: 1, failedWallets: 0, oversizedWallets: 0 });
    expect(pageLoads).toHaveBeenCalledTimes(7);
    expect(pageLoads.mock.calls.every((call) => call[4] === 25)).toBe(true);

    await repository.saveWalletTradeEvent(fifoTrade(walletAddress, 151, "buy", 100, 100));
    await repository.saveWalletTradeEvent(fifoTrade(walletAddress, 152, "sell", 100, 150));
    expect(
      await processWalletAlphaQueue(
        repository,
        "evidence-v1",
        "2026-07-10T00:01:00.000Z",
        30,
        options
      )
    ).toMatchObject({ processedWallets: 1, failedWallets: 0, oversizedWallets: 0 });
    expect(pageLoads).toHaveBeenCalledTimes(8);
    expect(pageLoads.mock.calls[7]![3]).toBeDefined();
    expect(await repository.listWalletAlphaScores("evidence-v1")).toEqual(
      buildWalletAlphaScores({
        trades: await repository.listWalletTradeEvents(walletAddress, "evidence-v1"),
        entries: [],
        outcomes: [],
        strategyVersion: "evidence-v1",
        calculatedAt: "2026-07-10T00:01:00.000Z"
      })
    );
    const merges = vi.spyOn(repository, "mergeWalletPositionLedger");
    await repository.saveWalletEntrySignal({
      ...unknownRiskEntry(),
      idempotencyKey: "paged-entry-only-wakeup",
      walletAddress
    });
    expect(
      await processWalletAlphaQueue(
        repository,
        "evidence-v1",
        "2026-07-10T00:02:00.000Z",
        30,
        options
      )
    ).toMatchObject({ processedWallets: 1, failedWallets: 0 });
    expect(merges).not.toHaveBeenCalled();
    expect(
      await repository.getWalletFifoContinuationState("solana", walletAddress, "evidence-v1")
    ).toMatchObject({ continuation: { generation: 2 } });
  });
});

function qualifiedScore(walletAddress: string): WalletAlphaScoreSnapshot {
  return {
    chain: "solana",
    walletAddress,
    strategyVersion: "evidence-v1",
    calculatedAt: "2026-07-09T00:00:00.000Z",
    status: "watch",
    profitabilityScore: 70,
    followabilityScore: 70,
    overallScore: 70,
    completedPositions: 10,
    uniqueTokens: 10,
    activeDays: 5,
    metrics: {} as WalletAlphaScoreSnapshot["metrics"],
    gates: { observed: true, watch: true, candidate: false, validatedPaper: false },
    reasons: ["test-qualified"]
  };
}

function unknownRiskEntry(): WalletEntrySignalEvidence {
  return {
    idempotencyKey: "unknown-risk-entry",
    chain: "solana",
    walletAddress: "WalletUnknownRisk",
    tokenAddress: "TokenUnknownRisk",
    poolAddress: "PoolUnknownRisk",
    sourceSwapIdempotencyKey: "source-swap-unknown-risk",
    observedEntryPriceUsd: 1,
    observedLiquidityUsd: 20_000,
    cohort: "wallet-alpha",
    repeatWalletCount: 1,
    flowEvidence: { poolAgeMinutes: 5 },
    signature: "unknown-risk-signature",
    slot: 1,
    provider: "mock",
    observedAt: "2026-07-09T00:00:00.000Z",
    strategyVersion: "evidence-v1"
  };
}

function walletTrade(
  walletAddress: string,
  idempotencyKey: string,
  slot: number
): WalletTradeEvidence {
  return {
    idempotencyKey,
    chain: "solana",
    walletAddress,
    tokenAddress: `Token${walletAddress}`,
    poolAddress: `Pool${walletAddress}`,
    side: "buy",
    baseAmount: 1,
    executionPriceUsd: 1,
    quoteValueUsd: 1,
    poolCreatedAt: "2026-07-09T00:00:00.000Z",
    poolAgeMinutes: 1,
    dataQuality: "observed-execution",
    signature: `signature-${idempotencyKey}`,
    slot,
    provider: "test",
    observedAt: new Date(Date.UTC(2026, 6, 9, 0, 0, slot % 60)).toISOString(),
    strategyVersion: "evidence-v1",
    raw: {}
  };
}

function fifoTrade(
  walletAddress: string,
  slot: number,
  side: "buy" | "sell",
  baseAmount: number,
  quoteValueUsd: number
): WalletTradeEvidence {
  return {
    idempotencyKey: `fifo-${slot}`,
    chain: "solana",
    walletAddress,
    tokenAddress: "ContinuationToken",
    poolAddress: "ContinuationPool",
    side,
    baseAmount,
    executionPriceUsd: quoteValueUsd / baseAmount,
    quoteValueUsd,
    poolCreatedAt: "2026-07-09T00:00:00.000Z",
    poolAgeMinutes: 1,
    dataQuality: "observed-execution",
    signature: `fifo-signature-${slot}`,
    slot,
    provider: "test",
    observedAt: new Date(Date.UTC(2026, 6, 9, 0, 0, slot)).toISOString(),
    strategyVersion: "evidence-v1",
    raw: {}
  };
}
