import { describe, expect, it, vi } from "vitest";
import { MemoryRepository } from "@memecoin-alpha/db";
import type { WalletEntrySignalEvidence, WalletTradeEvidence } from "@memecoin-alpha/shared";
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
    const scopedLoads = vi.spyOn(repository, "listWalletTradeEventsForWallets");
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
    expect(scopedLoads.mock.calls.map(([wallets]) => wallets)).toEqual([["ZHealthyWallet"]]);
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
    const scopedTradeLoads = vi.spyOn(repository, "listWalletTradeEventsForWallets");
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
    // Only the admitted wallet reaches the full evidence load. The low-evidence
    // wallet is completed from the revision-bound batch probe.
    expect(scopedTradeLoads.mock.calls.map(([wallets]) => wallets)).toEqual([["ThreeEntryWallet"]]);
  });

  it("falls back to a fresh probe when evidence advances the queued revision", async () => {
    const repository = new MemoryRepository();
    await repository.saveWalletTradeEvent(walletTrade("RevisionWallet", "revision-1", 1));
    const originalProbe = repository.probeWalletAlphaAdmission.bind(repository);
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
    expect(scopedTradeLoads).toHaveBeenCalledTimes(1);
  });

  it("processes a risk-passed source entry before historical backlog", async () => {
    const repository = new MemoryRepository();
    await repository.saveWalletTradeEvent(walletTrade("HistoricalWallet", "historical-buy", 1));
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
});

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
