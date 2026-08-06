import { describe, expect, it } from "vitest";
import { scoreToken } from "./token-scoring";
import { buildTokenFeatures } from "./feature-builder";
import type { RuntimeThresholds, TokenFeatures } from "@memecoin-alpha/shared";

const thresholds: RuntimeThresholds = {
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

const healthyFeatures: TokenFeatures = {
  tokenAgeMinutes: 8,
  liquidityUsd: 50000,
  volume5mUsd: 15000,
  volume1hUsd: 90000,
  uniqueBuyers5m: 80,
  buys5m: 90,
  sells5m: 28,
  topHolderPercent: 18,
  top10HolderPercent: 42,
  smartWalletCount: 3,
  averageSmartWalletScore: 72,
  creatorReputationScore: 65,
  mintAuthorityRevoked: true,
  freezeAuthorityRevoked: true,
  metadataComplete: true,
  duplicateBrandingSuspected: false,
  liquidityRemovedRecently: false,
  insiderClusterPercent: 8,
  washTradingSuspicion: 12,
  botActivityPercent: 35
};

describe("scoreToken", () => {
  it("scores healthy early traction higher than risky supply", () => {
    const healthy = scoreToken(healthyFeatures, thresholds);
    const risky = scoreToken(
      {
        ...healthyFeatures,
        liquidityUsd: 1200,
        topHolderPercent: 62,
        mintAuthorityRevoked: false,
        freezeAuthorityRevoked: false,
        liquidityRemovedRecently: true,
        washTradingSuspicion: 82
      },
      thresholds
    );

    expect(healthy.score).toBeGreaterThan(risky.score);
    expect(risky.warnings.length).toBeGreaterThan(healthy.warnings.length);
  });

  it("uses buyer diversity and top-10 concentration only as observed risk evidence", () => {
    const estimated = scoreToken(
      {
        ...healthyFeatures,
        uniqueBuyers5m: 2,
        top10HolderPercent: 90,
        featureEvidence: {
          uniqueBuyers5m: "estimated",
          top10HolderPercent: "estimated"
        }
      },
      thresholds
    );
    const observed = scoreToken(
      {
        ...healthyFeatures,
        uniqueBuyers5m: 2,
        top10HolderPercent: 90,
        featureEvidence: {
          uniqueBuyers5m: "observed",
          top10HolderPercent: "observed"
        }
      },
      thresholds
    );

    expect(observed.riskScore).toBeGreaterThan(estimated.riskScore);
    expect(observed.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("top-10 holder"),
        expect.stringContaining("buyer diversity")
      ])
    );
  });

  it("treats missing authority evidence as unsafe", () => {
    const built = buildTokenFeatures(
      {
        chain: "solana",
        address: "UnknownRiskMint",
        symbol: "UNK",
        name: "Unknown Risk",
        firstSeenAt: new Date().toISOString(),
        metadata: {}
      },
      undefined,
      {
        holderCount: 0,
        topHolderPercent: 0,
        top10HolderPercent: 0,
        capturedAt: new Date().toISOString()
      },
      [],
      thresholds
    );

    expect(built.mintAuthorityRevoked).toBe(false);
    expect(built.freezeAuthorityRevoked).toBe(false);
    const scored = scoreToken(built, thresholds);
    expect(scored.warnings).toContain("Mint authority appears retained.");
    expect(scored.warnings).toContain("Freeze authority appears retained.");
  });
});
