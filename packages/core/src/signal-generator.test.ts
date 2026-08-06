import { describe, expect, it } from "vitest";
import { buildSampleSignal, chooseAction } from "./signal-generator";
import type { RuntimeThresholds } from "@memecoin-alpha/shared";

const thresholds: RuntimeThresholds = {
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

describe("signal generator", () => {
  it("builds explainable non-financial-advice signals", () => {
    const signal = buildSampleSignal(thresholds);

    expect(signal.noFinancialAdvice).toBe(true);
    expect(signal.keyReasons.length).toBeGreaterThan(0);
    expect(signal.actionCategory).not.toBe("ignore");
  });

  it("downgrades high-risk signals", () => {
    expect(chooseAction({ score: 90, riskScore: 91, confidence: 90 }, thresholds)).toBe(
      "high-risk warning"
    );
  });
});

