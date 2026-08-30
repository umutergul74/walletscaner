import {
  type ChainId,
  type NormalizedEvent,
  type PoolSnapshot,
  type TokenSnapshot,
  nowIso
} from "@memecoin-alpha/shared";
import { fetchJson } from "./http";

export interface DexScreenerProfile {
  url?: string;
  chainId?: string;
  tokenAddress?: string;
  icon?: string;
  header?: string;
  description?: string;
  links?: Array<{ type?: string; label?: string; url?: string }>;
}

export interface DexScreenerPair {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; name?: string; symbol?: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: {
    m5?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
  };
  volume?: {
    m5?: number;
    h1?: number;
    h6?: number;
    h24?: number;
  };
  liquidity?: {
    usd?: number;
    base?: number;
    quote?: number;
  };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: Record<string, unknown>;
}

export class DexScreenerClient {
  constructor(
    private readonly baseUrl = "https://api.dexscreener.com",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly requestBudget: { timeoutMs?: number; retries?: number } = {}
  ) {}

  async fetchLatestTokenProfiles(): Promise<DexScreenerProfile[]> {
    const response = await fetchJson<DexScreenerProfile[] | DexScreenerProfile>(
      "dexscreener",
      `${this.baseUrl}/token-profiles/latest/v1`,
      { fetchImpl: this.fetchImpl, retries: 2 }
    );

    return Array.isArray(response) ? response : [response];
  }

  async fetchTokenPairs(chain: ChainId, tokenAddress: string): Promise<DexScreenerPair[]> {
    return fetchJson<DexScreenerPair[]>(
      "dexscreener",
      `${this.baseUrl}/token-pairs/v1/${chain}/${tokenAddress}`,
      { fetchImpl: this.fetchImpl, retries: 2 }
    );
  }

  async fetchPair(chain: ChainId, pairAddress: string): Promise<DexScreenerPair[]> {
    const response = await fetchJson<{ pairs?: DexScreenerPair[] | null }>(
      "dexscreener",
      `${this.baseUrl}/latest/dex/pairs/${chain}/${pairAddress}`,
      { fetchImpl: this.fetchImpl, retries: 2, ...this.requestBudget }
    );
    return response.pairs ?? [];
  }

  async fetchTokenPairsBatch(chain: ChainId, tokenAddresses: string[]): Promise<DexScreenerPair[]> {
    if (tokenAddresses.length === 0) return [];
    if (tokenAddresses.length > 30) {
      throw new Error("DexScreener token batch accepts at most 30 token addresses.");
    }
    return fetchJson<DexScreenerPair[]>(
      "dexscreener",
      `${this.baseUrl}/tokens/v1/${chain}/${tokenAddresses.join(",")}`,
      { fetchImpl: this.fetchImpl, retries: 2 }
    );
  }

  async discoverSolanaProfiles(limit = 12): Promise<NormalizedEvent[]> {
    const profiles = (await this.fetchLatestTokenProfiles())
      .filter((profile) => profile.chainId === "solana" && profile.tokenAddress)
      .slice(0, limit);

    const events: NormalizedEvent[] = [];
    for (const profile of profiles) {
      const tokenAddress = profile.tokenAddress;
      if (!tokenAddress) continue;

      const pairs = await this.fetchTokenPairs("solana", tokenAddress);
      const token = tokenFromProfile(profile, pairs);
      const pools = pairs
        .filter((pair) => pair.pairAddress)
        .map((pair) => poolFromPair(pair, token.address));

      events.push({
        idempotencyKey: `dexscreener:profile:${token.chain}:${token.address}`,
        chain: "solana",
        provider: "dexscreener",
        type: "token_profile",
        tokenAddress: token.address,
        observedAt: nowIso(),
        payload: {
          token,
          pools,
          profile
        }
      });
    }

    return events;
  }
}

function tokenFromProfile(profile: DexScreenerProfile, pairs: DexScreenerPair[]): TokenSnapshot {
  const primary = pairs[0];
  const symbol = primary?.baseToken?.symbol ?? shortAddress(profile.tokenAddress ?? "unknown");
  const name = primary?.baseToken?.name ?? symbol;

  return {
    chain: "solana",
    address: profile.tokenAddress ?? "unknown",
    symbol,
    name,
    firstSeenAt: nowIso(),
    metadata: {
      url: profile.url,
      icon: profile.icon,
      header: profile.header,
      description: profile.description,
      links: profile.links ?? []
    }
  };
}

function poolFromPair(pair: DexScreenerPair, fallbackBaseToken: string): PoolSnapshot {
  const createdAt = pair.pairCreatedAt ? new Date(pair.pairCreatedAt).toISOString() : undefined;
  const priceUsd = pair.priceUsd ? Number(pair.priceUsd) : undefined;
  const marketCapUsd = pair.marketCap ?? pair.fdv;
  const base: PoolSnapshot = {
    chain: "solana",
    poolAddress: pair.pairAddress ?? `${fallbackBaseToken}:unknown-pool`,
    dex: pair.dexId ?? "unknown",
    baseTokenAddress: pair.baseToken?.address ?? fallbackBaseToken,
    liquidityUsd: pair.liquidity?.usd ?? 0,
    volume5mUsd: pair.volume?.m5 ?? 0,
    volume1hUsd: pair.volume?.h1 ?? 0,
    txns5m: {
      buys: pair.txns?.m5?.buys ?? 0,
      sells: pair.txns?.m5?.sells ?? 0
    },
    raw: pair as Record<string, unknown>
  };

  return {
    ...base,
    ...(pair.quoteToken?.address ? { quoteTokenAddress: pair.quoteToken.address } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(pair.baseToken?.symbol ? { tokenSymbol: pair.baseToken.symbol } : {}),
    ...(pair.baseToken?.name ? { tokenName: pair.baseToken.name } : {}),
    ...(priceUsd !== undefined ? { priceUsd } : {}),
    ...(marketCapUsd !== undefined ? { marketCapUsd } : {})
  };
}

const shortAddress = (address: string): string =>
  address.length > 8 ? `${address.slice(0, 4)}...${address.slice(-4)}` : address;
