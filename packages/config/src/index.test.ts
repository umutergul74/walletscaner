import { describe, expect, it } from "vitest";
import { loadArchiveRuntimeConfig, loadRuntimeConfig } from "./index";

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
    expect(config.alerts.qualifiedPoolDeliveryMode).toBe("notify");
    expect(
      loadRuntimeConfig({ QUALIFIED_POOL_DELIVERY_MODE: "shadow" }).alerts.qualifiedPoolDeliveryMode
    ).toBe("shadow");
  });
});

describe("loadArchiveRuntimeConfig", () => {
  it("is disabled by default without requiring archive credentials", () => {
    expect(loadArchiveRuntimeConfig("writer", {})).toEqual({ enabled: false, role: "writer" });
  });

  it("loads only the credential pair required by the selected role", () => {
    const common = {
      ARCHIVE_ENABLED: "true",
      ARCHIVE_ENDPOINT: "https://s3.example.invalid",
      ARCHIVE_REGION: "test-region-1",
      ARCHIVE_BUCKET: "walletscaner",
      ARCHIVE_PREFIX: "walletscanner-prod",
      ARCHIVE_OBJECT_LOCK_EVIDENCE_MODE: "attested-default-policy",
      ARCHIVE_OBJECT_LOCK_DEFAULT_MODE: "GOVERNANCE",
      ARCHIVE_OBJECT_LOCK_DEFAULT_DAYS: "30"
    };
    const writer = loadArchiveRuntimeConfig("writer", {
      ...common,
      ARCHIVE_WRITE_ACCESS_KEY_ID: "writer-id",
      ARCHIVE_WRITE_SECRET_ACCESS_KEY: "writer-secret"
    });
    const verifier = loadArchiveRuntimeConfig("verifier", {
      ...common,
      ARCHIVE_READ_ACCESS_KEY_ID: "reader-id",
      ARCHIVE_READ_SECRET_ACCESS_KEY: "reader-secret"
    });

    expect(writer).toMatchObject({ enabled: true, role: "writer", accessKeyId: "writer-id" });
    expect(verifier).toMatchObject({ enabled: true, role: "verifier", accessKeyId: "reader-id" });
    expect(writer).toMatchObject({ maxSegmentsPerRun: 1, maxRunSeconds: 7_200 });
    expect(verifier).toMatchObject({
      objectLockEvidenceMode: "attested-default-policy",
      objectLockDefaultMode: "GOVERNANCE",
      objectLockDefaultDays: 30
    });
    expect(writer).not.toHaveProperty("readAccessKeyId");
    expect(verifier).not.toHaveProperty("writeAccessKeyId");
  });

  it("fails closed when an enabled role lacks its credentials", () => {
    expect(() =>
      loadArchiveRuntimeConfig("writer", {
        ARCHIVE_ENABLED: "true",
        ARCHIVE_ENDPOINT: "https://s3.example.invalid",
        ARCHIVE_REGION: "test-region-1",
        ARCHIVE_BUCKET: "walletscaner"
      })
    ).toThrow("Archive writer credentials are missing");
  });
});
