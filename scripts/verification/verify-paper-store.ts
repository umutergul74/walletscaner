import "dotenv/config";
import { createHash } from "node:crypto";
import pg from "pg";
import { PaperTradingStore } from "@memecoin-alpha/db";
import type { PaperTrade } from "@memecoin-alpha/shared";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const store = new PaperTradingStore(pool);
const strategyVersion = `paper-store-verification-${Date.now()}`;
const activatedAt = new Date(Date.now() - 60_000).toISOString();
const deliveredAt = new Date(Date.now() - 30_000).toISOString();
const tokenAddress = "PaperVerificationMint111";
const poolAddress = "PaperVerificationPool111";
const notificationId = stableId(`${strategyVersion}:notification`);
const tradeId = stableId(`${strategyVersion}:trade`);

try {
  await store.initializePortfolio({
    strategyVersion,
    startingBalanceUsd: 100,
    activatedAt,
    config: { verification: true }
  });
  await pool.query(
    `INSERT INTO token_risk_assessments (
       chain, token_address, calculated_at, score, risk_score, confidence,
       sub_scores, reasons, warnings
     )
     VALUES ('solana', $1, NOW(), 100, 0, 90, '{}', '["passed"]', '[]')`,
    [tokenAddress]
  );
  await pool.query(
    `INSERT INTO telegram_notification_outbox (
       id, event_type, source_key, payload, status, delivered_at
     )
     VALUES (
       $1, 'qualified-pool', $2, $3::jsonb, 'delivered', $4
     )`,
    [
      notificationId,
      poolAddress,
      JSON.stringify({
        tokenAddress,
        poolAddress,
        tokenSymbol: "VERIFY",
        tokenName: "Paper Verification",
        dex: "verification",
        createdAt: activatedAt,
        liquidityUsd: 20_000,
        volume5mUsd: 8_000,
        priceUsd: 0.001,
        riskScore: 0,
        riskConfidence: 90
      }),
      deliveredAt
    ]
  );
  const candidates = await store.listQualifiedPoolCandidates(strategyVersion, 0, 5);
  if (candidates.length !== 1 || !candidates[0]?.currentRiskPassed) {
    throw new Error("Expected one currently risk-passed paper candidate.");
  }

  const trade: PaperTrade = {
    id: tradeId,
    strategyVersion,
    signalId: notificationId,
    chain: "solana",
    tokenAddress,
    side: "buy",
    status: "open",
    quantity: 10_000,
    priceUsd: 0.001,
    notionalUsd: 12,
    feesUsd: 0.036,
    slippageBps: 150,
    openedAt: new Date().toISOString(),
    reason: "verification",
    raw: { poolAddress }
  };
  const event = {
    id: stableId(`${tradeId}:opened`),
    tradeId,
    strategyVersion,
    eventType: "opened" as const,
    quantity: 10_000,
    priceUsd: 0.001,
    grossValueUsd: 11.964,
    feesUsd: 0.036,
    cashDeltaUsd: -12,
    realizedPnlUsd: 0,
    slippageBps: 150,
    liquidityUsd: 20_000,
    occurredAt: new Date().toISOString(),
    reason: "verification"
  };
  if (!(await store.recordTradeEvent(trade, event))) {
    throw new Error("First paper event was not recorded.");
  }
  if (await store.recordTradeEvent(trade, event)) {
    throw new Error("Duplicate paper event was recorded twice.");
  }
  const snapshot = await store.getPortfolioSnapshot(strategyVersion);
  if (snapshot.cashBalanceUsd !== 88 || snapshot.openPositionCount !== 1) {
    throw new Error(
      `Unexpected portfolio snapshot: cash=${snapshot.cashBalanceUsd}, open=${snapshot.openPositionCount}.`
    );
  }
  console.log(
    JSON.stringify({
      type: "paper-store-verification",
      status: "passed",
      cashBalanceUsd: snapshot.cashBalanceUsd,
      openPositionCount: snapshot.openPositionCount,
      duplicateEventSuppressed: true,
      currentRiskRevalidated: true
    })
  );
} finally {
  await pool.end();
}

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
