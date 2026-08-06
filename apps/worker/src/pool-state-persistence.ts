export interface PoolStatePersistenceInput {
  nowMs: number;
  intervalMs: number;
  marketEligible: boolean;
  rugged: boolean;
  lastPersistedAtMs?: number;
  lastPersistedMarketEligible?: boolean;
}

export function shouldPersistPoolState(input: PoolStatePersistenceInput): boolean {
  if (input.lastPersistedAtMs === undefined) return true;
  if (input.rugged) return true;
  if (input.lastPersistedMarketEligible !== input.marketEligible) return true;
  return input.nowMs - input.lastPersistedAtMs >= input.intervalMs;
}
