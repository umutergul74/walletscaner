export interface RobustReturnStats {
  average: number;
  median: number;
  averageWithoutBest: number;
  bestWinnerShare: number;
}

export function summarizeReturns(values: number[]): RobustReturnStats {
  if (values.length === 0) {
    return {
      average: 0,
      median: 0,
      averageWithoutBest: 0,
      bestWinnerShare: 0
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  const withoutBest = sorted.slice(0, -1);
  const averageWithoutBest =
    withoutBest.length === 0
      ? 0
      : withoutBest.reduce((sum, value) => sum + value, 0) / withoutBest.length;
  const positiveValues = values.filter((value) => value > 0);
  const positiveTotal = positiveValues.reduce((sum, value) => sum + value, 0);
  const bestWinnerShare = positiveTotal > 0 ? Math.max(...positiveValues) / positiveTotal : 0;

  return {
    average,
    median,
    averageWithoutBest,
    bestWinnerShare
  };
}
