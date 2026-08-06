import { writeFile, mkdir } from "node:fs/promises";
import { loadRuntimeConfig } from "@memecoin-alpha/config";
import { buildSampleSignal } from "@memecoin-alpha/core";
import { exportBacktestCsv, exportBacktestJson, runHistoricalReplay } from "@memecoin-alpha/backtesting";

const config = loadRuntimeConfig();
const signal = { ...buildSampleSignal(config.thresholds), actionCategory: "paper-trade candidate" as const };
const baseTime = new Date(signal.detectedAt).getTime();
const run = runHistoricalReplay(
  [signal],
  [
    { tokenAddress: signal.tokenAddress, observedAt: new Date(baseTime + 1_000).toISOString(), priceUsd: 0.001, liquidityUsd: 50000 },
    { tokenAddress: signal.tokenAddress, observedAt: new Date(baseTime + 30_000).toISOString(), priceUsd: 0.0015, liquidityUsd: 53000 },
    { tokenAddress: signal.tokenAddress, observedAt: new Date(baseTime + 90_000).toISOString(), priceUsd: 0.003, liquidityUsd: 68000 }
  ],
  {
    strategyVersion: signal.strategyVersion,
    startingBalanceUsd: config.paperTrading.startingBalanceUsd,
    positionSizeUsd: config.thresholds.paperPositionSizeUsd,
    maxOpenPositions: config.thresholds.maxOpenPaperPositions,
    feeBps: 30,
    slippageBps: 100,
    providerLatencyMs: 1000,
    failedFillRate: 0.03,
    stopLossPercent: config.thresholds.stopLossPercent,
    takeProfitPercent: config.thresholds.takeProfitPercent,
    timeExitMinutes: config.thresholds.timeExitMinutes,
    minimumLiquidityUsd: config.thresholds.minimumLiquidityUsd
  }
);

await mkdir("reports", { recursive: true });
await writeFile("reports/backtest-sample.json", exportBacktestJson(run));
await writeFile("reports/backtest-sample.csv", exportBacktestCsv(run));
await writeFile("reports/backtest-sample.md", run.reportMarkdown);

console.log(`Backtest report written to reports/backtest-sample.*`);
