import { createHash } from "node:crypto";
import {
  SAMPLE_HOLDER_SNAPSHOT,
  SAMPLE_POOL,
  SAMPLE_TOKEN,
  SAMPLE_WALLET_FEATURES,
  type HolderSnapshot,
  type PoolSnapshot,
  type RuntimeThresholds,
  type ScoreBreakdown,
  type Signal,
  type SignalActionCategory,
  type TokenSnapshot,
  type WalletScore
} from "@memecoin-alpha/shared";
import { buildTokenFeatures, scoreToken, scoreWallet } from "@memecoin-alpha/scoring";

export interface SignalInput {
  token: TokenSnapshot;
  pool?: PoolSnapshot;
  holderSnapshot: HolderSnapshot;
  walletScores: WalletScore[];
  thresholds: RuntimeThresholds;
  detectedAt?: string;
  strategyVersion?: string;
}

export function generateSignal(input: SignalInput): Signal {
  const detectedAt = input.detectedAt ?? new Date().toISOString();
  const features = buildTokenFeatures(
    input.token,
    input.pool,
    input.holderSnapshot,
    input.walletScores,
    input.thresholds
  );
  const score = scoreToken(features, input.thresholds);
  const actionCategory = chooseAction(score, input.thresholds);
  const keyReasons = [
    ...score.reasons,
    ...score.warnings.map((warning) => `Risk: ${warning}`)
  ].slice(0, 8);

  return {
    id: signalId(input.token.chain, input.token.address, detectedAt),
    strategyVersion: input.strategyVersion ?? "evidence-v1",
    chain: input.token.chain,
    tokenAddress: input.token.address,
    tokenSymbol: input.token.symbol,
    ...(input.pool?.poolAddress ? { poolAddress: input.pool.poolAddress } : {}),
    signalType: "early_token_intelligence",
    confidence: score.confidence,
    riskScore: score.riskScore,
    tokenScore: score.score,
    detectedAt,
    keyReasons,
    wallets: input.walletScores,
    liquiditySnapshot: {
      liquidityUsd: input.pool?.liquidityUsd ?? 0,
      ...(input.pool?.marketCapUsd
        ? { marketCapUsd: input.pool.marketCapUsd }
        : input.pool?.raw?.marketCap
          ? { marketCapUsd: Number(input.pool.raw.marketCap) }
          : input.pool?.raw?.fdv
            ? { fdvUsd: Number(input.pool.raw.fdv) }
            : {}),
      ...(input.pool?.createdAt
        ? {
            poolAgeMinutes: Math.max(
              0,
              (Date.now() - new Date(input.pool.createdAt).getTime()) / 60_000
            )
          }
        : {})
    },
    volumeSnapshot: {
      volume5mUsd: input.pool?.volume5mUsd ?? 0,
      volume1hUsd: input.pool?.volume1hUsd ?? 0,
      buys5m: input.pool?.txns5m.buys ?? 0,
      sells5m: input.pool?.txns5m.sells ?? 0
    },
    holderSnapshot: input.holderSnapshot,
    actionCategory,
    noFinancialAdvice: true
  };
}

export function chooseAction(
  score: Pick<ScoreBreakdown, "score" | "riskScore" | "confidence">,
  thresholds: RuntimeThresholds
): SignalActionCategory {
  if (score.riskScore > thresholds.maximumRugRisk) return "high-risk warning";
  if (score.score < 42 || score.confidence < 35) return "ignore";
  if (
    score.confidence >= thresholds.alertMinimumConfidence &&
    score.score >= 76 &&
    score.riskScore <= 45
  ) {
    return "paper-trade candidate";
  }
  if (score.score >= 64 && score.confidence >= 55) return "research candidate";
  return "watchlist";
}

export function buildSampleSignal(thresholds: RuntimeThresholds): Signal {
  const walletScores = SAMPLE_WALLET_FEATURES.map((wallet) => scoreWallet(wallet));
  return generateSignal({
    token: SAMPLE_TOKEN,
    pool: SAMPLE_POOL,
    holderSnapshot: SAMPLE_HOLDER_SNAPSHOT,
    walletScores,
    thresholds,
    detectedAt: new Date(Date.now() - 3 * 60 * 1000).toISOString()
  });
}

function signalId(chain: string, tokenAddress: string, detectedAt: string): string {
  return createHash("sha256")
    .update(`${chain}:${tokenAddress}:${detectedAt}`)
    .digest("hex")
    .slice(0, 24);
}
