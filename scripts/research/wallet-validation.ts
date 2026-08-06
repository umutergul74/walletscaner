export type WalletVerdict = "reject" | "watch" | "candidate";

export interface WalletValidationInput {
  wallet: string;
  walletScore: number;
  walletConfidence: string;
  tokenOutcomeCount: number;
  matureSignalKeys?: string[];
  avgTokenReturnPct: number;
  worstTokenReturnPct: number;
  tokenHitRate: number;
  labels: string[];
}

export interface WalletEvidence {
  wallet: string;
  verdict: WalletVerdict;
  walletScore: number;
  walletConfidence: string;
  tokenOutcomeCount: number;
  avgTokenReturnPct: number;
  worstTokenReturnPct: number;
  tokenHitRate: number;
  persistenceRuns: number;
  watchPersistenceRuns: number;
  candidatePersistenceRuns: number;
  sampleGrowth: number;
  signalKeys?: string[];
}

export interface WalletDecisionHistoryInput {
  walletEvidence?: WalletEvidence[];
}

export interface WalletDecision {
  leadingWallet: string | null;
  leadingWalletVerdict: WalletVerdict | null;
  leadingWalletStreak: number;
  leadingWalletSampleGrowth: number;
  watchWallet: string | null;
  validatedWallet: string | null;
  walletEvidence: WalletEvidence[];
  reason: string;
}

export function evaluateWallet(wallet: WalletValidationInput): WalletVerdict {
  if (wallet.labels.includes("fast churn seller")) return "reject";

  const isCandidate =
    wallet.walletConfidence === "high" &&
    wallet.walletScore >= 70 &&
    wallet.tokenOutcomeCount >= 4 &&
    wallet.avgTokenReturnPct >= 8 &&
    wallet.tokenHitRate >= 0.6 &&
    wallet.worstTokenReturnPct >= -30;
  if (isCandidate) return "candidate";

  const isWatch =
    (wallet.walletConfidence === "medium" || wallet.walletConfidence === "high") &&
    wallet.walletScore >= 60 &&
    wallet.tokenOutcomeCount >= 3 &&
    wallet.avgTokenReturnPct >= 3 &&
    wallet.tokenHitRate >= 0.5 &&
    wallet.worstTokenReturnPct >= -40;
  return isWatch ? "watch" : "reject";
}

export function buildWalletDecision(
  wallets: WalletValidationInput[],
  history: WalletDecisionHistoryInput[]
): WalletDecision {
  const ranked = wallets
    .map((wallet) => {
      const verdict = evaluateWallet(wallet);
      const watchPersistenceRuns =
        verdict === "reject"
          ? 0
          : 1 + countConsecutiveEvidence(history, wallet.wallet, ["candidate", "watch"]);
      const candidatePersistenceRuns =
        verdict === "candidate"
          ? 1 + countConsecutiveEvidence(history, wallet.wallet, ["candidate"])
          : 0;
      const persistenceRuns =
        verdict === "candidate" ? candidatePersistenceRuns : Math.max(watchPersistenceRuns, 1);
      const acceptedVerdicts: WalletVerdict[] =
        verdict === "candidate" ? ["candidate"] : ["candidate", "watch"];
      const signalKeys = wallet.matureSignalKeys
        ? [...new Set(wallet.matureSignalKeys)]
        : undefined;
      const sampleGrowth = walletSampleGrowth(history, wallet.wallet, signalKeys, acceptedVerdicts);
      return {
        wallet: wallet.wallet,
        verdict,
        walletScore: wallet.walletScore,
        walletConfidence: wallet.walletConfidence,
        tokenOutcomeCount: wallet.tokenOutcomeCount,
        avgTokenReturnPct: wallet.avgTokenReturnPct,
        worstTokenReturnPct: wallet.worstTokenReturnPct,
        tokenHitRate: wallet.tokenHitRate,
        persistenceRuns,
        watchPersistenceRuns,
        candidatePersistenceRuns,
        sampleGrowth,
        ...(signalKeys ? { signalKeys } : {})
      } satisfies WalletEvidence;
    })
    .sort(
      (a, b) =>
        verdictRank(b.verdict) - verdictRank(a.verdict) ||
        b.tokenOutcomeCount - a.tokenOutcomeCount ||
        b.walletScore - a.walletScore ||
        b.avgTokenReturnPct - a.avgTokenReturnPct
    );

  const validated = ranked.find(
    (wallet) =>
      wallet.verdict === "candidate" &&
      wallet.candidatePersistenceRuns >= 3 &&
      wallet.sampleGrowth >= 1
  );
  const watch = ranked.find(
    (wallet) =>
      wallet.wallet !== validated?.wallet &&
      wallet.verdict !== "reject" &&
      wallet.watchPersistenceRuns >= 2
  );
  const meaningfulRanked = ranked.filter((wallet) => wallet.tokenOutcomeCount >= 3);
  const leading = meaningfulRanked[0];
  const walletEvidence = [
    ...meaningfulRanked.filter((wallet) => wallet.verdict !== "reject"),
    ...meaningfulRanked.filter((wallet) => wallet.verdict === "reject").slice(0, 5)
  ].slice(0, 20);

  let reason = "No wallet has enough repeated, outcome-adjusted evidence yet.";
  if (validated) {
    reason = `${validated.wallet} held candidate quality for ${validated.persistenceRuns} consecutive runs and added ${validated.sampleGrowth} new mature token outcomes.`;
  } else if (watch) {
    reason = `${watch.wallet} held watch quality for ${watch.watchPersistenceRuns} consecutive runs with ${watch.sampleGrowth} new mature token outcomes; it is not validated.`;
  } else if (leading?.verdict === "candidate") {
    reason = `${leading.wallet} has candidate-level current metrics, but has ${leading.persistenceRuns}/3 required consecutive runs and ${leading.sampleGrowth}/1 required new mature outcomes.`;
  } else if (leading?.verdict === "watch") {
    reason = `${leading.wallet} has watch-level current metrics, but only ${leading.persistenceRuns}/2 required consecutive runs.`;
  }

  return {
    leadingWallet: leading?.wallet ?? null,
    leadingWalletVerdict: leading?.verdict ?? null,
    leadingWalletStreak: leading?.persistenceRuns ?? 0,
    leadingWalletSampleGrowth: leading?.sampleGrowth ?? 0,
    watchWallet: watch?.wallet ?? null,
    validatedWallet: validated?.wallet ?? null,
    walletEvidence,
    reason
  };
}

function walletSampleGrowth(
  history: WalletDecisionHistoryInput[],
  wallet: string,
  currentSignalKeys: string[] | undefined,
  acceptedVerdicts: WalletVerdict[]
): number {
  if (!currentSignalKeys) return 0;

  let baselineKeys: Set<string> | null = null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const evidence = history[index]?.walletEvidence?.find((item) => item.wallet === wallet);
    if (!evidence || !acceptedVerdicts.includes(evidence.verdict)) break;
    if (evidence.signalKeys) baselineKeys = new Set(evidence.signalKeys);
  }

  return baselineKeys ? currentSignalKeys.filter((key) => !baselineKeys.has(key)).length : 0;
}

function countConsecutiveEvidence(
  history: WalletDecisionHistoryInput[],
  wallet: string,
  acceptedVerdicts: WalletVerdict[]
): number {
  let count = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const evidence = history[index]?.walletEvidence?.find((item) => item.wallet === wallet);
    if (!evidence || !acceptedVerdicts.includes(evidence.verdict)) break;
    count += 1;
  }
  return count;
}

function verdictRank(verdict: WalletVerdict): number {
  return verdict === "candidate" ? 2 : verdict === "watch" ? 1 : 0;
}
