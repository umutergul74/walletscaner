import { round } from "@memecoin-alpha/shared";

export const QUALIFIED_POOL_PAPER_STRATEGY_VERSION = "qualified-pool-paper-v1";
export const QUALIFIED_POOL_PAPER_V2_STRATEGY_VERSION = "qualified-pool-paper-v2";

export interface RugAwarePaperConfig {
  startingBalanceUsd: number;
  targetPositionSizeUsd: number;
  maximumOpenPositions: number;
  maximumPortfolioExposureUsd: number;
  confirmationDelaySeconds: number;
  maximumEntryAgeMinutes: number;
  minimumEntryLiquidityUsd: number;
  minimumEntryVolume5mUsd: number;
  minimumEntryTransactions: number;
  minimumEntryBuyShare: number;
  maximumEntryVolumeLiquidityRatio: number;
  minimumLiquidityRetention: number;
  maximumPositionLiquidityFraction: number;
  stopLossPercent: number;
  capitalRecoveryTriggerPercent: number;
  capitalRecoveryFraction: number;
  secondTakeProfitPercent: number;
  secondTakeProfitFraction: number;
  trailingStopPercent: number;
  maximumHoldMinutes: number;
  stagnationExitMinutes: number;
  minimumStagnationReturnPercent: number;
  emergencyLiquidityUsd: number;
  emergencyLiquidityRetention: number;
  missingPairLimit: number;
  feeBps: number;
  entryBaseSlippageBps: number;
  exitBaseSlippageBps: number;
}

export const defaultRugAwarePaperConfig: RugAwarePaperConfig = {
  startingBalanceUsd: 100,
  targetPositionSizeUsd: 12,
  maximumOpenPositions: 3,
  maximumPortfolioExposureUsd: 36,
  confirmationDelaySeconds: 120,
  maximumEntryAgeMinutes: 20,
  minimumEntryLiquidityUsd: 15_000,
  minimumEntryVolume5mUsd: 5_000,
  minimumEntryTransactions: 20,
  minimumEntryBuyShare: 3 / 7,
  maximumEntryVolumeLiquidityRatio: 999,
  minimumLiquidityRetention: 0.8,
  maximumPositionLiquidityFraction: 0.0006,
  stopLossPercent: 22,
  capitalRecoveryTriggerPercent: 75,
  capitalRecoveryFraction: 0.6,
  secondTakeProfitPercent: 200,
  secondTakeProfitFraction: 0.5,
  trailingStopPercent: 28,
  maximumHoldMinutes: 120,
  stagnationExitMinutes: 25,
  minimumStagnationReturnPercent: 8,
  emergencyLiquidityUsd: 7_500,
  emergencyLiquidityRetention: 0.4,
  missingPairLimit: 3,
  feeBps: 30,
  entryBaseSlippageBps: 150,
  exitBaseSlippageBps: 250
};

export const conservativeRugAwarePaperConfig: RugAwarePaperConfig = {
  startingBalanceUsd: 100,
  targetPositionSizeUsd: 8,
  maximumOpenPositions: 2,
  maximumPortfolioExposureUsd: 16,
  confirmationDelaySeconds: 300,
  maximumEntryAgeMinutes: 15,
  minimumEntryLiquidityUsd: 30_000,
  minimumEntryVolume5mUsd: 10_000,
  minimumEntryTransactions: 40,
  minimumEntryBuyShare: 0.58,
  maximumEntryVolumeLiquidityRatio: 1.5,
  minimumLiquidityRetention: 0.9,
  maximumPositionLiquidityFraction: 0.00025,
  stopLossPercent: 15,
  capitalRecoveryTriggerPercent: 30,
  capitalRecoveryFraction: 0.8,
  secondTakeProfitPercent: 75,
  secondTakeProfitFraction: 0.75,
  trailingStopPercent: 18,
  maximumHoldMinutes: 45,
  stagnationExitMinutes: 12,
  minimumStagnationReturnPercent: 5,
  emergencyLiquidityUsd: 18_000,
  emergencyLiquidityRetention: 0.65,
  missingPairLimit: 2,
  feeBps: 30,
  entryBaseSlippageBps: 200,
  exitBaseSlippageBps: 350
};

export function rugAwarePaperConfigForVersion(strategyVersion: string): RugAwarePaperConfig {
  if (strategyVersion === QUALIFIED_POOL_PAPER_STRATEGY_VERSION) {
    return defaultRugAwarePaperConfig;
  }
  if (strategyVersion === QUALIFIED_POOL_PAPER_V2_STRATEGY_VERSION) {
    return conservativeRugAwarePaperConfig;
  }
  throw new Error(`Unsupported paper strategy version: ${strategyVersion}.`);
}

export interface PaperMarketSnapshot {
  observedAt: string;
  priceUsd: number;
  volume5mUsd: number;
  buys5m: number;
  sells5m: number;
  pairFound: boolean;
  liquidityUsd?: number;
}

export interface PaperPositionState {
  initialQuantity: number;
  remainingQuantity: number;
  entryPriceUsd: number;
  entryNotionalUsd: number;
  entryLiquidityUsd: number;
  peakPriceUsd: number;
  openedAt: string;
  stage: "initial" | "capital_recovered" | "runner";
  missingPairCount: number;
  realizedProceedsUsd: number;
}

export type PaperPositionDecision =
  | { action: "hold"; state: PaperPositionState; reason: string }
  | {
      action: "sell";
      fraction: number;
      closeAfterFill: boolean;
      state: PaperPositionState;
      reason: string;
    }
  | { action: "rugged"; state: PaperPositionState; reason: string };

export function validatePaperEntry(input: {
  signalObservedAt: string;
  signalLiquidityUsd: number;
  snapshot: PaperMarketSnapshot;
  now?: string;
  config?: RugAwarePaperConfig;
}): string | undefined {
  const config = input.config ?? defaultRugAwarePaperConfig;
  const now = new Date(input.now ?? input.snapshot.observedAt).getTime();
  const signalTime = new Date(input.signalObservedAt).getTime();
  const ageMinutes = (now - signalTime) / 60_000;
  if (!input.snapshot.pairFound) return "exact_pool_not_found";
  if (!(input.snapshot.priceUsd > 0)) return "invalid_entry_price";
  if (input.snapshot.liquidityUsd === undefined) return "entry_liquidity_unknown";
  if (input.snapshot.liquidityUsd < config.minimumEntryLiquidityUsd) {
    return "entry_liquidity_below_floor";
  }
  if (
    input.signalLiquidityUsd > 0 &&
    input.snapshot.liquidityUsd / input.signalLiquidityUsd < config.minimumLiquidityRetention
  ) {
    return "entry_liquidity_not_persistent";
  }
  if (input.snapshot.volume5mUsd < config.minimumEntryVolume5mUsd) {
    return "entry_volume_below_floor";
  }
  const entryTransactions = input.snapshot.buys5m + input.snapshot.sells5m;
  if (entryTransactions < config.minimumEntryTransactions) {
    return "entry_activity_too_low";
  }
  if (input.snapshot.buys5m / Math.max(entryTransactions, 1) < config.minimumEntryBuyShare) {
    return "entry_sell_pressure";
  }
  if (
    input.snapshot.liquidityUsd > 0 &&
    input.snapshot.volume5mUsd / input.snapshot.liquidityUsd >
      config.maximumEntryVolumeLiquidityRatio
  ) {
    return "entry_turnover_too_high";
  }
  if (ageMinutes > config.maximumEntryAgeMinutes) return "entry_signal_stale";
  return undefined;
}

export function calculatePaperPositionSize(input: {
  cashBalanceUsd: number;
  committedExposureUsd: number;
  liquidityUsd: number;
  config?: RugAwarePaperConfig;
}): number {
  const config = input.config ?? defaultRugAwarePaperConfig;
  const remainingExposure = Math.max(
    0,
    config.maximumPortfolioExposureUsd - input.committedExposureUsd
  );
  return round(
    Math.max(
      0,
      Math.min(
        config.targetPositionSizeUsd,
        input.cashBalanceUsd,
        remainingExposure,
        input.liquidityUsd * config.maximumPositionLiquidityFraction
      )
    ),
    4
  );
}

export function entrySlippageBps(
  positionSizeUsd: number,
  liquidityUsd: number,
  config: RugAwarePaperConfig = defaultRugAwarePaperConfig
): number {
  if (!(liquidityUsd > 0)) return 2_000;
  const impactBps = (positionSizeUsd / liquidityUsd) * 20_000;
  return Math.round(Math.min(2_000, Math.max(config.entryBaseSlippageBps, impactBps)));
}

export function exitSlippageBps(
  grossPositionValueUsd: number,
  liquidityUsd: number | undefined,
  entryLiquidityUsd: number,
  config: RugAwarePaperConfig = defaultRugAwarePaperConfig
): number {
  if (liquidityUsd === undefined) return 500;
  if (liquidityUsd <= 0) return 10_000;
  const impactBps = (grossPositionValueUsd / liquidityUsd) * 30_000;
  const deteriorationBps =
    entryLiquidityUsd > 0 ? Math.max(0, (1 - liquidityUsd / entryLiquidityUsd) * 2_000) : 0;
  return Math.round(
    Math.min(5_000, Math.max(config.exitBaseSlippageBps, impactBps + deteriorationBps))
  );
}

export function decidePaperPosition(
  position: PaperPositionState,
  snapshot: PaperMarketSnapshot,
  config: RugAwarePaperConfig = defaultRugAwarePaperConfig
): PaperPositionDecision {
  const state: PaperPositionState = {
    ...position,
    peakPriceUsd:
      snapshot.pairFound && snapshot.priceUsd > 0
        ? Math.max(position.peakPriceUsd, snapshot.priceUsd)
        : position.peakPriceUsd,
    missingPairCount: snapshot.pairFound ? 0 : position.missingPairCount + 1
  };
  if (!snapshot.pairFound) {
    if (state.missingPairCount >= config.missingPairLimit) {
      return { action: "rugged", state, reason: "exact_pool_disappeared" };
    }
    return { action: "hold", state, reason: "exact_pool_temporarily_missing" };
  }
  if (!(snapshot.priceUsd > 0)) {
    return { action: "rugged", state, reason: "pool_price_zero" };
  }
  if (snapshot.liquidityUsd !== undefined && snapshot.liquidityUsd <= 0) {
    return { action: "rugged", state, reason: "pool_liquidity_zero" };
  }

  const returnPercent = (snapshot.priceUsd / position.entryPriceUsd - 1) * 100;
  const holdMinutes =
    (new Date(snapshot.observedAt).getTime() - new Date(position.openedAt).getTime()) / 60_000;
  const knownLiquidityEmergency =
    snapshot.liquidityUsd !== undefined &&
    (snapshot.liquidityUsd < config.emergencyLiquidityUsd ||
      snapshot.liquidityUsd / position.entryLiquidityUsd < config.emergencyLiquidityRetention);
  if (knownLiquidityEmergency) {
    return {
      action: "sell",
      fraction: 1,
      closeAfterFill: true,
      state,
      reason: "emergency_liquidity_exit"
    };
  }
  if (returnPercent <= -config.stopLossPercent + Number.EPSILON) {
    return {
      action: "sell",
      fraction: 1,
      closeAfterFill: true,
      state,
      reason: "hard_stop_loss"
    };
  }
  if (
    position.stage === "initial" &&
    returnPercent + 1e-9 >= config.capitalRecoveryTriggerPercent
  ) {
    return {
      action: "sell",
      fraction: config.capitalRecoveryFraction,
      closeAfterFill: false,
      state: { ...state, stage: "capital_recovered" },
      reason: "capital_recovery"
    };
  }
  if (
    position.stage === "capital_recovered" &&
    returnPercent + 1e-9 >= config.secondTakeProfitPercent
  ) {
    return {
      action: "sell",
      fraction: config.secondTakeProfitFraction,
      closeAfterFill: false,
      state: { ...state, stage: "runner" },
      reason: "second_take_profit"
    };
  }
  const drawdownFromPeak =
    state.peakPriceUsd > 0 ? (1 - snapshot.priceUsd / state.peakPriceUsd) * 100 : 0;
  if (position.stage !== "initial" && drawdownFromPeak >= config.trailingStopPercent) {
    return {
      action: "sell",
      fraction: 1,
      closeAfterFill: true,
      state,
      reason: "trailing_stop"
    };
  }
  if (
    holdMinutes >= config.stagnationExitMinutes &&
    returnPercent < config.minimumStagnationReturnPercent &&
    (snapshot.volume5mUsd < config.minimumEntryVolume5mUsd * 0.5 ||
      snapshot.sells5m > snapshot.buys5m * 1.4)
  ) {
    return {
      action: "sell",
      fraction: 1,
      closeAfterFill: true,
      state,
      reason: "momentum_decay"
    };
  }
  if (holdMinutes >= config.maximumHoldMinutes) {
    return {
      action: "sell",
      fraction: 1,
      closeAfterFill: true,
      state,
      reason: "maximum_hold_time"
    };
  }
  return { action: "hold", state, reason: "position_healthy" };
}
