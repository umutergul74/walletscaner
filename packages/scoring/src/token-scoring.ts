import { clamp, round, type RuntimeThresholds, type ScoreBreakdown, type TokenFeatures } from "@memecoin-alpha/shared";

const weightedAverage = (parts: Array<[number, number]>): number => {
  const totalWeight = parts.reduce((sum, [, weight]) => sum + weight, 0);
  return parts.reduce((sum, [value, weight]) => sum + value * weight, 0) / totalWeight;
};

export function scoreToken(features: TokenFeatures, thresholds: RuntimeThresholds): ScoreBreakdown {
  const hasObservedUniqueBuyers =
    features.featureEvidence?.uniqueBuyers5m === "observed";
  const hasObservedTop10 =
    features.featureEvidence?.top10HolderPercent === "observed";
  const subScores = {
    freshness: clamp(100 - features.tokenAgeMinutes * 1.7),
    liquidityQuality: clamp((features.liquidityUsd / thresholds.minimumLiquidityUsd) * 70),
    volumeQuality: clamp((features.volume5mUsd / thresholds.minimumVolume5mUsd) * 75),
    holderDistribution: clamp(100 - features.topHolderPercent * 2.1),
    smartWalletParticipation: clamp(
      features.smartWalletCount * 18 + features.averageSmartWalletScore * 0.55
    ),
    creatorReputation: clamp(features.creatorReputationScore),
    tokenSafety: clamp(
      (features.mintAuthorityRevoked ? 45 : 0) + (features.freezeAuthorityRevoked ? 45 : 0) + 10
    ),
    marketStructure: clamp(
      features.buys5m + features.sells5m > 0
        ? 55 + ((features.buys5m - features.sells5m) / (features.buys5m + features.sells5m)) * 35
        : 25
    ),
    metadataCredibility: clamp(
      (features.metadataComplete ? 78 : 38) - (features.duplicateBrandingSuspected ? 38 : 0)
    )
  };

  const warnings: string[] = [];
  const reasons: string[] = [];

  if (features.liquidityUsd >= thresholds.minimumLiquidityUsd) {
    reasons.push(`Liquidity is above the configured minimum at $${round(features.liquidityUsd, 0)}.`);
  } else {
    warnings.push(`Liquidity is below the configured minimum at $${round(features.liquidityUsd, 0)}.`);
  }

  if (features.volume5mUsd >= thresholds.minimumVolume5mUsd) {
    reasons.push(`Five-minute volume is active at $${round(features.volume5mUsd, 0)}.`);
  } else {
    warnings.push(`Five-minute volume is thin at $${round(features.volume5mUsd, 0)}.`);
  }

  if (features.smartWalletCount > 0) {
    reasons.push(`${features.smartWalletCount} scored wallet(s) participated early.`);
  }

  if (!features.mintAuthorityRevoked) warnings.push("Mint authority appears retained.");
  if (!features.freezeAuthorityRevoked) warnings.push("Freeze authority appears retained.");
  if (features.topHolderPercent > thresholds.maximumTopHolderPercent) {
    warnings.push(`Top holder concentration is high at ${round(features.topHolderPercent)}%.`);
  }
  if (hasObservedTop10 && features.top10HolderPercent > 70) {
    warnings.push(
      `Observed top-10 holder concentration is high at ${round(features.top10HolderPercent)}%.`
    );
  }
  if (hasObservedUniqueBuyers && features.uniqueBuyers5m < 10) {
    warnings.push(
      `Observed five-minute buyer diversity is low at ${features.uniqueBuyers5m} unique wallets.`
    );
  }
  if (features.liquidityRemovedRecently) warnings.push("Recent liquidity removal detected.");
  if (features.insiderClusterPercent > 35) warnings.push("Potential insider cluster concentration is high.");
  if (features.washTradingSuspicion > 60) warnings.push("Wash-trading suspicion is elevated.");
  if (features.botActivityPercent > 75) warnings.push("Activity appears dominated by bots.");
  if (features.duplicateBrandingSuspected) warnings.push("Metadata resembles duplicate or impersonated branding.");

  const baseScore = weightedAverage([
    [subScores.freshness, 0.1],
    [subScores.liquidityQuality, 0.14],
    [subScores.volumeQuality, 0.12],
    [subScores.holderDistribution, 0.13],
    [subScores.smartWalletParticipation, 0.16],
    [subScores.creatorReputation, 0.1],
    [subScores.tokenSafety, 0.14],
    [subScores.marketStructure, 0.07],
    [subScores.metadataCredibility, 0.04]
  ]);

  const riskScore = clamp(
    (!features.mintAuthorityRevoked ? 18 : 0) +
      (!features.freezeAuthorityRevoked ? 16 : 0) +
      Math.max(0, features.topHolderPercent - thresholds.maximumTopHolderPercent) * 1.4 +
      (features.liquidityRemovedRecently ? 28 : 0) +
      features.insiderClusterPercent * 0.32 +
      features.washTradingSuspicion * 0.24 +
      features.botActivityPercent * 0.18 +
      (hasObservedTop10 ? Math.max(0, features.top10HolderPercent - 70) * 0.8 : 0) +
      (hasObservedUniqueBuyers ? Math.max(0, 10 - features.uniqueBuyers5m) * 1.2 : 0) +
      (features.duplicateBrandingSuspected ? 14 : 0)
  );

  const score = clamp(baseScore - riskScore * 0.35);
  const confidence = clamp(
    35 +
      Math.min(features.volume1hUsd / Math.max(thresholds.minimumVolume5mUsd, 1), 8) * 5 +
      Math.min(features.liquidityUsd / Math.max(thresholds.minimumLiquidityUsd, 1), 5) * 4 +
      (features.smartWalletCount > 0 ? 12 : 0) -
      (warnings.length > 4 ? 8 : 0)
  );

  return {
    score: round(score),
    riskScore: round(riskScore),
    confidence: round(confidence),
    subScores: Object.fromEntries(
      Object.entries(subScores).map(([key, value]) => [key, round(value)])
    ),
    reasons,
    warnings
  };
}
