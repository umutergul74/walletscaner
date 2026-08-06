export interface TimedResearchRecord {
  observedAt: string;
}

export interface WalkForwardWindows<T> {
  train: T[];
  validation: T[];
  holdout1: T[];
  holdout2: T[];
}

export interface CandidateSelectionScore {
  train: { passed: boolean; score: number };
  validation: { passed: boolean; score: number };
  selectedCount: number;
}

export function splitChronologicalWalkForward<T extends TimedResearchRecord>(
  records: T[],
  embargoMinutes = 40
): WalkForwardWindows<T> {
  const sorted = [...records].sort(
    (a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime()
  );
  const firstSplit = sorted[Math.floor(sorted.length * 0.4)]?.observedAt;
  const secondSplit = sorted[Math.floor(sorted.length * 0.6)]?.observedAt;
  const thirdSplit = sorted[Math.floor(sorted.length * 0.8)]?.observedAt;
  if (!firstSplit || !secondSplit || !thirdSplit) {
    return { train: sorted, validation: [], holdout1: [], holdout2: [] };
  }

  const firstTime = new Date(firstSplit).getTime();
  const secondTime = new Date(secondSplit).getTime();
  const thirdTime = new Date(thirdSplit).getTime();
  const embargoMs = embargoMinutes * 60_000;
  return {
    train: sorted.filter((record) => new Date(record.observedAt).getTime() < firstTime - embargoMs),
    validation: sorted.filter((record) => {
      const observedAt = new Date(record.observedAt).getTime();
      return observedAt >= firstTime + embargoMs && observedAt < secondTime - embargoMs;
    }),
    holdout1: sorted.filter((record) => {
      const observedAt = new Date(record.observedAt).getTime();
      return observedAt >= secondTime + embargoMs && observedAt < thirdTime - embargoMs;
    }),
    holdout2: sorted.filter(
      (record) => new Date(record.observedAt).getTime() >= thirdTime + embargoMs
    )
  };
}

export function lockBestCandidate<T extends CandidateSelectionScore>(results: T[]): T | null {
  return [...results].sort(compareSelectionScores)[0] ?? null;
}

function compareSelectionScores(a: CandidateSelectionScore, b: CandidateSelectionScore): number {
  return (
    Number(b.validation.passed) - Number(a.validation.passed) ||
    b.validation.score - a.validation.score ||
    Number(b.train.passed) - Number(a.train.passed) ||
    b.train.score - a.train.score ||
    b.selectedCount - a.selectedCount
  );
}
