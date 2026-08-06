export interface TimedPricePoint {
  observedAt: string;
  priceUsd: number;
}

export interface FixedHorizonConfig {
  horizonMinutes: number;
  maxDelayMinutes: number;
  estimatedRoundTripCostPct: number;
}

export interface FixedHorizonEvaluation<T extends TimedPricePoint> {
  outcome: T;
  path: T[];
  grossReturnPct: number;
  netReturnPct: number;
  maxReturnPct: number;
  minReturnPct: number;
  ageMinutes: number;
}

export interface PaperExitPathPoint {
  observedAt: string;
  minutesSinceSignal: number;
  returnPct: number;
}

export interface PaperExitConfig {
  exitStrategy?: "single-stage" | "moonbag";
  takeProfitPct: number;
  stopLossPct: number;
  timeoutMinutes: number;
  moonbagSellFraction?: number;
  trailingStopPercent?: number;
}

export interface PaperExitSimulation {
  returnPct: number;
  reason: string;
  mature: boolean;
}

export function evaluateFixedHorizon<T extends TimedPricePoint>(
  signalAt: string,
  signalPriceUsd: number,
  observations: T[],
  config: FixedHorizonConfig
): FixedHorizonEvaluation<T> | undefined {
  if (!Number.isFinite(signalPriceUsd) || signalPriceUsd <= 0) return undefined;

  const signalTime = new Date(signalAt).getTime();
  const targetTime = signalTime + config.horizonMinutes * 60_000;
  const deadline = targetTime + config.maxDelayMinutes * 60_000;
  const ordered = observations
    .filter((observation) => {
      const observedTime = new Date(observation.observedAt).getTime();
      return (
        Number.isFinite(observedTime) &&
        observedTime >= signalTime &&
        Number.isFinite(observation.priceUsd) &&
        observation.priceUsd > 0
      );
    })
    .sort((a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime());
  const outcome = ordered.find((observation) => {
    const observedTime = new Date(observation.observedAt).getTime();
    return observedTime >= targetTime && observedTime <= deadline;
  });
  if (!outcome) return undefined;

  const outcomeTime = new Date(outcome.observedAt).getTime();
  const path = ordered.filter(
    (observation) => new Date(observation.observedAt).getTime() <= outcomeTime
  );
  const returns = path.map((observation) => percentChange(signalPriceUsd, observation.priceUsd));
  const grossReturnPct = percentChange(signalPriceUsd, outcome.priceUsd);

  return {
    outcome,
    path,
    grossReturnPct,
    netReturnPct: grossReturnPct - config.estimatedRoundTripCostPct,
    maxReturnPct: Math.max(...returns, 0),
    minReturnPct: Math.min(...returns, 0),
    ageMinutes: Math.max(0, (outcomeTime - signalTime) / 60_000)
  };
}

export function simulatePaperExitPath(
  returnPath: PaperExitPathPoint[],
  config: PaperExitConfig
): PaperExitSimulation {
  const points = returnPath
    .filter(
      (point) =>
        Number.isFinite(point.minutesSinceSignal) &&
        point.minutesSinceSignal >= 0 &&
        Number.isFinite(point.returnPct)
    )
    .sort((a, b) => a.minutesSinceSignal - b.minutesSinceSignal);
  const firstPoint = points[0] ?? {
    observedAt: "",
    minutesSinceSignal: 0,
    returnPct: 0
  };

  if (config.exitStrategy !== "moonbag") {
    let lastPoint = firstPoint;
    for (const point of points) {
      if (point.minutesSinceSignal >= config.timeoutMinutes) {
        return { returnPct: point.returnPct, reason: "timeout", mature: true };
      }
      if (point.returnPct >= config.takeProfitPct) {
        return {
          returnPct: config.takeProfitPct,
          reason: "take-profit",
          mature: true
        };
      }
      if (point.returnPct <= -config.stopLossPct) {
        return {
          returnPct: -config.stopLossPct,
          reason: "stop-loss",
          mature: true
        };
      }
      lastPoint = point;
    }
    return { returnPct: lastPoint.returnPct, reason: "provisional", mature: false };
  }

  const securedFraction = config.moonbagSellFraction ?? 0.5;
  const trailingStopPercent = config.trailingStopPercent ?? 30;
  let securedReturnPct: number | undefined;
  let peakReturnPct = 0;
  let lastReturnPct = firstPoint.returnPct;

  for (const point of points) {
    if (point.minutesSinceSignal >= config.timeoutMinutes) {
      return {
        returnPct:
          securedReturnPct === undefined
            ? point.returnPct
            : securedFraction * securedReturnPct + (1 - securedFraction) * point.returnPct,
        reason: "moonbag_time_exit",
        mature: true
      };
    }

    if (securedReturnPct === undefined && point.returnPct <= -config.stopLossPct) {
      return {
        returnPct: -config.stopLossPct,
        reason: "stop-loss",
        mature: true
      };
    }

    if (securedReturnPct === undefined && point.returnPct >= config.takeProfitPct) {
      securedReturnPct = config.takeProfitPct;
      peakReturnPct = point.returnPct;
      lastReturnPct = point.returnPct;
      continue;
    }

    if (securedReturnPct !== undefined) {
      peakReturnPct = Math.max(peakReturnPct, point.returnPct);
      const peakPriceMultiple = 1 + peakReturnPct / 100;
      const trailingPriceMultiple = peakPriceMultiple * (1 - trailingStopPercent / 100);
      const trailingStopReturnPct = (trailingPriceMultiple - 1) * 100;
      if (point.returnPct <= trailingStopReturnPct) {
        return {
          returnPct: securedFraction * securedReturnPct + (1 - securedFraction) * point.returnPct,
          reason: "moonbag_trailing_stop",
          mature: true
        };
      }
    }
    lastReturnPct = point.returnPct;
  }

  return {
    returnPct:
      securedReturnPct === undefined
        ? lastReturnPct
        : securedFraction * securedReturnPct + (1 - securedFraction) * lastReturnPct,
    reason: securedReturnPct === undefined ? "provisional" : "moonbag_provisional",
    mature: false
  };
}

function percentChange(from: number, to: number): number {
  return ((to - from) / from) * 100;
}
