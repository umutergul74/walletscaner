import type { BacktestMetrics } from "@memecoin-alpha/shared";
import { summarizeReturns } from "./robust-stats.js";

export interface AuditedOutcome {
  key: string;
  observedAt: string;
  netReturnPct: number;
}

export interface HoldoutWindowAudit {
  name: "holdout-1" | "holdout-2";
  signalCount: number;
  averageReturnPct: number;
  medianReturnPct: number;
  averageReturnExBestPct: number;
  bestWinnerShare: number;
  hitRate: number;
  worstReturnPct: number;
  passed: boolean;
}

export interface GoalCompletionAudit {
  completed: boolean;
  independentMatureSignalCount: number;
  observationDays: number;
  holdouts: HoldoutWindowAudit[];
  replay: {
    available: boolean;
    profitFactor: number | null;
    maxDrawdownPercent: number | null;
    passed: boolean;
  };
  checks: {
    enoughSignals: boolean;
    enoughObservationDays: boolean;
    twoHoldouts: boolean;
    holdoutsPassed: boolean;
    replayPassed: boolean;
  };
  reasons: string[];
}

export function buildGoalCompletionAudit(
  outcomes: AuditedOutcome[],
  replayMetrics?: Pick<BacktestMetrics, "profitFactor" | "maxDrawdownPercent">
): GoalCompletionAudit {
  const uniqueOutcomes = dedupeChronologically(outcomes);
  const observationDays =
    uniqueOutcomes.length < 2
      ? 0
      : (new Date(uniqueOutcomes[uniqueOutcomes.length - 1]!.observedAt).getTime() -
          new Date(uniqueOutcomes[0]!.observedAt).getTime()) /
        86_400_000;
  const holdout1 = auditHoldout(
    "holdout-1",
    uniqueOutcomes.slice(10, 20).map((outcome) => outcome.netReturnPct)
  );
  const holdout2 = auditHoldout(
    "holdout-2",
    uniqueOutcomes.slice(20).map((outcome) => outcome.netReturnPct)
  );
  const holdouts = [holdout1, holdout2];
  const replayPassed = Boolean(
    replayMetrics &&
      replayMetrics.profitFactor >= 1.2 &&
      replayMetrics.maxDrawdownPercent <= 15
  );
  const checks = {
    enoughSignals: uniqueOutcomes.length >= 30,
    enoughObservationDays: observationDays >= 7,
    twoHoldouts: holdouts.every((holdout) => holdout.signalCount >= 10),
    holdoutsPassed: holdouts.every((holdout) => holdout.passed),
    replayPassed
  };
  const reasons: string[] = [];
  if (!checks.enoughSignals) {
    reasons.push(`${uniqueOutcomes.length}/30 independent mature signals collected.`);
  }
  if (!checks.enoughObservationDays) {
    reasons.push(`${round(observationDays)}/7 observation days completed.`);
  }
  if (!checks.twoHoldouts) {
    reasons.push("Two chronological holdouts with at least 10 signals each are not available.");
  } else if (!checks.holdoutsPassed) {
    reasons.push("At least one chronological holdout failed the robust return gates.");
  }
  if (!replayMetrics) {
    reasons.push("No capital-constrained replay metrics are available.");
  } else if (!checks.replayPassed) {
    reasons.push(
      `Replay failed: profit factor=${round(replayMetrics.profitFactor)}, max drawdown=${round(replayMetrics.maxDrawdownPercent)}%.`
    );
  }
  const completed = Object.values(checks).every(Boolean);
  if (completed) {
    reasons.push("All evidence-first alpha completion gates passed.");
  }

  return {
    completed,
    independentMatureSignalCount: uniqueOutcomes.length,
    observationDays: round(observationDays),
    holdouts,
    replay: {
      available: Boolean(replayMetrics),
      profitFactor: replayMetrics?.profitFactor ?? null,
      maxDrawdownPercent: replayMetrics?.maxDrawdownPercent ?? null,
      passed: replayPassed
    },
    checks,
    reasons
  };
}

function auditHoldout(
  name: HoldoutWindowAudit["name"],
  values: number[]
): HoldoutWindowAudit {
  const stats = summarizeReturns(values);
  const hitRate =
    values.filter((value) => value > 0).length / Math.max(values.length, 1);
  const worstReturnPct = values.length > 0 ? Math.min(...values) : 0;
  const passed =
    values.length >= 10 &&
    stats.average >= 2 &&
    stats.median >= 0 &&
    hitRate >= 0.5 &&
    worstReturnPct >= -35 &&
    stats.bestWinnerShare <= 0.35 &&
    stats.averageWithoutBest > 0;

  return {
    name,
    signalCount: values.length,
    averageReturnPct: round(stats.average),
    medianReturnPct: round(stats.median),
    averageReturnExBestPct: round(stats.averageWithoutBest),
    bestWinnerShare: round(stats.bestWinnerShare),
    hitRate: round(hitRate),
    worstReturnPct: round(worstReturnPct),
    passed
  };
}

function dedupeChronologically(outcomes: AuditedOutcome[]): AuditedOutcome[] {
  const seen = new Set<string>();
  return [...outcomes]
    .sort(
      (a, b) =>
        new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime()
    )
    .filter((outcome) => {
      if (seen.has(outcome.key)) return false;
      seen.add(outcome.key);
      return true;
    });
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
