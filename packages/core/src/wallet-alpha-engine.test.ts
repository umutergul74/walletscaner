import { describe, expect, it } from "vitest";
import type {
  WalletEntrySignalEvidence,
  WalletSignalOutcomeEvidence,
  WalletTradeEvidence
} from "@memecoin-alpha/shared";
import {
  buildClosedWalletPositions,
  buildWalletLedger,
  buildWalletAlphaScores,
  buildWalletAlphaSignals
} from "./wallet-alpha-engine";

describe("wallet alpha engine", () => {
  it("builds a net realized position from matched buys and sells", () => {
    const positions = buildClosedWalletPositions([
      trade("buy", 100, 1, "2026-07-01T00:05:00.000Z"),
      trade("sell", 100, 1.5, "2026-07-01T00:15:00.000Z")
    ]);

    expect(positions).toHaveLength(1);
    expect(positions[0]!.investedUsd).toBeCloseTo(101.5, 6);
    expect(positions[0]!.proceedsUsd).toBeCloseTo(147.75, 6);
    expect(positions[0]!.netReturnPct).toBeCloseTo(45.57, 1);
  });

  it("realizes every partial sell while retaining the moonbag as open inventory", () => {
    const ledger = buildWalletLedger([
      trade("buy", 100, 1, "2026-07-01T00:05:00.000Z", "Moonbag", {
        rawAmount: "100000000",
        decimals: 6
      }),
      trade("sell", 40, 2, "2026-07-01T00:15:00.000Z", "Moonbag", {
        rawAmount: "40000000",
        decimals: 6
      }),
      trade("sell", 30, 1.5, "2026-07-01T00:20:00.000Z", "Moonbag", {
        rawAmount: "30000000",
        decimals: 6
      })
    ]);

    expect(ledger.realizedEpisodes).toHaveLength(2);
    expect(ledger.realizedEpisodes[0]).toEqual(
      expect.objectContaining({
        realizedBaseAmount: { rawAmount: "40000000", decimals: 6 },
        remainingBaseAmount: { rawAmount: "60000000", decimals: 6 },
        roundTripIndex: 1
      })
    );
    expect(ledger.realizedEpisodes[0]!.investedUsd).toBeCloseTo(40.6, 6);
    expect(ledger.realizedEpisodes[0]!.proceedsUsd).toBeCloseTo(78.8, 6);
    expect(ledger.realizedEpisodes[1]!.investedUsd).toBeCloseTo(30.45, 6);
    expect(ledger.realizedEpisodes[1]!.proceedsUsd).toBeCloseTo(44.325, 6);
    expect(ledger.openInventory).toEqual([
      expect.objectContaining({
        remainingBaseAmount: { rawAmount: "30000000", decimals: 6 },
        remainingCostUsd: expect.closeTo(30.45, 6)
      })
    ]);
    expect(ledger.positionEpisodes).toEqual([
      expect.objectContaining({
        status: "open",
        roundTripIndex: 1,
        remainingBaseAmount: { rawAmount: "30000000", decimals: 6 },
        realizedPnlUsd: expect.closeTo(52.075, 6),
        realizedLotCount: 2
      })
    ]);
    expect(ledger.positionEpisodes[0]!.metadata).toMatchObject({
      ledgerVersion: "fifo-v2",
      realizations: [
        expect.objectContaining({
          sourceEventIdempotencyKey: expect.any(String),
          openedAt: "2026-07-01T00:05:00.000Z",
          closedAt: "2026-07-01T00:15:00.000Z",
          rawAmount: "40000000",
          remainingRawAmount: "60000000",
          tokenDecimals: 6,
          highQuality: true,
          exact: true
        }),
        expect.objectContaining({
          sourceEventIdempotencyKey: expect.any(String),
          openedAt: "2026-07-01T00:05:00.000Z",
          closedAt: "2026-07-01T00:20:00.000Z",
          rawAmount: "30000000",
          remainingRawAmount: "30000000",
          tokenDecimals: 6,
          highQuality: true,
          exact: true
        })
      ]
    });
    expect(ledger.positionLots).toEqual([
      expect.objectContaining({
        rawAmount: { rawAmount: "100000000", decimals: 6 },
        remainingBaseAmount: { rawAmount: "30000000", decimals: 6 },
        status: "partially_realized"
      })
    ]);
  });

  it("separates repeated round trips for the same wallet and token", () => {
    const positions = buildClosedWalletPositions([
      trade("buy", 100, 1, "2026-07-01T00:05:00.000Z", "Repeat"),
      trade("sell", 100, 1.2, "2026-07-01T00:10:00.000Z", "Repeat"),
      trade("buy", 50, 1.1, "2026-07-01T00:20:00.000Z", "Repeat"),
      trade("sell", 50, 1.4, "2026-07-01T00:25:00.000Z", "Repeat")
    ]);

    expect(positions).toHaveLength(2);
    expect(positions.map((position) => position.roundTripIndex)).toEqual([1, 2]);
    expect(positions[0]!.sellIdempotencyKey).not.toBe(positions[1]!.sellIdempotencyKey);
    const ledger = buildWalletLedger([
      trade("buy", 100, 1, "2026-07-01T00:05:00.000Z", "Repeat"),
      trade("sell", 100, 1.2, "2026-07-01T00:10:00.000Z", "Repeat"),
      trade("buy", 50, 1.1, "2026-07-01T00:20:00.000Z", "Repeat"),
      trade("sell", 50, 1.4, "2026-07-01T00:25:00.000Z", "Repeat")
    ]);
    expect(ledger.positionEpisodes.map((episode) => episode.status)).toEqual([
      "realized",
      "realized"
    ]);
    expect(new Set(ledger.positionEpisodes.map((episode) => episode.episodeId)).size).toBe(2);
    expect(ledger.positionLots.every((lot) => lot.status === "realized")).toBe(true);
  });

  it("is deterministic for out-of-order and duplicate trade delivery", () => {
    const trades = [
      trade("buy", 60, 1, "2026-07-01T00:05:00.000Z", "Ordered"),
      trade("buy", 40, 1.5, "2026-07-01T00:06:00.000Z", "Ordered"),
      trade("sell", 50, 2, "2026-07-01T00:07:00.000Z", "Ordered"),
      trade("sell", 50, 1.8, "2026-07-01T00:08:00.000Z", "Ordered")
    ];
    const expected = buildWalletLedger(trades);
    const replayed = buildWalletLedger([
      trades[3]!,
      trades[1]!,
      trades[2]!,
      trades[0]!,
      trades[2]!
    ]);

    expect(replayed).toEqual(expected);
  });

  it("does not promote a followable wallet without completed wallet trades", () => {
    const entries = Array.from({ length: 20 }, (_, index) => entry(index));
    const outcomes = entries.map((value, index) => outcome(value, 10 + index));
    const [score] = buildWalletAlphaScores({
      trades: [],
      entries,
      outcomes,
      strategyVersion: "evidence-v1",
      calculatedAt: "2026-07-10T00:00:00.000Z"
    });

    expect(score?.followabilityScore).toBeGreaterThan(0);
    expect(score?.status).toBe("observed");
    expect(score?.gates.candidate).toBe(false);
  });

  it("excludes unknown-risk, failed-risk and uncontrolled entries from followability", () => {
    const unsafeEntries = [
      { ...entry(0), flowEvidence: { poolAgeMinutes: 6 } },
      {
        ...entry(1),
        flowEvidence: { poolAgeMinutes: 6, tokenRiskKnown: true, tokenRiskPassed: false }
      },
      { ...entry(2), cohort: "excluded-uncontrolled-flow" }
    ];
    const [score] = buildWalletAlphaScores({
      trades: [],
      entries: unsafeEntries,
      outcomes: unsafeEntries.map((value) => outcome(value, 100)),
      strategyVersion: "evidence-v1",
      calculatedAt: "2026-07-10T00:00:00.000Z"
    });

    expect(score?.metrics.followability.sampleCount).toBe(0);
    expect(score?.followabilityScore).toBe(0);
    expect(score?.status).toBe("insufficient");
  });

  it("creates candidate quality only when realized and followable evidence both pass", () => {
    const trades = Array.from({ length: 15 }, (_, index) => [
      trade("buy", 100, 1, day(index, 5), `Token${index}`),
      trade("sell", 100, index % 4 === 0 ? 0.95 : 1.2, day(index, 20), `Token${index}`)
    ]).flat();
    const entries = Array.from({ length: 15 }, (_, index) => entry(index));
    const outcomes = entries.map((value, index) => outcome(value, index % 4 === 0 ? -8 : 15));
    const [score] = buildWalletAlphaScores({
      trades,
      entries,
      outcomes,
      strategyVersion: "evidence-v1",
      calculatedAt: "2026-07-20T00:00:00.000Z"
    });

    expect(score?.status).toBe("candidate");
    expect(score?.completedPositions).toBe(15);
    expect(score?.metrics.profitability.averageReturnExBestPct).toBeGreaterThan(0);
    expect(score?.metrics.highQualityExecutionCoverage).toBe(1);
    expect(score!.metrics.profitability.hitRateWilsonLowerBound).toBeLessThan(
      score!.metrics.profitability.hitRate
    );
  });

  it("preserves the fixed-horizon v1 worst-return gate", () => {
    const fixture = managedScoringEvidence({ followCount: 15, ruggedIndexes: [0] });
    const [score] = buildWalletAlphaScores({
      trades: fixture.trades,
      entries: fixture.entries,
      outcomes: fixture.entries.map((value, index) =>
        outcome(value, index === 0 ? -103 : 15, index === 0)
      ),
      strategyVersion: "evidence-v1",
      calculatedAt: "2026-08-05T00:00:00.000Z"
    });

    expect(score?.metrics.followability.worstReturnPct).toBe(-103);
    expect(score?.gates.watch).toBe(false);
    expect(score?.status).toBe("observed");
  });

  it("uses managed exits and rate-based tail risk in the v2 shadow policy", () => {
    const fixture = managedScoringEvidence({ ruggedIndexes: [0] });
    const fixedOutcomes = fixture.entries.map((value) => outcome(value, -103, true));
    const [fixedScore] = buildWalletAlphaScores({
      ...fixture,
      outcomes: fixedOutcomes,
      strategyVersion: "evidence-v1",
      calculatedAt: "2026-08-05T00:00:00.000Z"
    });
    const [managedScore] = buildWalletAlphaScores({
      ...fixture,
      outcomes: [...fixedOutcomes, ...fixture.outcomes],
      strategyVersion: "evidence-v1",
      scoreStrategyVersion: "wallet-alpha-managed-v2",
      scoringPolicy: "managed-exit-v2",
      calculatedAt: "2026-08-20T00:00:00.000Z"
    });

    expect(fixedScore?.status).toBe("observed");
    expect(managedScore).toMatchObject({
      strategyVersion: "wallet-alpha-managed-v2",
      status: "watch",
      gates: { watch: true, candidate: false, validatedPaper: false }
    });
    expect(managedScore?.metrics).toMatchObject({
      scoringPolicy: "managed-exit-v2",
      evidenceStrategyVersion: "evidence-v1",
      followabilityExitStrategy: "tp15-sl20-20m"
    });
    expect(managedScore?.metrics.followability).toMatchObject({
      sampleCount: 30,
      ruggedOutcomeCount: 1,
      catastrophicLossCount: 1
    });
    expect(managedScore!.metrics.followability.ruggedOutcomeRate).toBeCloseTo(1 / 30, 8);
    expect(
      buildWalletAlphaSignals({
        scores: [managedScore!],
        entries: fixture.entries,
        strategyVersion: "wallet-alpha-managed-v2",
        now: "2026-08-05T00:00:00.000Z"
      })
    ).toEqual([]);
    expect(
      buildWalletAlphaSignals({
        scores: [managedScore!],
        entries: fixture.entries,
        strategyVersion: "evidence-v1",
        now: "2026-08-05T00:00:00.000Z"
      })
    ).toEqual([]);
  });

  it("fails closed when managed rug or catastrophic-loss frequency exceeds five percent", () => {
    for (const fixture of [
      managedScoringEvidence({ ruggedIndexes: [0, 1] }),
      managedScoringEvidence({ catastrophicIndexes: [0, 1] })
    ]) {
      const [score] = buildWalletAlphaScores({
        ...fixture,
        strategyVersion: "evidence-v1",
        scoreStrategyVersion: "wallet-alpha-managed-v2",
        scoringPolicy: "managed-exit-v2",
        calculatedAt: "2026-08-05T00:00:00.000Z"
      });

      expect(score?.metrics.followability.hitRate).toBeGreaterThan(0.9);
      expect(score?.gates.watch).toBe(false);
      expect(score?.status).toBe("observed");
      expect(score?.reasons.join(" ")).toContain("no more than 5% rug");
    }
  });

  it("requires both chronological managed holdouts for validated-paper", () => {
    const clean = managedScoringEvidence({ followCount: 40, activeDayCount: 20 });
    const weakTail = managedScoringEvidence({
      followCount: 40,
      activeDayCount: 20,
      catastrophicIndexes: [38, 39]
    });
    const [validated] = buildWalletAlphaScores({
      ...clean,
      strategyVersion: "evidence-v1",
      scoreStrategyVersion: "wallet-alpha-managed-v2",
      scoringPolicy: "managed-exit-v2",
      calculatedAt: "2026-08-20T00:00:00.000Z"
    });
    const [candidate] = buildWalletAlphaScores({
      ...weakTail,
      strategyVersion: "evidence-v1",
      scoreStrategyVersion: "wallet-alpha-managed-v2",
      scoringPolicy: "managed-exit-v2",
      calculatedAt: "2026-08-20T00:00:00.000Z"
    });

    expect(validated?.status).toBe("validated-paper");
    expect(validated?.metrics.followabilityHoldoutsPassed).toBe(true);
    expect(candidate?.gates.candidate).toBe(true);
    expect(candidate?.metrics.followabilityHoldoutsPassed).toBe(false);
    expect(candidate?.status).toBe("candidate");
  });

  it("keeps managed scores deterministic under outcome reordering", () => {
    const fixture = managedScoringEvidence({ ruggedIndexes: [0] });
    const input = {
      trades: fixture.trades,
      entries: fixture.entries,
      strategyVersion: "evidence-v1",
      scoreStrategyVersion: "wallet-alpha-managed-v2",
      scoringPolicy: "managed-exit-v2" as const,
      calculatedAt: "2026-08-05T00:00:00.000Z"
    };

    expect(buildWalletAlphaScores({ ...input, outcomes: [...fixture.outcomes].reverse() })).toEqual(
      buildWalletAlphaScores({ ...input, outcomes: fixture.outcomes })
    );
  });

  it("blocks candidate status below 90% high-quality execution coverage", () => {
    const trades = Array.from({ length: 15 }, (_, index) => [
      trade(
        "buy",
        100,
        1,
        day(index, 5),
        `Coverage${index}`,
        undefined,
        index < 2 ? "market-proxy" : "observed-execution"
      ),
      trade("sell", 100, 1.2, day(index, 20), `Coverage${index}`)
    ]).flat();
    const entries = Array.from({ length: 15 }, (_, index) => entry(index));
    const [score] = buildWalletAlphaScores({
      trades,
      entries,
      outcomes: entries.map((value) => outcome(value, 15)),
      strategyVersion: "evidence-v1",
      calculatedAt: "2026-07-20T00:00:00.000Z"
    });

    expect(score?.metrics.highQualityExecutionCoverage).toBeCloseTo(13 / 15, 6);
    expect(score?.gates.watch).toBe(true);
    expect(score?.gates.candidate).toBe(false);
    expect(score?.status).toBe("watch");
  });

  it("blocks candidate status when one winner dominates positive returns", () => {
    const trades = Array.from({ length: 15 }, (_, index) => [
      trade("buy", 100, 1, day(index, 5), `Concentrated${index}`),
      trade("sell", 100, index === 14 ? 11 : 1.15, day(index, 20), `Concentrated${index}`)
    ]).flat();
    const entries = Array.from({ length: 15 }, (_, index) => entry(index));
    const [score] = buildWalletAlphaScores({
      trades,
      entries,
      outcomes: entries.map((value) => outcome(value, 15)),
      strategyVersion: "evidence-v1",
      calculatedAt: "2026-07-20T00:00:00.000Z"
    });

    expect(score!.metrics.profitability.bestWinnerShare).toBeGreaterThan(0.4);
    expect(score?.gates.candidate).toBe(false);
    expect(score?.reasons.join(" ")).toContain("One winner");
  });

  it("keeps distinct 30-day and 90-day scoring windows with recency decay", () => {
    const [score] = buildWalletAlphaScores({
      trades: [
        trade("buy", 100, 1, "2026-05-10T00:05:00.000Z", "OlderWindow"),
        trade("sell", 100, 1.2, "2026-05-10T00:20:00.000Z", "OlderWindow"),
        trade("buy", 100, 1, "2026-07-10T00:05:00.000Z", "RecentWindow"),
        trade("sell", 100, 1.2, "2026-07-10T00:20:00.000Z", "RecentWindow")
      ],
      entries: [],
      outcomes: [],
      strategyVersion: "evidence-v1",
      calculatedAt: "2026-07-20T00:00:00.000Z"
    });

    expect(score?.metrics.profitability30d?.sampleCount).toBe(1);
    expect(score?.metrics.profitability90d?.sampleCount).toBe(2);
    expect(score!.metrics.recencyDecayFactor).toBeGreaterThan(0);
    expect(score!.metrics.recencyDecayFactor).toBeLessThan(1);
  });

  it("excludes a directly observed creator wallet", () => {
    const [score] = buildWalletAlphaScores({
      trades: [
        trade("buy", 100, 1, "2026-07-01T00:05:00.000Z"),
        trade("sell", 100, 2, "2026-07-01T00:15:00.000Z")
      ],
      entries: [entry(0)],
      outcomes: [outcome(entry(0), 20)],
      strategyVersion: "evidence-v1",
      creatorWallets: new Set(["WalletAlpha"])
    });
    expect(score?.status).toBe("excluded");
  });

  it("emits only paper signals from qualified wallet scores", () => {
    const qualified = buildWalletAlphaScores({
      trades: Array.from({ length: 15 }, (_, index) => [
        trade("buy", 100, 1, day(index, 5), `Token${index}`),
        trade("sell", 100, 1.25, day(index, 20), `Token${index}`)
      ]).flat(),
      entries: Array.from({ length: 15 }, (_, index) => entry(index)),
      outcomes: Array.from({ length: 15 }, (_, index) => outcome(entry(index), 15)),
      strategyVersion: "evidence-v1",
      calculatedAt: "2026-07-20T00:00:00.000Z"
    });
    const liveEntry = {
      ...entry(99),
      tokenAddress: "LiveToken",
      observedAt: "2026-07-20T00:30:00.000Z"
    };
    const signals = buildWalletAlphaSignals({
      scores: qualified,
      entries: [liveEntry],
      strategyVersion: "evidence-v1",
      now: "2026-07-20T01:00:00.000Z"
    });

    expect(signals).toEqual([
      expect.objectContaining({ tokenAddress: "LiveToken", status: "paper-candidate" })
    ]);
  });

  it("fails closed for unknown or failed token risk evidence", () => {
    const qualified = buildWalletAlphaScores({
      trades: Array.from({ length: 15 }, (_, index) => [
        trade("buy", 100, 1, day(index, 5), `Risk${index}`),
        trade("sell", 100, 1.25, day(index, 20), `Risk${index}`)
      ]).flat(),
      entries: Array.from({ length: 15 }, (_, index) => entry(index)),
      outcomes: Array.from({ length: 15 }, (_, index) => outcome(entry(index), 15)),
      strategyVersion: "evidence-v1",
      calculatedAt: "2026-07-20T00:00:00.000Z"
    });
    const passed = { ...entry(90), tokenAddress: "Passed", observedAt: "2026-07-20T00:30:00.000Z" };
    const unknown = {
      ...entry(91),
      tokenAddress: "Unknown",
      observedAt: "2026-07-20T00:31:00.000Z",
      flowEvidence: { poolAgeMinutes: 6 }
    };
    const failed = {
      ...entry(92),
      tokenAddress: "Failed",
      observedAt: "2026-07-20T00:32:00.000Z",
      flowEvidence: { poolAgeMinutes: 6, tokenRiskKnown: true, tokenRiskPassed: false }
    };

    const signals = buildWalletAlphaSignals({
      scores: qualified,
      entries: [unknown, failed, passed],
      strategyVersion: "evidence-v1",
      now: "2026-07-20T01:00:00.000Z"
    });

    expect(signals.map((signal) => signal.tokenAddress)).toEqual(["Passed"]);
  });

  it("scores a large wallet population without repeatedly scanning all outcomes", () => {
    const walletCount = 5_000;
    const entries = Array.from({ length: walletCount }, (_, index) => ({
      ...entry(index),
      idempotencyKey: `large-entry-${index}`,
      walletAddress: `Wallet${index}`,
      tokenAddress: `LargeToken${index}`,
      sourceSwapIdempotencyKey: `large-swap-${index}`,
      observedAt: "2026-07-19T00:05:00.000Z"
    }));
    const outcomes = entries.map((entryValue, index) => ({
      ...outcome(entryValue, index % 2 === 0 ? 8 : -4),
      idempotencyKey: `large-outcome-${index}`
    }));

    const scores = buildWalletAlphaScores({
      trades: [],
      entries,
      outcomes,
      strategyVersion: "evidence-v1",
      calculatedAt: "2026-07-20T00:00:00.000Z"
    });

    expect(scores).toHaveLength(walletCount);
    expect(scores.every((score) => score.metrics.followability.sampleCount === 1)).toBe(true);
  });
});

function trade(
  side: "buy" | "sell",
  baseAmount: number,
  executionPriceUsd: number,
  observedAt: string,
  tokenAddress = "TokenAlpha",
  baseTokenAmount?: { rawAmount: string; decimals: number },
  dataQuality: WalletTradeEvidence["dataQuality"] = "observed-execution"
): WalletTradeEvidence {
  return {
    idempotencyKey: `${tokenAddress}:${side}:${observedAt}`,
    chain: "solana",
    walletAddress: "WalletAlpha",
    tokenAddress,
    poolAddress: `Pool:${tokenAddress}`,
    side,
    baseAmount,
    ...(baseTokenAmount ? { baseTokenAmount } : {}),
    executionPriceUsd,
    poolCreatedAt: observedAt.slice(0, 11) + "00:00:00.000Z",
    poolAgeMinutes: 5,
    dataQuality,
    signature: `${tokenAddress}:${side}`,
    slot: 1,
    provider: "mock",
    observedAt,
    strategyVersion: "evidence-v1",
    raw: {}
  };
}

function entry(index: number): WalletEntrySignalEvidence {
  const observedAt = day(index, 6);
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
    flowEvidence: { poolAgeMinutes: 6, tokenRiskKnown: true, tokenRiskPassed: true },
    signature: `entry-sig-${index}`,
    slot: index + 1,
    provider: "mock",
    observedAt,
    strategyVersion: "evidence-v1"
  };
}

function outcome(
  entryValue: WalletEntrySignalEvidence,
  netReturnPct: number,
  rugged = false
): WalletSignalOutcomeEvidence {
  return {
    idempotencyKey: `outcome:${entryValue.idempotencyKey}`,
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
    signature: `outcome-sig:${entryValue.idempotencyKey}`,
    slot: 2,
    provider: "mock",
    observedAt: new Date(new Date(entryValue.observedAt).getTime() + 20 * 60_000).toISOString(),
    strategyVersion: "evidence-v1",
    raw: {}
  };
}

function managedOutcome(
  entryValue: WalletEntrySignalEvidence,
  netReturnPct: number,
  rugged = false
): WalletSignalOutcomeEvidence {
  return {
    ...outcome(entryValue, netReturnPct, rugged),
    idempotencyKey: `managed-outcome:${entryValue.idempotencyKey}`,
    exitStrategy: "tp15-sl20-20m"
  };
}

function managedScoringEvidence(options: {
  followCount?: number;
  activeDayCount?: number;
  ruggedIndexes?: number[];
  catastrophicIndexes?: number[];
}) {
  const followCount = options.followCount ?? 30;
  const activeDayCount = options.activeDayCount ?? 4;
  const ruggedIndexes = new Set(options.ruggedIndexes ?? []);
  const catastrophicIndexes = new Set(options.catastrophicIndexes ?? []);
  const entries = Array.from({ length: followCount }, (_, index) => entry(index));
  const trades = Array.from({ length: followCount }, (_, index) => [
    trade("buy", 100, 1, day(index % activeDayCount, 5), `Managed${index}`),
    trade("sell", 100, 1.2, day(index % activeDayCount, 20), `Managed${index}`)
  ]).flat();
  const outcomes = entries.map((value, index) =>
    ruggedIndexes.has(index)
      ? managedOutcome(value, -103, true)
      : managedOutcome(value, catastrophicIndexes.has(index) ? -70 : 15)
  );
  return { trades, entries, outcomes };
}

function day(index: number, minute: number): string {
  const date = new Date("2026-07-01T00:00:00.000Z");
  date.setUTCDate(date.getUTCDate() + index);
  date.setUTCMinutes(minute);
  return date.toISOString();
}
