import {
  type HolderSnapshot,
  type PoolSnapshot,
  type RuntimeThresholds,
  type TokenFeatures,
  type TokenSnapshot,
  type WalletScore
} from "@memecoin-alpha/shared";

export function buildTokenFeatures(
  token: TokenSnapshot,
  pool: PoolSnapshot | undefined,
  holderSnapshot: HolderSnapshot,
  walletScores: WalletScore[],
  thresholds: RuntimeThresholds,
  featureEvidence: TokenFeatures["featureEvidence"] = {}
): TokenFeatures {
  const firstSeen = new Date(token.firstSeenAt).getTime();
  const tokenAgeMinutes = Math.max(0, (Date.now() - firstSeen) / 60_000);
  const eligibleWallets = walletScores.filter((wallet) => wallet.score >= thresholds.minimumSmartWalletScore);

  return {
    tokenAgeMinutes,
    liquidityUsd: pool?.liquidityUsd ?? 0,
    volume5mUsd: pool?.volume5mUsd ?? 0,
    volume1hUsd: pool?.volume1hUsd ?? 0,
    uniqueBuyers5m:
      featureEvidence.uniqueBuyers5m === "observed"
        ? Number(pool?.raw?.uniqueBuyers5m ?? 0)
        : 0,
    buys5m: pool?.txns5m.buys ?? 0,
    sells5m: pool?.txns5m.sells ?? 0,
    topHolderPercent: holderSnapshot.topHolderPercent,
    top10HolderPercent: holderSnapshot.top10HolderPercent,
    smartWalletCount: eligibleWallets.length,
    averageSmartWalletScore:
      eligibleWallets.reduce((sum, wallet) => sum + wallet.score, 0) / Math.max(eligibleWallets.length, 1),
    creatorReputationScore: Number(token.metadata.creatorReputationScore ?? 50),
    // Missing authority evidence is deliberately fail-closed. A new token must
    // be positively verified before it can receive the safety contribution.
    mintAuthorityRevoked: token.metadata.mintAuthorityRevoked === true,
    freezeAuthorityRevoked: token.metadata.freezeAuthorityRevoked === true,
    metadataComplete: Boolean(token.name && token.symbol && token.metadata.description),
    duplicateBrandingSuspected: Boolean(token.metadata.duplicateBrandingSuspected ?? false),
    liquidityRemovedRecently: Boolean(token.metadata.liquidityRemovedRecently ?? false),
    insiderClusterPercent: Number(token.metadata.insiderClusterPercent ?? 0),
    washTradingSuspicion: Number(token.metadata.washTradingSuspicion ?? 0),
    botActivityPercent: Number(token.metadata.botActivityPercent ?? 0),
    featureEvidence
  };
}
