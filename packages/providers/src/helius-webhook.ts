import { fetchJson } from "./http";

export interface HeliusWebhookConfiguration {
  webhookID: string;
  webhookURL: string;
  transactionTypes: string[];
  accountAddresses: string[];
  webhookType: "enhanced" | "raw";
  authHeader?: string;
  active: boolean;
}

export interface HeliusWebhookAddressSyncResult {
  changed: boolean;
  addressCount: number;
  addedAddresses: string[];
  removedAddressCount: number;
}

export interface HeliusWebhookAddressClientOptions {
  apiKey: string;
  webhookId: string;
  webhookUrl: string;
  authHeader: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Keeps one enhanced Helius webhook aligned with the bounded active-pool set.
 * Updates are skipped when the normalized address set is unchanged because
 * webhook management calls consume credits independently from deliveries.
 */
export class HeliusWebhookAddressClient {
  private readonly apiBaseUrl: string;

  constructor(private readonly options: HeliusWebhookAddressClientOptions) {
    if (!options.apiKey.trim()) throw new Error("Helius webhook sync requires an API key.");
    if (!options.webhookId.trim()) throw new Error("Helius webhook sync requires HELIUS_WEBHOOK_ID.");
    if (!isHttpsUrl(options.webhookUrl)) {
      throw new Error("Helius webhook sync requires a public HTTPS webhook URL.");
    }
    if (!options.authHeader.trim()) {
      throw new Error("Helius webhook sync requires a non-empty auth header.");
    }
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api-mainnet.helius-rpc.com").replace(
      /\/$/,
      ""
    );
  }

  async get(): Promise<HeliusWebhookConfiguration> {
    return fetchJson<HeliusWebhookConfiguration>(
      "helius-webhooks",
      this.endpoint(),
      this.requestOptions()
    );
  }

  async syncAddresses(addresses: string[]): Promise<HeliusWebhookAddressSyncResult> {
    const desired = normalizedAddresses(addresses);
    if (desired.length === 0) {
      throw new Error("Refusing to update the Helius webhook with an empty address set.");
    }
    if (desired.length > 100_000) {
      throw new Error("Helius webhooks accept at most 100,000 account addresses.");
    }
    const current = await this.get();
    const existing = normalizedAddresses(current.accountAddresses ?? []);
    const existingSet = new Set(existing);
    const desiredSet = new Set(desired);
    const addedAddresses = desired.filter((address) => !existingSet.has(address));
    const removedAddressCount = existing.filter((address) => !desiredSet.has(address)).length;
    const configurationMatches =
      current.webhookURL === this.options.webhookUrl &&
      current.webhookType === "enhanced" &&
      // Some Helius responses omit the secret after creation. Treat an omitted
      // value as unchanged so the periodic sync does not spend credits forever.
      (current.authHeader === undefined || current.authHeader === this.options.authHeader) &&
      current.active !== false &&
      current.transactionTypes?.length === 1 &&
      current.transactionTypes[0] === "SWAP";
    if (addedAddresses.length === 0 && removedAddressCount === 0 && configurationMatches) {
      return { changed: false, addressCount: desired.length, addedAddresses, removedAddressCount };
    }

    await fetchJson<HeliusWebhookConfiguration>(
      "helius-webhooks",
      this.endpoint(),
      {
        ...this.requestOptions(),
        method: "PUT",
        body: {
          webhookURL: this.options.webhookUrl,
          transactionTypes: ["SWAP"],
          accountAddresses: desired,
          webhookType: "enhanced",
          authHeader: this.options.authHeader
        }
      }
    );
    return { changed: true, addressCount: desired.length, addedAddresses, removedAddressCount };
  }

  private endpoint(): string {
    return `${this.apiBaseUrl}/v0/webhooks/${encodeURIComponent(
      this.options.webhookId
    )}?api-key=${encodeURIComponent(this.options.apiKey)}`;
  }

  private requestOptions() {
    return {
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
      retries: 2,
      timeoutMs: 15_000
    };
  }
}

function normalizedAddresses(addresses: string[]): string[] {
  return [...new Set(addresses.map((address) => address.trim()).filter(Boolean))].sort();
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}
