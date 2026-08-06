import { createHash } from "node:crypto";
import { round, type PaperTrade, type RuntimeThresholds, type Signal } from "@memecoin-alpha/shared";

export interface PaperPortfolio {
  strategyVersion: string;
  balanceUsd: number;
  openTrades: PaperTrade[];
  closedTrades: PaperTrade[];
}

export interface PaperFillInput {
  signal: Signal;
  priceUsd: number;
  observedAt?: string;
  slippageBps?: number;
  feeBps?: number;
}

export function createPaperPortfolio(
  balanceUsd: number,
  strategyVersion = "evidence-v1"
): PaperPortfolio {
  return {
    strategyVersion,
    balanceUsd,
    openTrades: [],
    closedTrades: []
  };
}

export function tryOpenPaperTrade(
  portfolio: PaperPortfolio,
  input: PaperFillInput,
  thresholds: RuntimeThresholds
): PaperTrade {
  const now = input.observedAt ?? new Date().toISOString();

  if (input.signal.actionCategory !== "paper-trade candidate") {
    return rejectedTrade(input, now, "Signal is not a paper-trade candidate.");
  }
  if (input.signal.strategyVersion !== portfolio.strategyVersion) {
    return rejectedTrade(input, now, "Signal strategy version does not match the paper portfolio.");
  }
  if (portfolio.openTrades.length >= thresholds.maxOpenPaperPositions) {
    return rejectedTrade(input, now, "Maximum open paper positions reached.");
  }
  if (portfolio.balanceUsd < thresholds.paperPositionSizeUsd) {
    return rejectedTrade(input, now, "Insufficient simulated balance.");
  }
  if (input.priceUsd <= 0) {
    return rejectedTrade(input, now, "Invalid entry price.");
  }

  const slippageBps = input.slippageBps ?? 100;
  const feeBps = input.feeBps ?? 30;
  const fillPrice = input.priceUsd * (1 + slippageBps / 10_000);
  const notionalUsd = thresholds.paperPositionSizeUsd;
  const feesUsd = notionalUsd * (feeBps / 10_000);
  const quantity = (notionalUsd - feesUsd) / fillPrice;
  const trade: PaperTrade = {
    id: tradeId(input.signal.id, now),
    strategyVersion: input.signal.strategyVersion,
    signalId: input.signal.id,
    chain: input.signal.chain,
    tokenAddress: input.signal.tokenAddress,
    side: "buy",
    status: "open",
    quantity: round(quantity, 8),
    priceUsd: round(fillPrice, 10),
    notionalUsd,
    feesUsd: round(feesUsd, 4),
    slippageBps,
    openedAt: now,
    reason: "Opened from explainable signal in paper trading mode."
  };

  portfolio.balanceUsd = round(portfolio.balanceUsd - notionalUsd);
  portfolio.openTrades.push(trade);
  return trade;
}

export function markToMarketAndClose(
  portfolio: PaperPortfolio,
  tradeIdToClose: string,
  priceUsd: number,
  thresholds: RuntimeThresholds,
  observedAt = new Date().toISOString(),
  feeBps = 30,
  slippageBps = 100
): PaperTrade | undefined {
  const index = portfolio.openTrades.findIndex((trade) => trade.id === tradeIdToClose);
  if (index < 0) return undefined;

  const trade = portfolio.openTrades[index]!;
  const exitPrice = priceUsd * (1 - slippageBps / 10_000);
  const grossExitValue = trade.quantity * exitPrice;
  const feesUsd = grossExitValue * (feeBps / 10_000);
  const pnlUsd = grossExitValue - feesUsd - trade.notionalUsd;
  const returnPercent = (pnlUsd / trade.notionalUsd) * 100;
  const holdMinutes = (new Date(observedAt).getTime() - new Date(trade.openedAt).getTime()) / 60_000;
  const reason =
    returnPercent <= -thresholds.stopLossPercent
      ? "stop_loss"
      : returnPercent >= thresholds.takeProfitPercent
        ? "take_profit"
        : holdMinutes >= thresholds.timeExitMinutes
          ? "time_exit"
          : "manual_close";

  const closed: PaperTrade = {
    ...trade,
    status: "closed",
    side: "sell",
    priceUsd: round(exitPrice, 10),
    feesUsd: round(trade.feesUsd + feesUsd, 4),
    closedAt: observedAt,
    pnlUsd: round(pnlUsd, 4),
    reason
  };

  portfolio.openTrades.splice(index, 1);
  portfolio.closedTrades.push(closed);
  portfolio.balanceUsd = round(portfolio.balanceUsd + grossExitValue - feesUsd);
  return closed;
}

function rejectedTrade(input: PaperFillInput, observedAt: string, reason: string): PaperTrade {
  return {
    id: tradeId(input.signal.id, observedAt),
    strategyVersion: input.signal.strategyVersion,
    signalId: input.signal.id,
    chain: input.signal.chain,
    tokenAddress: input.signal.tokenAddress,
    side: "buy",
    status: "rejected",
    quantity: 0,
    priceUsd: input.priceUsd,
    notionalUsd: 0,
    feesUsd: 0,
    slippageBps: input.slippageBps ?? 0,
    openedAt: observedAt,
    reason
  };
}

function tradeId(signalId: string, observedAt: string): string {
  return createHash("sha256").update(`${signalId}:${observedAt}`).digest("hex").slice(0, 24);
}
