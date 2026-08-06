import { describe, expect, it } from "vitest";
import { MemoryRepository } from "@memecoin-alpha/db";
import {
  buildCanonicalEvidenceReport,
  renderCanonicalEvidenceMarkdown
} from "./evidence-report-builder";

describe("canonical evidence report", () => {
  it("builds its funnel and decision from repository evidence", async () => {
    const repository = new MemoryRepository();
    await repository.savePriceObservation({
      idempotencyKey: "price",
      chain: "solana",
      tokenAddress: "Mint111",
      poolAddress: "Pool111",
      priceUsd: 1,
      liquidityUsd: 20_000,
      rugged: false,
      signature: "price-sig",
      slot: 0,
      provider: "dexscreener",
      observedAt: "2026-07-05T00:00:00.000Z",
      strategyVersion: "evidence-v1",
      raw: {}
    });
    await repository.saveWalletEntrySignal({
      idempotencyKey: "entry",
      chain: "solana",
      walletAddress: "Wallet111",
      tokenAddress: "Mint111",
      poolAddress: "Pool111",
      sourceSwapIdempotencyKey: "swap-1",
      observedEntryPriceUsd: 1,
      observedLiquidityUsd: 20_000,
      cohort: "repeat-wallet+controlled-flow",
      repeatWalletCount: 2,
      flowEvidence: { controlledFlow: true },
      signature: "entry-sig",
      slot: 11,
      provider: "solana-rpc",
      observedAt: "2026-07-05T00:00:00.000Z",
      strategyVersion: "evidence-v1"
    });
    await repository.saveWalletSignalOutcome({
      idempotencyKey: "outcome",
      entryIdempotencyKey: "entry",
      chain: "solana",
      horizonMinutes: 20,
      status: "mature",
      outcomePriceUsd: 1.1,
      frozenAt: "2026-07-05T00:22:00.000Z",
      grossReturnPct: 10,
      netReturnPct: 7,
      estimatedRoundTripCostPct: 3,
      exitStrategy: "fixed-horizon",
      rugged: false,
      signature: "outcome-sig",
      slot: 12,
      provider: "dexscreener",
      observedAt: "2026-07-05T00:22:00.000Z",
      strategyVersion: "evidence-v1",
      raw: {}
    });
    await repository.saveHypothesisRun({
      idempotencyKey: "run",
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
      decisionReason: "Early evidence only.",
      signature: "derived:run-1",
      slot: 12,
      provider: "evidence-strategy-search",
      observedAt: "2026-07-05T00:22:00.000Z",
      strategyVersion: "evidence-v1"
    });

    const report = await buildCanonicalEvidenceReport(
      repository,
      "evidence-v1",
      { providerStatus: "degraded" },
      "2026-07-05T00:30:00.000Z"
    );

    expect(report).toMatchObject({
      recommendedMode: "paper-watch",
      rawLead: "repeat-wallet+controlled-flow / raw lead / unvalidated",
      funnel: {
        discoveredPools: 1,
        eligibleCandidates: 1,
        observedEntries: 1,
        matureOutcomes: 1,
        repeatingWallets: 1
      },
      dataQuality: {
        providerStatus: "degraded",
        missingSlotCount: 0,
        unresolvedOutcomeCount: 0
      }
    });
    expect(report.goalCompletionAudit.completed).toBe(false);
    expect(renderCanonicalEvidenceMarkdown(report)).toContain("Solana Evidence-First Alpha Report");
  });

  it("does not keep paper-watch alive from an older superseded hypothesis", async () => {
    const repository = new MemoryRepository();
    await repository.saveWalletEntrySignal({
      idempotencyKey: "entry-2",
      chain: "solana",
      walletAddress: "Wallet222",
      tokenAddress: "Mint222",
      sourceSwapIdempotencyKey: "swap-2",
      observedEntryPriceUsd: 1,
      observedLiquidityUsd: 20_000,
      cohort: "repeat-wallet+controlled-flow",
      repeatWalletCount: 2,
      flowEvidence: { controlledFlow: true },
      signature: "entry-2-sig",
      slot: 20,
      provider: "solana-rpc",
      observedAt: "2026-07-10T00:00:00.000Z",
      strategyVersion: "evidence-v1"
    });
    await repository.saveWalletSignalOutcome({
      idempotencyKey: "outcome-2",
      entryIdempotencyKey: "entry-2",
      chain: "solana",
      horizonMinutes: 20,
      status: "mature",
      outcomePriceUsd: 0.9,
      frozenAt: "2026-07-10T00:22:00.000Z",
      grossReturnPct: -10,
      netReturnPct: -13,
      estimatedRoundTripCostPct: 3,
      exitStrategy: "fixed-horizon",
      rugged: false,
      signature: "outcome-2-sig",
      slot: 21,
      provider: "dexscreener",
      observedAt: "2026-07-10T00:22:00.000Z",
      strategyVersion: "evidence-v1",
      raw: {}
    });
    const saveRun = async (suffix: string, verdict: "watch" | "reject", observedAt: string) =>
      repository.saveHypothesisRun({
        idempotencyKey: `run-${suffix}`,
        runId: `run-${suffix}`,
        chain: "solana",
        hypothesisKey: "paper:fixed20",
        cohort: "primary",
        verdict,
        signalKeys: ["Mint222"],
        metrics: {
          signalCount: 1,
          averageReturnPct: -13,
          medianReturnPct: -13,
          averageReturnExBestPct: 0,
          bestWinnerShare: 0,
          hitRate: 0,
          averageDrawdownPct: -13,
          worstReturnPct: -13,
          canonicalSourceLinked: 1,
          replayPassed: 0
        },
        decisionReason: "test",
        signature: `derived:${suffix}`,
        slot: 21,
        provider: "evidence-strategy-search",
        observedAt,
        strategyVersion: "evidence-v1"
      });

    await saveRun("old-watch", "watch", "2026-07-09T23:50:00.000Z");
    await saveRun("latest-reject", "reject", "2026-07-10T00:25:00.000Z");

    const report = await buildCanonicalEvidenceReport(
      repository,
      "evidence-v1",
      { providerStatus: "ok" },
      "2026-07-10T00:30:00.000Z"
    );

    expect(report.recommendedMode).toBe("observe-only");
    expect(report.rawLead).toBeNull();
    expect(report.hypotheses).toHaveLength(1);
    expect(report.hypotheses[0]?.verdict).toBe("reject");
  });

  it("keeps unlinked wallet scans exploratory and out of canonical performance", async () => {
    const repository = new MemoryRepository();
    await repository.saveWalletEntrySignal({
      idempotencyKey: "unlinked-entry",
      chain: "solana",
      walletAddress: "ExploratoryWallet",
      tokenAddress: "ExploratoryMint",
      observedEntryPriceUsd: 1,
      observedLiquidityUsd: 50_000,
      cohort: "controlled-flow-control",
      repeatWalletCount: 0,
      flowEvidence: { controlledFlow: true },
      signature: "scan-signature",
      slot: 50,
      provider: "market-watch-exploratory",
      observedAt: "2026-07-10T00:00:00.000Z",
      strategyVersion: "evidence-v1"
    });
    await repository.saveWalletSignalOutcome({
      idempotencyKey: "unlinked-outcome",
      entryIdempotencyKey: "unlinked-entry",
      chain: "solana",
      horizonMinutes: 20,
      status: "mature",
      outcomePriceUsd: 2,
      frozenAt: "2026-07-10T00:22:00.000Z",
      grossReturnPct: 100,
      netReturnPct: 97,
      estimatedRoundTripCostPct: 3,
      exitStrategy: "fixed-horizon",
      rugged: false,
      signature: "scan-outcome",
      slot: 51,
      provider: "dexscreener",
      observedAt: "2026-07-10T00:22:00.000Z",
      strategyVersion: "evidence-v1",
      raw: {}
    });

    const report = await buildCanonicalEvidenceReport(
      repository,
      "evidence-v1",
      { providerStatus: "ok" },
      "2026-07-10T00:30:00.000Z"
    );

    expect(report.funnel.observedEntries).toBe(0);
    expect(report.funnel.matureOutcomes).toBe(0);
    expect(report.topWallets).toHaveLength(0);
    expect(report.dataQuality.exploratoryEntryCount).toBe(1);
    expect(report.recommendedMode).toBe("observe-only");
  });

  it("requires a matching locked strategy candidate before validation", async () => {
    const repository = new MemoryRepository();
    const generatedAt = "2026-07-10T09:00:00.000Z";
    const endTime = new Date(generatedAt).getTime();
    const firstOutcomeTime = endTime - 7 * 24 * 60 * 60 * 1000;
    const tokenAddresses: string[] = [];

    for (let index = 0; index < 30; index += 1) {
      const tokenAddress = `CandidateMint${index}`;
      const entryId = `candidate-entry-${index}`;
      const outcomeTime = firstOutcomeTime + (index * 7 * 24 * 60 * 60 * 1000) / 29;
      const entryTime = outcomeTime - 20 * 60 * 1000;
      tokenAddresses.push(tokenAddress);
      await repository.saveWalletEntrySignal({
        idempotencyKey: entryId,
        chain: "solana",
        walletAddress: `CandidateWallet${index}`,
        tokenAddress,
        sourceSwapIdempotencyKey: `candidate-swap-${index}`,
        observedEntryPriceUsd: 1,
        observedLiquidityUsd: 25_000,
        cohort: "controlled-flow-control",
        repeatWalletCount: 0,
        flowEvidence: { controlledFlow: true },
        signature: `candidate-entry-signature-${index}`,
        slot: 100 + index,
        provider: "solana-rpc",
        observedAt: new Date(entryTime).toISOString(),
        strategyVersion: "evidence-v1"
      });
      await repository.saveWalletSignalOutcome({
        idempotencyKey: `candidate-outcome-${index}`,
        entryIdempotencyKey: entryId,
        chain: "solana",
        horizonMinutes: 20,
        status: "mature",
        outcomePriceUsd: 1.08,
        frozenAt: new Date(outcomeTime).toISOString(),
        grossReturnPct: 8,
        netReturnPct: 5,
        estimatedRoundTripCostPct: 3,
        exitStrategy: "fixed-horizon",
        rugged: false,
        signature: `candidate-outcome-signature-${index}`,
        slot: 200 + index,
        provider: "dexscreener",
        observedAt: new Date(outcomeTime).toISOString(),
        strategyVersion: "evidence-v1",
        raw: {}
      });
    }

    await repository.saveBacktestRun({
      id: "locked-candidate-replay",
      strategyVersion: "evidence-v1",
      startedAt: new Date(firstOutcomeTime).toISOString(),
      finishedAt: generatedAt,
      dateStart: new Date(firstOutcomeTime).toISOString(),
      dateEnd: generatedAt,
      config: {
        canonicalSourceLinked: true,
        strategySearchCandidateLabel: "locked-controlled-candidate"
      },
      metrics: {
        totalPnlUsd: 100,
        finalBalanceUsd: 1_100,
        executedTradeCount: 30,
        rejectedSignalCount: 0,
        capitalRejectedCount: 0,
        positionLimitRejectedCount: 0,
        failedFillCount: 0,
        winRate: 0.7,
        profitFactor: 2,
        maxDrawdownUsd: 50,
        maxDrawdownPercent: 5,
        medianReturnPercent: 5,
        averageReturnPercent: 5,
        tailLossPercent: -10,
        averageTimeInTradeMinutes: 20,
        rugExposureRate: 0,
        liquidityFailureRate: 0,
        signalPrecisionByConfidence: {}
      },
      reportMarkdown: "test replay"
    });

    const withoutCandidate = await buildCanonicalEvidenceReport(
      repository,
      "evidence-v1",
      { providerStatus: "ok" },
      generatedAt
    );
    expect(withoutCandidate.recommendedMode).toBe("observe-only");
    expect(withoutCandidate.goalCompletionAudit.completed).toBe(false);

    await repository.saveHypothesisRun({
      idempotencyKey: "locked-candidate-hypothesis",
      runId: "locked-candidate-hypothesis",
      chain: "solana",
      hypothesisKey: "canonical-strategy-search",
      cohort: "locked-controlled-candidate",
      verdict: "candidate",
      signalKeys: tokenAddresses,
      metrics: {
        signalCount: 30,
        averageReturnPct: 5,
        medianReturnPct: 5,
        averageReturnExBestPct: 5,
        bestWinnerShare: 0.1,
        hitRate: 1,
        averageDrawdownPct: -5,
        worstReturnPct: 5,
        canonicalSourceLinked: 1,
        replayPassed: 1
      },
      decisionReason: "Locked candidate passed both untouched holdouts and replay.",
      signature: "derived:locked-candidate",
      slot: 300,
      provider: "evidence-strategy-search",
      observedAt: generatedAt,
      strategyVersion: "evidence-v1"
    });

    const withCandidate = await buildCanonicalEvidenceReport(
      repository,
      "evidence-v1",
      { providerStatus: "ok" },
      generatedAt
    );
    expect(withCandidate.goalCompletionAudit.completed).toBe(true);
    expect(withCandidate.recommendedMode).toBe("paper-validate candidate");
  });
});
