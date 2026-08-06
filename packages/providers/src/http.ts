export interface FetchJsonOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
}

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly provider: string,
    public readonly endpoint: string
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchJson<T>(
  provider: string,
  endpoint: string,
  options: FetchJsonOptions = {}
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 10_000;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const init: RequestInit = {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...options.headers
        },
        signal: controller.signal
      };
      if (options.body) init.body = JSON.stringify(options.body);

      const response = await fetchImpl(endpoint, init);

      if (response.ok) {
        return (await response.json()) as T;
      }

      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        await sleep(250 * 2 ** attempt);
        continue;
      }

      throw new ProviderHttpError(
        `Provider ${provider} returned ${response.status}`,
        response.status,
        provider,
        endpoint
      );
    } catch (error) {
      if (attempt < retries && !(error instanceof ProviderHttpError)) {
        await sleep(250 * 2 ** attempt);
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new ProviderHttpError(`Provider ${provider} retry budget exhausted`, 503, provider, endpoint);
}
