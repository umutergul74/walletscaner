export interface PoolSamplingCandidate {
  poolAddress: string;
  createdAt: string;
  lastSampledAt?: string;
  subscribedToBuys: boolean;
  controlledFlow: boolean;
}

/**
 * Bound each provider cycle without starving older unsampled pools. Live trade
 * subscriptions are always refreshed first, then the least-recently sampled
 * candidates win. Controlled flow and recency are deterministic tie-breakers.
 */
export function selectBoundedPoolSamplingBatch<T extends PoolSamplingCandidate>(
  candidates: T[],
  limit: number
): T[] {
  const boundedLimit = Math.max(1, Math.trunc(limit));
  return [...candidates]
    .sort((left, right) => {
      const subscriptionPriority = Number(right.subscribedToBuys) - Number(left.subscribedToBuys);
      if (subscriptionPriority !== 0) return subscriptionPriority;

      const leftSampledAt = left.lastSampledAt ? Date.parse(left.lastSampledAt) : 0;
      const rightSampledAt = right.lastSampledAt ? Date.parse(right.lastSampledAt) : 0;
      if (leftSampledAt !== rightSampledAt) return leftSampledAt - rightSampledAt;

      const flowPriority = Number(right.controlledFlow) - Number(left.controlledFlow);
      if (flowPriority !== 0) return flowPriority;
      return Date.parse(right.createdAt) - Date.parse(left.createdAt);
    })
    .slice(0, boundedLimit);
}
