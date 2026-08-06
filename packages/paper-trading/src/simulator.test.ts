import { describe, expect, it } from "vitest";
import { buildSampleSignal } from "@memecoin-alpha/core";
import { createPaperPortfolio, markToMarketAndClose, tryOpenPaperTrade } from "./simulator";

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

describe("paper trading simulator", () => {
  it("opens and closes simulated positions only for paper-trade candidates", () => {
    const portfolio = createPaperPortfolio(1000);
    const signal = { ...buildSampleSignal(thresholds), actionCategory: "paper-trade candidate" as const };
    const trade = tryOpenPaperTrade(portfolio, { signal, priceUsd: 0.01 }, thresholds);

    expect(trade.status).toBe("open");
    expect(portfolio.balanceUsd).toBe(900);

    const closed = markToMarketAndClose(portfolio, trade.id, 0.03, thresholds);
    expect(closed?.status).toBe("closed");
    expect(closed?.pnlUsd).toBeGreaterThan(0);
  });
});

