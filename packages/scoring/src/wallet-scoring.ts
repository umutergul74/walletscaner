import {
  clamp,
  round,
  type WalletCategory,
  type WalletFeatures,
  type WalletScore
} from "@memecoin-alpha/shared";

export function scoreWallet(features: WalletFeatures, calculatedAt = new Date().toISOString()): WalletScore {
  const repeatability = clamp((features.winnersEnteredEarly / Math.max(features.earlyEntries, 1)) * 100);
  const roiQuality = clamp(features.medianRoiPercent * 0.55 + features.meanRoiPercent * 0.12);
  const winQuality = clamp(features.winRate * 100);
  const profitQuality = clamp(features.profitFactor * 24);
  const behaviorQuality = clamp(
    features.exitDisciplineScore * 0.35 +
      features.rugAvoidanceRate * 100 * 0.25 +
      features.copyabilityScore * 0.4
  );
  const suspicionPenalty = clamp(
    features.clusterCorrelation * 32 +
      features.deployerOverlap * 45 +
      features.sniperTimingScore * 0.32 +
      features.ruggedTokenCount * 1.7
  );

  const rawScore =
    repeatability * 0.2 +
    roiQuality * 0.2 +
    winQuality * 0.14 +
    profitQuality * 0.16 +
    behaviorQuality * 0.24 -
    suspicionPenalty * 0.3;

  const score = round(clamp(rawScore * features.recentDecayFactor));
  const category = classifyWallet(score, features, suspicionPenalty);
  const reasons = buildWalletReasons(features, score, category, suspicionPenalty);

  return {
    chain: features.chain,
    walletAddress: features.walletAddress,
    score,
    category,
    calculatedAt,
    reasons,
    features
  };
}

function classifyWallet(
  score: number,
  features: WalletFeatures,
  suspicionPenalty: number
): WalletCategory {
  if (features.clusterCorrelation > 0.82) return "bundler_cluster";
  if (features.deployerOverlap > 0.25) return "insider_dev_linked";
  if (features.sniperTimingScore > 82 && features.copyabilityScore < 35) return "sniper_bot";
  if (features.rugAvoidanceRate < 0.45 || features.ruggedTokenCount > 20) return "high_risk_wallet";
  if (score >= 78 && suspicionPenalty < 32) return "alpha_wallet";
  if (score >= 64 && features.copyabilityScore >= 55) return "copyable_smart_wallet";
  if (score >= 50 && features.averageHoldMinutes < 25) return "market_maker";
  return "noise_wallet";
}

function buildWalletReasons(
  features: WalletFeatures,
  score: number,
  category: WalletCategory,
  suspicionPenalty: number
): string[] {
  const reasons = [
    `Wallet score is ${score} and category is ${category}.`,
    `${features.winnersEnteredEarly} of ${features.earlyEntries} early entries became winners.`,
    `Median ROI is ${round(features.medianRoiPercent)}% with profit factor ${round(features.profitFactor)}.`
  ];

  if (features.copyabilityScore >= 60) reasons.push("Behavior appears copyable after latency.");
  if (features.exitDisciplineScore >= 70) reasons.push("Wallet often exits into strength.");
  if (suspicionPenalty > 45) reasons.push("Suspicion penalty is high due to cluster, deployer, or sniper traits.");
  if (features.rugAvoidanceRate < 0.65) reasons.push("Rug avoidance history is weak.");

  return reasons;
}
