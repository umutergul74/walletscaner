import type { DexScreenerPair } from "@memecoin-alpha/providers";

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

export function chunksOf<T>(items: T[], size: number): T[][] {
  const chunkSize = Math.max(1, Math.trunc(size));
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}
