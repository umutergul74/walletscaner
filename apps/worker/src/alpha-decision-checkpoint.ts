import type {
  DirectExactInQuoteEvidence,
  DirectExactInQuoteRequest,
  DexScreenerPair
} from "@memecoin-alpha/providers";
import { JupiterQuoteIntegrityError } from "@memecoin-alpha/providers";
import type {
  AlphaDecisionCheckpointClaim,
  AlphaDecisionCheckpointCompletion,
  AlphaDecisionFlowCounts,
  AlphaExecutionQuoteEvidence,
  AlphaQuoteStatus
} from "@memecoin-alpha/db";

const quoteSizes = [600, 2500, 10000] as const;
const wrappedSolMint = "So11111111111111111111111111111111111111112";
const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

interface ExactPairClient {
  fetchPair(chain: "solana", poolAddress: string): Promise<DexScreenerPair[]>;
}

interface DirectQuoteClient {
  fetchDirectExactInQuote(request: DirectExactInQuoteRequest): Promise<DirectExactInQuoteEvidence>;
}

export interface AlphaDecisionCheckpointDependencies {
  marketClient: ExactPairClient;
  quoteClient?: DirectQuoteClient;
  quoteUsdPrice(quoteMint: string): Promise<number>;
  measureFlow(decisionId: string, observedAt: string): Promise<AlphaDecisionFlowCounts>;
  now?: () => Date;
  slippageBps?: number;
}

/**
 * Collect one fixed-horizon observation. Network work is sequential and
 * bounded: six quotes at entry or three sell quotes at later checkpoints.
 * Every quote remains `quoted-not-filled` evidence.
 */
export async function collectAlphaDecisionCheckpoint(
  claim: AlphaDecisionCheckpointClaim,
  dependencies: AlphaDecisionCheckpointDependencies
): Promise<AlphaDecisionCheckpointCompletion> {
  const now = dependencies.now ?? (() => new Date());
  const slippageBps = boundedSlippage(dependencies.slippageBps ?? 400);
  const marketStartedAt = Date.now();
  let pair: DexScreenerPair | undefined;
  let marketError: string | undefined;
  try {
    const pairs = await dependencies.marketClient.fetchPair("solana", claim.poolAddress);
    pair = pairs.find(
      (candidate) => candidate.chainId === "solana" && candidate.pairAddress === claim.poolAddress
    );
  } catch (error) {
    marketError = safeError(error);
  }
  const marketProviderLatencyMs = Math.max(0, Date.now() - marketStartedAt);
  const marketObservedAt = now().toISOString();
  const flow = await dependencies.measureFlow(claim.decisionId, marketObservedAt);
  const liquidityUsd = finiteNonnegative(pair?.liquidity?.usd);
  const priceUsd = finiteNonnegative(Number(pair?.priceUsd));
  const buys5m = nonnegativeInteger(pair?.txns?.m5?.buys);
  const sells5m = nonnegativeInteger(pair?.txns?.m5?.sells);
  const exactPairStatus = marketError
    ? "provider-error"
    : !pair
      ? "missing"
      : (liquidityUsd ?? 0) <= 0
        ? "liquidity-zero"
        : "live";
  const quotes = await collectQuotes(claim, dependencies, slippageBps, now);

  return {
    exactPairStatus,
    ...(priceUsd !== undefined ? { priceUsd } : {}),
    ...(liquidityUsd !== undefined ? { liquidityUsd } : {}),
    ...(buys5m !== undefined ? { buys5m } : {}),
    ...(sells5m !== undefined ? { sells5m } : {}),
    uniqueBuyersSinceDecision: flow.uniqueBuyers,
    uniqueSellersSinceDecision: flow.uniqueSellers,
    // Address counts cannot be relabelled as independent actors until the
    // funder/bundle graph is implemented and verified.
    identityIndependenceStatus: "unknown",
    liquidityRemoved:
      exactPairStatus === "missing" ||
      exactPairStatus === "liquidity-zero" ||
      (liquidityUsd !== undefined && liquidityUsd < claim.initialLiquidityUsd * 0.2),
    marketObservedAt,
    marketProvider: marketError ? "dexscreener-exact-pair-error" : "dexscreener-exact-pair",
    marketProviderLatencyMs,
    quotes
  };
}

async function collectQuotes(
  claim: AlphaDecisionCheckpointClaim,
  dependencies: AlphaDecisionCheckpointDependencies,
  slippageBps: number,
  now: () => Date
): Promise<AlphaExecutionQuoteEvidence[]> {
  const quoteMint = claim.quoteTokenAddress;
  if (!quoteMint) {
    return missingQuoteRows(claim, slippageBps, now, "quote-mint-unknown");
  }
  if (!dependencies.quoteClient) {
    return missingQuoteRows(claim, slippageBps, now, "jupiter-api-key-not-configured");
  }

  if (claim.horizonSeconds > 0) {
    const rows: AlphaExecutionQuoteEvidence[] = [];
    for (const size of quoteSizes) {
      const rawAmount = claim.entryRawAmounts[size];
      if (!rawAmount) {
        rows.push(
          failureQuote({
            claim,
            direction: "sell",
            size,
            positionSource: "decision-entry",
            inputMint: claim.tokenAddress,
            outputMint: quoteMint,
            slippageBps,
            now,
            status: "not-attempted",
            reason: "decision-entry-buy-quote-unavailable"
          })
        );
        continue;
      }
      rows.push(
        await requestQuote({
          claim,
          quoteClient: dependencies.quoteClient,
          direction: "sell",
          size,
          positionSource: "decision-entry",
          inputMint: claim.tokenAddress,
          outputMint: quoteMint,
          rawInputAmount: rawAmount,
          slippageBps,
          now
        })
      );
    }
    return rows;
  }

  let quoteUsdPrice: number;
  try {
    quoteUsdPrice = await dependencies.quoteUsdPrice(quoteMint);
    if (!Number.isFinite(quoteUsdPrice) || quoteUsdPrice <= 0) {
      throw new Error("quote USD price was invalid");
    }
  } catch (error) {
    const reason = safeError(error).includes("stale")
      ? `stale-quote-usd-price:${safeError(error)}`
      : `quote-usd-price-unavailable:${safeError(error)}`;
    return missingQuoteRows(claim, slippageBps, now, reason);
  }

  const rows: AlphaExecutionQuoteEvidence[] = [];
  for (const size of quoteSizes) {
    const rawInputAmount = quoteNotionalRawAmount(quoteMint, size, quoteUsdPrice);
    const buy = await requestQuote({
      claim,
      quoteClient: dependencies.quoteClient,
      direction: "buy",
      size,
      positionSource: "new-buy",
      inputMint: quoteMint,
      outputMint: claim.tokenAddress,
      rawInputAmount,
      slippageBps,
      now
    });
    rows.push(buy);
    if (buy.status !== "quoted-not-filled" || !buy.rawMinimumOutputAmount) {
      rows.push(
        failureQuote({
          claim,
          direction: "sell",
          size,
          positionSource: "new-buy",
          inputMint: claim.tokenAddress,
          outputMint: quoteMint,
          slippageBps,
          now,
          status: "not-attempted",
          reason: "entry-buy-quote-unavailable"
        })
      );
      continue;
    }
    rows.push(
      await requestQuote({
        claim,
        quoteClient: dependencies.quoteClient,
        direction: "sell",
        size,
        positionSource: "new-buy",
        inputMint: claim.tokenAddress,
        outputMint: quoteMint,
        rawInputAmount: buy.rawMinimumOutputAmount,
        slippageBps,
        now
      })
    );
  }
  return rows;
}

async function requestQuote(input: {
  claim: AlphaDecisionCheckpointClaim;
  quoteClient: DirectQuoteClient;
  direction: "buy" | "sell";
  size: 600 | 2500 | 10000;
  positionSource: "new-buy" | "decision-entry";
  inputMint: string;
  outputMint: string;
  rawInputAmount: string;
  slippageBps: number;
  now: () => Date;
}): Promise<AlphaExecutionQuoteEvidence> {
  try {
    const quote = await input.quoteClient.fetchDirectExactInQuote({
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      rawInputAmount: input.rawInputAmount,
      slippageBps: input.slippageBps,
      expectedPoolAddress: input.claim.poolAddress
    });
    return {
      direction: input.direction,
      notionalUsdCents: input.size,
      positionSource: input.positionSource,
      status: "quoted-not-filled",
      inputMint: quote.inputMint,
      outputMint: quote.outputMint,
      rawInputAmount: quote.rawInputAmount,
      rawExpectedOutputAmount: quote.rawExpectedOutputAmount,
      rawMinimumOutputAmount: quote.rawMinimumOutputAmount,
      slippageBps: quote.slippageBps,
      priceImpactPercent: quote.priceImpactPercent,
      expectedPoolAddress: input.claim.poolAddress,
      routePoolAddress: quote.routePoolAddress,
      ...(quote.routeLabel ? { routeLabel: quote.routeLabel } : {}),
      ...(quote.routeRouter ? { routeRouter: quote.routeRouter } : {}),
      ...(quote.providerFeeBps !== undefined ? { providerFeeBps: quote.providerFeeBps } : {}),
      ...(quote.providerFeeMint ? { providerFeeMint: quote.providerFeeMint } : {}),
      ...(quote.platformFeeRawAmount ? { platformFeeRawAmount: quote.platformFeeRawAmount } : {}),
      ...(quote.platformFeeBps !== undefined ? { platformFeeBps: quote.platformFeeBps } : {}),
      ...(quote.platformFeeMint ? { platformFeeMint: quote.platformFeeMint } : {}),
      ...(quote.contextSlot !== undefined ? { contextSlot: quote.contextSlot } : {}),
      provider: quote.provider,
      ...(quote.providerTimeMs !== undefined ? { providerTimeMs: quote.providerTimeMs } : {}),
      httpLatencyMs: quote.httpLatencyMs,
      observedAt: quote.observedAt
    };
  } catch (error) {
    const reason = safeError(error);
    return failureQuote({
      claim: input.claim,
      direction: input.direction,
      size: input.size,
      positionSource: input.positionSource,
      inputMint: input.inputMint,
      outputMint: input.outputMint,
      rawInputAmount: input.rawInputAmount,
      slippageBps: input.slippageBps,
      now: input.now,
      status: classifyQuoteFailure(error),
      reason
    });
  }
}

function missingQuoteRows(
  claim: AlphaDecisionCheckpointClaim,
  slippageBps: number,
  now: () => Date,
  reason: string
): AlphaExecutionQuoteEvidence[] {
  const directions = claim.horizonSeconds === 0 ? (["buy", "sell"] as const) : (["sell"] as const);
  return quoteSizes.flatMap((size) =>
    directions.map((direction) =>
      failureQuote({
        claim,
        direction,
        size,
        positionSource: claim.horizonSeconds === 0 ? "new-buy" : "decision-entry",
        inputMint:
          direction === "buy" ? (claim.quoteTokenAddress ?? "unknown") : claim.tokenAddress,
        outputMint:
          direction === "buy" ? claim.tokenAddress : (claim.quoteTokenAddress ?? "unknown"),
        slippageBps,
        now,
        status: reason.startsWith("stale-") ? "stale" : "not-attempted",
        reason
      })
    )
  );
}

function failureQuote(input: {
  claim: AlphaDecisionCheckpointClaim;
  direction: "buy" | "sell";
  size: 600 | 2500 | 10000;
  positionSource: "new-buy" | "decision-entry";
  inputMint: string;
  outputMint: string;
  rawInputAmount?: string;
  slippageBps: number;
  now: () => Date;
  status: Exclude<AlphaQuoteStatus, "quoted-not-filled">;
  reason: string;
}): AlphaExecutionQuoteEvidence {
  return {
    direction: input.direction,
    notionalUsdCents: input.size,
    positionSource: input.positionSource,
    status: input.status,
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    ...(input.rawInputAmount ? { rawInputAmount: input.rawInputAmount } : {}),
    slippageBps: input.slippageBps,
    expectedPoolAddress: input.claim.poolAddress,
    provider: "jupiter-swap-v2-order",
    observedAt: input.now().toISOString(),
    failureReason: input.reason.slice(0, 1024)
  };
}

export function quoteNotionalRawAmount(
  quoteMint: string,
  notionalUsdCents: 600 | 2500 | 10000,
  quotePriceUsd: number
): string {
  if (!Number.isFinite(quotePriceUsd) || quotePriceUsd <= 0) {
    throw new Error("Quote USD price must be positive.");
  }
  if (quoteMint === usdcMint) return (BigInt(notionalUsdCents) * 10_000n).toString();
  if (quoteMint !== wrappedSolMint) throw new Error("Quote mint is not supported by tape v1.");
  const scaledPrice = decimalToScaledInteger(quotePriceUsd, 8);
  const lamports = (BigInt(notionalUsdCents) * 1_000_000_000_000_000n) / scaledPrice;
  if (lamports <= 0n) throw new Error("Quote notional rounded to zero raw units.");
  return lamports.toString();
}

function decimalToScaledInteger(value: number, decimals: number): bigint {
  const fixed = value.toFixed(decimals);
  const [whole = "0", fraction = ""] = fixed.split(".");
  return BigInt(`${whole}${fraction.padEnd(decimals, "0")}`);
}

function classifyQuoteFailure(error: unknown): Exclude<AlphaQuoteStatus, "quoted-not-filled"> {
  const message = safeError(error).toLowerCase();
  if (error instanceof JupiterQuoteIntegrityError && message.includes("did not use")) {
    return "wrong-pool";
  }
  if (error instanceof JupiterQuoteIntegrityError && message.includes("single 100% direct route")) {
    return "no-route";
  }
  if (message.includes("stale")) return "stale";
  return "provider-error";
}

function boundedSlippage(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error("Alpha decision slippage must be between 0 and 10000 bps.");
  }
  return value;
}

function finiteNonnegative(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonnegativeInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1024) : String(error).slice(0, 1024);
}
