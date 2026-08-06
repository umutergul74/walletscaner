import { fetchJson } from "./http";

interface PythParsedPrice {
  id?: string;
  price?: {
    price?: string;
    conf?: string;
    expo?: number;
    publish_time?: number;
  };
  metadata?: { slot?: number };
}

interface PythPriceResponse {
  parsed?: PythParsedPrice[];
}

export interface PythUsdQuote {
  feedId: string;
  priceUsd: number;
  confidenceUsd: number;
  confidenceRatio: number;
  publishTime: number;
  slot?: number;
  source: "pyth-hermes-latest" | "pyth-benchmarks";
  requestedTime?: number;
}

export interface PythPriceClientOptions {
  hermesUrl?: string;
  benchmarksUrl?: string;
  apiKey?: string;
  maxStalenessSeconds?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class PythPriceClient {
  private readonly hermesUrl: string;
  private readonly benchmarksUrl: string;
  private readonly maxStalenessSeconds: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(options: PythPriceClientOptions = {}) {
    this.hermesUrl = (options.hermesUrl ?? "https://hermes.pyth.network").replace(/\/$/, "");
    this.benchmarksUrl = (options.benchmarksUrl ?? "https://benchmarks.pyth.network").replace(/\/$/, "");
    this.maxStalenessSeconds = options.maxStalenessSeconds ?? 90;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.apiKey = options.apiKey;
  }

  private readonly apiKey: string | undefined;

  async latest(feedId: string): Promise<PythUsdQuote> {
    const url = new URL(`${this.hermesUrl}/v2/updates/price/latest`);
    url.searchParams.append("ids[]", normalizeFeedId(feedId));
    url.searchParams.set("parsed", "true");
    const response = await this.request(url);
    const quote = parseQuote(response, feedId, "pyth-hermes-latest");
    const ageSeconds = this.now().getTime() / 1_000 - quote.publishTime;
    if (ageSeconds < -5 || ageSeconds > this.maxStalenessSeconds) {
      throw new Error(`Pyth quote is stale by ${Math.round(ageSeconds)} seconds.`);
    }
    return quote;
  }

  async historical(feedId: string, timestamp: number, intervalSeconds = 60): Promise<PythUsdQuote> {
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
      throw new Error("Pyth historical timestamp must be a positive Unix second.");
    }
    if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 60) {
      throw new Error("Pyth historical interval must be between 1 and 60 seconds.");
    }
    // The interval endpoint returns an array containing one update per second.
    // This client needs one deterministic observation nearest transaction time,
    // so request the single-timestamp response and use intervalSeconds only as
    // the accepted publish-time window below.
    const url = new URL(`${this.benchmarksUrl}/v1/updates/price/${timestamp}`);
    url.searchParams.append("ids", normalizeFeedId(feedId));
    url.searchParams.set("parsed", "true");
    const response = await this.request(url);
    const quote = parseQuote(response, feedId, "pyth-benchmarks");
    if (quote.publishTime < timestamp || quote.publishTime > timestamp + intervalSeconds) {
      throw new Error("Pyth historical quote falls outside the requested interval.");
    }
    return { ...quote, requestedTime: timestamp };
  }

  async at(feedId: string, timestamp: number): Promise<PythUsdQuote> {
    const nowSeconds = Math.floor(this.now().getTime() / 1_000);
    return nowSeconds - timestamp <= this.maxStalenessSeconds
      ? this.latest(feedId)
      : this.historical(feedId, timestamp, 60);
  }

  private request(url: URL): Promise<PythPriceResponse> {
    return fetchJson<PythPriceResponse>("pyth", url.toString(), {
      headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
      fetchImpl: this.fetchImpl,
      retries: 2,
      timeoutMs: 10_000
    });
  }
}

function parseQuote(
  response: PythPriceResponse,
  expectedFeedId: string,
  source: PythUsdQuote["source"]
): PythUsdQuote {
  const parsed = response.parsed?.[0];
  const price = parsed?.price;
  if (!parsed || !price?.price || !price.conf || price.expo === undefined || !price.publish_time) {
    throw new Error("Pyth response is missing parsed price fields.");
  }
  const feedId = normalizeFeedId(parsed.id ?? "");
  if (feedId !== normalizeFeedId(expectedFeedId)) {
    throw new Error("Pyth response feed ID does not match the requested feed.");
  }
  const multiplier = 10 ** price.expo;
  const priceUsd = Number(price.price) * multiplier;
  const confidenceUsd = Number(price.conf) * multiplier;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0 || !Number.isFinite(confidenceUsd)) {
    throw new Error("Pyth response contains an invalid fixed-point price.");
  }
  return {
    feedId,
    priceUsd,
    confidenceUsd,
    confidenceRatio: confidenceUsd / priceUsd,
    publishTime: price.publish_time,
    ...(parsed.metadata?.slot !== undefined ? { slot: parsed.metadata.slot } : {}),
    source
  };
}

function normalizeFeedId(feedId: string): string {
  return feedId.toLowerCase().replace(/^0x/, "");
}
