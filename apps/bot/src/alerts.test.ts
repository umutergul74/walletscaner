import { describe, expect, it } from "vitest";
import {
  formatPaperTradeAlert,
  formatPipelineStatusAlert,
  formatQualifiedPoolAlert,
  formatWalletAlphaAlert
} from "./alerts";

describe("wallet alpha alerts", () => {
  it("formats a paper-only wallet alpha signal", () => {
    const message = formatWalletAlphaAlert({
      id: "signal-1",
      chain: "solana",
      tokenAddress: "Mint111",
      poolAddress: "Pool111",
      strategyVersion: "evidence-v2",
      detectedAt: "2026-07-11T00:00:00.000Z",
      observedPriceUsd: 0.001,
      observedLiquidityUsd: 25_000,
      confidence: 78,
      status: "paper-watch",
      walletAddresses: ["Wallet111"],
      evidence: { tokenRiskKnown: true, tokenRiskPassed: true }
    });
    expect(message).toContain("Wallet alpha paper-watch");
    expect(message).toContain("Live execution is disabled");
  });
});

describe("telegram operational alerts", () => {
  it("formats a qualified pool without calling it a trading signal", () => {
    const message = formatQualifiedPoolAlert({
      tokenAddress: "Mint111",
      poolAddress: "Pool111",
      tokenSymbol: "MEME",
      tokenName: "Meme Token",
      dex: "pump-amm",
      createdAt: "2026-07-16T00:00:00.000Z",
      liquidityUsd: 25_000,
      volume5mUsd: 8_000,
      priceUsd: 0.001,
      riskScore: 0,
      riskConfidence: 90
    });
    expect(message).toContain("Nitelikli yeni memtoken");
    expect(message).toContain("Likidite: $25,000");
    expect(message).toContain("Risk: geçti");
    expect(message).toContain("Canlı işlem kapalıdır");
  });

  it("formats a bounded pipeline status summary", () => {
    const message = formatPipelineStatusAlert({
      checkedAt: "2026-07-16T00:00:00.000Z",
      pipelineStatus: "ok",
      inboxBacklog: 0,
      deadLetters: 0,
      alphaQueuePending: 100,
      signals24h: 0,
      qualifiedPools24h: 3,
      lastPoolAgeSeconds: 4,
      lastWalletTradeAgeSeconds: 12,
      databaseBytes: 10 * 1024 ** 3
    });
    expect(message).toContain("Walletscaner durum: OK");
    expect(message).toContain("Inbox backlog / dead-letter: 0 / 0");
    expect(message).toContain("Veritabanı: 10.00 GiB");
  });

  it("formats a paper fill with balance and no live-trading implication", () => {
    const message = formatPaperTradeAlert({
      action: "opened",
      strategyVersion: "qualified-pool-paper-v1",
      occurredAt: "2026-07-16T12:00:00.000Z",
      balanceUsd: 88,
      startingBalanceUsd: 100,
      openPositionCount: 1,
      tokenAddress: "Mint111",
      tokenSymbol: "MEME",
      poolAddress: "Pool111",
      tradeId: "trade-1",
      priceUsd: 0.001,
      quantity: 10_000,
      notionalUsd: 12,
      liquidityUsd: 20_000,
      reason: "qualified_pool_confirmed"
    });
    expect(message).toContain("PAPER ALIM");
    expect(message).toContain("Nakit: $88");
    expect(message).toContain("gerçek emir gönderilmedi");
  });
});
