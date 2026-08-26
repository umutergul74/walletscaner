export interface MutableTradeCoverageState {
  subscribedToBuys: boolean;
  everSubscribedToBuys: boolean;
  controlledFlow: boolean;
  tradeCoverageComplete: boolean;
  tradeCoveragePersisted: boolean;
  tradeCoverageGapAt?: string;
  tradeCoverageGapReason?: string;
}

export type TradeCoverageReleaseResult = "released" | "already-incomplete" | "already-in-flight";

export interface TradeCoverageReleaseOperations {
  persist(): Promise<void>;
  unsubscribe(): void;
}

/**
 * Serializes one pool's fail-closed coverage transition and guarantees the
 * canonical gap is durable before the provider subscription is removed.
 */
export class TradeCoverageReleaseCoordinator {
  private readonly inFlight = new Set<string>();

  isInFlight(poolAddress: string): boolean {
    return this.inFlight.has(poolAddress);
  }

  async release(
    poolAddress: string,
    pool: MutableTradeCoverageState,
    reason: string,
    gapAt: string,
    operations: TradeCoverageReleaseOperations
  ): Promise<TradeCoverageReleaseResult> {
    if (this.inFlight.has(poolAddress)) return "already-in-flight";
    this.inFlight.add(poolAddress);
    try {
      const previous = snapshot(pool);
      const changed = excludeTradeCoverage(pool, reason, gapAt);
      if (!changed) {
        operations.unsubscribe();
        pool.subscribedToBuys = false;
        return "already-incomplete";
      }

      // Keep the occupied slot visible until the durable gap commit succeeds.
      pool.subscribedToBuys = previous.subscribedToBuys;
      try {
        await operations.persist();
      } catch (error) {
        restore(pool, previous);
        throw error;
      }
      pool.subscribedToBuys = false;
      operations.unsubscribe();
      return "released";
    } finally {
      this.inFlight.delete(poolAddress);
    }
  }
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

function snapshot(pool: MutableTradeCoverageState): MutableTradeCoverageState {
  return { ...pool };
}

function restore(
  pool: MutableTradeCoverageState,
  previous: MutableTradeCoverageState
): void {
  pool.subscribedToBuys = previous.subscribedToBuys;
  pool.everSubscribedToBuys = previous.everSubscribedToBuys;
  pool.controlledFlow = previous.controlledFlow;
  pool.tradeCoverageComplete = previous.tradeCoverageComplete;
  pool.tradeCoveragePersisted = previous.tradeCoveragePersisted;
  if (previous.tradeCoverageGapAt === undefined) delete pool.tradeCoverageGapAt;
  else pool.tradeCoverageGapAt = previous.tradeCoverageGapAt;
  if (previous.tradeCoverageGapReason === undefined) delete pool.tradeCoverageGapReason;
  else pool.tradeCoverageGapReason = previous.tradeCoverageGapReason;
}
