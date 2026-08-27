export interface MutableTradeCoverageState {
  subscribedToBuys: boolean;
  everSubscribedToBuys: boolean;
  controlledFlow: boolean;
  tradeCoverageComplete: boolean;
  tradeCoveragePersisted: boolean;
  tradeCoverageGapAt?: string;
  tradeCoverageGapReason?: string;
}

export interface MutableTradeSubscriptionState extends MutableTradeCoverageState {
  observationSubscribedAtMs?: number;
}

export type TradeSubscriptionBootstrapResult =
  | "activated"
  | "already-active"
  | "coverage-incomplete"
  | "excluded-during-bootstrap";

export interface TradeSubscriptionBootstrapOperations {
  subscribe(): Promise<void>;
  failClosed(error: unknown): Promise<void>;
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

/**
 * Reserves a bounded observation slot before provider bootstrap yields to
 * backfill or an ACK. This keeps scheduler occupancy correlated with the
 * provider's synchronously configured address while per-address backfill
 * serializes live notifications behind it.
 *
 * A provider failure is handed to the caller's durable fail-closed path while
 * the slot is still occupied. That path must persist the coverage gap before
 * unsubscribing; if persistence fails, the release coordinator deliberately
 * restores the occupied subscription so coverage cannot be lost silently.
 */
export async function bootstrapTradeSubscription(
  pool: MutableTradeSubscriptionState,
  subscribedAtMs: number,
  operations: TradeSubscriptionBootstrapOperations
): Promise<TradeSubscriptionBootstrapResult> {
  if (pool.subscribedToBuys) return "already-active";
  if (!activateTradeSubscription(pool)) return "coverage-incomplete";
  pool.observationSubscribedAtMs ??= subscribedAtMs;

  try {
    await operations.subscribe();
  } catch (error) {
    try {
      await operations.failClosed(error);
    } catch (failClosedError) {
      throw new AggregateError(
        [error, failClosedError],
        "Trade subscription bootstrap and durable fail-closed release both failed."
      );
    }
    throw error;
  }

  return pool.subscribedToBuys && pool.tradeCoverageComplete
    ? "activated"
    : "excluded-during-bootstrap";
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
