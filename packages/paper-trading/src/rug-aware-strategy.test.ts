import { describe, expect, it } from "vitest";
import {
  calculatePaperPositionSize,
  conservativeRugAwarePaperConfig,
  decidePaperPosition,
  defaultRugAwarePaperConfig,
  QUALIFIED_POOL_PAPER_V2_STRATEGY_VERSION,
  QUALIFIED_POOL_PAPER_V3_STRATEGY_VERSION,
  paperQualificationVersionForStrategy,
  rugAwarePaperConfigForVersion,
  strictFlowRugAwarePaperConfig,
  validatePaperEntry,
  type PaperMarketSnapshot,
  type PaperPositionState
} from "./rug-aware-strategy";

const observedAt = "2026-07-16T12:02:00.000Z";
const healthyMarket: PaperMarketSnapshot = {
  observedAt,
  priceUsd: 0.001,
  liquidityUsd: 20_000,
  volume5mUsd: 8_000,
  buys5m: 80,
  sells5m: 50,
  pairFound: true
};

const position: PaperPositionState = {
  initialQuantity: 10_000,
  remainingQuantity: 10_000,
  entryPriceUsd: 0.001,
  entryNotionalUsd: 12,
  entryLiquidityUsd: 20_000,
  peakPriceUsd: 0.001,
  openedAt: "2026-07-16T12:00:00.000Z",
  stage: "initial",
  missingPairCount: 0,
  realizedProceedsUsd: 0
};

describe("rug-aware paper strategy", () => {
  it("requires persistent known liquidity before entry", () => {
    expect(
      validatePaperEntry({
        signalObservedAt: "2026-07-16T12:00:00.000Z",
        signalLiquidityUsd: 20_000,
        snapshot: healthyMarket
      })
    ).toBeUndefined();
    const unknownLiquidity = { ...healthyMarket };
    delete unknownLiquidity.liquidityUsd;
    expect(
      validatePaperEntry({
        signalObservedAt: "2026-07-16T12:00:00.000Z",
        signalLiquidityUsd: 20_000,
        snapshot: unknownLiquidity
      })
    ).toBe("entry_liquidity_unknown");
  });

  it("caps each position by cash, exposure and pool liquidity", () => {
    expect(
      calculatePaperPositionSize({
        cashBalanceUsd: 100,
        committedExposureUsd: 0,
        liquidityUsd: 20_000
      })
    ).toBe(12);
    expect(
      calculatePaperPositionSize({
        cashBalanceUsd: 100,
        committedExposureUsd: 30,
        liquidityUsd: 20_000
      })
    ).toBe(6);
  });

  it("recovers capital after a 75 percent move and trails the remainder", () => {
    const recovery = decidePaperPosition(position, {
      ...healthyMarket,
      priceUsd: 0.0018
    });
    expect(recovery).toMatchObject({
      action: "sell",
      fraction: defaultRugAwarePaperConfig.capitalRecoveryFraction,
      closeAfterFill: false,
      reason: "capital_recovery"
    });
    if (recovery.action !== "sell") throw new Error("Expected a sell decision.");
    const trailed = decidePaperPosition(
      {
        ...recovery.state,
        remainingQuantity: 4_000,
        peakPriceUsd: 0.003,
        stage: "capital_recovered"
      },
      { ...healthyMarket, priceUsd: 0.0021 }
    );
    expect(trailed).toMatchObject({
      action: "sell",
      closeAfterFill: true,
      reason: "trailing_stop"
    });
  });

  it("waits through one missing response but terminalizes repeated disappearance", () => {
    const missing = { ...healthyMarket, pairFound: false, priceUsd: 0 };
    const first = decidePaperPosition(position, missing);
    expect(first).toMatchObject({ action: "hold", reason: "exact_pool_temporarily_missing" });
    const second = decidePaperPosition(first.state, missing);
    expect(second.action).toBe("hold");
    const third = decidePaperPosition(second.state, missing);
    expect(third).toMatchObject({ action: "rugged", reason: "exact_pool_disappeared" });
  });

  it("distinguishes unknown liquidity from explicit zero liquidity", () => {
    const unknownLiquidity = { ...healthyMarket };
    delete unknownLiquidity.liquidityUsd;
    expect(decidePaperPosition(position, unknownLiquidity).action).toBe("hold");
    expect(decidePaperPosition(position, { ...healthyMarket, liquidityUsd: 0 })).toMatchObject({
      action: "rugged",
      reason: "pool_liquidity_zero"
    });
  });

  it("keeps the conservative v2 policy immutable and fail-closed at entry", () => {
    const config = rugAwarePaperConfigForVersion(QUALIFIED_POOL_PAPER_V2_STRATEGY_VERSION);
    expect(config).toBe(conservativeRugAwarePaperConfig);
    const v2Market = {
      ...healthyMarket,
      liquidityUsd: 40_000,
      volume5mUsd: 12_000,
      buys5m: 60,
      sells5m: 30
    };
    expect(
      validatePaperEntry({
        signalObservedAt: "2026-07-16T12:00:00.000Z",
        signalLiquidityUsd: 42_000,
        snapshot: v2Market,
        config
      })
    ).toBeUndefined();
    expect(
      validatePaperEntry({
        signalObservedAt: "2026-07-16T12:00:00.000Z",
        signalLiquidityUsd: 42_000,
        snapshot: { ...v2Market, volume5mUsd: 80_000 },
        config
      })
    ).toBe("entry_turnover_too_high");
    expect(
      validatePaperEntry({
        signalObservedAt: "2026-07-16T12:00:00.000Z",
        signalLiquidityUsd: 42_000,
        snapshot: { ...v2Market, buys5m: 35, sells5m: 35 },
        config
      })
    ).toBe("entry_sell_pressure");
    expect(() => rugAwarePaperConfigForVersion("unknown-paper-version")).toThrow(
      "Unsupported paper strategy version"
    );
  });

  it("sizes v2 conservatively and recovers modeled capital after a 30 percent move", () => {
    const config = conservativeRugAwarePaperConfig;
    expect(
      calculatePaperPositionSize({
        cashBalanceUsd: 100,
        committedExposureUsd: 0,
        liquidityUsd: 40_000,
        config
      })
    ).toBe(8);
    expect(
      decidePaperPosition(position, { ...healthyMarket, priceUsd: 0.0013 }, config)
    ).toMatchObject({
      action: "sell",
      fraction: 0.8,
      closeAfterFill: false,
      reason: "capital_recovery"
    });
  });

  it("keeps strict-flow v3 isolated and rejects one-sided or overheated confirmation", () => {
    const config = rugAwarePaperConfigForVersion(QUALIFIED_POOL_PAPER_V3_STRATEGY_VERSION);
    expect(config).toBe(strictFlowRugAwarePaperConfig);
    expect(paperQualificationVersionForStrategy(QUALIFIED_POOL_PAPER_V3_STRATEGY_VERSION)).toBe(
      "strict-flow-v2-20260817"
    );
    const strictMarket = {
      ...healthyMarket,
      liquidityUsd: 20_000,
      volume5mUsd: 8_000,
      buys5m: 11,
      sells5m: 9
    };
    expect(
      validatePaperEntry({
        signalObservedAt: "2026-07-16T12:00:00.000Z",
        signalLiquidityUsd: 20_000,
        snapshot: strictMarket,
        config
      })
    ).toBeUndefined();
    expect(
      validatePaperEntry({
        signalObservedAt: "2026-07-16T12:00:00.000Z",
        signalLiquidityUsd: 20_000,
        snapshot: { ...strictMarket, buys5m: 18, sells5m: 2 },
        config
      })
    ).toBe("entry_buy_share_too_high");
    expect(
      validatePaperEntry({
        signalObservedAt: "2026-07-16T12:00:00.000Z",
        signalLiquidityUsd: 20_000,
        snapshot: { ...strictMarket, volume5mUsd: 12_000 },
        config
      })
    ).toBe("entry_turnover_too_high");
  });
});
