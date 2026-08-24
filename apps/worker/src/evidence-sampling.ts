import type { DexScreenerPair } from "@memecoin-alpha/providers";
import type {
  PriceObservationEvidence,
  WalletSignalOutcomeEvidence
} from "@memecoin-alpha/shared";

export interface EvidenceMarketGroup<T> {
  tokenAddress: string;
  poolAddress?: string;
  entries: T[];
}

export interface MissingExactPairState {
  missingStreak: number;
  rugged: boolean;
  lastSellableObservedAt?: string;
  lastSellablePriceUsd?: number;
  lastSellableLiquidityUsd?: number;
}

export function classifyMissingExactPair(
  history: PriceObservationEvidence[],
  poolAddress: string,
  terminalMissingSamples = 3
): MissingExactPairState {
  const exact = history
    .filter((observation) => observation.poolAddress === poolAddress)
    .sort((a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime());
  let priorMissingStreak = 0;
  for (let index = exact.length - 1; index >= 0; index -= 1) {
    if (exact[index]?.raw.marketState !== "pair-missing-confirmed") break;
    priorMissingStreak += 1;
  }
  const lastSellable = [...exact]
    .reverse()
    .find(
      (observation) =>
        observation.priceUsd > 0 &&
        observation.liquidityUsd > 0 &&
        observation.raw.marketExecutable !== false &&
        !observation.rugged
    );
  const missingStreak = priorMissingStreak + 1;
  return {
    missingStreak,
    rugged: Boolean(lastSellable && missingStreak >= Math.max(2, terminalMissingSamples)),
    ...(lastSellable
      ? {
          lastSellableObservedAt: lastSellable.observedAt,
          lastSellablePriceUsd: lastSellable.priceUsd,
          lastSellableLiquidityUsd: lastSellable.liquidityUsd
        }
      : {})
  };
}

export function sampleBucketStart(observedAt: Date, bucketSeconds: number): string {
  const safeSeconds = Math.max(1, Math.trunc(bucketSeconds));
  const bucketMs = safeSeconds * 1_000;
  return new Date(Math.floor(observedAt.getTime() / bucketMs) * bucketMs).toISOString();
}

export function dexScreenerObservationSignature(
  poolAddress: string | undefined,
  tokenAddress: string,
  bucketStart: string
): string {
  const marketIdentity = poolAddress?.trim() || tokenAddress.trim();
  return `dexscreener-observation:${marketIdentity}:${bucketStart}`;
}

/** Keep only fields used for audit/debugging; the normalized columns remain canonical. */
export function compactDexScreenerPair(pair: DexScreenerPair): Record<string, unknown> {
  return {
    source: "dexscreener-compact-v2",
    chainId: pair.chainId ?? "solana",
    dexId: pair.dexId ?? null,
    pairAddress: pair.pairAddress ?? null,
    baseTokenAddress: pair.baseToken?.address ?? null,
    quoteTokenAddress: pair.quoteToken?.address ?? null,
    priceUsd: pair.priceUsd ?? null,
    liquidityUsd: pair.liquidity?.usd ?? 0,
    volume5mUsd: pair.volume?.m5 ?? 0,
    volume1hUsd: pair.volume?.h1 ?? 0,
    buys5m: pair.txns?.m5?.buys ?? 0,
    sells5m: pair.txns?.m5?.sells ?? 0,
    fdv: pair.fdv ?? null,
    marketCap: pair.marketCap ?? null,
    pairCreatedAt: pair.pairCreatedAt ?? null
  };
}

/**
 * Select market evidence without crossing pool boundaries. When an entry has
 * an exact pool, absence of that pair is missing evidence rather than
 * permission to use the token's highest-liquidity alternative.
 */
export function selectEvidencePair(
  pairs: DexScreenerPair[],
  preferredPoolAddress?: string
): DexScreenerPair | undefined {
  if (preferredPoolAddress) {
    return pairs.find((pair) => pair.pairAddress === preferredPoolAddress);
  }
  return [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
}

/**
 * Group entries by the actual execution market. Provider requests can still
 * be batched by token, but every distinct exact pool needs its own durable
 * observation and cannot inherit the first pool seen for the mint.
 */
export function groupEvidenceMarkets<T extends { tokenAddress: string; poolAddress?: string }>(
  entries: T[]
): EvidenceMarketGroup<T>[] {
  const groups = new Map<string, EvidenceMarketGroup<T>>();
  for (const entry of entries) {
    const poolAddress = entry.poolAddress?.trim() || undefined;
    const key = `${entry.tokenAddress}:${poolAddress ?? "<unknown-pool>"}`;
    const group = groups.get(key) ?? {
      tokenAddress: entry.tokenAddress,
      ...(poolAddress ? { poolAddress } : {}),
      entries: []
    };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function walletOutcomeLifecycleKey(
  outcome: Pick<
    WalletSignalOutcomeEvidence,
    "entryIdempotencyKey" | "horizonMinutes" | "exitStrategy" | "strategyVersion"
  >
): string {
  return [
    outcome.entryIdempotencyKey,
    outcome.horizonMinutes,
    outcome.exitStrategy,
    outcome.strategyVersion
  ].join(":");
}

export function shouldPersistOutcomeTransition(
  currentStatus: WalletSignalOutcomeEvidence["status"] | undefined,
  nextStatus: WalletSignalOutcomeEvidence["status"]
): boolean {
  if (!currentStatus) return true;
  const statusOrder = { provisional: 0, unresolved: 1, mature: 2 } as const;
  return statusOrder[nextStatus] > statusOrder[currentStatus];
}

export function chunksOf<T>(items: T[], size: number): T[][] {
  const chunkSize = Math.max(1, Math.trunc(size));
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}
