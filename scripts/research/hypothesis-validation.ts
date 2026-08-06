import { summarizeReturns } from "./robust-stats.js";

export type HypothesisVerdict = "reject" | "watch" | "candidate";

export interface HypothesisOutcome {
  key: string;
  returnPct: number;
}

export interface HypothesisInput {
  key: string;
  verdict: HypothesisVerdict;
  signalCount: number;
  signalKeys?: string[];
  outcomes?: HypothesisOutcome[];
}

export interface HypothesisSnapshot {
  key: string;
  verdict: HypothesisVerdict;
  signalCount: number;
  signalKeys?: string[];
}

export interface HypothesisHistoryInput {
  runAt: string;
  evidence?: HypothesisSnapshot[];
}

export interface HypothesisDecision {
  leadingKey: string | null;
  leadingVerdict: HypothesisVerdict | null;
  rawCandidateKey: string | null;
  rawWatchKey: string | null;
  watchKey: string | null;
  validatedKey: string | null;
  leadingCandidateStreak: number;
  leadingSpanMinutes: number;
  leadingSampleGrowth: number;
  holdoutCount: number;
  holdoutAvgReturn: number;
  holdoutMedianReturn: number;
  holdoutHitRate: number;
  holdoutWorstReturn: number;
  holdoutPassed: boolean;
  evidence: HypothesisSnapshot[];
  reason: string;
}

interface Persistence {
  runs: number;
  spanMinutes: number;
  sampleGrowth: number;
}

interface HoldoutResult {
  count: number;
  avgReturn: number;
  medianReturn: number;
  hitRate: number;
  worstReturn: number;
  passed: boolean;
}

export function buildHypothesisDecision(
  current: HypothesisInput[],
  history: HypothesisHistoryInput[],
  currentRunAt: string
): HypothesisDecision {
  const evaluated = current.map((item) => ({
    item,
    candidate: persistenceFor(item, history, currentRunAt, ["candidate"]),
    watch: persistenceFor(item, history, currentRunAt, ["candidate", "watch"]),
    holdout: holdoutFor(item, history, ["candidate", "watch"])
  }));
  const validated = evaluated.find(
    ({ item, candidate, holdout }) =>
      item.verdict === "candidate" &&
      candidate.runs >= 3 &&
      candidate.spanMinutes >= 120 &&
      candidate.sampleGrowth >= 2 &&
      holdout.passed
  );
  const watch = evaluated.find(
    ({ item, watch: persistence }) =>
      item.key !== validated?.item.key &&
      item.verdict !== "reject" &&
      persistence.runs >= 2 &&
      persistence.spanMinutes >= 30
  );
  const leading = evaluated[0];
  const rawCandidate = evaluated.find(({ item }) => item.verdict === "candidate");
  const rawWatch = evaluated.find(({ item }) => item.verdict === "watch");
  const focus = validated ?? watch ?? rawCandidate ?? rawWatch ?? leading;
  const leadingPersistence =
    leading?.item.verdict === "candidate" ? leading.candidate : leading?.watch;

  let reason = "No persistent hypothesis has cleared the watch gate.";
  if (validated) {
    reason = `${validated.item.key} held candidate quality across ${validated.candidate.runs} runs, ${Math.round(validated.candidate.spanMinutes)} minutes, and ${validated.candidate.sampleGrowth} new signals; its ${validated.holdout.count}-signal holdout also passed.`;
  } else if (watch) {
    reason = `${watch.item.key} is watch-only after ${watch.watch.runs} runs and ${Math.round(watch.watch.spanMinutes)} minutes; validation still requires three candidate runs, 120 minutes, and two new signals.`;
  } else if (rawCandidate) {
    reason = `${rawCandidate.item.key} is only a raw candidate: ${rawCandidate.candidate.runs}/3 candidate runs, ${Math.round(rawCandidate.candidate.spanMinutes)}/120 minutes, ${rawCandidate.candidate.sampleGrowth}/2 new signals, and holdout passed=${rawCandidate.holdout.passed}.`;
  } else if (rawWatch) {
    reason = `${rawWatch.item.key} is only a raw watch: ${rawWatch.watch.runs}/2 qualifying runs and ${Math.round(rawWatch.watch.spanMinutes)}/30 minutes.`;
  }

  return {
    leadingKey: leading?.item.key ?? null,
    leadingVerdict: leading?.item.verdict ?? null,
    rawCandidateKey: rawCandidate?.item.key ?? null,
    rawWatchKey: rawWatch?.item.key ?? null,
    watchKey: watch?.item.key ?? null,
    validatedKey: validated?.item.key ?? null,
    leadingCandidateStreak: leadingPersistence?.runs ?? 0,
    leadingSpanMinutes: Math.round(leadingPersistence?.spanMinutes ?? 0),
    leadingSampleGrowth: leadingPersistence?.sampleGrowth ?? 0,
    holdoutCount: focus?.holdout.count ?? 0,
    holdoutAvgReturn: focus?.holdout.avgReturn ?? 0,
    holdoutMedianReturn: focus?.holdout.medianReturn ?? 0,
    holdoutHitRate: focus?.holdout.hitRate ?? 0,
    holdoutWorstReturn: focus?.holdout.worstReturn ?? 0,
    holdoutPassed: focus?.holdout.passed ?? false,
    evidence: [
      ...current.filter((item) => item.verdict !== "reject"),
      ...current.filter((item) => item.verdict === "reject").slice(0, 5)
    ]
      .slice(0, 20)
      .map(({ key, verdict, signalCount, signalKeys }) => ({
        key,
        verdict,
        signalCount,
        ...(signalKeys ? { signalKeys } : {})
      })),
    reason
  };
}

function persistenceFor(
  current: HypothesisInput,
  history: HypothesisHistoryInput[],
  currentRunAt: string,
  acceptedVerdicts: HypothesisVerdict[]
): Persistence {
  if (!acceptedVerdicts.includes(current.verdict)) {
    return { runs: 0, spanMinutes: 0, sampleGrowth: 0 };
  }

  let runs = 1;
  let earliestAt = currentRunAt;
  let oldestSignalCount = current.signalCount;
  let baselineKeys: Set<string> | null = null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    const snapshot = entry?.evidence?.find((item) => item.key === current.key);
    if (!entry || !snapshot || !acceptedVerdicts.includes(snapshot.verdict)) break;
    runs += 1;
    earliestAt = entry.runAt;
    oldestSignalCount = snapshot.signalCount;
    if (snapshot.signalKeys) baselineKeys = new Set(snapshot.signalKeys);
  }

  return {
    runs,
    spanMinutes: Math.max(
      0,
      (new Date(currentRunAt).getTime() - new Date(earliestAt).getTime()) / 60_000
    ),
    sampleGrowth:
      baselineKeys && current.signalKeys
        ? current.signalKeys.filter((key) => !baselineKeys.has(key)).length
        : Math.max(0, current.signalCount - oldestSignalCount)
  };
}

function holdoutFor(
  current: HypothesisInput,
  history: HypothesisHistoryInput[],
  acceptedVerdicts: HypothesisVerdict[]
): HoldoutResult {
  let baselineKeys: Set<string> | null = null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    const snapshot = entry?.evidence?.find((item) => item.key === current.key);
    if (!snapshot || !acceptedVerdicts.includes(snapshot.verdict)) break;
    if (snapshot.signalKeys) baselineKeys = new Set(snapshot.signalKeys);
  }

  if (!baselineKeys || !current.outcomes) {
    return {
      count: 0,
      avgReturn: 0,
      medianReturn: 0,
      hitRate: 0,
      worstReturn: 0,
      passed: false
    };
  }

  const holdoutReturns = current.outcomes
    .filter((outcome) => !baselineKeys.has(outcome.key))
    .map((outcome) => outcome.returnPct);
  const stats = summarizeReturns(holdoutReturns);
  const hitRate =
    holdoutReturns.filter((returnPct) => returnPct > 0).length / Math.max(holdoutReturns.length, 1);
  const worstReturn = Math.min(...holdoutReturns, 0);
  const passed =
    holdoutReturns.length >= 2 &&
    stats.average >= 2 &&
    stats.median >= 0 &&
    hitRate >= 0.5 &&
    worstReturn >= -35;

  return {
    count: holdoutReturns.length,
    avgReturn: stats.average,
    medianReturn: stats.median,
    hitRate,
    worstReturn,
    passed
  };
}
