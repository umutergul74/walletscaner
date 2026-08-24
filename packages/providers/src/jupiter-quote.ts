const U64_MAX = 18_446_744_073_709_551_615n;

export interface JupiterRouteStep {
  swapInfo?: {
    ammKey?: string;
    label?: string;
    inputMint?: string;
    outputMint?: string;
    inAmount?: string;
    outAmount?: string;
    feeAmount?: string;
    feeMint?: string;
  };
  percent?: number;
}

export interface JupiterQuoteResponse {
  inputMint?: string;
  inAmount?: string;
  outputMint?: string;
  outAmount?: string;
  otherAmountThreshold?: string;
  swapMode?: string;
  slippageBps?: number;
  priceImpactPct?: string;
  routePlan?: JupiterRouteStep[];
  contextSlot?: number;
  timeTaken?: number;
}

export interface DirectExactInQuoteRequest {
  inputMint: string;
  outputMint: string;
  rawInputAmount: bigint | string;
  slippageBps: number;
  /** Reject routes that borrow another market's liquidity during causal research. */
  expectedPoolAddress?: string;
}

export interface DirectExactInQuoteEvidence {
  provider: "jupiter-swap-v1";
  status: "quoted-not-filled";
  inputMint: string;
  outputMint: string;
  rawInputAmount: string;
  rawExpectedOutputAmount: string;
  rawMinimumOutputAmount: string;
  slippageBps: number;
  priceImpactPercent: number;
  routePoolAddress: string;
  routeLabel?: string;
  contextSlot?: number;
  providerTimeSeconds?: number;
  observedAt: string;
  raw: JupiterQuoteResponse;
}

export class JupiterQuoteIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JupiterQuoteIntegrityError";
  }
}

/**
 * Read-only quote client for paper/shadow evidence. A route quote includes AMM
 * fees and a slippage failure threshold, but it is not proof that a transaction
 * landed; live transaction building/signing remains outside the project.
 */
export class JupiterQuoteClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.jup.ag/swap/v1",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly requestTimeoutMs = 5_000
  ) {
    if (!apiKey.trim()) throw new Error("Jupiter API key is required.");
  }

  async fetchDirectExactInQuote(
    request: DirectExactInQuoteRequest
  ): Promise<DirectExactInQuoteEvidence> {
    const amount = parseRawAmount(request.rawInputAmount);
    const slippageBps = boundedInteger(request.slippageBps, 0, 10_000, "slippageBps");
    const inputMint = requiredAddress(request.inputMint, "inputMint");
    const outputMint = requiredAddress(request.outputMint, "outputMint");
    if (inputMint === outputMint) {
      throw new JupiterQuoteIntegrityError("Jupiter quote mints must differ.");
    }

    const url = new URL(`${this.baseUrl.replace(/\/$/u, "")}/quote`);
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", amount.toString());
    url.searchParams.set("swapMode", "ExactIn");
    url.searchParams.set("slippageBps", slippageBps.toString());
    url.searchParams.set("onlyDirectRoutes", "true");
    url.searchParams.set("restrictIntermediateTokens", "true");

    const response = await this.fetchImpl(url, {
      headers: { "x-api-key": this.apiKey },
      signal: AbortSignal.timeout(this.requestTimeoutMs)
    });
    if (!response.ok) throw new Error(`Jupiter quote returned HTTP ${response.status}.`);
    const quote = (await response.json()) as JupiterQuoteResponse;
    return validateDirectQuote(quote, {
      inputMint,
      outputMint,
      amount,
      slippageBps,
      ...(request.expectedPoolAddress
        ? { expectedPoolAddress: request.expectedPoolAddress }
        : {})
    });
  }
}

function validateDirectQuote(
  quote: JupiterQuoteResponse,
  expected: {
    inputMint: string;
    outputMint: string;
    amount: bigint;
    slippageBps: number;
    expectedPoolAddress?: string;
  }
): DirectExactInQuoteEvidence {
  if (
    quote.inputMint !== expected.inputMint ||
    quote.outputMint !== expected.outputMint ||
    quote.inAmount !== expected.amount.toString() ||
    quote.swapMode !== "ExactIn" ||
    quote.slippageBps !== expected.slippageBps
  ) {
    throw new JupiterQuoteIntegrityError("Jupiter quote identity did not match the request.");
  }
  const outAmount = parsePositiveU64(quote.outAmount, "outAmount");
  const minimumOut = parsePositiveU64(quote.otherAmountThreshold, "otherAmountThreshold");
  if (minimumOut > outAmount) {
    throw new JupiterQuoteIntegrityError("Jupiter minimum output exceeded expected output.");
  }
  const route = quote.routePlan;
  if (!route || route.length !== 1 || route[0]?.percent !== 100) {
    throw new JupiterQuoteIntegrityError("Jupiter quote was not a single 100% direct route.");
  }
  const routePoolAddress = requiredAddress(route[0]?.swapInfo?.ammKey, "route ammKey");
  if (expected.expectedPoolAddress && routePoolAddress !== expected.expectedPoolAddress) {
    throw new JupiterQuoteIntegrityError(
      "Jupiter direct route did not use the signal's exact pool."
    );
  }
  const priceImpactPercent = Number(quote.priceImpactPct);
  if (!Number.isFinite(priceImpactPercent) || priceImpactPercent < 0) {
    throw new JupiterQuoteIntegrityError("Jupiter quote price impact was invalid.");
  }
  return {
    provider: "jupiter-swap-v1",
    status: "quoted-not-filled",
    inputMint: expected.inputMint,
    outputMint: expected.outputMint,
    rawInputAmount: expected.amount.toString(),
    rawExpectedOutputAmount: outAmount.toString(),
    rawMinimumOutputAmount: minimumOut.toString(),
    slippageBps: expected.slippageBps,
    priceImpactPercent,
    routePoolAddress,
    ...(route[0]?.swapInfo?.label ? { routeLabel: route[0].swapInfo.label } : {}),
    ...(Number.isSafeInteger(quote.contextSlot) ? { contextSlot: quote.contextSlot } : {}),
    ...(typeof quote.timeTaken === "number" && Number.isFinite(quote.timeTaken)
      ? { providerTimeSeconds: quote.timeTaken }
      : {}),
    observedAt: new Date().toISOString(),
    raw: quote
  };
}

function parseRawAmount(value: bigint | string): bigint {
  let parsed: bigint;
  try {
    parsed = typeof value === "bigint" ? value : BigInt(value);
  } catch {
    throw new JupiterQuoteIntegrityError("Jupiter raw input amount was invalid.");
  }
  if (parsed <= 0n || parsed > U64_MAX) {
    throw new JupiterQuoteIntegrityError("Jupiter raw input amount was outside uint64.");
  }
  return parsed;
}

function parsePositiveU64(value: string | undefined, name: string): bigint {
  if (!value) throw new JupiterQuoteIntegrityError(`Jupiter ${name} was missing.`);
  return parseRawAmount(value);
}

function requiredAddress(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new JupiterQuoteIntegrityError(`Jupiter ${name} was missing.`);
  return normalized;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new JupiterQuoteIntegrityError(`Jupiter ${name} was outside its allowed range.`);
  }
  return value;
}
