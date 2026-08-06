import { describe, expect, it } from "vitest";
import { buildSampleSignal } from "@memecoin-alpha/core";
import { runHistoricalReplay } from "./replay";

const thresholds = {
  minimumLiquidityUsd: 10000,
  minimumVolume5mUsd: 5000,
  maximumTopHolderPercent: 70,
  maximumRugRisk: 70,
  minimumSmartWalletScore: 60,
  alertMinimumConfidence: 60,
  paperPositionSizeUsd: 100,
  maxOpenPaperPositions: 5,
  stopLossPercent: 35,
  takeProfitPercent: 150,
  timeExitMinutes: 240
};

describe("runHistoricalReplay", () => {
  it("simulates fees and slippage without lookahead entry", () => {
    const signal = {
      ...buildSampleSignal(thresholds),
      actionCategory: "paper-trade candidate" as const
    };
    const run = runHistoricalReplay(
      [signal],
      [
        {
          tokenAddress: signal.tokenAddress,
          observedAt: new Date(new Date(signal.detectedAt).getTime() - 1000).toISOString(),
          priceUsd: 1,
          liquidityUsd: 50000
        },
        {
          tokenAddress: signal.tokenAddress,
          observedAt: new Date(new Date(signal.detectedAt).getTime() + 2000).toISOString(),
          priceUsd: 1,
          liquidityUsd: 50000
        },
        {
          tokenAddress: signal.tokenAddress,
          observedAt: new Date(new Date(signal.detectedAt).getTime() + 60_000).toISOString(),
          priceUsd: 2.6,
          liquidityUsd: 50000
        }
      ],
      {
        strategyVersion: signal.strategyVersion,
        startingBalanceUsd: 10000,
        positionSizeUsd: 100,
        maxOpenPositions: 5,
        feeBps: 30,
        slippageBps: 100,
        providerLatencyMs: 1000,
        failedFillRate: 0,
        stopLossPercent: 25,
        takeProfitPercent: 100,
        timeExitMinutes: 60,
        minimumLiquidityUsd: 10000
      }
    );

    expect(run.metrics.totalPnlUsd).toBeGreaterThan(0);
    expect(run.metrics.profitFactor).toBe(999);
    expect(run.reportMarkdown).toContain("Backtest Report");
  });

  it("rejects overlapping signals when capital or position capacity is occupied", () => {
    const base = new Date("2026-07-05T00:00:00.000Z");
    const first = signalAt("signal-a", "MintA", base);
    const second = signalAt("signal-b", "MintB", new Date(base.getTime() + 60_000));
    const run = runHistoricalReplay(
      [first, second],
      [
        price("MintA", base, 1, 1),
        price("MintA", base, 11, 1.1),
        price("MintB", base, 1.1, 1),
        price("MintB", base, 12, 1.1)
      ],
      replayConfig({
        startingBalanceUsd: 100,
        positionSizeUsd: 100,
        maxOpenPositions: 1,
        timeExitMinutes: 10
      })
    );

    expect(run.metrics).toMatchObject({
      executedTradeCount: 1,
      rejectedSignalCount: 1,
      positionLimitRejectedCount: 1
    });
  });

  it("processes exits before entries at the same timestamp", () => {
    const base = new Date("2026-07-05T00:00:00.000Z");
    const first = signalAt("signal-a", "MintA", base);
    const second = signalAt("signal-b", "MintB", new Date(base.getTime() + 5 * 60_000));
    const run = runHistoricalReplay(
      [first, second],
      [
        price("MintA", base, 0, 1),
        price("MintA", base, 5, 1.1),
        price("MintB", base, 5, 1),
        price("MintB", base, 10, 1.1)
      ],
      replayConfig({
        startingBalanceUsd: 100,
        positionSizeUsd: 100,
        maxOpenPositions: 1,
        timeExitMinutes: 5
      })
    );

    expect(run.metrics.executedTradeCount).toBe(2);
    expect(run.metrics.positionLimitRejectedCount).toBe(0);
  });

  it("marks open positions to market when another signal arrives", () => {
    const base = new Date("2026-07-05T00:00:00.000Z");
    const first = signalAt("signal-a", "MintA", base);
    const second = signalAt("signal-b", "MintB", new Date(base.getTime() + 5 * 60_000));
    const run = runHistoricalReplay(
      [first, second],
      [
        price("MintA", base, 0, 1),
        price("MintA", base, 5, 0.5),
        price("MintA", base, 20, 1),
        price("MintB", base, 5, 1),
        price("MintB", base, 25, 1)
      ],
      replayConfig({
        startingBalanceUsd: 1_000,
        positionSizeUsd: 100,
        maxOpenPositions: 2,
        stopLossPercent: 90,
        timeExitMinutes: 20
      })
    );

    expect(run.metrics.executedTradeCount).toBe(2);
    expect(run.metrics.maxDrawdownPercent).toBe(5);
    expect(run.metrics.finalBalanceUsd).toBe(1_000);
  });

  it("includes rug and liquidity failure losses in portfolio drawdown", () => {
    const base = new Date("2026-07-05T00:00:00.000Z");
    const signal = signalAt("rug-signal", "RugMint", base);
    const run = runHistoricalReplay(
      [signal],
      [
        price("RugMint", base, 0, 1),
        {
          ...price("RugMint", base, 2, 0),
          liquidityUsd: 0,
          rugged: true
        }
      ],
      replayConfig({
        startingBalanceUsd: 100,
        positionSizeUsd: 100,
        maxOpenPositions: 1
      })
    );

    expect(run.metrics).toMatchObject({
      finalBalanceUsd: 0,
      totalPnlUsd: -100,
      rugExposureRate: 1,
      maxDrawdownPercent: 100
    });
  });
});

function replayConfig(
  overrides: Partial<Parameters<typeof runHistoricalReplay>[2]> = {}
): Parameters<typeof runHistoricalReplay>[2] {
  return {
    strategyVersion: "evidence-v1",
    startingBalanceUsd: 1_000,
    positionSizeUsd: 100,
    maxOpenPositions: 2,
    feeBps: 0,
    slippageBps: 0,
    providerLatencyMs: 0,
    failedFillRate: 0,
    stopLossPercent: 90,
    takeProfitPercent: 1_000,
    timeExitMinutes: 20,
    minimumLiquidityUsd: 10_000,
    ...overrides
  };
}

function signalAt(id: string, tokenAddress: string, detectedAt: Date) {
  return {
    ...buildSampleSignal(thresholds),
    id,
    tokenAddress,
    tokenSymbol: tokenAddress,
    detectedAt: detectedAt.toISOString(),
    actionCategory: "paper-trade candidate" as const
  };
}

function price(tokenAddress: string, base: Date, minute: number, priceUsd: number) {
  return {
    tokenAddress,
    observedAt: new Date(base.getTime() + minute * 60_000).toISOString(),
    priceUsd,
    liquidityUsd: 50_000
  };
}
