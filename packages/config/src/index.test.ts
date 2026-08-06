import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "./index";

describe("loadRuntimeConfig", () => {
  it("keeps explicitly configured public Solana endpoints", () => {
    const config = loadRuntimeConfig({
      HELIUS_API_KEY: "test-key",
      SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com",
      SOLANA_WS_URL: "wss://api.mainnet-beta.solana.com",
      ENABLE_LIVE_EXECUTION: "false"
    });

    expect(config.solana.rpcUrl).toBe("https://api.mainnet-beta.solana.com");
    expect(config.solana.wsUrl).toBe("wss://api.mainnet-beta.solana.com");
  });

  it("does not spend Helius RPC credits merely because an API key is present", () => {
    const config = loadRuntimeConfig({ HELIUS_API_KEY: "test-key" });

    expect(config.solana.rpcUrl).toBe("https://api.mainnet-beta.solana.com");
    expect(config.solana.wsUrl).toBe("wss://api.mainnet-beta.solana.com");
  });

  it("keeps explicitly configured non-public Solana endpoints", () => {
    const config = loadRuntimeConfig({
      HELIUS_API_KEY: "test-key",
      SOLANA_RPC_URL: "https://example.com",
      SOLANA_WS_URL: "wss://example.com",
      ENABLE_LIVE_EXECUTION: "false"
    });

    expect(config.solana.rpcUrl).toBe("https://example.com");
    expect(config.solana.wsUrl).toBe("wss://example.com");
  });

  it("exposes resilient stream, quote-price and outbox defaults", () => {
    const config = loadRuntimeConfig({});

    expect(config.solana.ingestMode).toBe("rpc");
    expect(config.solana.transactionStreamEnabled).toBe(false);
    expect(config.solana.webhookSyncIntervalMinutes).toBe(15);
    expect(config.solana.webhookManagementEnabled).toBe(false);
    expect(config.solana.wsPingIntervalSeconds).toBe(60);
    expect(config.solana.maxAccountFilters).toBe(50_000);
    expect(config.quotePrices.pythHermesUrl).toBe("https://hermes.pyth.network");
    expect(config.quotePrices.maxStalenessSeconds).toBe(90);
    expect(config.alerts.outboxPollIntervalMs).toBe(2_000);
  });
});
