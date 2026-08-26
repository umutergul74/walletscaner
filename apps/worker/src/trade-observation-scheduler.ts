export interface TradeObservationPool {
  poolAddress: string;
  createdAt: string;
  subscribedToBuys: boolean;
  controlledFlow: boolean;
  tradeCoverageComplete: boolean;
  observationSubscribedAtMs?: number;
}

export interface TradeObservationAdmissionOptions {
  nowMs: number;
  maximumActivePools: number;
  minimumHoldMs: number;
  marketEligible: boolean;
}

export type TradeObservationAdmission =
  | { action: "subscribe"; reason: "available-capacity" }
  | { action: "replace"; reason: "oldest-unprotected-observation"; evictPoolAddress: string }
  | {
      action: "defer";
      reason:
        | "market-ineligible"
        | "coverage-incomplete"
        | "already-subscribed"
        | "capacity-disabled"
        | "minimum-hold"
        | "alpha-protected-capacity";
    };

export interface TradeObservationHealthInput {
  marketEligibleTrackedPools: number;
  activePoolSubscriptions: number;
  configuredAddressCount?: number;
  subscribedAddressCount?: number;
}

export interface TradeObservationHealth {
  status: "ok" | "degraded";
  reason: "idle-no-candidate" | "active" | "eligible-lane-starved" | "subscription-ack-gap";
}

export function evaluateTradeObservationHealth(
  input: TradeObservationHealthInput
): TradeObservationHealth {
  const eligible = nonNegativeInteger(input.marketEligibleTrackedPools);
  const active = nonNegativeInteger(input.activePoolSubscriptions);
  if (eligible > 0 && active === 0) {
    return { status: "degraded", reason: "eligible-lane-starved" };
  }
  if (
    active > 0 &&
    (nonNegativeInteger(input.configuredAddressCount) < active ||
      nonNegativeInteger(input.subscribedAddressCount) < active)
  ) {
    return { status: "degraded", reason: "subscription-ack-gap" };
  }
  return active > 0
    ? { status: "ok", reason: "active" }
    : { status: "ok", reason: "idle-no-candidate" };
}

/**
 * Selects exact-pool observation capacity without weakening downstream alpha admission.
 *
 * A market-eligible pool may be observed before token-risk enrichment passes. At the hard
 * capacity boundary, only a non-alpha-protected observation that completed its minimum hold can
 * be replaced. The caller owns the durable coverage-gap transition before it unsubscribes the
 * selected pool.
 */
export function planTradeObservationAdmission<T extends TradeObservationPool>(
  candidate: T,
  pools: Iterable<T>,
  options: TradeObservationAdmissionOptions
): TradeObservationAdmission {
  if (!options.marketEligible) return { action: "defer", reason: "market-ineligible" };
  if (!candidate.tradeCoverageComplete) {
    return { action: "defer", reason: "coverage-incomplete" };
  }
  if (candidate.subscribedToBuys) return { action: "defer", reason: "already-subscribed" };

  const parsedCapacity = Math.trunc(options.maximumActivePools);
  const capacity = Number.isFinite(parsedCapacity) ? Math.max(0, parsedCapacity) : 0;
  if (capacity === 0) return { action: "defer", reason: "capacity-disabled" };

  const active = [...pools].filter((pool) => pool.subscribedToBuys);
  if (active.length < capacity) return { action: "subscribe", reason: "available-capacity" };

  const unprotected = active.filter((pool) => !pool.controlledFlow);
  if (unprotected.length === 0) {
    return { action: "defer", reason: "alpha-protected-capacity" };
  }

  const parsedMinimumHoldMs = Math.trunc(options.minimumHoldMs);
  const minimumHoldMs = Number.isFinite(parsedMinimumHoldMs)
    ? Math.max(0, parsedMinimumHoldMs)
    : Number.POSITIVE_INFINITY;
  const replaceable = unprotected
    .filter(
      (pool) =>
        pool.observationSubscribedAtMs !== undefined &&
        options.nowMs - pool.observationSubscribedAtMs >= minimumHoldMs
    )
    .sort((left, right) => {
      const subscribedAt =
        (left.observationSubscribedAtMs ?? Number.POSITIVE_INFINITY) -
        (right.observationSubscribedAtMs ?? Number.POSITIVE_INFINITY);
      if (subscribedAt !== 0) return subscribedAt;
      const createdAt = Date.parse(left.createdAt) - Date.parse(right.createdAt);
      if (createdAt !== 0) return createdAt;
      return left.poolAddress.localeCompare(right.poolAddress);
    });

  const evict = replaceable[0];
  if (!evict) return { action: "defer", reason: "minimum-hold" };
  return {
    action: "replace",
    reason: "oldest-unprotected-observation",
    evictPoolAddress: evict.poolAddress
  };
}

function nonNegativeInteger(value: number | undefined): number {
  const parsed = Math.trunc(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}
