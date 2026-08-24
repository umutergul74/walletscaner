export interface MutableTradeCoverageState {
  subscribedToBuys: boolean;
  everSubscribedToBuys: boolean;
  controlledFlow: boolean;
  tradeCoverageComplete: boolean;
  tradeCoveragePersisted: boolean;
  tradeCoverageGapAt?: string;
  tradeCoverageGapReason?: string;
}

export function excludeTradeCoverage(
  pool: MutableTradeCoverageState,
  reason: string,
  gapAt: string
): boolean {
  pool.subscribedToBuys = false;
  pool.controlledFlow = false;
  if (!pool.tradeCoverageComplete) return false;
  pool.tradeCoverageComplete = false;
  pool.tradeCoveragePersisted = false;
  pool.tradeCoverageGapAt = gapAt;
  pool.tradeCoverageGapReason = reason;
  return true;
}

export function activateTradeSubscription(pool: MutableTradeCoverageState): boolean {
  if (!pool.tradeCoverageComplete) {
    pool.subscribedToBuys = false;
    return false;
  }
  pool.subscribedToBuys = true;
  pool.everSubscribedToBuys = true;
  return true;
}
