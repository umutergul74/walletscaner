import { describe, expect, it, vi } from "vitest";
import { HeliusWebhookAddressClient } from "./helius-webhook";

describe("HeliusWebhookAddressClient", () => {
  it("skips paid management updates when the normalized configuration is unchanged", async () => {
    const fetchImpl = vi.fn(async () => response({
      webhookID: "webhook-1",
      webhookURL: "https://api.example.com/api/webhooks/helius",
      transactionTypes: ["SWAP"],
      accountAddresses: ["PoolB", "PoolA"],
      webhookType: "enhanced",
      authHeader: "secret",
      active: true
    }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.syncAddresses(["PoolA", "PoolB", "PoolA"])).resolves.toEqual({
      changed: false,
      addressCount: 2,
      addedAddresses: [],
      removedAddressCount: 0
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not spend update credits when Helius omits the stored auth secret", async () => {
    const fetchImpl = vi.fn(async () => response({
      webhookID: "webhook-1",
      webhookURL: "https://api.example.com/api/webhooks/helius",
      transactionTypes: ["SWAP"],
      accountAddresses: ["PoolA"],
      webhookType: "enhanced",
      active: true
    }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.syncAddresses(["PoolA"])).resolves.toMatchObject({ changed: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("updates the complete address set and reports additions", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response({
        webhookID: "webhook-1",
        webhookURL: "https://old.example.com/hook",
        transactionTypes: ["SWAP"],
        accountAddresses: ["PoolA", "OldPool"],
        webhookType: "enhanced",
        authHeader: "old-secret",
        active: true
      }))
      .mockResolvedValueOnce(response({ webhookID: "webhook-1", active: true }));
    const client = makeClient(fetchImpl as unknown as typeof fetch);

    await expect(client.syncAddresses(["PoolA", "PoolB"])).resolves.toEqual({
      changed: true,
      addressCount: 2,
      addedAddresses: ["PoolB"],
      removedAddressCount: 1
    });
    const update = fetchImpl.mock.calls[1]!;
    expect(update[0]).toContain("/v0/webhooks/webhook-1?api-key=api-key");
    expect(JSON.parse(String(update[1]?.body))).toMatchObject({
      webhookURL: "https://api.example.com/api/webhooks/helius",
      transactionTypes: ["SWAP"],
      accountAddresses: ["PoolA", "PoolB"],
      webhookType: "enhanced",
      authHeader: "secret"
    });
  });

  it("refuses empty address sets", async () => {
    const client = makeClient(vi.fn() as unknown as typeof fetch);
    await expect(client.syncAddresses([])).rejects.toThrow("empty address set");
  });
});

function makeClient(fetchImpl: typeof fetch) {
  return new HeliusWebhookAddressClient({
    apiKey: "api-key",
    webhookId: "webhook-1",
    webhookUrl: "https://api.example.com/api/webhooks/helius",
    authHeader: "secret",
    fetchImpl
  });
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
