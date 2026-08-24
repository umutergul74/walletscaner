import "dotenv/config";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import pg from "pg";
import { loadRuntimeConfig } from "@memecoin-alpha/config";
import {
  PaperTradingStore,
  TelegramNotificationStore,
  type PaperPortfolioSnapshot,
  type QualifiedPoolPaperCandidate
} from "@memecoin-alpha/db";
import {
  QUALIFIED_POOL_PAPER_V3_STRATEGY_VERSION,
  calculatePaperPositionSize,
  decidePaperPosition,
  entrySlippageBps,
  exitSlippageBps,
  paperQualificationVersionForStrategy,
  rugAwarePaperConfigForVersion,
  validatePaperEntry,
  type PaperMarketSnapshot,
  type PaperPositionState
} from "@memecoin-alpha/paper-trading";
import { DexScreenerClient, type DexScreenerPair } from "@memecoin-alpha/providers";
import { round, type PaperTrade, type PaperTradeNotification } from "@memecoin-alpha/shared";

const runtime = loadRuntimeConfig();
const strategyVersion = requiredPaperStrategyVersion();
const strategy = rugAwarePaperConfigForVersion(strategyVersion);
const requiredQualificationVersion = requiredPaperQualificationVersion(strategyVersion);
const pool = new pg.Pool({ connectionString: runtime.databaseUrl, max: 2 });
const store = new PaperTradingStore(pool);
const notificationStore = new TelegramNotificationStore(pool);
const dexScreener = new DexScreenerClient(runtime.dexscreener.baseUrl);
const workerId = `${hostname()}:${process.pid}:rug-aware-paper`;
const pollIntervalMs = 30_000;
let stopping = false;
let lastHealthLogAt = 0;

function requiredPaperStrategyVersion(): typeof QUALIFIED_POOL_PAPER_V3_STRATEGY_VERSION {
  const configured = process.env.PAPER_STRATEGY_VERSION?.trim();
  if (configured !== QUALIFIED_POOL_PAPER_V3_STRATEGY_VERSION) {
    throw new Error(
      `PAPER_STRATEGY_VERSION must be exactly ${QUALIFIED_POOL_PAPER_V3_STRATEGY_VERSION}.`
    );
  }
  return configured;
}

function requiredPaperQualificationVersion(strategyVersion: string): string {
  const qualificationVersion = paperQualificationVersionForStrategy(strategyVersion);
  if (!qualificationVersion) {
    throw new Error(
      "The active paper strategy requires an explicit notification qualification version."
    );
  }
  return qualificationVersion;
}

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

const portfolio = await store.initializePortfolio({
  strategyVersion,
  startingBalanceUsd: strategy.startingBalanceUsd,
  config: strategy as unknown as Record<string, unknown>
});
await enqueuePortfolioStarted(await store.getPortfolioSnapshot(strategyVersion));

while (!stopping) {
  const cycleStartedAt = Date.now();
  try {
    const opened = await processNewCandidates();
    const managed = await manageOpenPositions();
    if (Date.now() - lastHealthLogAt >= 300_000) {
      const snapshot = await store.getPortfolioSnapshot(strategyVersion);
      console.log(
        JSON.stringify({
          type: "rug-aware-paper-health",
          workerId,
          strategyVersion,
          requiredQualificationVersion,
          activatedAt: portfolio.activatedAt,
          cashBalanceUsd: snapshot.cashBalanceUsd,
          openPositionCount: snapshot.openPositionCount,
          opened,
          managed,
          cycleDurationMs: Date.now() - cycleStartedAt
        })
      );
      lastHealthLogAt = Date.now();
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "rug-aware-paper-error",
        workerId,
        message: safeError(error)
      })
    );
  }
  await sleep(pollIntervalMs);
}

await pool.end();

async function processNewCandidates(): Promise<number> {
  const candidates = await store.listQualifiedPoolCandidates(
    strategyVersion,
    strategy.confirmationDelaySeconds,
    5,
    requiredQualificationVersion
  );
  let opened = 0;
  for (const candidate of candidates) {
    try {
      if (await processCandidate(candidate)) opened += 1;
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "paper-candidate-error",
          notificationId: candidate.notificationId,
          tokenAddress: candidate.payload.tokenAddress,
          message: safeError(error)
        })
      );
    }
  }
  return opened;
}

async function processCandidate(candidate: QualifiedPoolPaperCandidate): Promise<boolean> {
  if (!candidate.currentDiscoveryCoveragePassed) {
    return rejectCandidate(candidate, "discovery_coverage_unreconciled");
  }
  if (!candidate.currentRiskPassed) {
    return rejectCandidate(candidate, "current_token_risk_unknown_or_failed");
  }
  const currentPortfolio = await store.getPortfolioSnapshot(strategyVersion);
  if (currentPortfolio.openPositionCount >= strategy.maximumOpenPositions) {
    return rejectCandidate(candidate, "maximum_open_positions");
  }
  const pairs = await dexScreener.fetchTokenPairs("solana", candidate.payload.tokenAddress);
  const market = exactPoolSnapshot(pairs, candidate.payload.poolAddress);
  const rejection = validatePaperEntry({
    signalObservedAt: candidate.deliveredAt,
    signalLiquidityUsd: candidate.payload.liquidityUsd,
    snapshot: market,
    config: strategy
  });
  if (rejection) return rejectCandidate(candidate, rejection);

  const liquidityUsd = market.liquidityUsd;
  if (liquidityUsd === undefined) return rejectCandidate(candidate, "entry_liquidity_unknown");
  const positionSizeUsd = calculatePaperPositionSize({
    cashBalanceUsd: currentPortfolio.cashBalanceUsd,
    committedExposureUsd: currentPortfolio.committedExposureUsd,
    liquidityUsd,
    config: strategy
  });
  if (positionSizeUsd < 5) return rejectCandidate(candidate, "position_size_below_five_usd");

  const slippageBps = entrySlippageBps(positionSizeUsd, liquidityUsd, strategy);
  const fillPriceUsd = market.priceUsd * (1 + slippageBps / 10_000);
  const entryFeeUsd = positionSizeUsd * (strategy.feeBps / 10_000);
  const quantity = (positionSizeUsd - entryFeeUsd) / fillPriceUsd;
  const occurredAt = market.observedAt;
  const tradeId = stableId(`${strategyVersion}:${candidate.notificationId}`);
  const state: PaperPositionState = {
    initialQuantity: quantity,
    remainingQuantity: quantity,
    entryPriceUsd: fillPriceUsd,
    entryNotionalUsd: positionSizeUsd,
    entryLiquidityUsd: liquidityUsd,
    peakPriceUsd: fillPriceUsd,
    openedAt: occurredAt,
    stage: "initial",
    missingPairCount: 0,
    realizedProceedsUsd: 0
  };
  const trade: PaperTrade = {
    id: tradeId,
    strategyVersion,
    signalId: candidate.notificationId,
    chain: "solana",
    tokenAddress: candidate.payload.tokenAddress,
    side: "buy",
    status: "open",
    quantity: round(quantity, 12),
    priceUsd: round(fillPriceUsd, 12),
    notionalUsd: round(positionSizeUsd, 4),
    feesUsd: round(entryFeeUsd, 6),
    slippageBps,
    openedAt: occurredAt,
    reason: "qualified_pool_confirmed",
    raw: {
      sourceType: "qualified-pool",
      poolAddress: candidate.payload.poolAddress,
      tokenSymbol: candidate.payload.tokenSymbol,
      tokenName: candidate.payload.tokenName,
      signalDeliveredAt: candidate.deliveredAt,
      state,
      lastMarket: market
    }
  };
  if (!(await store.isQualifiedPoolCandidateCoverageEligible(candidate.notificationId))) {
    return rejectCandidate(candidate, "discovery_coverage_unreconciled");
  }
  const recorded = await store.recordTradeEvent(
    trade,
    {
      id: stableId(`${tradeId}:opened`),
      tradeId,
      strategyVersion,
      eventType: "opened",
      quantity,
      priceUsd: fillPriceUsd,
      grossValueUsd: positionSizeUsd - entryFeeUsd,
      feesUsd: entryFeeUsd,
      cashDeltaUsd: -positionSizeUsd,
      realizedPnlUsd: 0,
      slippageBps,
      liquidityUsd,
      occurredAt,
      reason: trade.reason,
      raw: { market, candidate: candidate.payload }
    },
    { qualificationVersion: requiredQualificationVersion }
  );
  if (!recorded) {
    if (!(await store.isQualifiedPoolCandidateCoverageEligible(candidate.notificationId))) {
      return rejectCandidate(candidate, "discovery_coverage_unreconciled");
    }
    return false;
  }
  const updatedPortfolio = await store.getPortfolioSnapshot(strategyVersion);
  await enqueueTradeNotification(
    `opened:${tradeId}`,
    notificationFromTrade("opened", trade, updatedPortfolio, {
      priceUsd: fillPriceUsd,
      quantity,
      notionalUsd: positionSizeUsd,
      liquidityUsd,
      reason: "Likidite ve aktivite doğrulandı; gerçekçi maliyetlerle paper alım açıldı."
    })
  );
  return true;
}

async function rejectCandidate(
  candidate: QualifiedPoolPaperCandidate,
  reason: string
): Promise<boolean> {
  await store.saveRejectedCandidate({
    id: stableId(`${strategyVersion}:${candidate.notificationId}:rejected`),
    strategyVersion,
    signalId: candidate.notificationId,
    tokenAddress: candidate.payload.tokenAddress,
    priceUsd: candidate.payload.priceUsd ?? 0,
    observedAt: new Date().toISOString(),
    reason,
    raw: {
      sourceType: "qualified-pool",
      poolAddress: candidate.payload.poolAddress,
      tokenSymbol: candidate.payload.tokenSymbol,
      candidate: candidate.payload
    }
  });
  console.log(
    JSON.stringify({
      type: "paper-candidate-rejected",
      notificationId: candidate.notificationId,
      tokenAddress: candidate.payload.tokenAddress,
      reason
    })
  );
  return false;
}

async function manageOpenPositions(): Promise<number> {
  const trades = await store.listOpenTrades(strategyVersion);
  if (trades.length === 0) return 0;
  const pairs = await dexScreener.fetchTokenPairsBatch(
    "solana",
    [...new Set(trades.map((trade) => trade.tokenAddress))].slice(0, 30)
  );
  let changed = 0;
  for (const trade of trades) {
    const state = readPositionState(trade);
    const poolAddress = readString(trade.raw?.poolAddress);
    if (!state || !poolAddress) {
      console.error(JSON.stringify({ type: "paper-state-invalid", tradeId: trade.id }));
      continue;
    }
    const tokenPairs = pairs.filter(
      (pair) =>
        pair.baseToken?.address === trade.tokenAddress ||
        pair.quoteToken?.address === trade.tokenAddress
    );
    const market = exactPoolSnapshot(tokenPairs, poolAddress);
    const decision = decidePaperPosition(state, market, strategy);
    if (decision.action === "hold") {
      await store.updateOpenTradeState(trade.id, {
        ...(trade.raw ?? {}),
        state: decision.state,
        lastMarket: market,
        lastDecisionReason: decision.reason
      });
      continue;
    }
    if (decision.action === "rugged") {
      if (await recordRuggedTrade(trade, decision.state, market, decision.reason)) changed += 1;
      continue;
    }
    if (
      await recordPaperSale(
        trade,
        decision.state,
        market,
        decision.fraction,
        decision.closeAfterFill,
        decision.reason
      )
    ) {
      changed += 1;
    }
  }
  return changed;
}

async function recordPaperSale(
  trade: PaperTrade,
  state: PaperPositionState,
  market: PaperMarketSnapshot,
  fraction: number,
  closeAfterFill: boolean,
  reason: string
): Promise<boolean> {
  const soldQuantity = closeAfterFill
    ? state.remainingQuantity
    : state.remainingQuantity * Math.max(0, Math.min(1, fraction));
  const grossMarketValueUsd = soldQuantity * market.priceUsd;
  const slippageBps = exitSlippageBps(
    grossMarketValueUsd,
    market.liquidityUsd,
    state.entryLiquidityUsd,
    strategy
  );
  const fillPriceUsd = market.priceUsd * (1 - slippageBps / 10_000);
  const grossValueUsd = soldQuantity * fillPriceUsd;
  const feeUsd = grossValueUsd * (strategy.feeBps / 10_000);
  const netProceedsUsd = grossValueUsd - feeUsd;
  const remainingQuantity = Math.max(0, state.remainingQuantity - soldQuantity);
  const realizedProceedsUsd = state.realizedProceedsUsd + netProceedsUsd;
  const closed = closeAfterFill || remainingQuantity <= state.initialQuantity * 0.000001;
  const totalPnlUsd = realizedProceedsUsd - state.entryNotionalUsd;
  const eventCostBasisUsd =
    state.entryNotionalUsd * (soldQuantity / Math.max(state.initialQuantity, Number.EPSILON));
  const occurredAt = market.observedAt;
  const nextState: PaperPositionState = {
    ...state,
    remainingQuantity: closed ? 0 : remainingQuantity,
    realizedProceedsUsd
  };
  const updated: PaperTrade = {
    ...trade,
    side: closed ? "sell" : "buy",
    status: closed ? "closed" : "open",
    quantity: round(nextState.remainingQuantity, 12),
    priceUsd: closed ? round(fillPriceUsd, 12) : trade.priceUsd,
    feesUsd: round(trade.feesUsd + feeUsd, 6),
    slippageBps,
    ...(closed ? { closedAt: occurredAt, pnlUsd: round(totalPnlUsd, 4) } : {}),
    reason,
    raw: {
      ...(trade.raw ?? {}),
      state: nextState,
      lastMarket: market,
      lastExitPriceUsd: fillPriceUsd
    }
  };
  const eventType = closed ? "closed" : "partial_exit";
  const eventId = stableId(`${trade.id}:${eventType}:${reason}:${readEventSequence(trade) + 1}`);
  updated.raw = { ...updated.raw, eventSequence: readEventSequence(trade) + 1 };
  const recorded = await store.recordTradeEvent(updated, {
    id: eventId,
    tradeId: trade.id,
    strategyVersion,
    eventType,
    quantity: soldQuantity,
    priceUsd: fillPriceUsd,
    grossValueUsd,
    feesUsd: feeUsd,
    cashDeltaUsd: netProceedsUsd,
    realizedPnlUsd: netProceedsUsd - eventCostBasisUsd,
    slippageBps,
    ...(market.liquidityUsd !== undefined ? { liquidityUsd: market.liquidityUsd } : {}),
    occurredAt,
    reason,
    raw: { market, remainingQuantity: nextState.remainingQuantity }
  });
  if (!recorded) return false;
  const currentPortfolio = await store.getPortfolioSnapshot(strategyVersion);
  await enqueueTradeNotification(
    `${eventType}:${eventId}`,
    notificationFromTrade(closed ? "closed" : "partial-exit", updated, currentPortfolio, {
      priceUsd: fillPriceUsd,
      quantity: soldQuantity,
      proceedsUsd: netProceedsUsd,
      pnlUsd: closed ? totalPnlUsd : netProceedsUsd - eventCostBasisUsd,
      returnPercent: (fillPriceUsd / state.entryPriceUsd - 1) * 100,
      ...(market.liquidityUsd !== undefined ? { liquidityUsd: market.liquidityUsd } : {}),
      reason
    })
  );
  return true;
}

async function recordRuggedTrade(
  trade: PaperTrade,
  state: PaperPositionState,
  market: PaperMarketSnapshot,
  reason: string
): Promise<boolean> {
  const remainingCostBasisUsd =
    state.entryNotionalUsd *
    (state.remainingQuantity / Math.max(state.initialQuantity, Number.EPSILON));
  const totalPnlUsd = state.realizedProceedsUsd - state.entryNotionalUsd;
  const occurredAt = market.observedAt;
  const eventSequence = readEventSequence(trade) + 1;
  const updated: PaperTrade = {
    ...trade,
    side: "sell",
    status: "closed",
    quantity: 0,
    priceUsd: 0,
    slippageBps: 10_000,
    closedAt: occurredAt,
    pnlUsd: round(totalPnlUsd, 4),
    reason,
    raw: {
      ...(trade.raw ?? {}),
      state: { ...state, remainingQuantity: 0 },
      lastMarket: market,
      terminalRisk: true,
      eventSequence
    }
  };
  const eventId = stableId(`${trade.id}:rugged:${reason}:${eventSequence}`);
  const recorded = await store.recordTradeEvent(updated, {
    id: eventId,
    tradeId: trade.id,
    strategyVersion,
    eventType: "rugged",
    quantity: state.remainingQuantity,
    priceUsd: 0,
    grossValueUsd: 0,
    feesUsd: 0,
    cashDeltaUsd: 0,
    realizedPnlUsd: -remainingCostBasisUsd,
    slippageBps: 10_000,
    ...(market.liquidityUsd !== undefined ? { liquidityUsd: market.liquidityUsd } : {}),
    occurredAt,
    reason,
    raw: { market }
  });
  if (!recorded) return false;
  const currentPortfolio = await store.getPortfolioSnapshot(strategyVersion);
  await enqueueTradeNotification(
    `rugged:${eventId}`,
    notificationFromTrade("rugged", updated, currentPortfolio, {
      priceUsd: 0,
      quantity: state.remainingQuantity,
      proceedsUsd: 0,
      pnlUsd: totalPnlUsd,
      returnPercent: -100,
      ...(market.liquidityUsd !== undefined ? { liquidityUsd: market.liquidityUsd } : {}),
      reason
    })
  );
  return true;
}

function exactPoolSnapshot(pairs: DexScreenerPair[], poolAddress: string): PaperMarketSnapshot {
  const observedAt = new Date().toISOString();
  const pair = pairs.find(
    (candidate) => candidate.pairAddress?.toLowerCase() === poolAddress.toLowerCase()
  );
  if (!pair) {
    return {
      observedAt,
      priceUsd: 0,
      volume5mUsd: 0,
      buys5m: 0,
      sells5m: 0,
      pairFound: false
    };
  }
  const priceUsd = Number(pair.priceUsd ?? 0);
  const liquidity = pair.liquidity?.usd;
  return {
    observedAt,
    priceUsd: Number.isFinite(priceUsd) ? priceUsd : 0,
    volume5mUsd: Number(pair.volume?.m5 ?? 0),
    buys5m: Number(pair.txns?.m5?.buys ?? 0),
    sells5m: Number(pair.txns?.m5?.sells ?? 0),
    pairFound: true,
    ...(liquidity !== undefined && Number.isFinite(liquidity)
      ? { liquidityUsd: Number(liquidity) }
      : {})
  };
}

function readPositionState(trade: PaperTrade): PaperPositionState | undefined {
  const state = trade.raw?.state;
  if (!state || typeof state !== "object") return undefined;
  const candidate = state as Record<string, unknown>;
  const stage = candidate.stage;
  if (stage !== "initial" && stage !== "capital_recovered" && stage !== "runner") {
    return undefined;
  }
  const parsed: PaperPositionState = {
    initialQuantity: Number(candidate.initialQuantity),
    remainingQuantity: Number(candidate.remainingQuantity),
    entryPriceUsd: Number(candidate.entryPriceUsd),
    entryNotionalUsd: Number(candidate.entryNotionalUsd),
    entryLiquidityUsd: Number(candidate.entryLiquidityUsd),
    peakPriceUsd: Number(candidate.peakPriceUsd),
    openedAt: String(candidate.openedAt),
    stage,
    missingPairCount: Number(candidate.missingPairCount),
    realizedProceedsUsd: Number(candidate.realizedProceedsUsd)
  };
  return Object.values(parsed).some((value) => typeof value === "number" && !Number.isFinite(value))
    ? undefined
    : parsed;
}

function notificationFromTrade(
  action: PaperTradeNotification["action"],
  trade: PaperTrade,
  portfolioSnapshot: PaperPortfolioSnapshot,
  details: Omit<
    PaperTradeNotification,
    | "action"
    | "strategyVersion"
    | "occurredAt"
    | "balanceUsd"
    | "startingBalanceUsd"
    | "openPositionCount"
    | "tokenAddress"
    | "tokenSymbol"
    | "poolAddress"
    | "tradeId"
  >
): PaperTradeNotification {
  return {
    action,
    strategyVersion,
    occurredAt: new Date().toISOString(),
    balanceUsd: portfolioSnapshot.cashBalanceUsd,
    startingBalanceUsd: portfolioSnapshot.startingBalanceUsd,
    openPositionCount: portfolioSnapshot.openPositionCount,
    tokenAddress: trade.tokenAddress,
    tokenSymbol: readString(trade.raw?.tokenSymbol) ?? shortAddress(trade.tokenAddress),
    poolAddress: readString(trade.raw?.poolAddress) ?? "",
    tradeId: trade.id,
    ...details
  };
}

async function enqueuePortfolioStarted(snapshot: PaperPortfolioSnapshot): Promise<void> {
  await enqueueTradeNotification(`portfolio-started:${strategyVersion}`, {
    action: "portfolio-started",
    strategyVersion,
    occurredAt: snapshot.activatedAt,
    balanceUsd: snapshot.cashBalanceUsd,
    startingBalanceUsd: snapshot.startingBalanceUsd,
    openPositionCount: snapshot.openPositionCount,
    reason: `Rug-aware paper simülasyonu aktif (${strategyVersion}). Gerçek emir, özel anahtar ve canlı sermaye kullanılmıyor.`
  });
}

async function enqueueTradeNotification(
  sourceKey: string,
  payload: PaperTradeNotification
): Promise<void> {
  await notificationStore.enqueuePaperTrade(sourceKey, payload);
}

function readEventSequence(trade: PaperTrade): number {
  return Number(trade.raw?.eventSequence ?? 0);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function shortAddress(address: string): string {
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
