import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { clamp, round } from "@memecoin-alpha/shared";

type Json = Record<string, unknown>;

interface DexPair {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string | null;
  txns?: Record<string, { buys?: number; sells?: number } | undefined>;
  volume?: Record<string, number | undefined>;
  priceChange?: Record<string, number | undefined> | null;
  liquidity?: { usd?: number; base?: number; quote?: number } | null;
  fdv?: number | null;
  marketCap?: number | null;
  pairCreatedAt?: number | null;
  boosts?: { active?: number } | null;
  info?: Json;
}

interface TokenSource {
  tokenAddress: string;
  source: string;
}

interface Candidate {
  tokenAddress: string;
  symbol: string;
  name: string;
  pairAddress: string;
  dexId: string;
  url?: string;
  liquidityUsd: number;
  volume5mUsd: number;
  volume1hUsd: number;
  buys5m: number;
  sells5m: number;
  buys1h: number;
  sells1h: number;
  priceChange5m: number;
  priceChange1h: number;
  ageMinutes: number | null;
  priceUsd: number;
  sources: string[];
  tractionScore: number;
}

interface WalletTokenEvent {
  wallet: string;
  tokenAddress: string;
  tokenSymbol: string;
  pairAddress: string;
  signature: string;
  slot: number;
  blockTime: number;
  side: "buy" | "sell";
  baseDelta: number;
  quoteDelta: number;
  rank: number;
}

interface WalletAggregate {
  wallet: string;
  tokensTouched: number;
  earlyBuys: number;
  sells: number;
  averageRank: number;
  averageCandidateScore: number;
  buyPressureScore: number;
  labels: string[];
  events: WalletTokenEvent[];
}

interface WalletState extends WalletAggregate {
  lastSeenAt: string;
}

interface WalletHistorySummary {
  wallet: string;
  signaturesSeen: number;
  transactionsAttempted: number;
  transactionsParsed: number;
  uniqueMintsBought: number;
  pumpMintsBought: number;
  buyEvents: Array<{
    mint: string;
    symbol?: string;
    delta: number;
    signature: string;
    blockTime: number;
  }>;
  sellEvents: Array<{ mint: string; delta: number; signature: string; blockTime: number }>;
  labels: string[];
  historyScore: number;
  errors: string[];
}

interface PairScanStats {
  tokenSymbol: string;
  pairAddress: string;
  signaturesSeen: number;
  transactionsAttempted: number;
  transactionsParsed: number;
  eventsExtracted: number;
  errors: string[];
}

interface ResearchState {
  updatedAt: string;
  runs: Array<{
    runAt: string;
    candidateCount: number;
    walletEventCount: number;
    topCandidate?: Candidate;
    topWallet?: WalletAggregate;
  }>;
  wallets: Record<string, WalletState>;
}

const DEX_BASE = process.env.DEXSCREENER_BASE_URL ?? "https://api.dexscreener.com";
const RPC_ENDPOINTS = (
  process.env.SOLANA_RPC_URLS ??
  process.env.SOLANA_RPC_URL ??
  "https://api.mainnet-beta.solana.com,https://solana-rpc.publicnode.com"
)
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
const REPORT_DIR = "reports";
const STATE_PATH = `${REPORT_DIR}/live-alpha-state.json`;
const JSON_REPORT_PATH = `${REPORT_DIR}/live-alpha-latest.json`;
const MD_REPORT_PATH = `${REPORT_DIR}/live-alpha-latest.md`;
const MAX_TOKENS = Number(process.env.LIVE_ALPHA_MAX_TOKENS ?? 35);
const MAX_CANDIDATES = Number(process.env.LIVE_ALPHA_MAX_CANDIDATES ?? 8);
const SIGNATURE_LIMIT = Number(process.env.LIVE_ALPHA_SIGNATURE_LIMIT ?? 20);
const TX_LIMIT_PER_PAIR = Number(process.env.LIVE_ALPHA_TX_LIMIT_PER_PAIR ?? 8);
const ENRICH_WALLET_COUNT = Number(process.env.LIVE_ALPHA_ENRICH_WALLETS ?? 8);
const WALLET_SIGNATURE_LIMIT = Number(process.env.LIVE_ALPHA_WALLET_SIGNATURE_LIMIT ?? 28);
const WALLET_TX_LIMIT = Number(process.env.LIVE_ALPHA_WALLET_TX_LIMIT ?? 12);
const DEX_TIMEOUT_MS = Number(process.env.LIVE_ALPHA_DEX_TIMEOUT_MS ?? 12_000);
const RPC_TIMEOUT_MS = Number(process.env.LIVE_ALPHA_RPC_TIMEOUT_MS ?? 12_000);
let rpcCursor = 0;

async function main() {
  await mkdir(REPORT_DIR, { recursive: true });
  const runAt = new Date().toISOString();
  const candidates = await discoverCandidates();
  const selected = candidates.slice(0, MAX_CANDIDATES);
  const allEvents: WalletTokenEvent[] = [];
  const scanStats: PairScanStats[] = [];

  for (const candidate of selected) {
    const { events, stats } = await collectWalletEvents(candidate);
    allEvents.push(...events);
    scanStats.push(stats);
    await sleep(500);
  }

  const walletAggregates = aggregateWallets(allEvents, selected);
  const walletHistory = await enrichWalletHistories(walletAggregates.slice(0, ENRICH_WALLET_COUNT));
  const state = await mergeState(runAt, selected, allEvents, walletAggregates);
  const report = {
    runAt,
    rpcUrl: RPC_ENDPOINTS.map(redactUrl).join(", "),
    candidates: selected,
    scanStats,
    walletEvents: allEvents,
    walletAggregates,
    walletHistory,
    rawLead: describeRawLead(selected, walletAggregates, walletHistory)
  };

  await writeFile(JSON_REPORT_PATH, JSON.stringify(report, null, 2));
  await writeFile(MD_REPORT_PATH, renderMarkdown(report, state));

  console.log(
    JSON.stringify(
      {
        runAt,
        candidates: selected.length,
        walletEvents: allEvents.length,
        topCandidate: selected[0]
          ? `${selected[0].symbol} ${selected[0].tokenAddress} score=${selected[0].tractionScore}`
          : null,
        topWallet: walletAggregates[0]
          ? `${walletAggregates[0].wallet} earlyBuys=${walletAggregates[0].earlyBuys} tokens=${walletAggregates[0].tokensTouched}`
          : null,
        reports: [JSON_REPORT_PATH, MD_REPORT_PATH, STATE_PATH]
      },
      null,
      2
    )
  );
}

async function discoverCandidates(): Promise<Candidate[]> {
  const sources = await fetchTokenSources();
  const unique = dedupeSources(sources).slice(0, MAX_TOKENS);
  const pairsByToken = await mapLimit(unique, 5, async (source) => {
    try {
      const pairs = await fetchDex<DexPair[]>(`/token-pairs/v1/solana/${source.tokenAddress}`);
      return pairs
        .filter((pair) => pair.chainId === "solana" && pair.pairAddress && pair.baseToken?.address)
        .map((pair) => ({ pair, source }));
    } catch (error: unknown) {
      console.warn(
        `WARN: Failed to fetch pairs for token ${source.tokenAddress}:`,
        errorMessage(error)
      );
      return [];
    }
  });

  const grouped = new Map<string, Candidate>();
  for (const item of pairsByToken.flat()) {
    const candidate = candidateFromPair(item.pair, item.source);
    if (!candidate) continue;
    const existing = grouped.get(candidate.pairAddress);
    if (!existing || candidate.tractionScore > existing.tractionScore) {
      grouped.set(candidate.pairAddress, {
        ...candidate,
        sources: [...new Set([...(existing?.sources ?? []), ...candidate.sources])]
      });
    }
  }

  return [...grouped.values()]
    .filter((candidate) => candidate.liquidityUsd >= 5_000)
    .filter((candidate) => candidate.volume5mUsd >= 500 || candidate.volume1hUsd >= 3_000)
    .sort((a, b) => b.tractionScore - a.tractionScore);
}

async function fetchTokenSources(): Promise<TokenSource[]> {
  const profiles = await fetchDex<Array<{ chainId?: string; tokenAddress?: string }>>(
    "/token-profiles/latest/v1"
  ).catch((error: unknown) => {
    console.warn("WARN: Failed to fetch token profiles:", errorMessage(error));
    return [];
  });
  await sleep(1000);
  const boostsLatest = await fetchDex<unknown>("/token-boosts/latest/v1").catch(
    (error: unknown) => {
      console.warn("WARN: Failed to fetch latest boosts:", errorMessage(error));
      return [];
    }
  );
  await sleep(1000);
  const boostsTop = await fetchDex<unknown>("/token-boosts/top/v1").catch((error: unknown) => {
    console.warn("WARN: Failed to fetch top boosts:", errorMessage(error));
    return [];
  });

  return [
    ...profiles
      .filter((item) => item.chainId === "solana" && item.tokenAddress)
      .map((item) => ({ tokenAddress: item.tokenAddress!, source: "latest_profile" })),
    ...asArray<{ chainId?: string; tokenAddress?: string }>(boostsLatest)
      .filter((item) => item.chainId === "solana" && item.tokenAddress)
      .map((item) => ({ tokenAddress: item.tokenAddress!, source: "latest_boost" })),
    ...asArray<{ chainId?: string; tokenAddress?: string }>(boostsTop)
      .filter((item) => item.chainId === "solana" && item.tokenAddress)
      .map((item) => ({ tokenAddress: item.tokenAddress!, source: "top_boost" }))
  ];
}

function candidateFromPair(pair: DexPair, source: TokenSource): Candidate | undefined {
  const tokenAddress = pair.baseToken?.address;
  const pairAddress = pair.pairAddress;
  if (!tokenAddress || !pairAddress) return undefined;

  const liquidityUsd = number(pair.liquidity?.usd);
  const volume5mUsd = number(pair.volume?.m5);
  const volume1hUsd = number(pair.volume?.h1);
  const buys5m = number(pair.txns?.m5?.buys);
  const sells5m = number(pair.txns?.m5?.sells);
  const buys1h = number(pair.txns?.h1?.buys);
  const sells1h = number(pair.txns?.h1?.sells);
  const priceChange5m = number(pair.priceChange?.m5);
  const priceChange1h = number(pair.priceChange?.h1);
  const ageMinutes = pair.pairCreatedAt
    ? Math.max(0, (Date.now() - pair.pairCreatedAt) / 60_000)
    : null;
  const txns5m = buys5m + sells5m;
  const txns1h = buys1h + sells1h;
  const buyRatio5m = buys5m / Math.max(txns5m, 1);
  const buyRatio1h = buys1h / Math.max(txns1h, 1);

  const tractionScore = round(
    clamp(Math.log10(Math.max(volume5mUsd, 1)) * 13, 0, 45) +
      clamp(Math.log10(Math.max(volume1hUsd, 1)) * 9, 0, 35) +
      clamp(Math.log10(Math.max(liquidityUsd, 1)) * 7, 0, 25) +
      clamp((buyRatio5m - 0.45) * 45, -10, 16) +
      clamp((buyRatio1h - 0.45) * 24, -8, 12) +
      clamp(priceChange5m * 0.08, -12, 12) +
      clamp(priceChange1h * 0.05, -12, 12) +
      (ageMinutes === null ? 0 : clamp(18 - ageMinutes / 90, 0, 18)) -
      (liquidityUsd > 2_000_000 ? 8 : 0),
    2
  );

  return {
    tokenAddress,
    symbol: pair.baseToken?.symbol ?? shortAddress(tokenAddress),
    name: pair.baseToken?.name ?? pair.baseToken?.symbol ?? shortAddress(tokenAddress),
    pairAddress,
    dexId: pair.dexId ?? "unknown",
    ...(pair.url ? { url: pair.url } : {}),
    liquidityUsd,
    volume5mUsd,
    volume1hUsd,
    buys5m,
    sells5m,
    buys1h,
    sells1h,
    priceChange5m,
    priceChange1h,
    ageMinutes: ageMinutes === null ? null : round(ageMinutes, 1),
    priceUsd: number(pair.priceUsd),
    sources: [source.source],
    tractionScore
  };
}

async function collectWalletEvents(
  candidate: Candidate
): Promise<{ events: WalletTokenEvent[]; stats: PairScanStats }> {
  const errors: string[] = [];
  const signatures = await rpc<
    Array<{ signature: string; slot: number; blockTime?: number | null }>
  >("getSignaturesForAddress", [candidate.pairAddress, { limit: SIGNATURE_LIMIT }]).catch(
    (error: unknown) => {
      errors.push(error instanceof Error ? error.message : "signature fetch failed");
      return [];
    }
  );

  const usable = signatures
    .filter((item) => item.signature)
    .slice(0, TX_LIMIT_PER_PAIR)
    .reverse();
  const events: WalletTokenEvent[] = [];
  let rank = 0;
  let transactionsParsed = 0;

  for (const sig of usable) {
    const tx = await rpc<Json | null>("getTransaction", [
      sig.signature,
      { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }
    ]).catch((error: unknown) => {
      errors.push(error instanceof Error ? error.message : "transaction fetch failed");
      return null;
    });
    if (!tx) continue;
    transactionsParsed += 1;

    const extracted = extractTokenBalanceEvents(candidate, sig.signature, tx, rank + 1);
    if (extracted.length > 0) {
      rank += 1;
      events.push(...extracted.map((event) => ({ ...event, rank })));
    }

    await sleep(220);
  }

  return {
    events,
    stats: {
      tokenSymbol: candidate.symbol,
      pairAddress: candidate.pairAddress,
      signaturesSeen: signatures.length,
      transactionsAttempted: usable.length,
      transactionsParsed,
      eventsExtracted: events.length,
      errors: [...new Set(errors)].slice(0, 5)
    }
  };
}

function extractTokenBalanceEvents(
  candidate: Candidate,
  signature: string,
  tx: Json,
  rankFallback: number
): WalletTokenEvent[] {
  const slot = number(tx.slot);
  const blockTime = number(tx.blockTime);
  const meta = tx.meta as Json | undefined;
  if (!meta || meta.err) return [];

  const deltas = new Map<string, { baseDelta: number; quoteDelta: number }>();
  const pre = asArray<Json>(meta.preTokenBalances);
  const post = asArray<Json>(meta.postTokenBalances);
  const byOwnerMint = new Map<string, { pre: number; post: number }>();

  for (const balance of pre) {
    const owner = String(balance.owner ?? "");
    const mint = String(balance.mint ?? "");
    if (!owner || !mint) continue;
    const key = `${owner}:${mint}`;
    const current = byOwnerMint.get(key) ?? { pre: 0, post: 0 };
    current.pre += uiAmount(balance);
    byOwnerMint.set(key, current);
  }

  for (const balance of post) {
    const owner = String(balance.owner ?? "");
    const mint = String(balance.mint ?? "");
    if (!owner || !mint) continue;
    const key = `${owner}:${mint}`;
    const current = byOwnerMint.get(key) ?? { pre: 0, post: 0 };
    current.post += uiAmount(balance);
    byOwnerMint.set(key, current);
  }

  for (const [key, amounts] of byOwnerMint) {
    const [owner, mint] = key.split(":");
    if (!owner || !mint) continue;
    const delta = amounts.post - amounts.pre;
    if (Math.abs(delta) < 0.000001) continue;
    const current = deltas.get(owner) ?? { baseDelta: 0, quoteDelta: 0 };
    if (mint === candidate.tokenAddress) current.baseDelta += delta;
    else current.quoteDelta += delta;
    deltas.set(owner, current);
  }

  return [...deltas.entries()]
    .filter(([, delta]) => Math.abs(delta.baseDelta) > 0.000001)
    .filter(([wallet]) => !isLikelyProgramOrPool(wallet, candidate))
    .map(([wallet, delta]) => ({
      wallet,
      tokenAddress: candidate.tokenAddress,
      tokenSymbol: candidate.symbol,
      pairAddress: candidate.pairAddress,
      signature,
      slot,
      blockTime,
      side: delta.baseDelta > 0 ? "buy" : "sell",
      baseDelta: round(delta.baseDelta, 6),
      quoteDelta: round(delta.quoteDelta, 6),
      rank: rankFallback
    }));
}

function aggregateWallets(events: WalletTokenEvent[], candidates: Candidate[]): WalletAggregate[] {
  const candidateScore = new Map(
    candidates.map((candidate) => [candidate.tokenAddress, candidate.tractionScore])
  );
  const byWallet = new Map<string, WalletTokenEvent[]>();
  for (const event of events) {
    const current = byWallet.get(event.wallet) ?? [];
    current.push(event);
    byWallet.set(event.wallet, current);
  }

  return [...byWallet.entries()]
    .map(([wallet, walletEvents]) => {
      const buys = walletEvents.filter((event) => event.side === "buy");
      const sells = walletEvents.filter((event) => event.side === "sell");
      const tokensTouched = new Set(walletEvents.map((event) => event.tokenAddress)).size;
      const earlyBuys = buys.filter((event) => event.rank <= 18).length;
      const averageRank =
        buys.reduce((sum, event) => sum + event.rank, 0) / Math.max(buys.length, 1);
      const averageCandidateScore =
        buys.reduce((sum, event) => sum + (candidateScore.get(event.tokenAddress) ?? 0), 0) /
        Math.max(buys.length, 1);
      const labels = classifyWallet(
        tokensTouched,
        earlyBuys,
        sells.length,
        averageRank,
        averageCandidateScore
      );
      return {
        wallet,
        tokensTouched,
        earlyBuys,
        sells: sells.length,
        averageRank: round(averageRank, 2),
        averageCandidateScore: round(averageCandidateScore, 2),
        buyPressureScore: round(
          clamp(
            earlyBuys * 11 +
              tokensTouched * 18 +
              averageCandidateScore * 0.55 -
              sells.length * 5 -
              averageRank * 0.4
          ),
          2
        ),
        labels,
        events: walletEvents.sort((a, b) => a.rank - b.rank)
      };
    })
    .filter((wallet) => wallet.earlyBuys > 0)
    .sort((a, b) => b.buyPressureScore - a.buyPressureScore);
}

function classifyWallet(
  tokensTouched: number,
  earlyBuys: number,
  sells: number,
  averageRank: number,
  averageCandidateScore: number
): string[] {
  const labels: string[] = [];
  if (tokensTouched >= 2 && earlyBuys >= 2) labels.push("cross-token active degen");
  if (earlyBuys >= 1 && averageRank <= 8) labels.push("very early buyer");
  if (averageCandidateScore >= 75) labels.push("high-traction participant");
  if (sells > earlyBuys) labels.push("fast seller / possible bot");
  if (labels.length === 0) labels.push("single-token early buyer");
  return labels;
}

async function mergeState(
  runAt: string,
  candidates: Candidate[],
  events: WalletTokenEvent[],
  aggregates: WalletAggregate[]
): Promise<ResearchState> {
  const previous = await readState();
  const wallets = { ...previous.wallets };

  for (const aggregate of aggregates) {
    const existing = wallets[aggregate.wallet];
    const mergedEvents = dedupeEvents([...(existing?.events ?? []), ...aggregate.events]);
    const tokensTouched = new Set(mergedEvents.map((event) => event.tokenAddress)).size;
    const earlyBuys = mergedEvents.filter(
      (event) => event.side === "buy" && event.rank <= 18
    ).length;
    const sells = mergedEvents.filter((event) => event.side === "sell").length;
    const averageRank =
      mergedEvents
        .filter((event) => event.side === "buy")
        .reduce((sum, event) => sum + event.rank, 0) / Math.max(earlyBuys, 1);

    wallets[aggregate.wallet] = {
      wallet: aggregate.wallet,
      tokensTouched,
      earlyBuys,
      sells,
      averageRank: round(averageRank, 2),
      averageCandidateScore: aggregate.averageCandidateScore,
      buyPressureScore: aggregate.buyPressureScore,
      labels: aggregate.labels,
      events: mergedEvents,
      lastSeenAt: runAt
    };
  }

  // Prune old wallets to keep the state size small and prevent memory leaks
  const pruneCutoffWallets = new Date(new Date(runAt).getTime() - 24 * 60 * 60 * 1000); // 24 hours
  for (const [walletAddress, wallet] of Object.entries(wallets)) {
    const lastSeen = wallet.lastSeenAt ? new Date(wallet.lastSeenAt) : new Date(0);
    if (lastSeen.getTime() < pruneCutoffWallets.getTime()) {
      delete wallets[walletAddress];
    }
  }

  const state: ResearchState = {
    updatedAt: runAt,
    runs: [
      ...previous.runs.slice(-30),
      {
        runAt,
        candidateCount: candidates.length,
        walletEventCount: events.length,
        ...(candidates[0] ? { topCandidate: candidates[0] } : {}),
        ...(aggregates[0] ? { topWallet: aggregates[0] } : {})
      }
    ],
    wallets
  };

  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
  return state;
}

async function readState(): Promise<ResearchState> {
  if (!existsSync(STATE_PATH)) {
    return { updatedAt: new Date(0).toISOString(), runs: [], wallets: {} };
  }
  return JSON.parse(await readFile(STATE_PATH, "utf8")) as ResearchState;
}

async function enrichWalletHistories(wallets: WalletAggregate[]): Promise<WalletHistorySummary[]> {
  const summaries: WalletHistorySummary[] = [];

  for (const wallet of wallets) {
    const errors: string[] = [];
    const signatures = await rpc<
      Array<{ signature: string; slot: number; blockTime?: number | null }>
    >("getSignaturesForAddress", [wallet.wallet, { limit: WALLET_SIGNATURE_LIMIT }]).catch(
      (error: unknown) => {
        errors.push(error instanceof Error ? error.message : "wallet signature fetch failed");
        return [];
      }
    );
    const usable = signatures.slice(0, WALLET_TX_LIMIT);
    const buyEvents: WalletHistorySummary["buyEvents"] = [];
    const sellEvents: WalletHistorySummary["sellEvents"] = [];
    let transactionsParsed = 0;

    for (const sig of usable) {
      const tx = await rpc<Json | null>("getTransaction", [
        sig.signature,
        { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }
      ]).catch((error: unknown) => {
        errors.push(error instanceof Error ? error.message : "wallet transaction fetch failed");
        return null;
      });
      if (!tx) continue;
      transactionsParsed += 1;

      const deltas = extractWalletMintDeltas(wallet.wallet, tx);
      for (const delta of deltas) {
        if (delta.mint === "So11111111111111111111111111111111111111112") continue;
        if (Math.abs(delta.delta) < 0.000001) continue;
        if (delta.delta > 0) {
          buyEvents.push({
            mint: delta.mint,
            delta: round(delta.delta, 6),
            signature: sig.signature,
            blockTime: number(tx.blockTime)
          });
        } else {
          sellEvents.push({
            mint: delta.mint,
            delta: round(delta.delta, 6),
            signature: sig.signature,
            blockTime: number(tx.blockTime)
          });
        }
      }
      await sleep(180);
    }

    const uniqueMintsBought = new Set(buyEvents.map((event) => event.mint)).size;
    const pumpMintsBought = new Set(
      buyEvents
        .filter((event) => event.mint.toLowerCase().endsWith("pump"))
        .map((event) => event.mint)
    ).size;
    const labels = classifyWalletHistory(
      uniqueMintsBought,
      pumpMintsBought,
      buyEvents.length,
      sellEvents.length
    );
    summaries.push({
      wallet: wallet.wallet,
      signaturesSeen: signatures.length,
      transactionsAttempted: usable.length,
      transactionsParsed,
      uniqueMintsBought,
      pumpMintsBought,
      buyEvents: buyEvents.slice(0, 20),
      sellEvents: sellEvents.slice(0, 20),
      labels,
      historyScore: round(
        clamp(
          uniqueMintsBought * 16 +
            pumpMintsBought * 18 +
            buyEvents.length * 3 -
            sellEvents.length * 2
        )
      ),
      errors: [...new Set(errors)].slice(0, 5)
    });
    await sleep(500);
  }

  return summaries.sort((a, b) => b.historyScore - a.historyScore);
}

function extractWalletMintDeltas(wallet: string, tx: Json): Array<{ mint: string; delta: number }> {
  const meta = tx.meta as Json | undefined;
  if (!meta || meta.err) return [];
  const balances = new Map<string, { pre: number; post: number }>();

  for (const balance of asArray<Json>(meta.preTokenBalances)) {
    if (String(balance.owner ?? "") !== wallet) continue;
    const mint = String(balance.mint ?? "");
    if (!mint) continue;
    const current = balances.get(mint) ?? { pre: 0, post: 0 };
    current.pre += uiAmount(balance);
    balances.set(mint, current);
  }

  for (const balance of asArray<Json>(meta.postTokenBalances)) {
    if (String(balance.owner ?? "") !== wallet) continue;
    const mint = String(balance.mint ?? "");
    if (!mint) continue;
    const current = balances.get(mint) ?? { pre: 0, post: 0 };
    current.post += uiAmount(balance);
    balances.set(mint, current);
  }

  return [...balances.entries()]
    .map(([mint, amounts]) => ({ mint, delta: amounts.post - amounts.pre }))
    .filter((item) => Math.abs(item.delta) > 0.000001);
}

function classifyWalletHistory(
  uniqueMintsBought: number,
  pumpMintsBought: number,
  buyEvents: number,
  sellEvents: number
): string[] {
  const labels: string[] = [];
  if (pumpMintsBought >= 3) labels.push("active pump degen wallet");
  if (uniqueMintsBought >= 4) labels.push("multi-token recent buyer");
  if (buyEvents >= 5 && sellEvents <= buyEvents) labels.push("net recent accumulator");
  if (sellEvents > buyEvents) labels.push("fast churn seller");
  if (labels.length === 0) labels.push("limited recent history");
  return labels;
}

function describeRawLead(
  candidates: Candidate[],
  wallets: WalletAggregate[],
  walletHistory: WalletHistorySummary[]
) {
  const topWallet = wallets[0];
  const topCandidate = candidates[0];
  const repeatedWallets = wallets.filter(
    (wallet) => wallet.tokensTouched >= 2 && wallet.earlyBuys >= 2
  );
  const activeDegenWallets = walletHistory.filter((wallet) => wallet.pumpMintsBought >= 3);
  const systemName =
    repeatedWallets.length > 0
      ? "Cross-token early-wallet convergence"
      : activeDegenWallets.length > 0
        ? "Early-buyer wallet history enrichment"
        : "High-traction new-pair wallet extraction";

  return {
    systemName,
    validationStatus: "raw lead / unvalidated",
    topCandidate,
    topWallet,
    topHistoryWallet: activeDegenWallets[0] ?? walletHistory[0],
    repeatedWalletCount: repeatedWallets.length,
    activeDegenWalletCount: activeDegenWallets.length,
    explanation:
      repeatedWallets.length > 0
        ? "Ayni canli taramada birden fazla kontrollu-akis tokenina erken giren cuzdanlar bulundu. Bu yalnizca test edilecek bir ham ipucudur."
        : activeDegenWallets.length > 0
          ? "Erken alici cuzdanlardan en az biri yakin gecmiste birden fazla pump token almis gorunuyor. Olgun observed-entry sonucu olmadan performans adayi sayilmaz."
          : "Bu turda yalnizca token traction bulundu. Tekrarlanan observed-entry kaniti olmadigi icin sistem avantaji iddia edilmiyor."
  };
}

function renderMarkdown(
  report: {
    runAt: string;
    rpcUrl: string;
    candidates: Candidate[];
    scanStats: PairScanStats[];
    walletEvents: WalletTokenEvent[];
    walletAggregates: WalletAggregate[];
    walletHistory: WalletHistorySummary[];
    rawLead: ReturnType<typeof describeRawLead>;
  },
  state: ResearchState
): string {
  const lines = [
    "# Live Solana Alpha Research",
    "",
    `Run: ${report.runAt}`,
    `RPC: ${report.rpcUrl}`,
    "",
    "Research only. Not financial advice. Live execution is disabled.",
    "",
    "## Raw Lead (Unvalidated)",
    "",
    `Lead: ${report.rawLead.systemName}`,
    `Status: ${report.rawLead.validationStatus}`,
    `Explanation: ${report.rawLead.explanation}`,
    "",
    "## Top Candidates",
    "",
    "| Rank | Token | Pair | Dex | Liquidity | Vol 5m | Buys/Sells 5m | Age | Score |",
    "|---:|---|---|---|---:|---:|---:|---:|---:|",
    ...report.candidates
      .slice(0, 10)
      .map((candidate, index) =>
        [
          index + 1,
          `${candidate.symbol} (${shortAddress(candidate.tokenAddress)})`,
          shortAddress(candidate.pairAddress),
          candidate.dexId,
          `$${Math.round(candidate.liquidityUsd).toLocaleString()}`,
          `$${Math.round(candidate.volume5mUsd).toLocaleString()}`,
          `${candidate.buys5m}/${candidate.sells5m}`,
          candidate.ageMinutes === null ? "?" : `${candidate.ageMinutes}m`,
          candidate.tractionScore
        ].join(" | ")
      ),
    "",
    "## Wallet Leads",
    "",
    "| Rank | Wallet | Labels | Tokens | Early Buys | Sells | Avg Rank | Score |",
    "|---:|---|---|---:|---:|---:|---:|---:|",
    ...report.walletAggregates
      .slice(0, 15)
      .map((wallet, index) =>
        [
          index + 1,
          wallet.wallet,
          wallet.labels.join(", "),
          wallet.tokensTouched,
          wallet.earlyBuys,
          wallet.sells,
          wallet.averageRank,
          wallet.buyPressureScore
        ].join(" | ")
      ),
    "",
    "## Wallet History Enrichment",
    "",
    "| Rank | Wallet | Labels | Unique Buys | Pump Buys | Parsed | Score |",
    "|---:|---|---|---:|---:|---:|---:|",
    ...report.walletHistory
      .slice(0, 12)
      .map((wallet, index) =>
        [
          index + 1,
          wallet.wallet,
          wallet.labels.join(", "),
          wallet.uniqueMintsBought,
          wallet.pumpMintsBought,
          wallet.transactionsParsed,
          wallet.historyScore
        ].join(" | ")
      ),
    "",
    "## Cumulative State",
    "",
    `Runs stored: ${state.runs.length}`,
    `Wallets tracked: ${Object.keys(state.wallets).length}`,
    "",
    "## Pair Scan Stats",
    "",
    "| Token | Signatures | Attempted | Parsed | Events | Errors |",
    "|---|---:|---:|---:|---:|---|",
    ...report.scanStats.map((stats) =>
      [
        stats.tokenSymbol,
        stats.signaturesSeen,
        stats.transactionsAttempted,
        stats.transactionsParsed,
        stats.eventsExtracted,
        stats.errors.length ? stats.errors.join("; ").replaceAll("|", "/") : "-"
      ].join(" | ")
    ),
    "",
    "## Caveats",
    "",
    "- Public RPC gives recent observable pool-account transactions, not a full paid indexer history.",
    "- A wallet being early does not prove profitability; it can be a bot, insider, market maker, or noise.",
    "- Treat repeated cross-token early buys as a watchlist input, not a blind copy signal."
  ];

  return lines.join("\n");
}

async function fetchDex<T>(path: string): Promise<T> {
  return fetchJson<T>(`${DEX_BASE}${path}`);
}

async function fetchJson<T>(url: string, retries = 2): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEX_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      if (response.ok) return (await response.json()) as T;
      if (attempt < retries && (response.status === 429 || response.status >= 500)) {
        const delay = response.status === 429 ? 3000 * 2 ** attempt : 500 * 2 ** attempt;
        await sleep(delay);
        continue;
      }
      throw new Error(`HTTP ${response.status} for ${url}`);
    } catch (error) {
      if (attempt >= retries) throw error;
      await sleep(500 * 2 ** attempt);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`Retry exhausted for ${url}`);
}

async function rpc<T>(method: string, params: unknown[], retries = 1): Promise<T> {
  const totalAttempts = Math.max(retries + 1, RPC_ENDPOINTS.length * 2);
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    const endpoint = nextRpcEndpoint();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
        signal: controller.signal
      });
      const body = (await response.json()) as { result?: T; error?: { message?: string } };
      if (body.error) {
        throw new Error(
          `${redactUrl(endpoint)}: ${body.error.message ?? `RPC error for ${method}`}`
        );
      }
      await sleep(120);
      return body.result as T;
    } catch (error) {
      if (attempt >= totalAttempts - 1) throw error;
      await sleep(650 * 2 ** attempt);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`RPC retry exhausted for ${method}`);
}

function nextRpcEndpoint(): string {
  const endpoint = RPC_ENDPOINTS[rpcCursor % RPC_ENDPOINTS.length];
  rpcCursor += 1;
  if (!endpoint) throw new Error("No Solana RPC endpoints configured.");
  return endpoint;
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function worker() {
    while (index < values.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(values[currentIndex]!, currentIndex);
      await sleep(90);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => worker()));
  return results;
}

function dedupeSources(sources: TokenSource[]): TokenSource[] {
  const byToken = new Map<string, TokenSource>();
  for (const source of sources) {
    const existing = byToken.get(source.tokenAddress);
    byToken.set(source.tokenAddress, {
      tokenAddress: source.tokenAddress,
      source: existing ? `${existing.source},${source.source}` : source.source
    });
  }
  return [...byToken.values()];
}

function dedupeEvents(events: WalletTokenEvent[]): WalletTokenEvent[] {
  const seen = new Set<string>();
  const out: WalletTokenEvent[] = [];
  for (const event of events) {
    const key = `${event.wallet}:${event.tokenAddress}:${event.signature}:${event.side}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  return out;
}

function uiAmount(balance: Json): number {
  const amount = balance.uiTokenAmount as Json | undefined;
  return number(amount?.uiAmountString ?? amount?.uiAmount);
}

function isLikelyProgramOrPool(wallet: string, candidate: Candidate): boolean {
  return (
    wallet === candidate.pairAddress || wallet === candidate.tokenAddress || wallet.length < 32
  );
}

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") return [value as T];
  return [];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function number(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-6)}` : address;
}

function redactUrl(url: string): string {
  return url.replace(/api-key=[^&]+/gi, "api-key=REDACTED");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("live-solana-alpha.ts") ||
    process.argv[1].endsWith("live-solana-alpha.js"));

if (isMain) {
  await main();
}

export { main };
