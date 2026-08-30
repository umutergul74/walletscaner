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
  mode?: string;
  inputMint?: string;
  inAmount?: string;
  outputMint?: string;
  outAmount?: string;
  otherAmountThreshold?: string;
  swapMode?: string;
  slippageBps?: number;
  priceImpact?: number;
  priceImpactPct?: string;
  routePlan?: JupiterRouteStep[];
  feeBps?: number;
  feeMint?: string;
  platformFee?: {
    amount?: string;
    feeBps?: number;
    feeMint?: string;
  };
  router?: string;
  transaction?: string | null;
  totalTime?: number;
  contextSlot?: number;
  timeTaken?: number;
}

export interface DirectExactInQuoteRequest {
  /** Local evidence deadline, never sent to the provider. */
  deadlineAt?: string;
  inputMint: string;
  outputMint: string;
  rawInputAmount: bigint | string;
  slippageBps: number;
  /** Reject routes that borrow another market's liquidity during causal research. */
  expectedPoolAddress?: string;
}

export interface DirectExactInQuoteEvidence {
  provider: "jupiter-swap-v2-order";
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
  routeRouter?: string;
  providerFeeBps?: number;
  providerFeeMint?: string;
  platformFeeRawAmount?: string;
  platformFeeBps?: number;
  platformFeeMint?: string;
  contextSlot?: number;
  providerTimeMs?: number;
  httpLatencyMs: number;
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
  private nextRequestAtMs = 0;
  private blockedUntilMs = 0;
  private requestActive = false;
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://api.jup.ag/swap/v2",
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly requestTimeoutMs = 5_000,
    private readonly minimumRequestIntervalMs = 0
  ) {
    if (!apiKey.trim()) throw new Error("Jupiter API key is required.");
    if (!Number.isInteger(minimumRequestIntervalMs) || minimumRequestIntervalMs < 0
      || minimumRequestIntervalMs > 10_000) throw new Error("Invalid Jupiter request interval.");
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

    const url = new URL(`${this.baseUrl.replace(/\/$/u, "")}/order`);
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", amount.toString());
    url.searchParams.set("swapMode", "ExactIn");
    url.searchParams.set("slippageBps", slippageBps.toString());

    if (this.blockedUntilMs > Date.now()) throw new Error("Jupiter quote provider in bounded backoff.");
    if (this.requestActive) throw new Error("Jupiter quote concurrent request rejected; retry within evidence deadline.");
    this.requestActive = true;
    try {
      const waitMs = Math.max(0, this.nextRequestAtMs - Date.now());
      const deadlineMs = request.deadlineAt === undefined ? Infinity : Date.parse(request.deadlineAt);
      if (Number.isNaN(deadlineMs) || Date.now() + waitMs >= deadlineMs) {
        throw new JupiterQuoteIntegrityError("Jupiter quote evidence is stale: checkpoint deadline.");
      }
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      const requestedAt = Date.now();
      if (requestedAt >= deadlineMs) throw new JupiterQuoteIntegrityError("Jupiter quote evidence is stale: checkpoint deadline.");
      this.nextRequestAtMs = requestedAt + this.minimumRequestIntervalMs;
      const response = await this.fetchImpl(url, {
        headers: { "x-api-key": this.apiKey },
        signal: AbortSignal.timeout(Math.min(this.requestTimeoutMs, deadlineMs - requestedAt))
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) this.blockedUntilMs = Date.now() + 900_000;
        if (response.status === 429) this.blockedUntilMs = Date.now() + 60_000;
        throw new Error(`Jupiter quote returned HTTP ${response.status}.`);
      }
      const quote = (await response.json()) as JupiterQuoteResponse;
      return validateDirectQuote(quote, {
      inputMint,
      outputMint,
      amount,
      slippageBps,
      ...(request.expectedPoolAddress ? { expectedPoolAddress: request.expectedPoolAddress } : {}),
      httpLatencyMs: Math.max(0, Date.now() - requestedAt)
      });
    } finally {
      this.requestActive = false;
    }
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
    httpLatencyMs: number;
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
  if (quote.transaction !== undefined && quote.transaction !== null) {
    throw new JupiterQuoteIntegrityError(
      "Jupiter quote-only response unexpectedly contained a transaction."
    );
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
  const priceImpactPercent =
    typeof quote.priceImpact === "number" ? quote.priceImpact : Number(quote.priceImpactPct) * 100;
  if (
    !Number.isFinite(priceImpactPercent) ||
    priceImpactPercent < -100 ||
    priceImpactPercent > 100
  ) {
    throw new JupiterQuoteIntegrityError("Jupiter quote price impact was invalid.");
  }
  const providerFeeBps = validOptionalBps(quote.feeBps, "total fee bps");
  const platformFeeBps = validOptionalBps(quote.platformFee?.feeBps, "platform fee bps");
  const platformFeeRawAmount = optionalRawAmount(quote.platformFee?.amount, "platform fee amount");
  return {
    provider: "jupiter-swap-v2-order",
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
    ...(quote.router ? { routeRouter: quote.router } : {}),
    ...(providerFeeBps !== undefined ? { providerFeeBps } : {}),
    ...(quote.feeMint ? { providerFeeMint: quote.feeMint } : {}),
    ...(platformFeeRawAmount !== undefined ? { platformFeeRawAmount } : {}),
    ...(platformFeeBps !== undefined ? { platformFeeBps } : {}),
    ...(quote.platformFee?.feeMint ? { platformFeeMint: quote.platformFee.feeMint } : {}),
    ...(Number.isSafeInteger(quote.contextSlot) ? { contextSlot: quote.contextSlot } : {}),
    ...(typeof quote.totalTime === "number" && Number.isFinite(quote.totalTime)
      ? { providerTimeMs: Math.max(0, Math.round(quote.totalTime)) }
      : typeof quote.timeTaken === "number" && Number.isFinite(quote.timeTaken)
        ? { providerTimeMs: Math.max(0, Math.round(quote.timeTaken * 1_000)) }
        : {}),
    httpLatencyMs: expected.httpLatencyMs,
    observedAt: new Date().toISOString(),
    raw: quote
  };
}

function optionalRawAmount(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = BigInt(value);
    if (parsed < 0n || parsed > U64_MAX) throw new Error("outside uint64");
    return parsed.toString();
  } catch {
    throw new JupiterQuoteIntegrityError(`Jupiter ${name} was invalid.`);
  }
}

function validOptionalBps(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  return boundedInteger(value, 0, 10_000, name);
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
