import { createHash } from "node:crypto";
import { round, type BacktestMetrics, type BacktestRun, type Signal } from "@memecoin-alpha/shared";

export interface PricePoint {
  tokenAddress: string;
  observedAt: string;
  priceUsd: number;
  liquidityUsd: number;
  rugged?: boolean;
}

export interface ReplayConfig {
  strategyVersion: string;
  startingBalanceUsd: number;
  positionSizeUsd: number;
  maxOpenPositions: number;
  feeBps: number;
  slippageBps: number;
  providerLatencyMs: number;
  failedFillRate: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  timeExitMinutes: number;
  minimumLiquidityUsd: number;
}

interface PlannedTrade {
  signal: Signal;
  entry: PricePoint;
  exit: { point: PricePoint; reason: string };
}

interface SimulatedTrade {
  signalId: string;
  tokenAddress: string;
  enteredAt: string;
  exitedAt: string;
  entryPrice: number;
  exitPrice: number;
  positionSizeUsd: number;
  pnlUsd: number;
  returnPercent: number;
  holdMinutes: number;
  exitReason: string;
}

interface OpenTrade {
  planned: PlannedTrade;
  trade: SimulatedTrade;
  quantity: number;
  netExitValueUsd: number;
}

interface ReplayRejections {
  failedFill: number;
  noLiquidEntry: number;
  insufficientBalance: number;
  positionLimit: number;
}

interface EquityPoint {
  observedAt: string;
  equityUsd: number;
}

export function runHistoricalReplay(
  signals: Signal[],
  prices: PricePoint[],
  config: ReplayConfig,
  now = new Date().toISOString()
): BacktestRun {
  validateConfig(config);
  const sortedSignals = dedupeSignalsByToken(signals).sort(
    (a, b) => time(a.detectedAt) - time(b.detectedAt)
  );
  const sortedPrices = [...prices].sort((a, b) => time(a.observedAt) - time(b.observedAt));
  const plans = buildTradePlans(sortedSignals, sortedPrices, config);
  const trades: SimulatedTrade[] = [];
  const openTrades: OpenTrade[] = [];
  const firstHistoricalEventAt =
    [...plans.values()].map((plan) => plan.entry.observedAt).sort((a, b) => time(a) - time(b))[0] ??
    sortedSignals[0]?.detectedAt ??
    now;
  const equityCurve: EquityPoint[] = [
    { observedAt: firstHistoricalEventAt, equityUsd: config.startingBalanceUsd }
  ];
  const rejections: ReplayRejections = {
    failedFill: 0,
    noLiquidEntry: 0,
    insufficientBalance: 0,
    positionLimit: 0
  };
  let balanceUsd = config.startingBalanceUsd;

  for (const signal of sortedSignals) {
    if (!isEligibleSignal(signal, config.strategyVersion)) continue;
    if (deterministicFailure(signal.id, config.failedFillRate)) {
      rejections.failedFill += 1;
      continue;
    }
    const plan = plans.get(signal.id);
    if (!plan) {
      rejections.noLiquidEntry += 1;
      continue;
    }

    balanceUsd = closeDueTrades(
      openTrades,
      trades,
      equityCurve,
      balanceUsd,
      plan.entry.observedAt,
      sortedPrices,
      config
    );
    if (openTrades.length >= config.maxOpenPositions) {
      rejections.positionLimit += 1;
      continue;
    }
    if (balanceUsd < config.positionSizeUsd) {
      rejections.insufficientBalance += 1;
      continue;
    }

    const openTrade = simulateTrade(plan, config);
    balanceUsd -= config.positionSizeUsd;
    openTrades.push(openTrade);
    openTrades.sort((a, b) => time(a.trade.exitedAt) - time(b.trade.exitedAt));
    equityCurve.push({
      observedAt: plan.entry.observedAt,
      equityUsd: portfolioEquityUsd(
        balanceUsd,
        openTrades,
        plan.entry.observedAt,
        sortedPrices,
        config
      )
    });
  }

  for (const pending of [...openTrades]) {
    balanceUsd = closeDueTrades(
      openTrades,
      trades,
      equityCurve,
      balanceUsd,
      pending.trade.exitedAt,
      sortedPrices,
      config
    );
  }

  const metrics = calculateMetrics(
    trades,
    sortedSignals,
    rejections,
    equityCurve,
    balanceUsd,
    config
  );
  const dateStart = sortedSignals[0]?.detectedAt ?? now;
  const dateEnd =
    equityCurve[equityCurve.length - 1]?.observedAt ??
    sortedSignals[sortedSignals.length - 1]?.detectedAt ??
    now;
  const reportMarkdown = renderMarkdownReport(metrics, trades, rejections, config);

  return {
    id: createHash("sha256")
      .update(`${config.strategyVersion}:${dateStart}:${dateEnd}`)
      .digest("hex")
      .slice(0, 24),
    strategyVersion: config.strategyVersion,
    startedAt: now,
    finishedAt: now,
    dateStart,
    dateEnd,
    config: config as unknown as Record<string, unknown>,
    metrics,
    reportMarkdown
  };
}

export function exportBacktestCsv(run: BacktestRun): string {
  const rows = Object.entries(run.metrics).map(
    ([metric, value]) => `${metric},${JSON.stringify(value)}`
  );
  return ["metric,value", ...rows].join("\n");
}

export function exportBacktestJson(run: BacktestRun): string {
  return JSON.stringify(run, null, 2);
}

function buildTradePlans(
  signals: Signal[],
  prices: PricePoint[],
  config: ReplayConfig
): Map<string, PlannedTrade> {
  const plans = new Map<string, PlannedTrade>();
  for (const signal of signals) {
    if (!isEligibleSignal(signal, config.strategyVersion)) continue;
    const availableAt = time(signal.detectedAt) + config.providerLatencyMs;
    const path = prices.filter(
      (point) => point.tokenAddress === signal.tokenAddress && time(point.observedAt) >= availableAt
    );
    const entry = path.find(
      (point) => point.priceUsd > 0 && point.liquidityUsd >= config.minimumLiquidityUsd
    );
    if (!entry) continue;
    const entryPath = path.slice(path.indexOf(entry));
    const entryPrice = applyBuySlippage(entry.priceUsd, config.slippageBps);
    const maxExitAt = time(entry.observedAt) + config.timeExitMinutes * 60_000;
    plans.set(signal.id, {
      signal,
      entry,
      exit: chooseExit(entryPath, entryPrice, maxExitAt, config)
    });
  }
  return plans;
}

function simulateTrade(plan: PlannedTrade, config: ReplayConfig): OpenTrade {
  const entryPrice = applyBuySlippage(plan.entry.priceUsd, config.slippageBps);
  const forcedTotalLoss = ["rug", "liquidity_failure"].includes(plan.exit.reason);
  const exitPrice = forcedTotalLoss
    ? 0
    : applySellSlippage(plan.exit.point.priceUsd, config.slippageBps);
  const entryFeeUsd = config.positionSizeUsd * (config.feeBps / 10_000);
  const quantity = (config.positionSizeUsd - entryFeeUsd) / entryPrice;
  const grossExitValueUsd = quantity * exitPrice;
  const exitFeeUsd = grossExitValueUsd * (config.feeBps / 10_000);
  const netExitValueUsd = Math.max(0, grossExitValueUsd - exitFeeUsd);
  const pnlUsd = netExitValueUsd - config.positionSizeUsd;
  const holdMinutes = (time(plan.exit.point.observedAt) - time(plan.entry.observedAt)) / 60_000;
  const trade: SimulatedTrade = {
    signalId: plan.signal.id,
    tokenAddress: plan.signal.tokenAddress,
    enteredAt: plan.entry.observedAt,
    exitedAt: plan.exit.point.observedAt,
    entryPrice,
    exitPrice,
    positionSizeUsd: config.positionSizeUsd,
    pnlUsd,
    returnPercent: (pnlUsd / config.positionSizeUsd) * 100,
    holdMinutes,
    exitReason: plan.exit.reason
  };
  return { planned: plan, trade, quantity, netExitValueUsd };
}

function closeDueTrades(
  openTrades: OpenTrade[],
  trades: SimulatedTrade[],
  equityCurve: EquityPoint[],
  startingBalanceUsd: number,
  throughObservedAt: string,
  prices: PricePoint[],
  config: ReplayConfig
): number {
  let balanceUsd = startingBalanceUsd;
  const through = time(throughObservedAt);
  while (openTrades[0] && time(openTrades[0].trade.exitedAt) <= through) {
    const closed = openTrades.shift()!;
    balanceUsd += closed.netExitValueUsd;
    trades.push(closed.trade);
    equityCurve.push({
      observedAt: closed.trade.exitedAt,
      equityUsd: portfolioEquityUsd(balanceUsd, openTrades, closed.trade.exitedAt, prices, config)
    });
  }
  return balanceUsd;
}

function portfolioEquityUsd(
  balanceUsd: number,
  openTrades: OpenTrade[],
  observedAt: string,
  prices: PricePoint[],
  config: ReplayConfig
): number {
  return (
    balanceUsd +
    openTrades.reduce(
      (sum, openTrade) => sum + markOpenTradeUsd(openTrade, observedAt, prices, config),
      0
    )
  );
}

function markOpenTradeUsd(
  openTrade: OpenTrade,
  observedAt: string,
  prices: PricePoint[],
  config: ReplayConfig
): number {
  const entryTime = time(openTrade.trade.enteredAt);
  const markTime = time(observedAt);
  const latest = prices
    .filter(
      (point) =>
        point.tokenAddress === openTrade.trade.tokenAddress &&
        time(point.observedAt) >= entryTime &&
        time(point.observedAt) <= markTime
    )
    .at(-1);
  const mark = latest ?? openTrade.planned.entry;
  if (mark.rugged || mark.priceUsd <= 0 || mark.liquidityUsd < config.minimumLiquidityUsd) {
    return 0;
  }
  const liquidationPrice = applySellSlippage(mark.priceUsd, config.slippageBps);
  const grossValueUsd = openTrade.quantity * liquidationPrice;
  const liquidationFeeUsd = grossValueUsd * (config.feeBps / 10_000);
  return Math.max(0, grossValueUsd - liquidationFeeUsd);
}

function chooseExit(
  path: PricePoint[],
  entryPrice: number,
  maxExitAt: number,
  config: ReplayConfig
): { point: PricePoint; reason: string } {
  const stopPrice = entryPrice * (1 - config.stopLossPercent / 100);
  const takeProfitPrice = entryPrice * (1 + config.takeProfitPercent / 100);

  for (const point of path.slice(1)) {
    if (point.rugged || point.liquidityUsd <= 0) {
      return { point: { ...point, priceUsd: 0 }, reason: "rug" };
    }
    if (point.liquidityUsd < config.minimumLiquidityUsd) {
      return { point: { ...point, priceUsd: 0 }, reason: "liquidity_failure" };
    }
    if (point.priceUsd <= stopPrice) return { point, reason: "stop_loss" };
    if (point.priceUsd >= takeProfitPrice) {
      return { point, reason: "take_profit" };
    }
    if (time(point.observedAt) >= maxExitAt) {
      return { point, reason: "time_exit" };
    }
  }

  return { point: path[path.length - 1]!, reason: "end_of_data" };
}

function calculateMetrics(
  trades: SimulatedTrade[],
  signals: Signal[],
  rejections: ReplayRejections,
  equityCurve: EquityPoint[],
  finalBalanceUsd: number,
  config: ReplayConfig
): BacktestMetrics {
  const wins = trades.filter((trade) => trade.pnlUsd > 0);
  const losses = trades.filter((trade) => trade.pnlUsd <= 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnlUsd, 0));
  const returns = trades.map((trade) => trade.returnPercent).sort((a, b) => a - b);
  const drawdown = maxDrawdown(equityCurve);
  const totalRejected =
    rejections.failedFill +
    rejections.noLiquidEntry +
    rejections.insufficientBalance +
    rejections.positionLimit;

  return {
    totalPnlUsd: round(finalBalanceUsd - config.startingBalanceUsd),
    finalBalanceUsd: round(finalBalanceUsd),
    executedTradeCount: trades.length,
    rejectedSignalCount: totalRejected,
    capitalRejectedCount: rejections.insufficientBalance,
    positionLimitRejectedCount: rejections.positionLimit,
    failedFillCount: rejections.failedFill,
    winRate: round(wins.length / Math.max(trades.length, 1)),
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? 999 : 0) : round(grossWin / grossLoss),
    maxDrawdownUsd: round(drawdown.usd),
    maxDrawdownPercent: round(drawdown.percent),
    medianReturnPercent: round(medianValue(returns)),
    averageReturnPercent: round(
      returns.reduce((sum, value) => sum + value, 0) / Math.max(returns.length, 1)
    ),
    tailLossPercent: round(returns[Math.floor(returns.length * 0.05)] ?? 0),
    averageTimeInTradeMinutes: round(
      trades.reduce((sum, trade) => sum + trade.holdMinutes, 0) / Math.max(trades.length, 1)
    ),
    rugExposureRate: round(
      trades.filter((trade) => trade.exitReason === "rug").length / Math.max(trades.length, 1)
    ),
    liquidityFailureRate: round(
      (rejections.noLiquidEntry +
        trades.filter((trade) => trade.exitReason === "liquidity_failure").length) /
        Math.max(signals.length, 1)
    ),
    signalPrecisionByConfidence: precisionByBucket(signals, trades)
  };
}

function precisionByBucket(signals: Signal[], trades: SimulatedTrade[]): Record<string, number> {
  const winningSignalIds = new Set(
    trades.filter((trade) => trade.pnlUsd > 0).map((trade) => trade.signalId)
  );
  const buckets: Record<string, Signal[]> = {
    "0-49": [],
    "50-69": [],
    "70-84": [],
    "85-100": []
  };

  for (const signal of signals) {
    if (signal.confidence < 50) buckets["0-49"]!.push(signal);
    else if (signal.confidence < 70) buckets["50-69"]!.push(signal);
    else if (signal.confidence < 85) buckets["70-84"]!.push(signal);
    else buckets["85-100"]!.push(signal);
  }

  return Object.fromEntries(
    Object.entries(buckets).map(([bucket, bucketSignals]) => [
      bucket,
      round(
        bucketSignals.filter((signal) => winningSignalIds.has(signal.id)).length /
          Math.max(bucketSignals.length, 1)
      )
    ])
  );
}

function maxDrawdown(curve: EquityPoint[]): { usd: number; percent: number } {
  let peak = curve[0]?.equityUsd ?? 0;
  let maxUsd = 0;
  let maxPercent = 0;
  for (const point of curve) {
    peak = Math.max(peak, point.equityUsd);
    const drawdownUsd = Math.max(0, peak - point.equityUsd);
    maxUsd = Math.max(maxUsd, drawdownUsd);
    maxPercent = Math.max(maxPercent, peak > 0 ? (drawdownUsd / peak) * 100 : 0);
  }
  return { usd: maxUsd, percent: maxPercent };
}

function dedupeSignalsByToken(signals: Signal[]): Signal[] {
  const seen = new Set<string>();
  return [...signals]
    .sort((a, b) => time(a.detectedAt) - time(b.detectedAt))
    .filter((signal) => {
      const key = `${signal.chain}:${signal.tokenAddress}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function isEligibleSignal(signal: Signal, strategyVersion: string): boolean {
  return (
    signal.strategyVersion === strategyVersion &&
    ["paper-trade candidate", "research candidate"].includes(signal.actionCategory)
  );
}

function applyBuySlippage(price: number, bps: number): number {
  return price * (1 + bps / 10_000);
}

function applySellSlippage(price: number, bps: number): number {
  return price * (1 - bps / 10_000);
}

function deterministicFailure(signalId: string, failedFillRate: number): boolean {
  if (failedFillRate <= 0) return false;
  const hash = createHash("sha256").update(signalId).digest("hex");
  const bucket = Number.parseInt(hash.slice(0, 8), 16) / 0xffffffff;
  return bucket < failedFillRate;
}

function medianValue(values: number[]): number {
  if (values.length === 0) return 0;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 === 0 ? (values[middle - 1]! + values[middle]!) / 2 : values[middle]!;
}

function time(value: string): number {
  return new Date(value).getTime();
}

function validateConfig(config: ReplayConfig) {
  if (config.startingBalanceUsd <= 0) {
    throw new Error("startingBalanceUsd must be positive.");
  }
  if (config.positionSizeUsd <= 0) {
    throw new Error("positionSizeUsd must be positive.");
  }
  if (config.maxOpenPositions <= 0) {
    throw new Error("maxOpenPositions must be positive.");
  }
  if (config.positionSizeUsd > config.startingBalanceUsd) {
    throw new Error("positionSizeUsd cannot exceed startingBalanceUsd.");
  }
}

function renderMarkdownReport(
  metrics: BacktestMetrics,
  trades: SimulatedTrade[],
  rejections: ReplayRejections,
  config: ReplayConfig
): string {
  return [
    "# Backtest Report",
    "",
    `Strategy version: ${config.strategyVersion}`,
    `Trades: ${trades.length}`,
    `Rejected signals: ${metrics.rejectedSignalCount}`,
    `Capital rejections: ${rejections.insufficientBalance}`,
    `Position-limit rejections: ${rejections.positionLimit}`,
    `Final paper balance: $${metrics.finalBalanceUsd}`,
    `Total paper PnL: $${metrics.totalPnlUsd}`,
    `Win rate: ${round(metrics.winRate * 100)}%`,
    `Profit factor: ${metrics.profitFactor}`,
    `Max portfolio drawdown: ${metrics.maxDrawdownPercent}% ($${metrics.maxDrawdownUsd})`,
    "",
    "Signals are simulated research outputs, not financial advice."
  ].join("\n");
}
