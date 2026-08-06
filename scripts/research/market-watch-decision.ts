export interface MarketWatchModeInput {
  validatedMethod: boolean;
  validatedRule: boolean;
  validatedPaperExit: boolean;
  validatedWallet: boolean;
  watchMethod: boolean;
  watchRule: boolean;
  watchPaperExit: boolean;
  watchWallet: boolean;
  canonicalReplayPassed: boolean;
}

export interface MarketWatchModeDecision {
  recommendedMode: "observe-only" | "paper-watch" | "paper-validate candidate";
  status: "collecting evidence" | "wallet candidate emerging" | "validated paper system candidate";
  systemCandidate: boolean;
  walletOnlyCandidate: boolean;
  systemWatch: boolean;
}

export function decideMarketWatchMode(input: MarketWatchModeInput): MarketWatchModeDecision {
  const systemCandidate = Boolean(
    input.validatedMethod &&
    input.validatedRule &&
    input.validatedPaperExit &&
    input.canonicalReplayPassed
  );
  const walletOnlyCandidate = input.validatedWallet && !systemCandidate;
  const systemWatch = Boolean(
    input.watchMethod || input.watchRule || input.watchPaperExit || walletOnlyCandidate
  );

  return {
    recommendedMode: systemCandidate
      ? "paper-validate candidate"
      : systemWatch
        ? "paper-watch"
        : "observe-only",
    status: systemCandidate
      ? "validated paper system candidate"
      : walletOnlyCandidate
        ? "wallet candidate emerging"
        : "collecting evidence",
    systemCandidate,
    walletOnlyCandidate,
    systemWatch
  };
}
