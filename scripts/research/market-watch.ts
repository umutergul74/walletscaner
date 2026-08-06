import "dotenv/config";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { clamp, round } from "@memecoin-alpha/shared";
import { PostgresRepository } from "@memecoin-alpha/db";
import { evaluateAndSaveWalletOutcome } from "@memecoin-alpha/core";
import {
  buildHypothesisDecision,
  type HypothesisOutcome,
  type HypothesisSnapshot,
  type HypothesisVerdict
} from "./hypothesis-validation.js";
import { summarizeReturns } from "./robust-stats.js";
import { dedupeSignalsByToken } from "./signal-cohorts.js";
import {
  evaluateFixedHorizon,
  simulatePaperExitPath,
  type PaperExitConfig
} from "./market-watch-evaluation.js";
import { decideMarketWatchMode } from "./market-watch-decision.js";
import { calculateWalletSignalOutcomes, type ObservedWalletSignal } from "./wallet-outcomes.js";
import {
  buildWalletDecision,
  evaluateWallet,
  type WalletEvidence,
  type WalletVerdict
} from "./wallet-validation.js";
import { main as runLiveAlphaModule } from "./live-solana-alpha.js";
import {
  buildCanonicalEvidenceReport,
  renderCanonicalEvidenceMarkdown
} from "./evidence-report-builder.js";

interface LiveCandidate {
  tokenAddress: string;
  symbol: string;
  name: string;
  pairAddress: string;
  dexId: string;
  url?: string;
  liquidityUsd: number;
  volume5mUsd: number;
  volume1hUsd: number;
  buys5m: number;
  sells5m: number;
  buys1h: number;
  sells1h: number;
  priceChange5m: number;
  priceChange1h: number;
  ageMinutes: number | null;
  priceUsd: number;
  tractionScore: number;
}

interface LiveWalletAggregate {
  wallet: string;
  tokensTouched: number;
  earlyBuys: number;
  labels: string[];
  events: Array<{
    tokenAddress: string;
    tokenSymbol: string;
    side: "buy" | "sell";
    rank: number;
    signature?: string;
    slot?: number;
    blockTime?: number;
  }>;
}

interface LiveWalletHistory {
  wallet: string;
  uniqueMintsBought: number;
  pumpMintsBought: number;
  historyScore: number;
  labels: string[];
}

interface LiveReport {
  runAt: string;
  candidates: LiveCandidate[];
  walletAggregates: LiveWalletAggregate[];
  walletHistory?: LiveWalletHistory[];
}

interface Observation {
  observedAt: string;
  priceUsd: number;
  liquidityUsd: number;
  volume5mUsd: number;
  volume1hUsd: number;
  buys5m: number;
  sells5m: number;
  priceChange5m?: number;
  priceChange1h?: number;
  pairAgeMinutes?: number | null;
  tractionScore: number;
  walletEventCount: number;
  crossTokenWalletCount: number;
  activeDegenWalletCount: number;
  methodTags: string[];
}

interface TokenTrack {
  tokenAddress: string;
  symbol: string;
  name: string;
  pairAddress: string;
  dexId: string;
  url?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  firstPriceUsd: number;
  firstLiquidityUsd: number;
  firstTractionScore: number;
  observations: Observation[];
}

interface WalletTrack {
  wallet: string;
  firstSeenAt: string;
  lastSeenAt: string;
  tokens: string[];
  labels: string[];
  signalCount: number;
  signalKeys?: string[];
  walletSignals?: ObservedWalletSignal[];
  pumpMintsBought?: number;
  uniqueMintsBought?: number;
  historyScore?: number;
}

interface DecisionHistoryEntry {
  runAt: string;
  mode: string;
  bestMethod: string;
  leadingMethod: string;
  leadingRule: string | null;
  watchRule: string | null;
  validatedRule: string | null;
  leadingPaperExit: string | null;
  watchPaperExit: string | null;
  validatedPaperExit: string | null;
  topRuleVerdict: string | null;
  topRuleAvgReturn: number | null;
  topRuleMedianReturn?: number | null;
  topRuleAvgReturnExBest?: number | null;
  topRuleWorstReturn: number | null;
  topPaperExitVerdict: string | null;
  topPaperExitAvgReturn: number | null;
  topPaperExitWorstReturn: number | null;
  topWallet: string | null;
  topWalletConfidence: string | null;
  leadingWallet?: string | null;
  leadingWalletVerdict?: WalletVerdict | null;
  leadingWalletStreak?: number;
  leadingWalletSampleGrowth?: number;
  watchWallet?: string | null;
  validatedWallet?: string | null;
  walletMatureOutcomeCount?: number;
  walletProvisionalOutcomeCount?: number;
  walletUnresolvedOutcomeCount?: number;
  walletsWithAtLeast3MatureOutcomes?: number;
  walletEvidence?: WalletEvidence[];
  methodEvidence?: HypothesisSnapshot[];
  ruleEvidence?: HypothesisSnapshot[];
  paperExitEvidence?: HypothesisSnapshot[];
}

interface MarketWatchState {
  evidenceSemanticsVersion?: string;
  updatedAt: string;
  runs: Array<{ runAt: string; tokensTracked: number; walletsTracked: number; bestMethod: string }>;
  decisionHistory?: DecisionHistoryEntry[];
  tokens: Record<string, TokenTrack>;
  wallets: Record<string, WalletTrack>;
}

interface ScoredToken {
  token: TokenTrack;
  latest: Observation;
  returnPct: number;
  maxReturnPct: number;
  minReturnPct: number;
  ageMinutes: number;
  durabilityScore: number;
}

interface ScoredWallet extends WalletTrack {
  avgTokenReturnPct: number;
  bestTokenReturnPct: number;
  worstTokenReturnPct: number;
  tokenHitRate: number;
  tokenOutcomeCount: number;
  provisionalOutcomeCount: number;
  unresolvedOutcomeCount: number;
  provisionalAvgTokenReturnPct: number;
  maxObservedEntryAgeMinutes: number;
  walletOutcomeHorizonMinutes: number;
  legacySignalCount: number;
  observedEntryCount: number;
  matureSignalKeys: string[];
  walletConfidence: "early" | "medium" | "high";
  walletScore: number;
}

interface MethodSignal {
  method: string;
  tokenAddress: string;
  symbol: string;
  signalAt: string;
  signalPriceUsd: number;
  signalLiquidityUsd: number;
  signalVolume5mUsd: number;
  signalBuyRatio: number;
  signalPriceChange5m: number | null;
  signalPriceChange1h: number | null;
  signalPairAgeMinutes: number | null;
  signalVolumeLiquidityRatio: number;
  signalWalletEventCount: number;
  signalCrossTokenWalletCount: number;
  signalActiveDegenWalletCount: number;
  signalTractionScore: number;
  latestAt: string;
  latestPriceUsd: number;
  returnPct: number;
  maxReturnPct: number;
  minReturnPct: number;
  ageMinutes: number;
  observationsAfterSignal: number;
  liquidityUsd: number;
  buyRatio: number;
  methodTags: string[];
}

interface RuleCandidate {
  rule: string;
  description: string;
  signalCount: number;
  avgReturn: number;
  medianReturn: number;
  avgReturnExBest: number;
  bestWinnerShare: number;
  hitRate: number;
  avgDrawdown: number;
  avgMaxReturn: number;
  bestReturn: number;
  worstReturn: number;
  sampleConfidence: number;
  evidenceScore: number;
  verdict: "reject" | "watch" | "candidate";
  signalKeys: string[];
  signalOutcomes: HypothesisOutcome[];
}

interface SignalPath extends MethodSignal {
  returnPath: Array<{ observedAt: string; minutesSinceSignal: number; returnPct: number }>;
}

interface PaperExitCandidate {
  strategy: string;
  cohort: string;
  description: string;
  totalSignalCount: number;
  signalCount: number;
  provisionalSignalCount: number;
  grossAvgReturn: number;
  estimatedRoundTripCostPct: number;
  avgReturn: number;
  medianReturn: number;
  avgReturnExBest: number;
  bestWinnerShare: number;
  hitRate: number;
  takeProfitRate: number;
  stopLossRate: number;
  timeoutRate: number;
  latestRate: number;
  bestReturn: number;
  worstReturn: number;
  sampleConfidence: number;
  evidenceScore: number;
  verdict: "reject" | "watch" | "candidate";
  parentVerdict: HypothesisVerdict;
  decisionVerdict: HypothesisVerdict;
  signalKeys: string[];
  signalOutcomes: HypothesisOutcome[];
}

const REPORT_DIR = "reports";
const LIVE_REPORT_PATH = `${REPORT_DIR}/live-alpha-latest.json`;
const STATE_PATH = `${REPORT_DIR}/market-watch-state.json`;
const JSON_REPORT_PATH = `${REPORT_DIR}/market-watch-latest.json`;
const MD_REPORT_PATH = `${REPORT_DIR}/market-watch-latest.md`;
const DEX_BASE = process.env.DEXSCREENER_BASE_URL ?? "https://api.dexscreener.com";
const RUN_LIVE_SCAN = (process.env.MARKET_WATCH_RUN_SCAN ?? "true") === "true";
const CYCLES = Number(process.env.MARKET_WATCH_CYCLES ?? 1);
const INTERVAL_SECONDS = Number(process.env.MARKET_WATCH_INTERVAL_SECONDS ?? 300);
const MAX_TRACKED_REFRESH = Number(process.env.MARKET_WATCH_REFRESH_TOKENS ?? 40);
const DEX_TIMEOUT_MS = Number(process.env.MARKET_WATCH_DEX_TIMEOUT_MS ?? 12_000);
const PAPER_ROUND_TRIP_COST_PCT = Number(process.env.MARKET_WATCH_PAPER_ROUND_TRIP_COST_PCT ?? 3);
const WALLET_OUTCOME_HORIZON_MINUTES = Number(
  process.env.MARKET_WATCH_WALLET_OUTCOME_HORIZON_MINUTES ?? 20
);
const WALLET_OUTCOME_MAX_DELAY_MINUTES = Number(
  process.env.MARKET_WATCH_WALLET_OUTCOME_MAX_DELAY_MINUTES ?? 20
);
const STRATEGY_VERSION = process.env.ALPHA_STRATEGY_VERSION ?? "evidence-v1";
const MARKET_WATCH_EVIDENCE_SEMANTICS = "fixed-20m-net-parent-gated-source-linked-v2";
const DATABASE_URL = process.env.DATABASE_URL;
const EVIDENCE_JSON_REPORT_PATH = `${REPORT_DIR}/evidence-latest.json`;
const EVIDENCE_MD_REPORT_PATH = `${REPORT_DIR}/evidence-latest.md`;

async function main() {
  await mkdir(REPORT_DIR, { recursive: true });

  const infinite = CYCLES <= 0;
  for (let cycle = 0; infinite || cycle < CYCLES; cycle += 1) {
    try {
      if (RUN_LIVE_SCAN) await runLiveAlpha();
      await updateMarketWatch();
    } catch (err: unknown) {
      console.error(`Error in market-watch cycle ${cycle}:`, errorMessage(err));
    }

    if (infinite || cycle < CYCLES - 1) {
      await sleep(INTERVAL_SECONDS * 1000);
    }
  }
}

async function updateMarketWatch() {
  const liveReport = JSON.parse(await readFile(LIVE_REPORT_PATH, "utf8")) as LiveReport;
  const state = await readState();
  const observedAt = new Date().toISOString();
  const methodMaps = buildMethodMaps(liveReport);

  if (RUN_LIVE_SCAN) {
    for (const candidate of liveReport.candidates) {
      upsertTokenObservation(state, candidate, observedAt, methodMaps);
    }
  }

  const refreshTokens = Object.values(state.tokens)
    .sort((a, b) => new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime())
    .slice(0, MAX_TRACKED_REFRESH);

  for (const token of refreshTokens) {
    if (
      RUN_LIVE_SCAN &&
      liveReport.candidates.some((candidate) => candidate.tokenAddress === token.tokenAddress)
    ) {
      continue;
    }
    const current = await fetchCurrentCandidate(token).catch(() => undefined);
    if (!current) continue;
    const latest = token.observations[token.observations.length - 1];
    upsertTokenObservation(state, current, observedAt, {
      tokenTags: new Map([[token.tokenAddress, latest?.methodTags ?? ["high-traction"]]]),
      walletEventCounts: new Map([[token.tokenAddress, latest?.walletEventCount ?? 0]])
    });
    await sleep(120);
  }

  if (RUN_LIVE_SCAN) {
    updateWalletTracks(state, liveReport, observedAt);
  }
  const scored = scoreTokens(state);
  const methodSignals = buildMethodSignals(state);
  const methodSummary = summarizeMethods(methodSignals);
  const ruleCandidates = buildRuleCandidates(methodSignals);
  const hasWalletQuality = methodSignals.some((signal) => signal.method !== "high-traction");
  const paperExitCandidates = buildPaperExitCandidates(
    state,
    methodSummary,
    ruleCandidates,
    hasWalletQuality
  );
  const methodDecision = buildHypothesisDecision(
    methodSummary.map((method) => {
      const signals = dedupeSignalsByToken(
        methodSignals.filter((signal) => signal.method === method.method)
      );
      return {
        key: method.method,
        verdict: classifyMethodHypothesis(method, hasWalletQuality),
        signalCount: method.tokenCount,
        signalKeys: signals.map((signal) => signal.tokenAddress),
        outcomes: signals.map((signal) => ({
          key: signal.tokenAddress,
          returnPct: signal.returnPct
        }))
      };
    }),
    (state.decisionHistory ?? []).map((entry) => ({
      runAt: entry.runAt,
      ...(entry.methodEvidence ? { evidence: entry.methodEvidence } : {})
    })),
    observedAt
  );
  const ruleDecision = buildHypothesisDecision(
    ruleCandidates.map((rule) => ({
      key: rule.rule,
      verdict: rule.verdict,
      signalCount: rule.signalCount,
      signalKeys: rule.signalKeys,
      outcomes: rule.signalOutcomes
    })),
    (state.decisionHistory ?? []).map((entry) => ({
      runAt: entry.runAt,
      ...(entry.ruleEvidence ? { evidence: entry.ruleEvidence } : {})
    })),
    observedAt
  );
  const paperExitDecision = buildHypothesisDecision(
    paperExitCandidates.map((paperExit) => ({
      key: paperExitKey(paperExit),
      verdict: paperExit.decisionVerdict,
      signalCount: paperExit.signalCount,
      signalKeys: paperExit.signalKeys,
      outcomes: paperExit.signalOutcomes
    })),
    (state.decisionHistory ?? []).map((entry) => ({
      runAt: entry.runAt,
      ...(entry.paperExitEvidence ? { evidence: entry.paperExitEvidence } : {})
    })),
    observedAt
  );
  const scoredWallets = scoreWallets(state, scored, observedAt).map((wallet) => ({
    ...wallet,
    walletVerdict: evaluateWallet(wallet)
  }));
  const walletOutcomeStats = summarizeWalletOutcomes(scoredWallets);
  const walletDecision = buildWalletDecision(scoredWallets, state.decisionHistory ?? []);
  const canonicalReplayPassed = await loadCanonicalReplayStatus();
  const decisionStatus = buildDecisionStatus(
    methodSummary,
    ruleCandidates,
    paperExitCandidates,
    methodSignals,
    methodDecision,
    ruleDecision,
    paperExitDecision,
    walletDecision,
    walletOutcomeStats,
    canonicalReplayPassed,
    state.runs.length + 1
  );
  const leadingMethod = methodSummary[0]?.method ?? "insufficient evidence";
  const bestMethod = decisionStatus.validatedMethod ?? "none";
  const topWallets = scoredWallets.slice(0, 20);
  const nearWalletCandidates = buildNearWalletCandidates(scoredWallets).slice(0, 20);

  // Prune old tokens and wallets to keep the state size small and prevent memory bloat
  const pruneCutoffTokens = new Date(new Date(observedAt).getTime() - 6 * 60 * 60 * 1000); // 6 hours
  const pruneCutoffWallets = new Date(new Date(observedAt).getTime() - 24 * 60 * 60 * 1000); // 24 hours

  for (const [tokenAddress, token] of Object.entries(state.tokens)) {
    if (new Date(token.lastSeenAt).getTime() < pruneCutoffTokens.getTime()) {
      delete state.tokens[tokenAddress];
    }
  }

  for (const [walletAddress, wallet] of Object.entries(state.wallets)) {
    if (new Date(wallet.lastSeenAt).getTime() < pruneCutoffWallets.getTime()) {
      delete state.wallets[walletAddress];
    }
  }

  state.updatedAt = observedAt;
  state.evidenceSemanticsVersion = MARKET_WATCH_EVIDENCE_SEMANTICS;
  state.runs.push({
    runAt: observedAt,
    tokensTracked: Object.keys(state.tokens).length,
    walletsTracked: Object.keys(state.wallets).length,
    bestMethod
  });
  state.runs = state.runs.slice(-200);
  recordDecisionHistory(state, {
    observedAt,
    bestMethod,
    leadingMethod,
    decisionStatus,
    ruleCandidates,
    paperExitCandidates,
    topWallets,
    walletOutcomeStats,
    walletDecision,
    methodDecision,
    ruleDecision,
    paperExitDecision
  });

  const reportCore = {
    generatedAt: observedAt,
    bestMethod,
    leadingMethod,
    methodSummary,
    methodDecision,
    ruleCandidates,
    paperExitCandidates,
    ruleDecision,
    paperExitDecision,
    methodSignals: methodSignals.slice(0, 25),
    topTokens: scored.slice(0, 15),
    topWallets,
    nearWalletCandidates,
    walletOutcomeStats,
    walletDecision,
    decisionStatus,
    decisionHistory: state.decisionHistory?.slice(-30).reverse() ?? [],
    stateStats: {
      tokensTracked: Object.keys(state.tokens).length,
      walletsTracked: Object.keys(state.wallets).length,
      runs: state.runs.length
    },
    ruleSet: buildRuleSet(methodSummary)
  };
  const evidencePersistence = await persistCanonicalEvidence({
    liveReport,
    state,
    observedAt,
    methodSummary,
    methodSignals,
    ruleCandidates,
    paperExitCandidates
  });
  const report = {
    ...reportCore,
    evidencePersistence
  };

  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
  await writeFile(JSON_REPORT_PATH, JSON.stringify(report, null, 2));
  await writeFile(MD_REPORT_PATH, renderMarkdown(report));

  console.log(
    JSON.stringify(
      {
        generatedAt: observedAt,
        bestMethod,
        leadingMethod,
        topRule: ruleCandidates[0]
          ? `${ruleCandidates[0].rule} avg=${ruleCandidates[0].avgReturn}%`
          : null,
        topPaperExit: paperExitCandidates[0]
          ? `${paperExitCandidates[0].strategy} ${paperExitCandidates[0].cohort} avg=${paperExitCandidates[0].avgReturn}%`
          : null,
        tokensTracked: report.stateStats.tokensTracked,
        walletsTracked: report.stateStats.walletsTracked,
        topToken: report.topTokens[0]
          ? `${report.topTokens[0].token.symbol} return=${report.topTokens[0].returnPct}%`
          : null,
        reports: [JSON_REPORT_PATH, MD_REPORT_PATH, STATE_PATH]
      },
      null,
      2
    )
  );
}

async function persistCanonicalEvidence(input: {
  liveReport: LiveReport;
  state: MarketWatchState;
  observedAt: string;
  methodSummary: ReturnType<typeof summarizeMethods>;
  methodSignals: MethodSignal[];
  ruleCandidates: RuleCandidate[];
  paperExitCandidates: PaperExitCandidate[];
}) {
  if (!DATABASE_URL) {
    return {
      status: "degraded" as const,
      reason:
        "DATABASE_URL is not configured; canonical PostgreSQL evidence report was not generated."
    };
  }

  try {
    const repository = new PostgresRepository(DATABASE_URL);
    const eventsByToken = new Map<string, LiveWalletAggregate["events"]>();
    for (const aggregate of input.liveReport.walletAggregates ?? []) {
      for (const event of aggregate.events ?? []) {
        const events = eventsByToken.get(event.tokenAddress) ?? [];
        events.push(event);
        eventsByToken.set(event.tokenAddress, events);
      }
    }

    for (const token of Object.values(input.state.tokens)) {
      const latest = token.observations[token.observations.length - 1];
      if (!latest || latest.observedAt !== input.observedAt || latest.priceUsd <= 0) continue;
      const tokenEvents = eventsByToken.get(token.tokenAddress) ?? [];
      const slot = Math.max(...tokenEvents.map((event) => event.slot ?? 0), 0);
      const signature = `market-price:${token.tokenAddress}:${input.observedAt}`;
      const previous = token.observations[token.observations.length - 2];
      await repository.savePriceObservation({
        idempotencyKey: createHash("sha256").update(signature).digest("hex"),
        chain: "solana",
        tokenAddress: token.tokenAddress,
        poolAddress: token.pairAddress,
        priceUsd: latest.priceUsd,
        liquidityUsd: latest.liquidityUsd,
        rugged: Boolean(previous && previous.liquidityUsd > 0 && latest.liquidityUsd <= 0),
        signature,
        slot,
        provider: "dexscreener",
        observedAt: input.observedAt,
        strategyVersion: STRATEGY_VERSION,
        raw: { ...latest }
      });
    }

    const minObservedTime = new Date(
      new Date(input.observedAt).getTime() - 45 * 60 * 1000
    ).toISOString();
    const entries = await repository.listWalletEntrySignals(
      undefined,
      STRATEGY_VERSION,
      minObservedTime
    );
    const prices = await repository.listPriceObservations(
      undefined,
      STRATEGY_VERSION,
      minObservedTime
    );
    const pricesByToken = new Map<string, typeof prices>();
    for (const observation of prices) {
      const tokenPrices = pricesByToken.get(observation.tokenAddress) ?? [];
      tokenPrices.push(observation);
      pricesByToken.set(observation.tokenAddress, tokenPrices);
    }
    for (const entry of entries) {
      const tokenPrices = pricesByToken.get(entry.tokenAddress) ?? [];
      await evaluateAndSaveWalletOutcome(repository, entry, tokenPrices, input.observedAt, {
        horizonMinutes: WALLET_OUTCOME_HORIZON_MINUTES,
        maxDelayMinutes: WALLET_OUTCOME_MAX_DELAY_MINUTES,
        estimatedRoundTripCostPct: PAPER_ROUND_TRIP_COST_PCT,
        exitStrategy: "fixed-horizon"
      });
      await evaluateAndSaveWalletOutcome(repository, entry, tokenPrices, input.observedAt, {
        horizonMinutes: WALLET_OUTCOME_HORIZON_MINUTES,
        maxDelayMinutes: WALLET_OUTCOME_MAX_DELAY_MINUTES,
        estimatedRoundTripCostPct: PAPER_ROUND_TRIP_COST_PCT,
        exitStrategy: "tp15-sl20-20m"
      });
    }

    const maxSlot = Math.max(
      ...[...eventsByToken.values()].flat().map((event) => event.slot ?? 0),
      0
    );
    for (const method of input.methodSummary) {
      const signals = dedupeSignalsByToken(
        input.methodSignals.filter((signal) => signal.method === method.method)
      );
      await saveHypothesisEvidence(repository, {
        key: `method:${method.method}`,
        cohort: method.method,
        verdict: classifyMethodHypothesis(
          method,
          input.methodSignals.some((signal) => signal.method !== "high-traction")
        ),
        signalKeys: signals.map((signal) => signal.tokenAddress),
        metrics: {
          signalCount: method.tokenCount,
          averageReturnPct: method.avgReturn,
          medianReturnPct: method.medianReturn,
          averageReturnExBestPct: method.avgReturnExBest,
          bestWinnerShare: method.bestWinnerShare,
          hitRate: method.hitRate,
          averageDrawdownPct: method.avgDrawdown,
          worstReturnPct: method.worstReturn
        },
        observedAt: input.observedAt,
        slot: maxSlot
      });
    }
    for (const rule of input.ruleCandidates) {
      await saveHypothesisEvidence(repository, {
        key: `rule:${rule.rule}`,
        cohort: rule.rule,
        verdict: rule.verdict,
        signalKeys: rule.signalKeys,
        metrics: {
          signalCount: rule.signalCount,
          averageReturnPct: rule.avgReturn,
          medianReturnPct: rule.medianReturn,
          averageReturnExBestPct: rule.avgReturnExBest,
          bestWinnerShare: rule.bestWinnerShare,
          hitRate: rule.hitRate,
          averageDrawdownPct: rule.avgDrawdown,
          worstReturnPct: rule.worstReturn
        },
        observedAt: input.observedAt,
        slot: maxSlot
      });
    }
    for (const paperExit of input.paperExitCandidates) {
      await saveHypothesisEvidence(repository, {
        key: `paper:${paperExitKey(paperExit)}`,
        cohort: paperExit.cohort,
        verdict: paperExit.decisionVerdict,
        signalKeys: paperExit.signalKeys,
        metrics: {
          signalCount: paperExit.signalCount,
          totalObservedSignalCount: paperExit.totalSignalCount,
          provisionalSignalCount: paperExit.provisionalSignalCount,
          averageReturnPct: paperExit.avgReturn,
          medianReturnPct: paperExit.medianReturn,
          averageReturnExBestPct: paperExit.avgReturnExBest,
          bestWinnerShare: paperExit.bestWinnerShare,
          hitRate: paperExit.hitRate,
          averageDrawdownPct: 0,
          worstReturnPct: paperExit.worstReturn,
          grossAverageReturnPct: paperExit.grossAvgReturn,
          estimatedRoundTripCostPct: paperExit.estimatedRoundTripCostPct
        },
        observedAt: input.observedAt,
        slot: maxSlot
      });
    }

    const canonicalReport = await buildCanonicalEvidenceReport(
      repository,
      STRATEGY_VERSION,
      {
        providerStatus: /api\.mainnet-beta\.solana\.com/i.test(process.env.SOLANA_RPC_URL ?? "")
          ? "degraded"
          : "ok"
      },
      input.observedAt
    );
    await writeFile(EVIDENCE_JSON_REPORT_PATH, JSON.stringify(canonicalReport, null, 2));
    await writeFile(EVIDENCE_MD_REPORT_PATH, renderCanonicalEvidenceMarkdown(canonicalReport));
    return {
      status: "ok" as const,
      canonicalReport: EVIDENCE_JSON_REPORT_PATH,
      recommendedMode: canonicalReport.recommendedMode,
      goalCompleted: canonicalReport.goalCompletionAudit.completed
    };
  } catch (error) {
    return {
      status: "down" as const,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

async function saveHypothesisEvidence(
  repository: PostgresRepository,
  input: {
    key: string;
    cohort: string;
    verdict: HypothesisVerdict;
    signalKeys: string[];
    metrics: {
      signalCount: number;
      averageReturnPct: number;
      medianReturnPct: number;
      averageReturnExBestPct: number;
      bestWinnerShare: number;
      hitRate: number;
      averageDrawdownPct: number;
      worstReturnPct: number;
      [key: string]: number;
    };
    observedAt: string;
    slot: number;
  }
) {
  const runId = createHash("sha256")
    .update(`${STRATEGY_VERSION}:${input.key}:${input.observedAt}`)
    .digest("hex")
    .slice(0, 24);
  await repository.saveHypothesisRun({
    idempotencyKey: `hypothesis:${runId}`,
    runId,
    chain: "solana",
    hypothesisKey: input.key,
    cohort: input.cohort,
    verdict: input.verdict,
    signalKeys: [...new Set(input.signalKeys)],
    metrics: { ...input.metrics, canonicalSourceLinked: 0 },
    decisionReason:
      "Exploratory market-watch evidence only; it is not source-swap-linked canonical evidence.",
    signature: `derived:${runId}`,
    slot: input.slot,
    provider: "market-watch-exploratory",
    observedAt: input.observedAt,
    strategyVersion: STRATEGY_VERSION
  });
}

function upsertTokenObservation(
  state: MarketWatchState,
  candidate: LiveCandidate,
  observedAt: string,
  methodMaps: { tokenTags: Map<string, string[]>; walletEventCounts: Map<string, number> }
) {
  const existing = state.tokens[candidate.tokenAddress];
  const tags = methodMaps.tokenTags.get(candidate.tokenAddress) ?? ["high-traction"];
  const observation: Observation = {
    observedAt,
    priceUsd: candidate.priceUsd,
    liquidityUsd: candidate.liquidityUsd,
    volume5mUsd: candidate.volume5mUsd,
    volume1hUsd: candidate.volume1hUsd,
    buys5m: candidate.buys5m,
    sells5m: candidate.sells5m,
    priceChange5m: candidate.priceChange5m,
    priceChange1h: candidate.priceChange1h,
    pairAgeMinutes: candidate.ageMinutes,
    tractionScore: candidate.tractionScore,
    walletEventCount: methodMaps.walletEventCounts.get(candidate.tokenAddress) ?? 0,
    crossTokenWalletCount: tags.includes("cross-token-wallet") ? 1 : 0,
    activeDegenWalletCount: tags.includes("active-degen-history") ? 1 : 0,
    methodTags: tags
  };

  if (!existing) {
    state.tokens[candidate.tokenAddress] = {
      tokenAddress: candidate.tokenAddress,
      symbol: candidate.symbol,
      name: candidate.name,
      pairAddress: candidate.pairAddress,
      dexId: candidate.dexId,
      ...(candidate.url ? { url: candidate.url } : {}),
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      firstPriceUsd: candidate.priceUsd,
      firstLiquidityUsd: candidate.liquidityUsd,
      firstTractionScore: candidate.tractionScore,
      observations: [observation]
    };
    return;
  }

  existing.symbol = candidate.symbol;
  existing.name = candidate.name;
  existing.lastSeenAt = observedAt;
  existing.observations.push(observation);
  existing.observations = existing.observations.slice(-100);
}

function updateWalletTracks(state: MarketWatchState, liveReport: LiveReport, observedAt: string) {
  const historyByWallet = new Map(
    (liveReport.walletHistory ?? []).map((wallet) => [wallet.wallet, wallet])
  );
  const candidateByToken = new Map(
    liveReport.candidates.map((candidate) => [candidate.tokenAddress, candidate])
  );

  for (const aggregate of liveReport.walletAggregates ?? []) {
    const current = state.wallets[aggregate.wallet] ?? {
      wallet: aggregate.wallet,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      tokens: [],
      labels: [],
      signalCount: 0,
      signalKeys: [],
      walletSignals: []
    };
    const history = historyByWallet.get(aggregate.wallet);
    const signalKeys = new Set(current.signalKeys ?? []);
    const walletSignals = [...(current.walletSignals ?? [])];
    const observedSignalTokens = new Set(walletSignals.map((signal) => signal.tokenAddress));
    current.lastSeenAt = observedAt;
    current.tokens = [
      ...new Set([...current.tokens, ...aggregate.events.map((event) => event.tokenAddress)])
    ];
    current.labels = [
      ...new Set([...current.labels, ...aggregate.labels, ...(history?.labels ?? [])])
    ];
    for (const event of aggregate.events ?? []) {
      if (event.side !== "buy") continue;
      signalKeys.add(`${event.tokenAddress}:buy`);
      const candidate = candidateByToken.get(event.tokenAddress);
      if (!observedSignalTokens.has(event.tokenAddress) && candidate && candidate.priceUsd > 0) {
        walletSignals.push({
          tokenAddress: event.tokenAddress,
          observedAt,
          observedEntryPriceUsd: candidate.priceUsd,
          observedLiquidityUsd: candidate.liquidityUsd
        });
        observedSignalTokens.add(event.tokenAddress);
      }
    }
    current.signalKeys = [...signalKeys];
    current.walletSignals = walletSignals;
    current.signalCount = walletSignals.length;
    if (history) {
      current.pumpMintsBought = history.pumpMintsBought;
      current.uniqueMintsBought = history.uniqueMintsBought;
      current.historyScore = history.historyScore;
    }
    state.wallets[aggregate.wallet] = current;
  }
}

function recordDecisionHistory(
  state: MarketWatchState,
  report: {
    observedAt: string;
    bestMethod: string;
    leadingMethod: string;
    decisionStatus: ReturnType<typeof buildDecisionStatus>;
    ruleCandidates: RuleCandidate[];
    paperExitCandidates: PaperExitCandidate[];
    topWallets: Array<ScoredWallet & { walletVerdict: WalletVerdict }>;
    walletOutcomeStats: ReturnType<typeof summarizeWalletOutcomes>;
    walletDecision: ReturnType<typeof buildWalletDecision>;
    methodDecision: ReturnType<typeof buildHypothesisDecision>;
    ruleDecision: ReturnType<typeof buildHypothesisDecision>;
    paperExitDecision: ReturnType<typeof buildHypothesisDecision>;
  }
) {
  const topRule = report.ruleCandidates[0];
  const topPaperExit = report.paperExitCandidates[0];
  const topWallet = report.topWallets[0];

  state.decisionHistory = [
    ...(state.decisionHistory ?? []),
    {
      runAt: report.observedAt,
      mode: report.decisionStatus.recommendedMode,
      bestMethod: report.bestMethod,
      leadingMethod: report.leadingMethod,
      leadingRule: report.decisionStatus.leadingRule,
      watchRule: report.decisionStatus.watchRule,
      validatedRule: report.decisionStatus.validatedRule,
      leadingPaperExit: report.decisionStatus.leadingPaperExit,
      watchPaperExit: report.decisionStatus.watchPaperExit,
      validatedPaperExit: report.decisionStatus.validatedPaperExit,
      topRuleVerdict: topRule?.verdict ?? null,
      topRuleAvgReturn: topRule?.avgReturn ?? null,
      topRuleMedianReturn: topRule?.medianReturn ?? null,
      topRuleAvgReturnExBest: topRule?.avgReturnExBest ?? null,
      topRuleWorstReturn: topRule?.worstReturn ?? null,
      topPaperExitVerdict: topPaperExit?.decisionVerdict ?? null,
      topPaperExitAvgReturn: topPaperExit?.avgReturn ?? null,
      topPaperExitWorstReturn: topPaperExit?.worstReturn ?? null,
      topWallet: topWallet?.wallet ?? null,
      topWalletConfidence: topWallet?.walletConfidence ?? null,
      leadingWallet: report.walletDecision.leadingWallet,
      leadingWalletVerdict: report.walletDecision.leadingWalletVerdict,
      leadingWalletStreak: report.walletDecision.leadingWalletStreak,
      leadingWalletSampleGrowth: report.walletDecision.leadingWalletSampleGrowth,
      watchWallet: report.walletDecision.watchWallet,
      validatedWallet: report.walletDecision.validatedWallet,
      walletMatureOutcomeCount: report.walletOutcomeStats.matureOutcomeCount,
      walletProvisionalOutcomeCount: report.walletOutcomeStats.provisionalOutcomeCount,
      walletUnresolvedOutcomeCount: report.walletOutcomeStats.unresolvedOutcomeCount,
      walletsWithAtLeast3MatureOutcomes:
        report.walletOutcomeStats.walletsWithAtLeast3MatureOutcomes,
      walletEvidence: report.walletDecision.walletEvidence,
      methodEvidence: report.methodDecision.evidence,
      ruleEvidence: report.ruleDecision.evidence,
      paperExitEvidence: report.paperExitDecision.evidence
    }
  ].slice(-200);
}

function buildMethodMaps(liveReport: LiveReport) {
  const tokenTags = new Map<string, string[]>();
  const walletEventCounts = new Map<string, number>();
  const activeHistoryWallets = new Set(
    (liveReport.walletHistory ?? [])
      .filter((wallet) =>
        wallet.labels.some(
          (label) => label.includes("active pump") || label.includes("multi-token")
        )
      )
      .map((wallet) => wallet.wallet)
  );

  for (const candidate of liveReport.candidates) {
    tokenTags.set(candidate.tokenAddress, ["high-traction"]);
  }

  for (const wallet of liveReport.walletAggregates ?? []) {
    for (const event of wallet.events ?? []) {
      walletEventCounts.set(
        event.tokenAddress,
        (walletEventCounts.get(event.tokenAddress) ?? 0) + 1
      );
      const tags = tokenTags.get(event.tokenAddress) ?? ["high-traction"];
      if (wallet.tokensTouched >= 2 || wallet.labels.includes("cross-token active degen")) {
        tags.push("cross-token-wallet");
      }
      if (activeHistoryWallets.has(wallet.wallet)) {
        tags.push("active-degen-history");
      }
      tokenTags.set(event.tokenAddress, [...new Set(tags)]);
    }
  }

  return { tokenTags, walletEventCounts };
}

function scoreTokens(state: MarketWatchState): ScoredToken[] {
  return Object.values(state.tokens)
    .map((token) => {
      const latest = token.observations[token.observations.length - 1]!;
      const returns = token.observations.map((observation) =>
        percentChange(token.firstPriceUsd, observation.priceUsd)
      );
      const returnPct = percentChange(token.firstPriceUsd, latest.priceUsd);
      const ageMinutes =
        (new Date(latest.observedAt).getTime() - new Date(token.firstSeenAt).getTime()) / 60_000;
      const buyRatio = latest.buys5m / Math.max(latest.buys5m + latest.sells5m, 1);
      const durabilityScore = round(
        clamp(
          returnPct * 0.55 +
            Math.max(...returns) * 0.18 +
            Math.min(latest.liquidityUsd / 1000, 35) +
            latest.walletEventCount * 1.4 +
            latest.crossTokenWalletCount * 18 +
            latest.activeDegenWalletCount * 22 +
            (buyRatio >= 0.55 ? 8 : -8) -
            (latest.liquidityUsd < 10_000 ? 15 : 0) -
            (ageMinutes < 3 ? 10 : 0),
          -100,
          100
        )
      );
      return {
        token,
        latest,
        returnPct: round(returnPct),
        maxReturnPct: round(Math.max(...returns)),
        minReturnPct: round(Math.min(...returns)),
        ageMinutes: round(ageMinutes, 1),
        durabilityScore
      };
    })
    .sort((a, b) => b.durabilityScore - a.durabilityScore);
}

function scoreWallets(
  state: MarketWatchState,
  scoredTokens: ScoredToken[],
  observedAt: string
): ScoredWallet[] {
  const priceHistories = new Map(
    scoredTokens.map((token) => [
      token.token.tokenAddress,
      token.token.observations.map((observation) => ({
        observedAt: observation.observedAt,
        priceUsd: observation.priceUsd
      }))
    ])
  );

  return Object.values(state.wallets)
    .map((wallet) => {
      const labels = new Set(wallet.labels);
      const legacySignalCount = wallet.signalKeys?.length ?? 0;
      const allOutcomes = calculateWalletSignalOutcomes(
        wallet.walletSignals ?? [],
        priceHistories,
        observedAt,
        WALLET_OUTCOME_HORIZON_MINUTES,
        WALLET_OUTCOME_MAX_DELAY_MINUTES
      );
      const tokenOutcomes = allOutcomes.filter((outcome) => outcome.mature);
      const provisionalOutcomes = allOutcomes.filter((outcome) => outcome.status === "provisional");
      const unresolvedOutcomes = allOutcomes.filter((outcome) => outcome.status === "unresolved");
      const dedupedSignalCount = tokenOutcomes.length;
      const avgTokenReturnPct =
        tokenOutcomes.reduce((sum, outcome) => sum + outcome.returnPct, 0) /
        Math.max(tokenOutcomes.length, 1);
      const provisionalAvgTokenReturnPct =
        provisionalOutcomes.reduce((sum, outcome) => sum + outcome.returnPct, 0) /
        Math.max(provisionalOutcomes.length, 1);
      const bestTokenReturnPct = Math.max(...tokenOutcomes.map((outcome) => outcome.returnPct), 0);
      const worstTokenReturnPct = Math.min(...tokenOutcomes.map((outcome) => outcome.returnPct), 0);
      const tokenHitRate =
        tokenOutcomes.filter((outcome) => outcome.returnPct > 0).length /
        Math.max(tokenOutcomes.length, 1);
      const outcomeScore = clamp(
        avgTokenReturnPct * 0.8 +
          bestTokenReturnPct * 0.15 +
          worstTokenReturnPct * 0.3 +
          tokenHitRate * 25,
        -60,
        50
      );
      const labelBonus =
        (labels.has("cross-token active degen") ? 12 : 0) +
        (labels.has("active pump degen wallet") ? 8 : 0) +
        (labels.has("multi-token recent buyer") ? 8 : 0) +
        (labels.has("net recent accumulator") ? 6 : 0);
      const labelPenalty =
        (labels.has("fast churn seller") ? 30 : 0) +
        (labels.has("limited recent history") ? 12 : 0);
      const rawWalletScore =
        tokenOutcomes.length * 10 +
        dedupedSignalCount * 6 +
        (wallet.pumpMintsBought ?? 0) * 6 +
        (wallet.uniqueMintsBought ?? 0) * 4 +
        (wallet.historyScore ?? 0) * 0.12 +
        labelBonus -
        labelPenalty +
        outcomeScore;
      const scoreCaps = [
        tokenOutcomes.length === 0 ? 25 : tokenOutcomes.length < 2 ? 72 : 100,
        avgTokenReturnPct <= 0 ? 55 : 100,
        tokenOutcomes.length >= 3 && tokenHitRate < 0.5 ? 60 : 100,
        worstTokenReturnPct < -50 ? 50 : 100,
        labels.has("fast churn seller") ? 60 : 100
      ];
      const walletScore = round(clamp(rawWalletScore, 0, Math.min(...scoreCaps)));
      const walletConfidence: ScoredWallet["walletConfidence"] =
        tokenOutcomes.length >= 4 &&
        avgTokenReturnPct >= 5 &&
        tokenHitRate >= 0.6 &&
        worstTokenReturnPct >= -35
          ? "high"
          : tokenOutcomes.length >= 3 &&
              avgTokenReturnPct > 0 &&
              tokenHitRate >= 0.5 &&
              worstTokenReturnPct >= -50
            ? "medium"
            : "early";
      return {
        ...wallet,
        signalCount: allOutcomes.length,
        avgTokenReturnPct: round(avgTokenReturnPct),
        provisionalAvgTokenReturnPct: round(provisionalAvgTokenReturnPct),
        bestTokenReturnPct: round(bestTokenReturnPct),
        worstTokenReturnPct: round(worstTokenReturnPct),
        tokenHitRate: round(tokenHitRate),
        tokenOutcomeCount: tokenOutcomes.length,
        provisionalOutcomeCount: provisionalOutcomes.length,
        unresolvedOutcomeCount: unresolvedOutcomes.length,
        maxObservedEntryAgeMinutes: round(
          Math.max(...allOutcomes.map((outcome) => outcome.ageMinutes), 0),
          1
        ),
        walletOutcomeHorizonMinutes: WALLET_OUTCOME_HORIZON_MINUTES,
        legacySignalCount,
        observedEntryCount: wallet.walletSignals?.length ?? 0,
        matureSignalKeys: tokenOutcomes.map((outcome) => outcome.tokenAddress),
        walletConfidence,
        walletScore
      };
    })
    .sort(
      (a, b) =>
        b.tokenOutcomeCount - a.tokenOutcomeCount ||
        b.provisionalOutcomeCount - a.provisionalOutcomeCount ||
        b.walletScore - a.walletScore ||
        b.avgTokenReturnPct - a.avgTokenReturnPct ||
        b.provisionalAvgTokenReturnPct - a.provisionalAvgTokenReturnPct
    );
}

function summarizeWalletOutcomes(wallets: ScoredWallet[]) {
  const sum = (selector: (wallet: ScoredWallet) => number) =>
    wallets.reduce((total, wallet) => total + selector(wallet), 0);

  return {
    walletCount: wallets.length,
    matureOutcomeCount: sum((wallet) => wallet.tokenOutcomeCount),
    provisionalOutcomeCount: sum((wallet) => wallet.provisionalOutcomeCount),
    unresolvedOutcomeCount: sum((wallet) => wallet.unresolvedOutcomeCount),
    walletsWithMatureOutcomes: wallets.filter((wallet) => wallet.tokenOutcomeCount > 0).length,
    walletsWithAtLeast3MatureOutcomes: wallets.filter((wallet) => wallet.tokenOutcomeCount >= 3)
      .length,
    walletsWithAtLeast4MatureOutcomes: wallets.filter((wallet) => wallet.tokenOutcomeCount >= 4)
      .length,
    maxMatureOutcomesPerWallet: Math.max(...wallets.map((wallet) => wallet.tokenOutcomeCount), 0)
  };
}

function buildNearWalletCandidates(
  wallets: Array<ScoredWallet & { walletVerdict: WalletVerdict }>
) {
  return wallets
    .filter(
      (wallet) =>
        wallet.walletVerdict !== "candidate" &&
        (wallet.tokenOutcomeCount >= 2 ||
          wallet.observedEntryCount >= 2 ||
          wallet.provisionalOutcomeCount > 0)
    )
    .sort(
      (a, b) =>
        b.tokenOutcomeCount - a.tokenOutcomeCount ||
        b.observedEntryCount - a.observedEntryCount ||
        b.provisionalOutcomeCount - a.provisionalOutcomeCount ||
        b.walletScore - a.walletScore ||
        b.avgTokenReturnPct - a.avgTokenReturnPct
    );
}

function buildMethodSignals(state: MarketWatchState): MethodSignal[] {
  const methods = ["high-traction", "cross-token-wallet", "active-degen-history"];
  const signals: MethodSignal[] = [];

  for (const token of Object.values(state.tokens)) {
    for (const method of methods) {
      const signalIndex = token.observations.findIndex((observation) =>
        observation.methodTags.includes(method)
      );
      if (signalIndex < 0) continue;

      const signal = token.observations[signalIndex]!;
      const observationsAfterSignal = token.observations.slice(signalIndex);
      const fixedOutcome = evaluateFixedHorizon(
        signal.observedAt,
        signal.priceUsd,
        observationsAfterSignal,
        {
          horizonMinutes: WALLET_OUTCOME_HORIZON_MINUTES,
          maxDelayMinutes: WALLET_OUTCOME_MAX_DELAY_MINUTES,
          estimatedRoundTripCostPct: PAPER_ROUND_TRIP_COST_PCT
        }
      );
      if (!fixedOutcome) continue;

      const outcome = fixedOutcome.outcome;
      const buyRatio = outcome.buys5m / Math.max(outcome.buys5m + outcome.sells5m, 1);
      signals.push({
        method,
        tokenAddress: token.tokenAddress,
        symbol: token.symbol,
        signalAt: signal.observedAt,
        signalPriceUsd: signal.priceUsd,
        signalLiquidityUsd: signal.liquidityUsd,
        signalVolume5mUsd: signal.volume5mUsd,
        signalBuyRatio: round(signal.buys5m / Math.max(signal.buys5m + signal.sells5m, 1)),
        signalPriceChange5m: finiteNumber(signal.priceChange5m),
        signalPriceChange1h: finiteNumber(signal.priceChange1h),
        signalPairAgeMinutes: finiteNumber(signal.pairAgeMinutes),
        signalVolumeLiquidityRatio: round(signal.volume5mUsd / Math.max(signal.liquidityUsd, 1), 3),
        signalWalletEventCount: signal.walletEventCount,
        signalCrossTokenWalletCount: signal.crossTokenWalletCount,
        signalActiveDegenWalletCount: signal.activeDegenWalletCount,
        signalTractionScore: signal.tractionScore,
        latestAt: outcome.observedAt,
        latestPriceUsd: outcome.priceUsd,
        returnPct: round(fixedOutcome.netReturnPct),
        maxReturnPct: round(fixedOutcome.maxReturnPct),
        minReturnPct: round(fixedOutcome.minReturnPct),
        ageMinutes: round(fixedOutcome.ageMinutes, 1),
        observationsAfterSignal: fixedOutcome.path.length,
        liquidityUsd: outcome.liquidityUsd,
        buyRatio: round(buyRatio),
        methodTags: outcome.methodTags
      });
    }
  }

  return signals.sort((a, b) => b.returnPct - a.returnPct);
}

function buildRuleCandidates(signals: MethodSignal[]): RuleCandidate[] {
  return getRuleDefinitions()
    .map(({ rule, description, test }) =>
      summarizeRule(rule, description, dedupeSignalsByToken(signals.filter(test)))
    )
    .sort((a, b) => b.evidenceScore - a.evidenceScore || b.avgReturn - a.avgReturn);
}

function getRuleDefinitions(): Array<{
  rule: string;
  description: string;
  test: (signal: MethodSignal) => boolean;
}> {
  return [
    {
      rule: "high-traction / buy pressure",
      description:
        "High-traction signal where five-minute buys are at least 58% of swaps at signal time.",
      test: (signal) => signal.method === "high-traction" && signal.signalBuyRatio >= 0.58
    },
    {
      rule: "high-traction / liquid",
      description: "High-traction signal with at least $20k liquidity at signal time.",
      test: (signal) => signal.method === "high-traction" && signal.signalLiquidityUsd >= 20_000
    },
    {
      rule: "high-traction / liquid + buy pressure",
      description:
        "High-traction signal with at least $20k liquidity and at least 58% buy pressure at signal time.",
      test: (signal) =>
        signal.method === "high-traction" &&
        signal.signalLiquidityUsd >= 20_000 &&
        signal.signalBuyRatio >= 0.58
    },
    {
      rule: "high-traction / controlled momentum",
      description:
        "Liquid high-traction signal that is moving, but has not already entered a five-minute or one-hour blow-off.",
      test: (signal) =>
        signal.method === "high-traction" &&
        signal.signalLiquidityUsd >= 20_000 &&
        signal.signalBuyRatio >= 0.55 &&
        hasControlledMomentum(signal)
    },
    {
      rule: "high-traction / liquidity-backed balanced flow",
      description:
        "High-traction signal with balanced buy pressure and five-minute volume supported by liquidity rather than extreme churn.",
      test: (signal) =>
        signal.method === "high-traction" &&
        signal.signalLiquidityUsd >= 30_000 &&
        signal.signalBuyRatio >= 0.55 &&
        signal.signalBuyRatio <= 0.75 &&
        signal.signalVolumeLiquidityRatio >= 0.1 &&
        signal.signalVolumeLiquidityRatio <= 2.5
    },
    {
      rule: "high-traction / wallet events",
      description: "High-traction signal with at least four observable early wallet events.",
      test: (signal) => signal.method === "high-traction" && signal.signalWalletEventCount >= 4
    },
    {
      rule: "high-traction / liquid + wallet events",
      description:
        "High-traction signal with at least $20k liquidity and four observable early wallet events.",
      test: (signal) =>
        signal.method === "high-traction" &&
        signal.signalLiquidityUsd >= 20_000 &&
        signal.signalWalletEventCount >= 4
    },
    {
      rule: "wallet-quality / buy pressure",
      description: "Any wallet-quality signal with at least 55% buy pressure at signal time.",
      test: (signal) => signal.method !== "high-traction" && signal.signalBuyRatio >= 0.55
    },
    {
      rule: "wallet-quality / controlled momentum",
      description:
        "Wallet-quality signal with sufficient liquidity, balanced buy flow, and no signal-time momentum blow-off.",
      test: (signal) =>
        signal.method !== "high-traction" &&
        signal.signalLiquidityUsd >= 20_000 &&
        signal.signalBuyRatio >= 0.55 &&
        signal.signalBuyRatio <= 0.75 &&
        hasControlledMomentum(signal)
    },
    {
      rule: "active-degen / liquid",
      description: "Active-degen-history signal with at least $20k liquidity at signal time.",
      test: (signal) =>
        signal.method === "active-degen-history" && signal.signalLiquidityUsd >= 20_000
    },
    {
      rule: "cross-token / liquid",
      description: "Cross-token wallet signal with at least $20k liquidity at signal time.",
      test: (signal) =>
        signal.method === "cross-token-wallet" && signal.signalLiquidityUsd >= 20_000
    },
    {
      rule: "strict / liquid + buy pressure + wallet events",
      description:
        "Any signal with at least $20k liquidity, at least 58% buy pressure, and at least four early wallet events.",
      test: (signal) =>
        signal.signalLiquidityUsd >= 20_000 &&
        signal.signalBuyRatio >= 0.58 &&
        signal.signalWalletEventCount >= 4
    }
  ];
}

function hasControlledMomentum(signal: MethodSignal): boolean {
  return (
    signal.signalPriceChange5m !== null &&
    signal.signalPriceChange1h !== null &&
    signal.signalPairAgeMinutes !== null &&
    signal.signalPriceChange5m >= -5 &&
    signal.signalPriceChange5m <= 25 &&
    signal.signalPriceChange1h >= -10 &&
    signal.signalPriceChange1h <= 80 &&
    signal.signalPairAgeMinutes >= 3 &&
    signal.signalPairAgeMinutes <= 360
  );
}

function summarizeRule(rule: string, description: string, signals: MethodSignal[]): RuleCandidate {
  const returnStats = summarizeReturns(signals.map((signal) => signal.returnPct));
  const avgReturn = returnStats.average;
  const hitRate =
    signals.filter((signal) => signal.returnPct > 0).length / Math.max(signals.length, 1);
  const avgDrawdown =
    signals.reduce((sum, signal) => sum + signal.minReturnPct, 0) / Math.max(signals.length, 1);
  const avgMaxReturn =
    signals.reduce((sum, signal) => sum + signal.maxReturnPct, 0) / Math.max(signals.length, 1);
  const bestReturn = Math.max(...signals.map((signal) => signal.returnPct), 0);
  const worstReturn = Math.min(...signals.map((signal) => signal.returnPct), 0);
  const sampleConfidence = Math.min(signals.length / 5, 1);
  const robustReturn =
    avgReturn * 0.4 + returnStats.median * 0.35 + returnStats.averageWithoutBest * 0.25;
  const rawScore = robustReturn * 0.8 + hitRate * 35 + avgDrawdown * 0.35 + signals.length * 1.5;
  const evidenceScore = round(clamp(rawScore * sampleConfidence, -100, 100));
  const riskControlled = avgDrawdown >= -15 && worstReturn >= -35;
  const robustPositive =
    returnStats.median >= 2 &&
    returnStats.averageWithoutBest >= 2 &&
    returnStats.bestWinnerShare <= 0.65;
  const positiveEnough = avgReturn >= 5 && hitRate >= 0.55 && robustPositive;
  const verdict =
    signals.length >= 5 && positiveEnough && riskControlled
      ? "candidate"
      : signals.length >= 3 &&
          avgReturn > 0 &&
          returnStats.median >= 0 &&
          returnStats.averageWithoutBest >= 0 &&
          returnStats.bestWinnerShare <= 0.8 &&
          hitRate >= 0.4 &&
          worstReturn >= -50
        ? "watch"
        : "reject";

  return {
    rule,
    description,
    signalCount: signals.length,
    avgReturn: round(avgReturn),
    medianReturn: round(returnStats.median),
    avgReturnExBest: round(returnStats.averageWithoutBest),
    bestWinnerShare: round(returnStats.bestWinnerShare),
    hitRate: round(hitRate),
    avgDrawdown: round(avgDrawdown),
    avgMaxReturn: round(avgMaxReturn),
    bestReturn: round(bestReturn),
    worstReturn: round(worstReturn),
    sampleConfidence: round(sampleConfidence),
    evidenceScore,
    verdict,
    signalKeys: signals.map((signal) => signal.tokenAddress),
    signalOutcomes: signals.map((signal) => ({
      key: signal.tokenAddress,
      returnPct: signal.returnPct
    }))
  };
}

function buildPaperExitCandidates(
  state: MarketWatchState,
  methodSummary: ReturnType<typeof summarizeMethods>,
  ruleCandidates: RuleCandidate[],
  hasWalletQuality: boolean
): PaperExitCandidate[] {
  const signalPaths = buildSignalPaths(state);
  const cohorts = [
    {
      cohort: "method: high-traction",
      description: "All high-traction method signals.",
      test: (signal: SignalPath) => signal.method === "high-traction"
    },
    {
      cohort: "method: cross-token-wallet",
      description: "All cross-token wallet method signals.",
      test: (signal: SignalPath) => signal.method === "cross-token-wallet"
    },
    {
      cohort: "method: active-degen-history",
      description: "All active-degen-history method signals.",
      test: (signal: SignalPath) => signal.method === "active-degen-history"
    },
    ...getRuleDefinitions().map((rule) => ({
      cohort: `rule: ${rule.rule}`,
      description: rule.description,
      test: (signal: SignalPath) => rule.test(signal)
    }))
  ];
  const strategies = [
    {
      strategy: "tp15/sl20/20m",
      exitStrategy: "single-stage" as const,
      takeProfitPct: 15,
      stopLossPct: 20,
      timeoutMinutes: 20
    },
    {
      strategy: "tp25/sl25/45m",
      exitStrategy: "single-stage" as const,
      takeProfitPct: 25,
      stopLossPct: 25,
      timeoutMinutes: 45
    },
    {
      strategy: "tp40/sl30/60m",
      exitStrategy: "single-stage" as const,
      takeProfitPct: 40,
      stopLossPct: 30,
      timeoutMinutes: 60
    },
    {
      strategy: "tp60/sl35/90m",
      exitStrategy: "single-stage" as const,
      takeProfitPct: 60,
      stopLossPct: 35,
      timeoutMinutes: 90
    },
    {
      strategy: "mb50/tp100/ts30/90m",
      exitStrategy: "moonbag" as const,
      takeProfitPct: 100,
      stopLossPct: 30,
      timeoutMinutes: 90,
      moonbagSellFraction: 0.5,
      trailingStopPercent: 30
    },
    {
      strategy: "mb50/tp50/ts25/60m",
      exitStrategy: "moonbag" as const,
      takeProfitPct: 50,
      stopLossPct: 25,
      timeoutMinutes: 60,
      moonbagSellFraction: 0.5,
      trailingStopPercent: 25
    }
  ];

  return cohorts
    .flatMap((cohort) =>
      strategies.map((strategy) =>
        summarizePaperExit(
          strategy.strategy,
          cohort.cohort,
          cohort.description,
          dedupeSignalsByToken(signalPaths.filter(cohort.test)),
          strategy
        )
      )
    )
    .map((candidate) => {
      const parentVerdict = paperExitParentVerdict(
        candidate.cohort,
        methodSummary,
        ruleCandidates,
        hasWalletQuality
      );
      return {
        ...candidate,
        parentVerdict,
        decisionVerdict: parentVerdict === "reject" ? "reject" : candidate.verdict
      };
    })
    .sort((a, b) => b.evidenceScore - a.evidenceScore || b.avgReturn - a.avgReturn);
}

function paperExitParentVerdict(
  cohort: string,
  methodSummary: ReturnType<typeof summarizeMethods>,
  ruleCandidates: RuleCandidate[],
  hasWalletQuality: boolean
): HypothesisVerdict {
  if (cohort.startsWith("method: ")) {
    const method = methodSummary.find((item) => item.method === cohort.slice("method: ".length));
    return method ? classifyMethodHypothesis(method, hasWalletQuality) : "reject";
  }
  if (cohort.startsWith("rule: ")) {
    return (
      ruleCandidates.find((item) => item.rule === cohort.slice("rule: ".length))?.verdict ??
      "reject"
    );
  }
  return "reject";
}

function buildSignalPaths(state: MarketWatchState): SignalPath[] {
  const methods = ["high-traction", "cross-token-wallet", "active-degen-history"];
  const signals: SignalPath[] = [];

  for (const token of Object.values(state.tokens)) {
    for (const method of methods) {
      const signalIndex = token.observations.findIndex((observation) =>
        observation.methodTags.includes(method)
      );
      if (signalIndex < 0) continue;

      const signal = token.observations[signalIndex]!;
      const latest = token.observations[token.observations.length - 1]!;
      const observationsAfterSignal = token.observations.slice(signalIndex);
      const returns = observationsAfterSignal.map((observation) =>
        percentChange(signal.priceUsd, observation.priceUsd)
      );
      const buyRatio = latest.buys5m / Math.max(latest.buys5m + latest.sells5m, 1);
      signals.push({
        method,
        tokenAddress: token.tokenAddress,
        symbol: token.symbol,
        signalAt: signal.observedAt,
        signalPriceUsd: signal.priceUsd,
        signalLiquidityUsd: signal.liquidityUsd,
        signalVolume5mUsd: signal.volume5mUsd,
        signalBuyRatio: round(signal.buys5m / Math.max(signal.buys5m + signal.sells5m, 1)),
        signalPriceChange5m: finiteNumber(signal.priceChange5m),
        signalPriceChange1h: finiteNumber(signal.priceChange1h),
        signalPairAgeMinutes: finiteNumber(signal.pairAgeMinutes),
        signalVolumeLiquidityRatio: round(signal.volume5mUsd / Math.max(signal.liquidityUsd, 1), 3),
        signalWalletEventCount: signal.walletEventCount,
        signalCrossTokenWalletCount: signal.crossTokenWalletCount,
        signalActiveDegenWalletCount: signal.activeDegenWalletCount,
        signalTractionScore: signal.tractionScore,
        latestAt: latest.observedAt,
        latestPriceUsd: latest.priceUsd,
        returnPct: round(percentChange(signal.priceUsd, latest.priceUsd)),
        maxReturnPct: round(Math.max(...returns)),
        minReturnPct: round(Math.min(...returns)),
        ageMinutes: round(
          (new Date(latest.observedAt).getTime() - new Date(signal.observedAt).getTime()) / 60_000,
          1
        ),
        observationsAfterSignal: observationsAfterSignal.length,
        liquidityUsd: latest.liquidityUsd,
        buyRatio: round(buyRatio),
        methodTags: latest.methodTags,
        returnPath: observationsAfterSignal.map((observation) => ({
          observedAt: observation.observedAt,
          minutesSinceSignal: round(
            (new Date(observation.observedAt).getTime() - new Date(signal.observedAt).getTime()) /
              60_000,
            1
          ),
          returnPct: round(percentChange(signal.priceUsd, observation.priceUsd))
        }))
      });
    }
  }

  return signals;
}

function summarizePaperExit(
  strategy: string,
  cohort: string,
  description: string,
  signals: SignalPath[],
  config: PaperExitConfig
): PaperExitCandidate {
  const simulations = signals.map((signal) => simulatePaperExitPath(signal.returnPath, config));
  const mature = simulations.flatMap((simulation, index) => {
    const signal = signals[index];
    return simulation.mature && signal ? [{ simulation, signal }] : [];
  });
  const grossExits = mature.map(({ simulation }) => simulation);
  const exits = grossExits.map((exit) => ({
    ...exit,
    returnPct: exit.returnPct - PAPER_ROUND_TRIP_COST_PCT
  }));
  const grossReturnStats = summarizeReturns(grossExits.map((exit) => exit.returnPct));
  const returnStats = summarizeReturns(exits.map((exit) => exit.returnPct));
  const avgReturn = returnStats.average;
  const hitRate = exits.filter((exit) => exit.returnPct > 0).length / Math.max(exits.length, 1);
  const takeProfitRate =
    exits.filter((exit) =>
      ["take-profit", "moonbag_trailing_stop", "moonbag_capital_recovered"].includes(exit.reason)
    ).length / Math.max(exits.length, 1);
  const stopLossRate =
    exits.filter((exit) =>
      ["stop-loss", "moonbag_rug", "moonbag_liquidity_failure"].includes(exit.reason)
    ).length / Math.max(exits.length, 1);
  const timeoutRate =
    exits.filter((exit) => ["timeout", "moonbag_time_exit"].includes(exit.reason)).length /
    Math.max(exits.length, 1);
  const provisionalSignalCount = simulations.filter((simulation) => !simulation.mature).length;
  const latestRate = provisionalSignalCount / Math.max(simulations.length, 1);
  const bestReturn = Math.max(...exits.map((exit) => exit.returnPct), 0);
  const worstReturn = Math.min(...exits.map((exit) => exit.returnPct), 0);
  const sampleConfidence = Math.min(exits.length / 6, 1);
  const robustReturn =
    avgReturn * 0.45 + returnStats.median * 0.3 + returnStats.averageWithoutBest * 0.25;
  const rawScore =
    robustReturn * 0.9 + hitRate * 30 + takeProfitRate * 18 - stopLossRate * 28 + worstReturn * 0.2;
  const evidenceScore = round(clamp(rawScore * sampleConfidence, -100, 100));
  const verdict =
    exits.length >= 6 &&
    avgReturn >= 5 &&
    returnStats.median >= 2 &&
    returnStats.averageWithoutBest >= 2 &&
    returnStats.bestWinnerShare <= 0.65 &&
    hitRate >= 0.55 &&
    stopLossRate <= 0.35 &&
    worstReturn >= -35
      ? "candidate"
      : exits.length >= 4 &&
          avgReturn >= 2 &&
          returnStats.median >= 0 &&
          returnStats.averageWithoutBest >= 0 &&
          returnStats.bestWinnerShare <= 0.8 &&
          hitRate >= 0.5 &&
          stopLossRate <= 0.4 &&
          worstReturn >= -30
        ? "watch"
        : "reject";

  return {
    strategy,
    cohort,
    description,
    totalSignalCount: signals.length,
    signalCount: exits.length,
    provisionalSignalCount,
    grossAvgReturn: round(grossReturnStats.average),
    estimatedRoundTripCostPct: PAPER_ROUND_TRIP_COST_PCT,
    avgReturn: round(avgReturn),
    medianReturn: round(returnStats.median),
    avgReturnExBest: round(returnStats.averageWithoutBest),
    bestWinnerShare: round(returnStats.bestWinnerShare),
    hitRate: round(hitRate),
    takeProfitRate: round(takeProfitRate),
    stopLossRate: round(stopLossRate),
    timeoutRate: round(timeoutRate),
    latestRate: round(latestRate),
    bestReturn: round(bestReturn),
    worstReturn: round(worstReturn),
    sampleConfidence: round(sampleConfidence),
    evidenceScore,
    verdict,
    parentVerdict: "reject",
    decisionVerdict: "reject",
    signalKeys: mature.map(({ signal }) => signal.tokenAddress),
    signalOutcomes: mature.map(({ signal }, index) => ({
      key: signal.tokenAddress,
      returnPct: exits[index]?.returnPct ?? 0
    }))
  };
}

function paperExitKey(paperExit: Pick<PaperExitCandidate, "strategy" | "cohort">): string {
  return `${paperExit.strategy} / ${paperExit.cohort}`;
}

function summarizeMethods(signals: MethodSignal[]) {
  const methods = ["high-traction", "cross-token-wallet", "active-degen-history"];
  return methods
    .map((method) => {
      const methodSignals = signals.filter((signal) => signal.method === method);
      const returnStats = summarizeReturns(methodSignals.map((signal) => signal.returnPct));
      const avgReturn = returnStats.average;
      const hitRate =
        methodSignals.filter((signal) => signal.returnPct > 0).length /
        Math.max(methodSignals.length, 1);
      const avgDrawdown =
        methodSignals.reduce((sum, signal) => sum + signal.minReturnPct, 0) /
        Math.max(methodSignals.length, 1);
      const bestReturn = Math.max(...methodSignals.map((signal) => signal.returnPct), 0);
      const worstReturn = Math.min(...methodSignals.map((signal) => signal.returnPct), 0);
      const avgMaxReturn =
        methodSignals.reduce((sum, signal) => sum + signal.maxReturnPct, 0) /
        Math.max(methodSignals.length, 1);
      const sampleConfidence = Math.min(
        methodSignals.length / (method === "high-traction" ? 8 : 3),
        1
      );
      const robustReturn =
        avgReturn * 0.4 + returnStats.median * 0.35 + returnStats.averageWithoutBest * 0.25;
      const rawScore =
        robustReturn * 0.7 + hitRate * 35 + methodSignals.length * 2 + avgDrawdown * 0.25;
      const evidenceScore = round(clamp(rawScore * sampleConfidence, -100, 100));
      return {
        method,
        tokenCount: methodSignals.length,
        avgReturn: round(avgReturn),
        medianReturn: round(returnStats.median),
        avgReturnExBest: round(returnStats.averageWithoutBest),
        bestWinnerShare: round(returnStats.bestWinnerShare),
        hitRate: round(hitRate),
        avgDrawdown: round(avgDrawdown),
        avgMaxReturn: round(avgMaxReturn),
        bestReturn: round(bestReturn),
        worstReturn: round(worstReturn),
        sampleConfidence: round(sampleConfidence),
        evidenceScore
      };
    })
    .sort((a, b) => b.evidenceScore - a.evidenceScore);
}

function classifyMethodHypothesis(
  method: ReturnType<typeof summarizeMethods>[number],
  hasWalletQuality: boolean
): HypothesisVerdict {
  if (method.method === "high-traction" && !hasWalletQuality) return "reject";

  const minimumSignals = method.method === "high-traction" ? 8 : 3;
  const candidate =
    method.tokenCount >= minimumSignals &&
    method.avgReturn >= 5 &&
    method.medianReturn >= 2 &&
    method.avgReturnExBest >= 2 &&
    method.bestWinnerShare <= 0.65 &&
    method.hitRate >= 0.55 &&
    method.avgDrawdown >= -15 &&
    method.worstReturn >= -35;
  if (candidate) return "candidate";

  const watch =
    method.tokenCount >= minimumSignals &&
    method.avgReturn >= 2 &&
    method.medianReturn >= 0 &&
    method.avgReturnExBest >= 0 &&
    method.bestWinnerShare <= 0.8 &&
    method.hitRate >= 0.45 &&
    method.avgDrawdown >= -25 &&
    method.worstReturn >= -50;
  return watch ? "watch" : "reject";
}

function buildRuleSet(methodSummary: ReturnType<typeof summarizeMethods>) {
  const bestMethod = methodSummary[0]?.method ?? "high-traction";
  return {
    bestCurrentMethod: bestMethod,
    useWhen: [
      "Liquidity is above $10k and not collapsing.",
      "The token is still in active discovery, not only a stale boost.",
      "At least one cross-token early wallet or active pump-degen history wallet appears.",
      "Five-minute buy/sell ratio is not heavily sell-dominated."
    ],
    avoidWhen: [
      "Only high traction is present but no wallet-quality tag appears.",
      "The token already printed a large move and five-minute flow turns sell-heavy.",
      "Liquidity is below $10k or the pair stops producing fresh swaps.",
      "The same wallet is only fast-churning in one token without broader history."
    ]
  };
}

function buildDecisionStatus(
  methodSummary: ReturnType<typeof summarizeMethods>,
  ruleCandidates: RuleCandidate[],
  paperExitCandidates: PaperExitCandidate[],
  methodSignals: MethodSignal[],
  methodDecision: ReturnType<typeof buildHypothesisDecision>,
  ruleDecision: ReturnType<typeof buildHypothesisDecision>,
  paperExitDecision: ReturnType<typeof buildHypothesisDecision>,
  walletDecision: ReturnType<typeof buildWalletDecision>,
  walletOutcomeStats: ReturnType<typeof summarizeWalletOutcomes>,
  canonicalReplayPassed: boolean,
  runs: number
) {
  const bestMethod = methodSummary[0];
  const bestRule = ruleCandidates[0];
  const bestPaperExit = paperExitCandidates[0];
  const walletQualityTokens = new Set(
    methodSignals
      .filter((signal) => signal.method !== "high-traction")
      .map((signal) => signal.tokenAddress)
  ).size;
  const enoughRuns = runs >= 6;
  const minimumSignals = bestMethod?.method === "high-traction" ? 8 : 3;
  const enoughTokens = (bestMethod?.tokenCount ?? 0) >= minimumSignals;
  const robustPositive =
    (bestMethod?.medianReturn ?? -100) >= 2 &&
    (bestMethod?.avgReturnExBest ?? -100) >= 2 &&
    (bestMethod?.bestWinnerShare ?? 1) <= 0.65;
  const positiveEnough =
    (bestMethod?.avgReturn ?? 0) >= 5 && (bestMethod?.hitRate ?? 0) >= 0.55 && robustPositive;
  const riskControlled =
    (bestMethod?.avgDrawdown ?? -100) >= -15 && (bestMethod?.worstReturn ?? -100) >= -35;
  const hasWalletQuality = walletQualityTokens > 0;
  const methodIsOnlyTraction = bestMethod?.method === "high-traction" && !hasWalletQuality;
  const rawMethodCandidate = Boolean(methodDecision.rawCandidateKey);
  const rawRuleCandidate = Boolean(ruleDecision.rawCandidateKey);
  const rawPaperExitCandidateEntry = paperExitCandidates.find(
    (candidate) => candidate.verdict === "candidate"
  );
  const rawPaperExitCandidate = Boolean(rawPaperExitCandidateEntry);
  const rawMethodWatch = Boolean(methodDecision.rawWatchKey);
  const rawRuleWatch = Boolean(ruleDecision.rawWatchKey);
  const rawPaperExitWatchEntry = paperExitCandidates.find(
    (candidate) => candidate.verdict === "watch"
  );
  const rawPaperExitWatch = Boolean(rawPaperExitWatchEntry);
  const methodEmerging = Boolean(methodDecision.validatedKey);
  const ruleCandidate = Boolean(ruleDecision.validatedKey);
  const paperExitCandidate = Boolean(paperExitDecision.validatedKey);
  const methodWatch = Boolean(methodDecision.watchKey);
  const ruleWatch = Boolean(ruleDecision.watchKey);
  const paperExitWatch = Boolean(paperExitDecision.watchKey);
  const walletCandidate = Boolean(walletDecision.validatedWallet);
  const walletWatch = Boolean(walletDecision.watchWallet);
  const modeDecision = decideMarketWatchMode({
    validatedMethod: methodEmerging,
    validatedRule: ruleCandidate,
    validatedPaperExit: paperExitCandidate,
    validatedWallet: walletCandidate,
    watchMethod: methodWatch,
    watchRule: ruleWatch,
    watchPaperExit: paperExitWatch,
    watchWallet: walletWatch,
    canonicalReplayPassed
  });

  return {
    status: modeDecision.status,
    recommendedMode: modeDecision.recommendedMode,
    validatedMethod: methodDecision.validatedKey,
    validatedRule: ruleDecision.validatedKey,
    validatedPaperExit: paperExitDecision.validatedKey,
    validatedWallet: null,
    walletCandidate: walletDecision.validatedWallet,
    walletOnlyCandidate: modeDecision.walletOnlyCandidate,
    rawCandidateMethod: methodDecision.rawCandidateKey,
    rawCandidateRule: ruleDecision.rawCandidateKey,
    rawCandidatePaperExit: rawPaperExitCandidateEntry
      ? paperExitKey(rawPaperExitCandidateEntry)
      : null,
    rawWatchMethod: methodDecision.rawWatchKey,
    rawWatchRule: ruleDecision.rawWatchKey,
    rawWatchPaperExit: rawPaperExitWatchEntry ? paperExitKey(rawPaperExitWatchEntry) : null,
    leadingMethod: methodDecision.leadingKey,
    leadingRule: bestRule?.rule ?? null,
    leadingPaperExit: bestPaperExit ? `${bestPaperExit.strategy} / ${bestPaperExit.cohort}` : null,
    leadingWallet: walletDecision.leadingWallet,
    leadingWalletVerdict: walletDecision.leadingWalletVerdict,
    leadingWalletStreak: walletDecision.leadingWalletStreak,
    leadingWalletSampleGrowth: walletDecision.leadingWalletSampleGrowth,
    watchMethod: methodDecision.watchKey,
    watchRule: ruleDecision.watchKey,
    watchPaperExit: paperExitDecision.watchKey,
    watchWallet: walletDecision.watchWallet,
    methodEvidenceReason: methodDecision.reason,
    ruleEvidenceReason: ruleDecision.reason,
    paperExitEvidenceReason: paperExitDecision.reason,
    walletReason: walletDecision.reason,
    verdict: modeDecision.systemCandidate
      ? "A repeatable paper system candidate cleared method, rule, exit, holdout and replay gates; it remains research-only."
      : modeDecision.walletOnlyCandidate
        ? "A wallet-only candidate is emerging, but no repeatable method, rule or exit system has been validated."
        : modeDecision.systemWatch || (positiveEnough && riskControlled)
          ? "Keep watching. Current evidence has a watch-only paper pattern, but it is still too thin for a sustainable method."
          : "Stand down. The tested methods are not positive or risk-controlled enough yet; keep collecting evidence only.",
    runs,
    walletQualityTokens,
    walletOutcomeStats,
    minimumSignals,
    checks: {
      enoughRuns,
      enoughTokens,
      positiveEnough,
      robustPositive,
      riskControlled,
      hasWalletQuality,
      methodIsOnlyTraction,
      rawMethodCandidate,
      rawRuleCandidate,
      rawPaperExitCandidate,
      rawMethodWatch,
      rawRuleWatch,
      rawPaperExitWatch,
      methodCandidate: methodEmerging,
      systemCandidate: modeDecision.systemCandidate,
      canonicalReplayPassed,
      walletOnlyCandidate: modeDecision.walletOnlyCandidate,
      methodWatch,
      ruleCandidate,
      paperExitCandidate,
      walletCandidate,
      ruleWatch,
      paperExitWatch,
      walletWatch
    }
  };
}

async function loadCanonicalReplayStatus(): Promise<boolean> {
  if (!existsSync(EVIDENCE_JSON_REPORT_PATH)) return false;
  try {
    const report = JSON.parse(await readFile(EVIDENCE_JSON_REPORT_PATH, "utf8")) as {
      strategyVersion?: string;
      goalCompletionAudit?: {
        completed?: boolean;
        replay?: { passed?: boolean };
      };
    };
    return (
      report.strategyVersion === STRATEGY_VERSION &&
      report.goalCompletionAudit?.completed === true &&
      report.goalCompletionAudit?.replay?.passed === true
    );
  } catch {
    return false;
  }
}

async function fetchCurrentCandidate(token: TokenTrack): Promise<LiveCandidate | undefined> {
  const pairs = await fetchJson<Array<LiveCandidateFromDex>>(
    `${DEX_BASE}/token-pairs/v1/solana/${token.tokenAddress}`
  );
  const pair = pairs.find((item) => item.pairAddress === token.pairAddress) ?? pairs[0];
  if (!pair?.baseToken?.address || !pair.pairAddress) return undefined;

  return {
    tokenAddress: pair.baseToken.address,
    symbol: pair.baseToken.symbol ?? token.symbol,
    name: pair.baseToken.name ?? token.name,
    pairAddress: pair.pairAddress,
    dexId: pair.dexId ?? token.dexId,
    ...(pair.url ? { url: pair.url } : {}),
    liquidityUsd: number(pair.liquidity?.usd),
    volume5mUsd: number(pair.volume?.m5),
    volume1hUsd: number(pair.volume?.h1),
    buys5m: number(pair.txns?.m5?.buys),
    sells5m: number(pair.txns?.m5?.sells),
    buys1h: number(pair.txns?.h1?.buys),
    sells1h: number(pair.txns?.h1?.sells),
    priceChange5m: number(pair.priceChange?.m5),
    priceChange1h: number(pair.priceChange?.h1),
    ageMinutes: pair.pairCreatedAt ? round((Date.now() - pair.pairCreatedAt) / 60_000, 1) : null,
    priceUsd: number(pair.priceUsd),
    tractionScore: token.firstTractionScore
  };
}

interface LiveCandidateFromDex {
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string | null;
  txns?: Record<string, { buys?: number; sells?: number } | undefined>;
  volume?: Record<string, number | undefined>;
  priceChange?: Record<string, number | undefined> | null;
  liquidity?: { usd?: number } | null;
  pairCreatedAt?: number | null;
}

async function runLiveAlpha(): Promise<void> {
  await runLiveAlphaModule();
}

async function readState(): Promise<MarketWatchState> {
  if (!existsSync(STATE_PATH)) {
    return {
      evidenceSemanticsVersion: MARKET_WATCH_EVIDENCE_SEMANTICS,
      updatedAt: new Date(0).toISOString(),
      runs: [],
      decisionHistory: [],
      tokens: {},
      wallets: {}
    };
  }
  const state = JSON.parse(await readFile(STATE_PATH, "utf8")) as MarketWatchState;
  if (state.evidenceSemanticsVersion !== MARKET_WATCH_EVIDENCE_SEMANTICS) {
    return {
      ...state,
      evidenceSemanticsVersion: MARKET_WATCH_EVIDENCE_SEMANTICS,
      runs: [],
      decisionHistory: []
    };
  }
  return state;
}

function renderMarkdown(report: {
  generatedAt: string;
  bestMethod: string;
  leadingMethod: string;
  methodSummary: ReturnType<typeof summarizeMethods>;
  methodDecision: ReturnType<typeof buildHypothesisDecision>;
  ruleCandidates: RuleCandidate[];
  paperExitCandidates: PaperExitCandidate[];
  ruleDecision: ReturnType<typeof buildHypothesisDecision>;
  paperExitDecision: ReturnType<typeof buildHypothesisDecision>;
  methodSignals: MethodSignal[];
  topTokens: ScoredToken[];
  topWallets: Array<ScoredWallet & { walletVerdict: WalletVerdict }>;
  nearWalletCandidates: Array<ScoredWallet & { walletVerdict: WalletVerdict }>;
  walletOutcomeStats: ReturnType<typeof summarizeWalletOutcomes>;
  walletDecision: ReturnType<typeof buildWalletDecision>;
  decisionStatus: ReturnType<typeof buildDecisionStatus>;
  decisionHistory: DecisionHistoryEntry[];
  stateStats: { tokensTracked: number; walletsTracked: number; runs: number };
  ruleSet: ReturnType<typeof buildRuleSet>;
}): string {
  return [
    "# Market Watch Report",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "Research only. Not financial advice. This is a paper/research watchlist, not an execution instruction.",
    "",
    "## Decision Status",
    "",
    `Status: ${report.decisionStatus.status}`,
    `Mode: ${report.decisionStatus.recommendedMode}`,
    `Validated method: ${report.decisionStatus.validatedMethod ?? "none"}`,
    `Validated rule: ${report.decisionStatus.validatedRule ?? "none"}`,
    `Validated paper exit: ${report.decisionStatus.validatedPaperExit ?? "none"}`,
    `Validated wallet: ${report.decisionStatus.validatedWallet ?? "none"}`,
    `Wallet candidate: ${report.decisionStatus.walletCandidate ?? "none"}`,
    `Raw candidate method: ${report.decisionStatus.rawCandidateMethod ?? "none"}`,
    `Raw candidate rule: ${report.decisionStatus.rawCandidateRule ?? "none"}`,
    `Raw candidate paper exit: ${report.decisionStatus.rawCandidatePaperExit ?? "none"}`,
    `Raw watch method: ${report.decisionStatus.rawWatchMethod ?? "none"}`,
    `Raw watch rule: ${report.decisionStatus.rawWatchRule ?? "none"}`,
    `Raw watch paper exit: ${report.decisionStatus.rawWatchPaperExit ?? "none"}`,
    `Watch method: ${report.decisionStatus.watchMethod ?? "none"}`,
    `Watch rule: ${report.decisionStatus.watchRule ?? "none"}`,
    `Watch paper exit: ${report.decisionStatus.watchPaperExit ?? "none"}`,
    `Watch wallet: ${report.decisionStatus.watchWallet ?? "none"}`,
    `Leading rule: ${report.decisionStatus.leadingRule ?? "none"}`,
    `Leading paper exit: ${report.decisionStatus.leadingPaperExit ?? "none"}`,
    `Leading wallet: ${report.decisionStatus.leadingWallet ?? "none"}`,
    `Leading wallet verdict: ${report.decisionStatus.leadingWalletVerdict ?? "none"}`,
    `Leading wallet streak: ${report.decisionStatus.leadingWalletStreak}`,
    `Leading wallet mature-signal growth: ${report.decisionStatus.leadingWalletSampleGrowth}`,
    `Method persistence: ${report.decisionStatus.methodEvidenceReason}`,
    `Rule persistence: ${report.decisionStatus.ruleEvidenceReason}`,
    `Paper-exit persistence: ${report.decisionStatus.paperExitEvidenceReason}`,
    `Method holdout: ${formatHoldout(report.methodDecision)}`,
    `Rule holdout: ${formatHoldout(report.ruleDecision)}`,
    `Paper-exit holdout: ${formatHoldout(report.paperExitDecision)}`,
    `Wallet evidence: ${report.decisionStatus.walletReason}`,
    `Verdict: ${report.decisionStatus.verdict}`,
    "",
    "| Check | Value |",
    "|---|---:|",
    `Market-watch runs | ${report.decisionStatus.runs}`,
    `Wallet-quality tokens | ${report.decisionStatus.walletQualityTokens}`,
    `Wallet observed entries scored | ${report.walletOutcomeStats.walletCount}`,
    `Wallet mature outcomes | ${report.walletOutcomeStats.matureOutcomeCount}`,
    `Wallet provisional outcomes | ${report.walletOutcomeStats.provisionalOutcomeCount}`,
    `Wallet unresolved outcomes | ${report.walletOutcomeStats.unresolvedOutcomeCount}`,
    `Wallets with >=3 mature outcomes | ${report.walletOutcomeStats.walletsWithAtLeast3MatureOutcomes}`,
    `Near wallet rows | ${report.nearWalletCandidates.length}`,
    `Enough runs | ${report.decisionStatus.checks.enoughRuns ? "yes" : "no"}`,
    `Enough tokens | ${report.decisionStatus.checks.enoughTokens ? "yes" : "no"}`,
    `Positive enough | ${report.decisionStatus.checks.positiveEnough ? "yes" : "no"}`,
    `Robust after outlier checks | ${report.decisionStatus.checks.robustPositive ? "yes" : "no"}`,
    `Risk controlled | ${report.decisionStatus.checks.riskControlled ? "yes" : "no"}`,
    `Only traction | ${report.decisionStatus.checks.methodIsOnlyTraction ? "yes" : "no"}`,
    `Raw method candidate | ${report.decisionStatus.checks.rawMethodCandidate ? "yes" : "no"}`,
    `Raw rule candidate | ${report.decisionStatus.checks.rawRuleCandidate ? "yes" : "no"}`,
    `Raw paper-exit candidate | ${report.decisionStatus.checks.rawPaperExitCandidate ? "yes" : "no"}`,
    `Raw method watch | ${report.decisionStatus.checks.rawMethodWatch ? "yes" : "no"}`,
    `Raw rule watch | ${report.decisionStatus.checks.rawRuleWatch ? "yes" : "no"}`,
    `Raw paper-exit watch | ${report.decisionStatus.checks.rawPaperExitWatch ? "yes" : "no"}`,
    `Method candidate | ${report.decisionStatus.checks.methodCandidate ? "yes" : "no"}`,
    `Rule candidate | ${report.decisionStatus.checks.ruleCandidate ? "yes" : "no"}`,
    `Paper-exit candidate | ${report.decisionStatus.checks.paperExitCandidate ? "yes" : "no"}`,
    `Wallet candidate | ${report.decisionStatus.checks.walletCandidate ? "yes" : "no"}`,
    `System candidate | ${report.decisionStatus.checks.systemCandidate ? "yes" : "no"}`,
    `Canonical replay passed | ${report.decisionStatus.checks.canonicalReplayPassed ? "yes" : "no"}`,
    `Wallet-only candidate | ${report.decisionStatus.checks.walletOnlyCandidate ? "yes" : "no"}`,
    `Method watch | ${report.decisionStatus.checks.methodWatch ? "yes" : "no"}`,
    `Rule watch | ${report.decisionStatus.checks.ruleWatch ? "yes" : "no"}`,
    `Paper-exit watch | ${report.decisionStatus.checks.paperExitWatch ? "yes" : "no"}`,
    `Wallet watch | ${report.decisionStatus.checks.walletWatch ? "yes" : "no"}`,
    "",
    "## Decision History",
    "",
    "| Run | Mode | Best | Leading Rule | Rule Verdict | Rule Avg | Rule Median | Rule Ex-Best | Rule Worst | Paper Verdict | Paper Avg | Leading Wallet Verdict | Wallet Streak | Wallet Growth |",
    "|---|---|---|---|---|---:|---:|---:|---:|---|---:|---|---:|---:|",
    ...report.decisionHistory
      .slice(0, 12)
      .map((item) =>
        [
          item.runAt,
          item.mode,
          item.bestMethod,
          item.leadingRule ?? "none",
          item.topRuleVerdict ?? "none",
          item.topRuleAvgReturn === null ? "n/a" : `${item.topRuleAvgReturn}%`,
          item.topRuleMedianReturn == null ? "n/a" : `${item.topRuleMedianReturn}%`,
          item.topRuleAvgReturnExBest == null ? "n/a" : `${item.topRuleAvgReturnExBest}%`,
          item.topRuleWorstReturn === null ? "n/a" : `${item.topRuleWorstReturn}%`,
          item.topPaperExitVerdict ?? "none",
          item.topPaperExitAvgReturn === null ? "n/a" : `${item.topPaperExitAvgReturn}%`,
          item.leadingWalletVerdict ?? "none",
          item.leadingWalletStreak ?? 0,
          item.leadingWalletSampleGrowth ?? 0
        ].join(" | ")
      ),
    "",
    "## Method Status",
    "",
    `Validated method: ${report.bestMethod}`,
    `Leading raw method: ${report.leadingMethod}`,
    "",
    "| Method | Mature Tokens | Avg Net 20m | Median | Avg Ex-Best | Best-Winner Share | Hit Rate | Avg Drawdown | Evidence Score |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.methodSummary.map((item) =>
      [
        item.method,
        item.tokenCount,
        `${item.avgReturn}%`,
        `${item.medianReturn}%`,
        `${item.avgReturnExBest}%`,
        `${round(item.bestWinnerShare * 100)}%`,
        `${round(item.hitRate * 100)}%`,
        `${item.avgDrawdown}%`,
        item.evidenceScore
      ].join(" | ")
    ),
    "",
    "## Rule Candidates",
    "",
    "These are stricter filters tested from signal-time features only. They are research cohorts, not instructions.",
    "",
    "| Rank | Rule | Verdict | Mature Signals | Avg Net 20m | Median | Avg Ex-Best | Best-Winner Share | Hit Rate | Avg Drawdown | Worst | Evidence |",
    "|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.ruleCandidates
      .slice(0, 10)
      .map((item, index) =>
        [
          index + 1,
          item.rule,
          item.verdict,
          item.signalCount,
          `${item.avgReturn}%`,
          `${item.medianReturn}%`,
          `${item.avgReturnExBest}%`,
          `${round(item.bestWinnerShare * 100)}%`,
          `${round(item.hitRate * 100)}%`,
          `${item.avgDrawdown}%`,
          `${item.worstReturn}%`,
          item.evidenceScore
        ].join(" | ")
      ),
    "",
    "## Paper Exit Candidates",
    "",
    "These simulate paper exits over observed samples. Unfinished paths stay provisional, and an exit can affect the decision only when its parent method or rule is at least watch quality.",
    "",
    "| Rank | Strategy | Cohort | Raw | Parent | Decision | Mature | Provisional | Gross Avg | Cost | Net Avg | Median | Avg Ex-Best | Best-Winner Share | Hit Rate | TP Rate | SL Rate | Worst | Evidence |",
    "|---:|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.paperExitCandidates
      .slice(0, 12)
      .map((item, index) =>
        [
          index + 1,
          item.strategy,
          item.cohort,
          item.verdict,
          item.parentVerdict,
          item.decisionVerdict,
          item.signalCount,
          item.provisionalSignalCount,
          `${item.grossAvgReturn}%`,
          `${item.estimatedRoundTripCostPct}%`,
          `${item.avgReturn}%`,
          `${item.medianReturn}%`,
          `${item.avgReturnExBest}%`,
          `${round(item.bestWinnerShare * 100)}%`,
          `${round(item.hitRate * 100)}%`,
          `${round(item.takeProfitRate * 100)}%`,
          `${round(item.stopLossRate * 100)}%`,
          `${item.worstReturn}%`,
          item.evidenceScore
        ].join(" | ")
      ),
    "",
    "## Method Signal Cohorts",
    "",
    "This section freezes each method at the first post-horizon price in the 20-40 minute window and deducts the configured 3% round-trip cost.",
    "",
    "| Rank | Method | Token | Signal 5m | Signal 1h | V/L | Net 20m | Max Path | Min Path | Outcome Age | Observations |",
    "|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.methodSignals
      .slice(0, 12)
      .map((signal, index) =>
        [
          index + 1,
          signal.method,
          `${signal.symbol} (${shortAddress(signal.tokenAddress)})`,
          signal.signalPriceChange5m === null ? "n/a" : `${signal.signalPriceChange5m}%`,
          signal.signalPriceChange1h === null ? "n/a" : `${signal.signalPriceChange1h}%`,
          signal.signalVolumeLiquidityRatio,
          `${signal.returnPct}%`,
          `${signal.maxReturnPct}%`,
          `${signal.minReturnPct}%`,
          `${signal.ageMinutes}m`,
          signal.observationsAfterSignal
        ].join(" | ")
      ),
    "",
    "## Current Rule Set",
    "",
    "Use when:",
    ...report.ruleSet.useWhen.map((line) => `- ${line}`),
    "",
    "Avoid when:",
    ...report.ruleSet.avoidWhen.map((line) => `- ${line}`),
    "",
    "## Top Tracked Tokens",
    "",
    "| Rank | Token | Tags | Return | Max | Min | Liquidity | Wallet Events | Score |",
    "|---:|---|---|---:|---:|---:|---:|---:|---:|",
    ...report.topTokens
      .slice(0, 15)
      .map((item, index) =>
        [
          index + 1,
          `${item.token.symbol} (${shortAddress(item.token.tokenAddress)})`,
          item.latest.methodTags.join(", "),
          `${item.returnPct}%`,
          `${item.maxReturnPct}%`,
          `${item.minReturnPct}%`,
          `$${Math.round(item.latest.liquidityUsd).toLocaleString()}`,
          item.latest.walletEventCount,
          item.durabilityScore
        ].join(" | ")
      ),
    "",
    "## Near Wallet Candidates",
    "",
    "Wallets here are not approved. They are only the closest observed-entry cohorts to watch gates.",
    "",
    "| Rank | Wallet | Verdict | Confidence | Mature | Provisional | Unresolved | Observed Entries | Provisional Avg | Mature Avg | Worst | Hit Rate | Score |",
    "|---:|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.nearWalletCandidates.map((wallet, index) =>
      [
        index + 1,
        wallet.wallet,
        wallet.walletVerdict,
        wallet.walletConfidence,
        wallet.tokenOutcomeCount,
        wallet.provisionalOutcomeCount,
        wallet.unresolvedOutcomeCount,
        wallet.observedEntryCount,
        `${wallet.provisionalAvgTokenReturnPct}%`,
        `${wallet.avgTokenReturnPct}%`,
        `${wallet.worstTokenReturnPct}%`,
        `${round(wallet.tokenHitRate * 100)}%`,
        wallet.walletScore
      ].join(" | ")
    ),
    report.nearWalletCandidates.length === 0 ? "none" : "",
    "",
    "## Top Wallet Watchlist",
    "",
    "| Rank | Wallet | Verdict | Confidence | Labels | Mature | Provisional | Unresolved | Max Age | Observed Entries | Legacy Buys | Provisional Avg | Mature Avg | Worst | Hit Rate | Score |",
    "|---:|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.topWallets
      .slice(0, 20)
      .map((wallet, index) =>
        [
          index + 1,
          wallet.wallet,
          wallet.walletVerdict,
          wallet.walletConfidence,
          wallet.labels.join(", "),
          wallet.tokenOutcomeCount,
          wallet.provisionalOutcomeCount,
          wallet.unresolvedOutcomeCount,
          `${wallet.maxObservedEntryAgeMinutes}m`,
          wallet.observedEntryCount,
          wallet.legacySignalCount,
          `${wallet.provisionalAvgTokenReturnPct}%`,
          `${wallet.avgTokenReturnPct}%`,
          `${wallet.worstTokenReturnPct}%`,
          `${round(wallet.tokenHitRate * 100)}%`,
          wallet.walletScore
        ].join(" | ")
      ),
    "",
    "## State",
    "",
    `Tokens tracked: ${report.stateStats.tokensTracked}`,
    `Wallets tracked: ${report.stateStats.walletsTracked}`,
    `Market-watch runs: ${report.stateStats.runs}`,
    "",
    "## How To Continue",
    "",
    "Run `npm run research:market-watch` repeatedly. More cycles make the method comparison more meaningful."
  ].join("\n");
}

async function fetchJson<T>(url: string, retries = 2): Promise<T> {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEX_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      if (response.ok) return (await response.json()) as T;
      if (attempt < retries && (response.status === 429 || response.status >= 500)) {
        const delay = response.status === 429 ? 3000 * 2 ** attempt : 500 * 2 ** attempt;
        await sleep(delay);
        continue;
      }
      throw new Error(`HTTP ${response.status} for ${url}`);
    } catch (error) {
      if (attempt >= retries) throw error;
      await sleep(500 * 2 ** attempt);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`Retry exhausted for ${url}`);
}

function percentChange(from: number, to: number): number {
  if (!from || from <= 0) return 0;
  return ((to - from) / from) * 100;
}

function number(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatHoldout(decision: ReturnType<typeof buildHypothesisDecision>): string {
  return `${decision.holdoutCount} new signals, avg=${round(decision.holdoutAvgReturn)}%, median=${round(decision.holdoutMedianReturn)}%, hit=${round(decision.holdoutHitRate * 100)}%, worst=${round(decision.holdoutWorstReturn)}%, passed=${decision.holdoutPassed ? "yes" : "no"}`;
}

function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}...${address.slice(-6)}` : address;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
