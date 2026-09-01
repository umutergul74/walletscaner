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
    expect(message).toContain("Yeni token araştırma adayı");
    expect(message).toContain("Likidite: $25,000");
    expect(message).toContain("Token risk skoru: 0/100 (düşük daha iyi)");
    expect(message).toContain("kâr olasılığı değildir");
    expect(message).toContain("Canlı işlem kapalıdır");
  });

  it("explains strict-flow evidence without presenting it as proven alpha", () => {
    const message = formatQualifiedPoolAlert({
      qualificationVersion: "strict-flow-v2-20260817",
      tokenAddress: "MintStrict111",
      poolAddress: "PoolStrict111",
      tokenSymbol: "STRICT",
      tokenName: "Strict Token",
      dex: "pumpswap",
      createdAt: "2026-08-17T00:00:00.000Z",
      liquidityUsd: 25_000,
      volume5mUsd: 8_000,
      riskScore: 0,
      riskConfidence: 90,
      poolAgeMinutes: 5.4,
      buys5m: 11,
      sells5m: 9,
      transactions5m: 20,
      buyShare5m: 0.55,
      volumeLiquidityRatio: 0.32,
      top10HolderPercent: 18,
      tradeCoverageComplete: true
    });
    expect(message).toContain("Sıkı filtreyi geçen yeni token adayı");
    expect(message).toContain("5 dk akış: 11 alış / 9 satış");
    expect(message).toContain("Top-10 holder yoğunluğu: 18.0%");
    expect(message).toContain("kanıtlanmış alpha");
  });

  it("formats a bounded pipeline status summary", () => {
    const message = formatPipelineStatusAlert({
      checkedAt: "2026-07-16T00:00:00.000Z",
      pipelineStatus: "ok",
      inboxBacklog: 0,
      deadLetters: 0,
      alphaQueuePending: 100,
      alphaQueueDeferred: 12_345,
      alphaQueueUnchecked: 0,
      signals24h: 0,
      qualifiedPools24h: 3,
      lastPoolAgeSeconds: 4,
      lastWalletTradeAgeSeconds: 12,
      databaseBytes: 10 * 1024 ** 3,
      operationalHealth: {
        checkedAt: "2026-07-16T00:00:00.000Z",
        status: "degraded",
        reasons: ["1 wallet compact operational retry days"],
        walletCompactMismatchDays: 0,
        walletCompactRetryDays: 1
      }
    });
    expect(message).toContain("Walletscaner durum: OK");
    expect(message).toContain("Inbox backlog / dead-letter: 0 / 0");
    expect(message).toContain("Alpha pending / deferred / unchecked: 100 / 12,345 / 0");
    expect(message).toContain("Açık discovery coverage incident: 0");
    expect(message).toContain("Veritabanı: 10.00 GiB");
    expect(message).toContain("Wallet compact geçici işlem hatası: 1");
    expect(message).not.toContain("Wallet compact parity hatası");
  });

  it("formats coverage incident and recovery transitions without claiming gap completion", () => {
    const base = {
      checkedAt: "2026-08-21T00:01:00.000Z",
      pipelineStatus: "degraded" as const,
      inboxBacklog: 0,
      deadLetters: 0,
      alphaQueuePending: 0,
      signals24h: 0,
      qualifiedPools24h: 0,
      databaseBytes: 10 * 1024 ** 3,
      openCoverageIncidentCount: 1
    };
    const incident = {
      incidentId: "incident-1",
      programAddress: "ProgramCoverage111",
      provider: "solana-rpc-discovery",
      reason: "head_slot_lag",
      gapStartedAt: "2026-08-21T00:00:00.000Z",
      openedAt: "2026-08-21T00:01:00.000Z",
      transition: "opened" as const,
      transitionAt: "2026-08-21T00:01:00.000Z",
      clusterSlot: 1_000,
      sourceSlot: 700,
      slotLag: 300,
      coverageDisposition: "alpha_excluded_unreconciled" as const
    };
    const opened = formatPipelineStatusAlert({ ...base, coverageTransition: incident });
    expect(opened).toContain("Program: ProgramCoverage111");
    expect(opened).toContain("Gap başlangıcı: 2026-08-21T00:00:00.000Z");
    expect(opened).toContain("alpha coverage dışıdır");

    const recovered = formatPipelineStatusAlert({
      ...base,
      pipelineStatus: "ok",
      openCoverageIncidentCount: 0,
      coverageTransition: {
        ...incident,
        transition: "transport-recovered",
        transitionAt: "2026-08-21T00:03:00.000Z"
      }
    });
    expect(recovered).toContain("transportu yeniden sağlıklı");
    expect(recovered).toContain("kayıtlı gap complete sayılmadı");

    const reconciled = formatPipelineStatusAlert({
      ...base,
      pipelineStatus: "ok",
      openCoverageIncidentCount: 0,
      coverageTransition: {
        ...incident,
        transition: "coverage-reconciled",
        transitionAt: "2026-08-21T00:04:00.000Z",
        coverageDisposition: "reconciled"
      }
    });
    expect(reconciled).toContain("gap'i doğrulanarak onarıldı");
    expect(reconciled).toContain("oldest-first replay");
    expect(reconciled).toContain("coverage açısından uzlaştırıldı");
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
