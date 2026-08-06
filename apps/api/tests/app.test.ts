import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadRuntimeConfig } from "@memecoin-alpha/config";
import { MemoryRepository } from "@memecoin-alpha/db";
import type { WalletAlphaScoreSnapshot, WalletAlphaSignalEvidence } from "@memecoin-alpha/shared";
import { createApp, createRepository } from "../src/app";

describe("api", () => {
  const config = loadRuntimeConfig({
    NODE_ENV: "test",
    HELIUS_WEBHOOK_AUTH_HEADER: "test-helius-secret"
  });
  const repository = MemoryRepository.seeded(config.thresholds);
  const app = createApp({ config, repository });
  const alphaScore: WalletAlphaScoreSnapshot = {
    chain: "solana",
    walletAddress: "AlphaWallet111",
    strategyVersion: "wallet-alpha-v2",
    calculatedAt: "2026-07-11T10:00:00.000Z",
    status: "candidate",
    profitabilityScore: 82,
    followabilityScore: 78,
    overallScore: 80,
    completedPositions: 18,
    uniqueTokens: 12,
    activeDays: 8,
    metrics: {
      completedPositions: 18,
      eligibleEarlyPositions: 16,
      uniqueTokens: 12,
      activeDays: 8,
      exactPositionCount: 17,
      estimatedPositionCount: 1,
      profitability: returnMetrics(18),
      followability: returnMetrics(16),
      profitabilityHoldoutsPassed: false,
      followabilityHoldoutsPassed: false,
      directCreator: false
    },
    gates: { observed: true, watch: true, candidate: true, validatedPaper: false },
    reasons: ["Candidate gates passed"]
  };
  const alphaSignal: WalletAlphaSignalEvidence = {
    id: "alpha-signal-1",
    chain: "solana",
    tokenAddress: "TokenAlpha111",
    strategyVersion: "wallet-alpha-v2",
    detectedAt: "2026-07-11T10:01:00.000Z",
    observedPriceUsd: 0.001,
    observedLiquidityUsd: 50_000,
    confidence: 80,
    status: "paper-candidate",
    walletAddresses: [alphaScore.walletAddress],
    evidence: { source: "test" }
  };

  beforeAll(async () => {
    await repository.saveWalletAlphaScore(alphaScore);
    await repository.saveWalletAlphaSignal(alphaSignal);
  });

  it("serves health", async () => {
    const response = await request(app).get("/health").expect(200);
    expect(response.body.liveExecutionEnabled).toBe(false);
  });

  it("serves seeded signals", async () => {
    const response = await request(app).get("/api/signals").expect(200);
    expect(response.body.data.length).toBeGreaterThan(0);
  });

  it("normalizes helius webhooks", async () => {
    const response = await request(app)
      .post("/api/webhooks/helius")
      .set("x-helius-auth", "test-helius-secret")
      .send([
        {
          signature: "sig",
          tokenTransfers: [{ mint: "Mint" }],
          events: { swap: { tokenOutputs: [{ mint: "Mint", tokenAmount: 1 }] } }
        }
      ])
      .expect(200);

    expect(response.body.accepted).toBe(1);
    expect(response.body.duplicates).toBe(0);
    const claimed = await repository.claimChainEvents({ workerId: "api-test", limit: 10 });
    expect(claimed).toEqual([
      expect.objectContaining({
        idempotencyKey: "helius:swap:sig",
        status: "processing",
        source: "helius-webhook"
      })
    ]);
    expect(await repository.completeChainEvent(claimed[0]!.idempotencyKey, "api-test")).toBe(true);

    const duplicate = await request(app)
      .post("/api/webhooks/helius")
      .set("x-helius-auth", "test-helius-secret")
      .send([
        {
          signature: "sig",
          tokenTransfers: [{ mint: "Mint" }],
          events: { swap: { tokenOutputs: [{ mint: "Mint", tokenAmount: 1 }] } }
        }
      ])
      .expect(200);
    expect(duplicate.body).toMatchObject({ accepted: 0, duplicates: 1 });
  });

  it("rejects unauthenticated helius webhooks", async () => {
    await request(app)
      .post("/api/webhooks/helius")
      .send([{ signature: "unauthorized", tokenTransfers: [{ mint: "Mint" }] }])
      .expect(401);
  });

  it("serves wallet-alpha rankings, details and signals", async () => {
    const rankings = await request(app)
      .get("/api/wallet-alpha/rankings?status=candidate")
      .expect(200);
    expect(rankings.body.data).toEqual([
      expect.objectContaining({ walletAddress: "AlphaWallet111" })
    ]);

    const detail = await request(app).get("/api/wallets/AlphaWallet111/alpha").expect(200);
    expect(detail.body.data).toMatchObject({
      walletAddress: "AlphaWallet111",
      latestScore: { status: "candidate" }
    });

    const signals = await request(app)
      .get("/api/wallet-alpha/signals?status=paper-candidate")
      .expect(200);
    expect(signals.body.data).toEqual([expect.objectContaining({ id: "alpha-signal-1" })]);
  });

  it("serves canonical pipeline health", async () => {
    const healthSpy = vi.spyOn(repository, "getPipelineHealth");
    const response = await request(app).get("/api/pipeline/health").expect(200);
    expect(response.body.data).toMatchObject({
      database: "ok",
      inbox: { processed: 1, dead_letter: 0 },
      backlog: 0,
      watermarkCount: expect.any(Number)
    });
    await request(app).get("/api/pipeline/health").expect(200);
    expect(healthSpy).toHaveBeenCalledTimes(1);
  });

  it("creates independent paper and alert outbox deliveries", async () => {
    const paper = await repository.claimSignalOutbox({
      destination: "paper",
      workerId: "paper-test"
    });
    const alert = await repository.claimSignalOutbox({
      destination: "alert",
      workerId: "alert-test"
    });
    expect(paper).toEqual([expect.objectContaining({ signalId: "alpha-signal-1" })]);
    expect(alert).toEqual([expect.objectContaining({ signalId: "alpha-signal-1" })]);
    expect(await repository.completeSignalOutbox(paper[0]!.id, "paper-test")).toBe(true);
    expect(await repository.completeSignalOutbox(alert[0]!.id, "alert-test")).toBe(true);
  });

  it("refuses the in-memory repository outside test/demo", () => {
    vi.stubEnv("REPOSITORY_MODE", "memory");
    expect(() => createRepository(loadRuntimeConfig({ NODE_ENV: "production" }))).toThrow(
      "restricted to NODE_ENV=test or NODE_ENV=demo"
    );
    vi.unstubAllEnvs();
  });
});

function returnMetrics(sampleCount: number) {
  return {
    sampleCount,
    averageReturnPct: 20,
    medianReturnPct: 8,
    averageReturnExBestPct: 10,
    bestWinnerShare: 0.3,
    hitRate: 0.6,
    profitFactor: 1.4,
    worstReturnPct: -20,
    maxDrawdownPct: 15
  };
}
