import { describe, expect, it, vi } from "vitest";
import { buildWalletAlphaScores } from "@memecoin-alpha/core";
import type {
  WalletEntrySignalEvidence,
  WalletSignalOutcomeEvidence,
  WalletTradeEvidence
} from "@memecoin-alpha/shared";
import {
  buildManagedShadowReport,
  entryDetectionDelaySeconds,
  renderManagedShadowMarkdown
} from "./wallet-alpha-managed-shadow-builder";

describe("wallet alpha managed shadow report", () => {
  it("compares a bounded sample without persisting scores or enabling signals", async () => {
    const evidence = managedEvidence();
    const [sourceScore] = buildWalletAlphaScores({
      trades: evidence.trades,
      entries: evidence.entries,
      outcomes: evidence.entries.map((entry) => fixedOutcome(entry, -103, true)),
      strategyVersion: "evidence-v1",
      calculatedAt: "2026-08-05T00:00:00.000Z"
    });
    const repository = {
      listWalletAlphaScores: vi.fn().mockResolvedValue([sourceScore!]),
      listWalletTradeEventsForWallets: vi.fn().mockResolvedValue(evidence.trades),
      listWalletEntrySignalsForWallets: vi.fn().mockResolvedValue(evidence.entries),
      listWalletSignalOutcomesForWallets: vi.fn().mockResolvedValue(evidence.outcomes),
      listTokenCreatorAddresses: vi.fn().mockResolvedValue([])
    };

    const report = await buildManagedShadowReport(
      repository,
      "evidence-v1",
      "2026-08-05T00:00:00.000Z",
      { maximumWallets: 10, sourceScoreReadLimit: 25 }
    );

    expect(report).toMatchObject({
      persisted: false,
      signalsEnabled: false,
      scoreStrategyVersion: "wallet-alpha-managed-v2",
      inputs: { entries: 30, followableEntries: 30, timingExcludedEntries: 0 },
      statusCounts: { watch: 1 }
    });
    expect(report.comparisons[0]).toMatchObject({
      sourceStatus: "observed",
      managedStatus: "watch"
    });
    expect(repository.listWalletTradeEventsForWallets).toHaveBeenCalledWith(
      ["WalletAlpha"],
      "evidence-v1"
    );
    expect(renderManagedShadowMarkdown(report)).toContain("Persisted: no");
    expect(renderManagedShadowMarkdown(report)).toContain("Signals enabled: no");
  });

  it("excludes stale or unprovable entry timing from followability", async () => {
    const evidence = managedEvidence();
    const staleEntries = evidence.entries.map((value) => ({
      ...value,
      flowEvidence: {
        ...value.flowEvidence,
        buyObservedAt: new Date(new Date(value.observedAt).getTime() - 61_000).toISOString()
      }
    }));
    const [sourceScore] = buildWalletAlphaScores({
      trades: evidence.trades,
      entries: evidence.entries,
      outcomes: evidence.outcomes,
      strategyVersion: "evidence-v1",
      calculatedAt: "2026-08-05T00:00:00.000Z"
    });
    const repository = {
      listWalletAlphaScores: vi.fn().mockResolvedValue([sourceScore!]),
      listWalletTradeEventsForWallets: vi.fn().mockResolvedValue(evidence.trades),
      listWalletEntrySignalsForWallets: vi.fn().mockResolvedValue(staleEntries),
      listWalletSignalOutcomesForWallets: vi.fn().mockResolvedValue(evidence.outcomes),
      listTokenCreatorAddresses: vi.fn().mockResolvedValue([])
    };

    const report = await buildManagedShadowReport(
      repository,
      "evidence-v1",
      "2026-08-05T00:00:00.000Z",
      { maximumWallets: 1, maximumEntryDetectionDelaySeconds: 60 }
    );

    expect(report.inputs).toMatchObject({
      entries: 30,
      followableEntries: 0,
      timingExcludedEntries: 30
    });
    expect(report.statusCounts.watch).toBe(0);
    expect(entryDetectionDelaySeconds(staleEntries[0]!)).toBe(61);
  });
});

function managedEvidence() {
  const entries = Array.from({ length: 30 }, (_, index) => entry(index));
  const trades = Array.from({ length: 30 }, (_, index) => [
    trade("buy", index, 1),
    trade("sell", index, 1.2)
  ]).flat();
  const outcomes = entries.map((value, index) => managedOutcome(value, index === 0 ? -103 : 15));
  return { entries, trades, outcomes };
}

function trade(side: "buy" | "sell", index: number, price: number): WalletTradeEvidence {
  const date = new Date("2026-07-01T00:00:00.000Z");
  date.setUTCDate(date.getUTCDate() + (index % 4));
  date.setUTCMinutes(side === "buy" ? 5 : 20);
  const observedAt = date.toISOString();
  return {
    idempotencyKey: `Managed${index}:${side}:${observedAt}`,
    chain: "solana",
    walletAddress: "WalletAlpha",
    tokenAddress: `Managed${index}`,
    poolAddress: `PoolManaged${index}`,
    side,
    baseAmount: 100,
    executionPriceUsd: price,
    poolCreatedAt: observedAt.slice(0, 11) + "00:00:00.000Z",
    poolAgeMinutes: 5,
    dataQuality: "observed-execution",
    signature: `Managed${index}:${side}`,
    slot: index * 2 + (side === "buy" ? 1 : 2),
    provider: "mock",
    observedAt,
    strategyVersion: "evidence-v1",
    raw: {}
  };
}

function entry(index: number): WalletEntrySignalEvidence {
  const observedAt = new Date(
    new Date("2026-07-01T00:06:00.000Z").getTime() + index * 24 * 60 * 60 * 1_000
  ).toISOString();
  return {
    idempotencyKey: `entry-${index}`,
    chain: "solana",
    walletAddress: "WalletAlpha",
    tokenAddress: `Token${index}`,
    poolAddress: `Pool${index}`,
    sourceSwapIdempotencyKey: `swap-${index}`,
    observedEntryPriceUsd: 1,
    observedLiquidityUsd: 20_000,
    cohort: "wallet-alpha",
    repeatWalletCount: index,
    flowEvidence: {
      poolAgeMinutes: 6,
      tokenRiskKnown: true,
      tokenRiskPassed: true,
      buyObservedAt: new Date(new Date(observedAt).getTime() - 30_000).toISOString()
    },
    signature: `entry-sig-${index}`,
    slot: index + 1,
    provider: "mock",
    observedAt,
    strategyVersion: "evidence-v1"
  };
}

function fixedOutcome(
  entryValue: WalletEntrySignalEvidence,
  netReturnPct: number,
  rugged: boolean
): WalletSignalOutcomeEvidence {
  return {
    idempotencyKey: `fixed:${entryValue.idempotencyKey}`,
    chain: "solana",
    entryIdempotencyKey: entryValue.idempotencyKey,
    horizonMinutes: 20,
    status: "mature",
    outcomePriceUsd: 1 + (netReturnPct + 3) / 100,
    frozenAt: entryValue.observedAt,
    grossReturnPct: netReturnPct + 3,
    netReturnPct,
    estimatedRoundTripCostPct: 3,
    exitStrategy: "fixed-horizon",
    rugged,
    signature: `fixed:${entryValue.idempotencyKey}`,
    slot: 2,
    provider: "mock",
    observedAt: new Date(new Date(entryValue.observedAt).getTime() + 20 * 60_000).toISOString(),
    strategyVersion: "evidence-v1",
    raw: {}
  };
}

function managedOutcome(
  entryValue: WalletEntrySignalEvidence,
  netReturnPct: number
): WalletSignalOutcomeEvidence {
  return {
    ...fixedOutcome(entryValue, netReturnPct, netReturnPct <= -100),
    idempotencyKey: `managed:${entryValue.idempotencyKey}`,
    exitStrategy: "tp15-sl20-20m"
  };
}
