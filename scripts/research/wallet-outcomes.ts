export interface ObservedWalletSignal {
  tokenAddress: string;
  observedAt: string;
  observedEntryPriceUsd: number;
  observedLiquidityUsd: number;
}

export interface TokenPriceObservation {
  observedAt: string;
  priceUsd: number;
}

export type WalletSignalOutcomeStatus = "mature" | "provisional" | "unresolved";

export interface WalletSignalOutcome extends ObservedWalletSignal {
  outcomePriceUsd: number;
  outcomeObservedAt: string;
  ageMinutes: number;
  mature: boolean;
  status: WalletSignalOutcomeStatus;
  returnPct: number;
}

export function calculateWalletSignalOutcomes(
  signals: ObservedWalletSignal[],
  priceHistories: ReadonlyMap<string, TokenPriceObservation[]>,
  currentObservedAt: string,
  horizonMinutes = 20,
  maxDelayMinutes = 20
): WalletSignalOutcome[] {
  const earliestByToken = new Map<string, ObservedWalletSignal>();
  for (const signal of signals) {
    const existing = earliestByToken.get(signal.tokenAddress);
    if (
      !existing ||
      new Date(signal.observedAt).getTime() < new Date(existing.observedAt).getTime()
    ) {
      earliestByToken.set(signal.tokenAddress, signal);
    }
  }

  return [...earliestByToken.values()].flatMap((signal) => {
    const history = priceHistories.get(signal.tokenAddress) ?? [];
    const signalTime = new Date(signal.observedAt).getTime();
    const currentTime = new Date(currentObservedAt).getTime();
    const targetTime = signalTime + horizonMinutes * 60_000;
    const deadline = targetTime + maxDelayMinutes * 60_000;
    const matureObservation = history
      .filter((observation) => {
        const observedTime = new Date(observation.observedAt).getTime();
        return observedTime >= targetTime && observedTime <= deadline;
      })
      .sort((a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime())[0];
    const latestObservation = history
      .filter((observation) => new Date(observation.observedAt).getTime() <= currentTime)
      .sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime())[0];
    const status: WalletSignalOutcomeStatus = matureObservation
      ? "mature"
      : currentTime < targetTime
        ? "provisional"
        : "unresolved";
    const outcomeObservation = matureObservation ?? latestObservation;
    if (
      !outcomeObservation ||
      outcomeObservation.priceUsd <= 0 ||
      !signal.observedEntryPriceUsd ||
      signal.observedEntryPriceUsd <= 0
    ) {
      return [];
    }
    return [
      {
        ...signal,
        outcomePriceUsd: outcomeObservation.priceUsd,
        outcomeObservedAt: outcomeObservation.observedAt,
        ageMinutes: Math.max(0, (currentTime - signalTime) / 60_000),
        mature: Boolean(matureObservation),
        status,
        returnPct:
          ((outcomeObservation.priceUsd - signal.observedEntryPriceUsd) /
            signal.observedEntryPriceUsd) *
          100
      }
    ];
  });
}
