import { createHash } from "node:crypto";
import type {
  TokenAmount,
  WalletAlphaReturnMetrics,
  WalletAlphaScoreSnapshot,
  WalletAlphaSignalEvidence,
  WalletEntrySignalEvidence,
  WalletSignalOutcomeEvidence,
  WalletTradeEvidence,
  WalletTradePriceQuality
} from "@memecoin-alpha/shared";
import { isSourceLinkedWalletEntry } from "./evidence-engine";

type WalletAlphaReturnMetricsV2 = WalletAlphaReturnMetrics &
  Required<
    Pick<
      WalletAlphaReturnMetrics,
      "hitRateWilsonLowerBound" | "shrunkHitRate" | "sampleReliability"
    >
  >;

export type WalletAlphaScoringPolicy = "fixed-horizon-v1" | "managed-exit-v2";

interface WalletAlphaReturnObservation {
  value: number;
  observedAt: string;
  rugged: boolean;
}

interface ManagedTailRiskThresholds {
  maximumRuggedOutcomeRate: number;
  maximumCatastrophicLossRate: number;
}

export const MANAGED_EXIT_V2_POLICY = {
  scoreStrategyVersion: "wallet-alpha-managed-v2",
  followabilityExitStrategy: "tp15-sl20-20m",
  catastrophicLossBoundaryPct: -50,
  watch: {
    minimumProfitabilitySamples: 15,
    minimumFollowabilitySamples: 30,
    minimumActiveDays: 4,
    minimumFollowabilityHitRate: 0.55,
    minimumFollowabilityProfitFactor: 1.2,
    maximumRuggedOutcomeRate: 0.05,
    maximumCatastrophicLossRate: 0.05
  },
  candidate: {
    minimumProfitabilitySamples: 30,
    minimumFollowabilitySamples: 30,
    minimumActiveDays: 7,
    minimumHighQualityExecutionCoverage: 0.9,
    maximumBestWinnerShare: 0.4,
    minimumHitRate: 0.55,
    minimumProfitFactor: 1.2,
    maximumRuggedOutcomeRate: 0.025,
    maximumCatastrophicLossRate: 0.05
  },
  validatedPaper: {
    minimumProfitabilitySamples: 30,
    minimumFollowabilitySamples: 30,
    minimumActiveDays: 14,
    holdoutMaximumRuggedOutcomeRate: 0.1,
    holdoutMaximumCatastrophicLossRate: 0.1
  }
} as const;

export interface WalletClosedPosition {
  episodeId: string;
  walletAddress: string;
  tokenAddress: string;
  roundTripIndex: number;
  sellIdempotencyKey: string;
  openedAt: string;
  closedAt: string;
  realizedBaseAmount: TokenAmount;
  remainingBaseAmount: TokenAmount;
  investedUsd: number;
  proceedsUsd: number;
  netPnlUsd: number;
  netReturnPct: number;
  highQuality: boolean;
  priceQuality: WalletTradePriceQuality;
  /** Backward-compatible alias for high-quality execution coverage. */
  exact: boolean;
}

export interface WalletOpenInventory {
  walletAddress: string;
  tokenAddress: string;
  roundTripIndex: number;
  openedAt: string;
  updatedAt: string;
  remainingBaseAmount: TokenAmount;
  remainingCostUsd: number;
  lotCount: number;
  highQuality: boolean;
}

export interface WalletLedger {
  realizedEpisodes: WalletClosedPosition[];
  openInventory: WalletOpenInventory[];
  /** Durable round-trip projection. Partial exits accumulate on the same episode. */
  positionEpisodes: WalletLedgerPositionEpisode[];
  /** Durable FIFO audit trail, including fully-consumed and still-open buy lots. */
  positionLots: WalletLedgerPositionLot[];
}

export interface WalletLedgerPositionEpisode {
  episodeId: string;
  chain: WalletTradeEvidence["chain"];
  strategyVersion: string;
  walletAddress: string;
  tokenAddress: string;
  roundTripIndex: number;
  status: "open" | "realized";
  openedAt: string;
  closedAt?: string;
  costBasisUsd: number;
  proceedsUsd: number;
  realizedPnlUsd: number;
  returnPct?: number;
  remainingBaseAmount: TokenAmount;
  realizedLotCount: number;
  highQualityPriceCoverage: number;
  metadata: Record<string, unknown>;
}

export interface WalletLedgerPositionLot {
  lotId: string;
  episodeId: string;
  sourceEventIdempotencyKey: string;
  lotSequence: number;
  rawAmount: TokenAmount;
  remainingBaseAmount: TokenAmount;
  quoteCostUsd: number;
  feesUsd: number;
  slippageUsd: number;
  openedAt: string;
  closedAt?: string;
  status: "open" | "partially_realized" | "realized";
  metadata: Record<string, unknown>;
}

export type WalletEntryRiskGateStatus = "passed" | "unknown" | "failed";

export interface BuildWalletAlphaInput {
  trades: WalletTradeEvidence[];
  entries: WalletEntrySignalEvidence[];
  outcomes: WalletSignalOutcomeEvidence[];
  strategyVersion: string;
  /** Optional separate score namespace; evidence remains in strategyVersion. */
  scoreStrategyVersion?: string;
  /** Defaults to the production-compatible fixed-horizon policy. */
  scoringPolicy?: WalletAlphaScoringPolicy;
  calculatedAt?: string;
  creatorWallets?: Set<string>;
  roundTripCostPct?: number;
  /** Verified per-wallet ledgers can supply profitability without rereading archived trades. */
  prebuiltLedgers?: ReadonlyMap<string, WalletLedger>;
}

export interface BuildWalletAlphaSignalInput {
  scores: WalletAlphaScoreSnapshot[];
  entries: WalletEntrySignalEvidence[];
  strategyVersion: string;
  now?: string;
  maximumSignalAgeHours?: number;
  minimumLiquidityUsd?: number;
}

export function buildWalletAlphaScores(input: BuildWalletAlphaInput): WalletAlphaScoreSnapshot[] {
  const calculatedAt = input.calculatedAt ?? new Date().toISOString();
  const calculatedAtMs = validTimestamp(calculatedAt) ?? Date.now();
  const scoringPolicy = input.scoringPolicy ?? "fixed-horizon-v1";
  const scoreStrategyVersion = input.scoreStrategyVersion ?? input.strategyVersion;
  const followabilityExitStrategy =
    scoringPolicy === "managed-exit-v2"
      ? MANAGED_EXIT_V2_POLICY.followabilityExitStrategy
      : "fixed-horizon";
  const strategyTrades = input.trades.filter(
    (trade) => trade.strategyVersion === input.strategyVersion
  );
  const strategyEntries = input.entries.filter(
    (entry) => entry.strategyVersion === input.strategyVersion
  );
  const strategyOutcomes = input.outcomes.filter(
    (outcome) => outcome.strategyVersion === input.strategyVersion
  );
  const tradesByWallet = groupByWallet(strategyTrades);
  const entriesByWallet = groupByWallet(strategyEntries);
  const matureOutcomeByEntry = indexMatureOutcomes(strategyOutcomes, followabilityExitStrategy);
  const wallets = new Set([
    ...tradesByWallet.keys(),
    ...entriesByWallet.keys(),
    ...(input.prebuiltLedgers?.keys() ?? [])
  ]);

  return [...wallets]
    .map((walletAddress) => {
      const ledger =
        input.prebuiltLedgers?.get(walletAddress) ??
        buildWalletLedger(tradesByWallet.get(walletAddress) ?? [], input.roundTripCostPct ?? 3);
      const allProfitabilityReturns = ledger.realizedEpisodes.map((position) => ({
        value: position.netReturnPct,
        observedAt: position.closedAt,
        rugged: false
      }));
      const allFollowability = walletFollowabilityReturns(
        entriesByWallet.get(walletAddress) ?? [],
        matureOutcomeByEntry
      );
      const positions90d = ledger.realizedEpisodes.filter((position) =>
        isWithinDays(position.closedAt, calculatedAtMs, 90)
      );
      const profitabilityReturns90d = withinDays(allProfitabilityReturns, calculatedAtMs, 90);
      const profitabilityReturns30d = withinDays(allProfitabilityReturns, calculatedAtMs, 30);
      const followability90d = withinDays(allFollowability, calculatedAtMs, 90);
      const followability30d = withinDays(allFollowability, calculatedAtMs, 30);
      const profitability90d = summarizeReturnObservations(profitabilityReturns90d);
      const profitability30d = summarizeReturnObservations(profitabilityReturns30d);
      const followabilityMetrics90d = summarizeReturnObservations(followability90d);
      const followabilityMetrics30d = summarizeReturnObservations(followability30d);
      const activeDays = new Set(
        positions90d.flatMap((position) => [
          position.openedAt.slice(0, 10),
          position.closedAt.slice(0, 10)
        ])
      ).size;
      const highQualityPositionCount = positions90d.filter(
        (position) => position.highQuality
      ).length;
      const directCreator = input.creatorWallets?.has(walletAddress) ?? false;
      const profitabilityHoldoutsPassed = chronologicalHoldoutsPass(
        profitabilityReturns90d,
        scoringPolicy,
        "profitability"
      );
      const followabilityHoldoutsPassed = chronologicalHoldoutsPass(
        followability90d,
        scoringPolicy,
        "followability"
      );
      const profitabilityDecay = recencyDecayFactor(profitabilityReturns90d, calculatedAtMs);
      const followabilityDecay = recencyDecayFactor(followability90d, calculatedAtMs);
      const profitabilityScore = blendedWindowScore(
        profitability30d,
        profitability90d,
        profitabilityDecay,
        "fixed-horizon-v1"
      );
      const followabilityScore = blendedWindowScore(
        followabilityMetrics30d,
        followabilityMetrics90d,
        followabilityDecay,
        scoringPolicy
      );
      const overallScore = round(
        Math.min(100, profitabilityScore * 0.55 + followabilityScore * 0.45)
      );
      const highQualityExecutionCoverage =
        highQualityPositionCount / Math.max(positions90d.length, 1);
      const gates =
        scoringPolicy === "managed-exit-v2"
          ? buildManagedExitGates({
              profitability: profitability90d,
              followability: followabilityMetrics90d,
              profitabilitySamples: positions90d.length,
              followabilitySamples: followability90d.length,
              activeDays,
              highQualityExecutionCoverage
            })
          : buildFixedHorizonGates({
              profitability: profitability90d,
              followability: followabilityMetrics90d,
              profitabilitySamples: positions90d.length,
              followabilitySamples: followability90d.length,
              activeDays,
              highQualityExecutionCoverage
            });
      gates.validatedPaper =
        gates.candidate &&
        positions90d.length >= 30 &&
        followability90d.length >= 30 &&
        activeDays >= 14 &&
        profitabilityHoldoutsPassed &&
        followabilityHoldoutsPassed;

      const status = directCreator
        ? "excluded"
        : gates.validatedPaper
          ? "validated-paper"
          : gates.candidate
            ? "candidate"
            : gates.watch
              ? "watch"
              : gates.observed
                ? "observed"
                : "insufficient";
      const reasons = buildReasons({
        status,
        positions: positions90d,
        followabilityCount: followability90d.length,
        profitability: profitability90d,
        followability: followabilityMetrics90d,
        activeDays,
        highQualityExecutionCoverage,
        directCreator,
        scoringPolicy,
        followabilityExitStrategy,
        watchPassed: gates.watch
      });

      const uniqueTokens = new Set(positions90d.map((position) => position.tokenAddress)).size;
      const openInventoryCostUsd = ledger.openInventory.reduce(
        (sum, inventory) => sum + inventory.remainingCostUsd,
        0
      );
      const reliabilityScore = round(
        100 *
          mean([
            profitability90d.hitRateWilsonLowerBound * profitability90d.sampleReliability,
            followabilityMetrics90d.hitRateWilsonLowerBound *
              followabilityMetrics90d.sampleReliability
          ])
      );
      const recencyFactor = round(mean([profitabilityDecay, followabilityDecay]));

      return {
        chain: "solana",
        walletAddress,
        strategyVersion: scoreStrategyVersion,
        calculatedAt,
        status,
        profitabilityScore,
        followabilityScore,
        overallScore,
        completedPositions: positions90d.length,
        uniqueTokens,
        activeDays,
        metrics: {
          completedPositions: positions90d.length,
          eligibleEarlyPositions: positions90d.length,
          uniqueTokens,
          activeDays,
          exactPositionCount: highQualityPositionCount,
          estimatedPositionCount: positions90d.length - highQualityPositionCount,
          highQualityPositionCount,
          highQualityExecutionCoverage,
          openInventoryCount: ledger.openInventory.length,
          openInventoryCostUsd: round(openInventoryCostUsd),
          profitability: profitability90d,
          followability: followabilityMetrics90d,
          profitability30d,
          profitability90d,
          followability30d: followabilityMetrics30d,
          followability90d: followabilityMetrics90d,
          scoringPolicy,
          evidenceStrategyVersion: input.strategyVersion,
          followabilityExitStrategy,
          reliabilityScore,
          recencyDecayFactor: recencyFactor,
          profitabilityHoldoutsPassed,
          followabilityHoldoutsPassed,
          directCreator
        },
        gates,
        reasons
      } satisfies WalletAlphaScoreSnapshot;
    })
    .sort(
      (a, b) =>
        statusRank(b.status) - statusRank(a.status) ||
        b.overallScore - a.overallScore ||
        b.completedPositions - a.completedPositions ||
        compareCodeUnits(a.walletAddress, b.walletAddress)
    );
}

export function buildClosedWalletPositions(
  trades: WalletTradeEvidence[],
  roundTripCostPct = 3
): WalletClosedPosition[] {
  return buildWalletLedger(trades, roundTripCostPct).realizedEpisodes;
}

interface WalletInventoryLot {
  id: string;
  episodeId: string;
  sourceEventIdempotencyKey: string;
  lotSequence: number;
  originalUnits: bigint;
  units: bigint;
  quoteCostUsd: number;
  modeledExecutionCostUsd: number;
  originalCostUsd: number;
  costUsd: number;
  openedAt: string;
  closedAt?: string;
  highQuality: boolean;
  priceQuality: WalletTradePriceQuality;
  roundTripIndex: number;
  realizationIds: string[];
}

interface WalletEpisodeAccumulator {
  episodeId: string;
  chain: WalletTradeEvidence["chain"];
  strategyVersion: string;
  walletAddress: string;
  tokenAddress: string;
  roundTripIndex: number;
  openedAt: string;
  lastUpdatedAt: string;
  costBasisUsd: number;
  realizedCostBasisUsd: number;
  proceedsUsd: number;
  realizedPnlUsd: number;
  realizedLotCount: number;
  highQualityEventCount: number;
  priceEventCount: number;
  realizations: Array<Record<string, unknown>>;
}

interface NormalizedTradeQuantity {
  units: bigint;
  decimals: number;
}

type LedgerOrder = Pick<
  WalletTradeEvidence,
  "slot" | "observedAt" | "signature" | "idempotencyKey"
>;
type LedgerFirstBuy = Pick<
  WalletTradeEvidence,
  "walletAddress" | "tokenAddress" | "observedAt" | "poolAgeMinutes"
>;
type SerializedInventoryLot = Omit<WalletInventoryLot, "originalUnits" | "units"> & {
  originalUnits: string;
  units: string;
};
interface LedgerMarketContinuation {
  key: string;
  decimals: number;
  firstBuy?: LedgerFirstBuy;
  roundTripIndex: number;
  lotSequence: number;
  lastTrackedAt: string;
  activeEpisode?: WalletEpisodeAccumulator;
  lots: SerializedInventoryLot[];
}

/** Local-only continuation format. NOT an archive receipt or source-retirement permission. */
export interface WalletLedgerCheckpoint {
  version: "fifo-continuation-v1";
  payload: string;
  sha256: string;
}
export type WalletLedgerCheckpointOrder = LedgerOrder;
interface LedgerContinuationPayload {
  scope: string;
  roundTripCostPct: number;
  lastOrder: LedgerOrder;
  markets: LedgerMarketContinuation[];
}

export function walletLedgerCheckpointOrder(
  checkpoint: WalletLedgerCheckpoint
): WalletLedgerCheckpointOrder {
  if (
    checkpoint.version !== "fifo-continuation-v1" ||
    Buffer.byteLength(checkpoint.payload) > 4 * 1024 * 1024 ||
    createHash("sha256").update(checkpoint.payload).digest("hex") !== checkpoint.sha256
  ) {
    throw new Error("Invalid FIFO continuation checkpoint integrity");
  }
  const parsed = JSON.parse(checkpoint.payload) as Partial<LedgerContinuationPayload>;
  const order = parsed.lastOrder;
  if (
    !order ||
    !Number.isSafeInteger(order.slot) ||
    !Number.isFinite(Date.parse(order.observedAt)) ||
    typeof order.signature !== "string" ||
    typeof order.idempotencyKey !== "string"
  ) {
    throw new Error("Invalid FIFO continuation checkpoint order");
  }
  return { ...order };
}

/**
 * Returns new realizations/closed episodes and the complete current open inventory.
 * Consumers must persist those deltas and the checkpoint atomically. Old/changed input at or
 * before the boundary requires an archive-backed rebuild; it must never be silently skipped.
 * No production reader uses this until database CAS, archive and full dual-read gates pass.
 */
export function advanceWalletLedger(
  trades: WalletTradeEvidence[],
  checkpoint?: WalletLedgerCheckpoint,
  roundTripCostPct = 3
): { ledger: WalletLedger; checkpoint: WalletLedgerCheckpoint } {
  const maximumBytes = 4 * 1024 * 1024;
  if (trades.length > 10_000) throw new Error("FIFO continuation trade budget exceeded");
  if (!Number.isFinite(roundTripCostPct) || roundTripCostPct < 0) {
    throw new Error("Invalid FIFO continuation cost model");
  }
  let prior: LedgerContinuationPayload | undefined;
  if (checkpoint) {
    if (
      checkpoint.version !== "fifo-continuation-v1" ||
      Buffer.byteLength(checkpoint.payload) > maximumBytes ||
      createHash("sha256").update(checkpoint.payload).digest("hex") !== checkpoint.sha256
    ) {
      throw new Error("Invalid FIFO continuation checkpoint integrity");
    }
    prior = JSON.parse(checkpoint.payload) as LedgerContinuationPayload;
    if (
      prior.roundTripCostPct !== roundTripCostPct ||
      !Array.isArray(prior.markets) ||
      prior.markets.length > 2_000 ||
      !prior.lastOrder ||
      typeof prior.scope !== "string"
    ) {
      throw new Error("FIFO continuation policy mismatch");
    }
  }
  const ordered = deduplicateTrades(trades);
  const first = ordered[0];
  const scope = first
    ? `${first.chain}:${first.strategyVersion}:${first.walletAddress}`
    : prior?.scope;
  if (!scope || (prior && prior.scope !== scope))
    throw new Error("FIFO continuation scope mismatch");
  for (const trade of ordered) {
    if (
      `${trade.chain}:${trade.strategyVersion}:${trade.walletAddress}` !== scope ||
      !Number.isSafeInteger(trade.slot) ||
      !Number.isFinite(Date.parse(trade.observedAt))
    ) {
      throw new Error("Invalid FIFO continuation evidence scope/order");
    }
    if (prior && compareEvidenceOrder(trade, prior.lastOrder) <= 0) {
      throw new Error("FIFO continuation requires rebuild for late or overlapping evidence");
    }
  }
  const markets: LedgerMarketContinuation[] = [];
  const ledger = buildWalletLedgerBatch(ordered, roundTripCostPct, prior?.markets, markets);
  if (markets.length > 2_000 || markets.reduce((n, item) => n + item.lots.length, 0) > 10_000) {
    throw new Error("FIFO continuation inventory budget exceeded");
  }
  const last = ordered.at(-1);
  const payload = JSON.stringify({
    scope,
    roundTripCostPct,
    lastOrder: last ? ledgerOrder(last) : prior!.lastOrder,
    markets: markets.sort((a, b) => compareCodeUnits(a.key, b.key))
  } satisfies LedgerContinuationPayload);
  if (Buffer.byteLength(payload) > maximumBytes)
    throw new Error("FIFO continuation byte budget exceeded");
  return {
    ledger,
    checkpoint: {
      version: "fifo-continuation-v1",
      payload,
      sha256: createHash("sha256").update(payload).digest("hex")
    }
  };
}

function ledgerOrder(trade: WalletTradeEvidence): LedgerOrder {
  return {
    slot: trade.slot,
    observedAt: trade.observedAt,
    signature: trade.signature,
    idempotencyKey: trade.idempotencyKey
  };
}

export function buildWalletLedger(
  trades: WalletTradeEvidence[],
  roundTripCostPct = 3
): WalletLedger {
  return buildWalletLedgerBatch(trades, roundTripCostPct);
}

function buildWalletLedgerBatch(
  trades: WalletTradeEvidence[],
  roundTripCostPct: number,
  previous: LedgerMarketContinuation[] = [],
  next?: LedgerMarketContinuation[]
): WalletLedger {
  const byWalletToken = new Map<string, WalletTradeEvidence[]>();
  const previousByKey = new Map(previous.map((item) => [item.key, item]));
  for (const item of previous) byWalletToken.set(item.key, []);
  const deterministicTrades = deduplicateTrades(trades);
  for (const trade of deterministicTrades) {
    const key = `${trade.chain}:${trade.strategyVersion}:${trade.walletAddress}:${trade.tokenAddress}`;
    const current = byWalletToken.get(key) ?? [];
    current.push(trade);
    byWalletToken.set(key, current);
  }
  const sideCostRate = Math.max(0, roundTripCostPct) / 200;
  const realizedEpisodes: WalletClosedPosition[] = [];
  const openInventory: WalletOpenInventory[] = [];
  const positionEpisodes: WalletLedgerPositionEpisode[] = [];
  const positionLots: WalletLedgerPositionLot[] = [];

  for (const [key, walletTrades] of byWalletToken) {
    const prior = previousByKey.get(key);
    const ordered = [...walletTrades].sort(compareEvidenceOrder);
    const firstBuy = prior?.firstBuy ?? ordered.find((trade) => trade.side === "buy");
    const decimals = prior?.decimals ?? commonBaseDecimals(ordered);
    if (prior && ordered.length > 0 && commonBaseDecimals(ordered) > prior.decimals) {
      throw new Error("FIFO continuation requires rebuild for changed token precision");
    }
    const lots: WalletInventoryLot[] = (prior?.lots ?? []).map((lot) => ({
      ...lot,
      originalUnits: BigInt(lot.originalUnits),
      units: BigInt(lot.units)
    }));
    let roundTripIndex = prior?.roundTripIndex ?? 0;
    let lotSequence = prior?.lotSequence ?? 0;
    let activeEpisode = prior?.activeEpisode;
    let lastTrackedAt = prior?.lastTrackedAt ?? firstBuy?.observedAt ?? ordered[0]!.observedAt;
    const capture = () =>
      next?.push({
        key,
        decimals,
        roundTripIndex,
        lotSequence,
        lastTrackedAt,
        ...(firstBuy
          ? {
              firstBuy: {
                walletAddress: firstBuy.walletAddress,
                tokenAddress: firstBuy.tokenAddress,
                observedAt: firstBuy.observedAt,
                ...(firstBuy.poolAgeMinutes !== undefined
                  ? { poolAgeMinutes: firstBuy.poolAgeMinutes }
                  : {})
              }
            }
          : {}),
        ...(activeEpisode ? { activeEpisode } : {}),
        // Fully consumed lots are emitted as deltas, never retained in continuation state.
        lots: lots
          .filter((lot) => lot.units > 0n)
          .map((lot) => ({
            ...lot,
            originalUnits: lot.originalUnits.toString(),
            units: lot.units.toString()
          }))
      });
    if (!firstBuy || !isNewTokenEntry(firstBuy.poolAgeMinutes)) {
      capture();
      continue;
    }

    for (const trade of ordered) {
      const quantity = normalizedTradeQuantity(trade, decimals);
      const tradeValueUsd = usdValue(trade);
      if (!quantity || quantity.units <= 0n || tradeValueUsd === null) continue;
      const priceQuality = normalizedPriceQuality(trade);
      const highQuality = isHighQualityPrice(priceQuality);
      lastTrackedAt = trade.observedAt;

      if (trade.side === "buy") {
        if (inventoryUnits(lots) === 0n) {
          roundTripIndex += 1;
          lotSequence = 0;
          const episodeId = deterministicLedgerId([
            "episode-v2",
            trade.chain,
            trade.strategyVersion,
            trade.walletAddress,
            trade.tokenAddress,
            roundTripIndex.toString(),
            trade.idempotencyKey
          ]);
          activeEpisode = {
            episodeId,
            chain: trade.chain,
            strategyVersion: trade.strategyVersion,
            walletAddress: trade.walletAddress,
            tokenAddress: trade.tokenAddress,
            roundTripIndex,
            openedAt: trade.observedAt,
            lastUpdatedAt: trade.observedAt,
            costBasisUsd: 0,
            realizedCostBasisUsd: 0,
            proceedsUsd: 0,
            realizedPnlUsd: 0,
            realizedLotCount: 0,
            highQualityEventCount: 0,
            priceEventCount: 0,
            realizations: []
          };
        }
        if (!activeEpisode) continue;
        const cost = tradeValueUsd * (1 + sideCostRate);
        const executionCost = cost - tradeValueUsd;
        lotSequence += 1;
        lots.push({
          id: deterministicLedgerId([
            "lot-v2",
            activeEpisode.episodeId,
            trade.idempotencyKey,
            lotSequence.toString()
          ]),
          episodeId: activeEpisode.episodeId,
          sourceEventIdempotencyKey: trade.idempotencyKey,
          lotSequence,
          originalUnits: quantity.units,
          units: quantity.units,
          quoteCostUsd: tradeValueUsd,
          modeledExecutionCostUsd: executionCost,
          originalCostUsd: cost,
          costUsd: cost,
          openedAt: trade.observedAt,
          highQuality,
          priceQuality,
          roundTripIndex,
          realizationIds: []
        });
        activeEpisode.costBasisUsd += cost;
        activeEpisode.lastUpdatedAt = trade.observedAt;
        activeEpisode.priceEventCount += 1;
        if (highQuality) activeEpisode.highQualityEventCount += 1;
        continue;
      }

      const availableUnits = inventoryUnits(lots);
      if (availableUnits <= 0n || !activeEpisode) continue;
      const matchedUnits = minBigInt(availableUnits, quantity.units);
      let unitsToConsume = matchedUnits;
      let allocatedCostUsd = 0;
      let openedAt = trade.observedAt;
      let consumedLotCount = 0;
      const consumedQualities: WalletTradePriceQuality[] = [priceQuality];

      for (const lot of lots) {
        if (unitsToConsume <= 0n) break;
        if (lot.units <= 0n) continue;
        const consumed = minBigInt(lot.units, unitsToConsume);
        const consumedFraction = bigintRatio(consumed, lot.units);
        const consumedCost = lot.costUsd * consumedFraction;
        allocatedCostUsd += consumedCost;
        openedAt = earlierIso(openedAt, lot.openedAt);
        consumedQualities.push(lot.priceQuality);
        lot.units -= consumed;
        lot.costUsd -= consumedCost;
        lot.realizationIds.push(trade.idempotencyKey);
        unitsToConsume -= consumed;
        consumedLotCount += 1;
        if (lot.units === 0n) lot.closedAt = trade.observedAt;
      }

      if (allocatedCostUsd <= 0 || unitsToConsume > 0n) continue;
      const grossProceedsUsd = tradeValueUsd * bigintRatio(matchedUnits, quantity.units);
      const proceedsUsd = grossProceedsUsd * (1 - sideCostRate);
      const netPnlUsd = proceedsUsd - allocatedCostUsd;
      const remainingUnits = inventoryUnits(lots);
      const episodeQuality = combinePriceQualities(consumedQualities);
      const episodeHighQuality = isHighQualityPrice(episodeQuality);
      const realizationId = deterministicLedgerId([
        "realization-v2",
        activeEpisode.episodeId,
        trade.idempotencyKey,
        matchedUnits.toString()
      ]);
      realizedEpisodes.push({
        episodeId: realizationId,
        walletAddress: trade.walletAddress,
        tokenAddress: trade.tokenAddress,
        roundTripIndex,
        sellIdempotencyKey: trade.idempotencyKey,
        openedAt,
        closedAt: trade.observedAt,
        realizedBaseAmount: tokenAmount(matchedUnits, decimals),
        remainingBaseAmount: tokenAmount(remainingUnits, decimals),
        investedUsd: allocatedCostUsd,
        proceedsUsd,
        netPnlUsd,
        netReturnPct: (netPnlUsd / allocatedCostUsd) * 100,
        highQuality: episodeHighQuality,
        priceQuality: episodeQuality,
        exact: episodeHighQuality
      });
      activeEpisode.realizedCostBasisUsd += allocatedCostUsd;
      activeEpisode.proceedsUsd += proceedsUsd;
      activeEpisode.realizedPnlUsd += netPnlUsd;
      activeEpisode.realizedLotCount += consumedLotCount;
      activeEpisode.lastUpdatedAt = trade.observedAt;
      activeEpisode.priceEventCount += 1;
      if (highQuality) activeEpisode.highQualityEventCount += 1;
      activeEpisode.realizations.push({
        id: realizationId,
        sourceEventIdempotencyKey: trade.idempotencyKey,
        openedAt,
        closedAt: trade.observedAt,
        rawAmount: matchedUnits.toString(),
        remainingRawAmount: remainingUnits.toString(),
        tokenDecimals: decimals,
        costBasisUsd: allocatedCostUsd,
        proceedsUsd,
        realizedPnlUsd: netPnlUsd,
        returnPct: (netPnlUsd / allocatedCostUsd) * 100,
        highQuality: episodeHighQuality,
        priceQuality: episodeQuality,
        exact: episodeHighQuality
      });

      if (remainingUnits === 0n) {
        positionEpisodes.push(
          finalizePositionEpisode(activeEpisode, decimals, 0n, "realized", trade.observedAt)
        );
        activeEpisode = undefined;
      }
    }

    capture();
    const remainingUnits = inventoryUnits(lots);
    const activeLots = lots.filter((lot) => lot.units > 0n);
    if (remainingUnits > 0n && activeLots.length > 0 && activeEpisode) {
      openInventory.push({
        walletAddress: firstBuy.walletAddress,
        tokenAddress: firstBuy.tokenAddress,
        roundTripIndex: activeLots[0]!.roundTripIndex,
        openedAt: activeLots[0]!.openedAt,
        updatedAt: lastTrackedAt,
        remainingBaseAmount: tokenAmount(remainingUnits, decimals),
        remainingCostUsd: activeLots.reduce((sum, lot) => sum + lot.costUsd, 0),
        lotCount: activeLots.length,
        highQuality: activeLots.every((lot) => lot.highQuality)
      });
      positionEpisodes.push(
        finalizePositionEpisode(activeEpisode, decimals, remainingUnits, "open")
      );
    }

    positionLots.push(
      ...lots.map((lot) => ({
        lotId: lot.id,
        episodeId: lot.episodeId,
        sourceEventIdempotencyKey: lot.sourceEventIdempotencyKey,
        lotSequence: lot.lotSequence,
        rawAmount: tokenAmount(lot.originalUnits, decimals),
        remainingBaseAmount: tokenAmount(lot.units, decimals),
        quoteCostUsd: lot.quoteCostUsd,
        feesUsd: 0,
        slippageUsd: lot.modeledExecutionCostUsd,
        openedAt: lot.openedAt,
        ...(lot.closedAt ? { closedAt: lot.closedAt } : {}),
        status:
          lot.units === 0n
            ? ("realized" as const)
            : lot.units < lot.originalUnits
              ? ("partially_realized" as const)
              : ("open" as const),
        metadata: {
          remainingCostUsd: lot.costUsd,
          allInOriginalCostUsd: lot.originalCostUsd,
          priceQuality: lot.priceQuality,
          realizationIds: lot.realizationIds,
          costModel: "modeled-round-trip-cost"
        }
      }))
    );
  }

  return {
    realizedEpisodes: realizedEpisodes.sort(compareRealizedEpisodes),
    openInventory: openInventory.sort(
      (a, b) =>
        compareCodeUnits(a.walletAddress, b.walletAddress) ||
        compareCodeUnits(a.tokenAddress, b.tokenAddress)
    ),
    positionEpisodes: positionEpisodes.sort(comparePositionEpisodes),
    positionLots: positionLots.sort(comparePositionLots)
  };
}

function finalizePositionEpisode(
  episode: WalletEpisodeAccumulator,
  decimals: number,
  remainingUnits: bigint,
  status: WalletLedgerPositionEpisode["status"],
  closedAt?: string
): WalletLedgerPositionEpisode {
  const highQualityPriceCoverage =
    episode.priceEventCount === 0 ? 0 : episode.highQualityEventCount / episode.priceEventCount;
  return {
    episodeId: episode.episodeId,
    chain: episode.chain,
    strategyVersion: episode.strategyVersion,
    walletAddress: episode.walletAddress,
    tokenAddress: episode.tokenAddress,
    roundTripIndex: episode.roundTripIndex,
    status,
    openedAt: episode.openedAt,
    ...(closedAt ? { closedAt } : {}),
    costBasisUsd: episode.costBasisUsd,
    proceedsUsd: episode.proceedsUsd,
    realizedPnlUsd: episode.realizedPnlUsd,
    ...(episode.realizedCostBasisUsd > 0
      ? { returnPct: (episode.realizedPnlUsd / episode.realizedCostBasisUsd) * 100 }
      : {}),
    remainingBaseAmount: tokenAmount(remainingUnits, decimals),
    realizedLotCount: episode.realizedLotCount,
    highQualityPriceCoverage,
    metadata: {
      ledgerVersion: "fifo-v2",
      lastUpdatedAt: episode.lastUpdatedAt,
      realizedCostBasisUsd: episode.realizedCostBasisUsd,
      realizations: episode.realizations
    }
  };
}

function deterministicLedgerId(parts: string[]): string {
  return createHash("sha256").update(parts.join(":"), "utf8").digest("hex");
}

function comparePositionEpisodes(
  a: WalletLedgerPositionEpisode,
  b: WalletLedgerPositionEpisode
): number {
  return (
    compareCodeUnits(a.walletAddress, b.walletAddress) ||
    compareCodeUnits(a.tokenAddress, b.tokenAddress) ||
    a.roundTripIndex - b.roundTripIndex ||
    compareCodeUnits(a.episodeId, b.episodeId)
  );
}

function comparePositionLots(a: WalletLedgerPositionLot, b: WalletLedgerPositionLot): number {
  return (
    compareCodeUnits(a.episodeId, b.episodeId) ||
    a.lotSequence - b.lotSequence ||
    compareCodeUnits(a.lotId, b.lotId)
  );
}

export function buildWalletAlphaSignals(
  input: BuildWalletAlphaSignalInput
): WalletAlphaSignalEvidence[] {
  const now = new Date(input.now ?? new Date().toISOString()).getTime();
  const maximumAgeMs = (input.maximumSignalAgeHours ?? 6) * 60 * 60 * 1_000;
  const minimumLiquidityUsd = input.minimumLiquidityUsd ?? 10_000;
  const qualifiedScores = new Map(
    input.scores
      .filter(
        (score) =>
          score.strategyVersion === input.strategyVersion &&
          ["watch", "candidate", "validated-paper"].includes(score.status)
      )
      .map((score) => [score.walletAddress, score])
  );
  const byToken = new Map<string, WalletEntrySignalEvidence[]>();

  for (const entry of input.entries) {
    if (entry.strategyVersion !== input.strategyVersion || !isSourceLinkedWalletEntry(entry))
      continue;
    if (!qualifiedScores.has(entry.walletAddress)) continue;
    if (walletEntryRiskGateStatus(entry) !== "passed") continue;
    if (!isNewTokenEntry(numberField(entry.flowEvidence.poolAgeMinutes))) continue;
    if (entry.observedLiquidityUsd < minimumLiquidityUsd) continue;
    const ageMs = now - new Date(entry.observedAt).getTime();
    if (ageMs < 0 || ageMs > maximumAgeMs) continue;
    const current = byToken.get(entry.tokenAddress) ?? [];
    current.push(entry);
    byToken.set(entry.tokenAddress, current);
  }

  return [...byToken.entries()]
    .map(([tokenAddress, tokenEntries]) => {
      const ordered = [...tokenEntries].sort(compareObservedAt);
      const first = ordered[0]!;
      const walletScores = [
        ...new Map(
          ordered.map((entry) => [entry.walletAddress, qualifiedScores.get(entry.walletAddress)!])
        ).values()
      ];
      const strongestStatus = walletScores.some((score) =>
        ["candidate", "validated-paper"].includes(score.status)
      )
        ? "paper-candidate"
        : "paper-watch";
      const averageScore =
        walletScores.reduce((sum, score) => sum + score.overallScore, 0) /
        Math.max(walletScores.length, 1);
      const confidence = round(
        Math.min(100, averageScore + Math.min(15, (walletScores.length - 1) * 5))
      );
      const id = createHash("sha256")
        .update([input.strategyVersion, tokenAddress, "wallet-alpha-paper-signal"].join(":"))
        .digest("hex");
      return {
        id,
        chain: "solana",
        tokenAddress,
        ...(first.poolAddress ? { poolAddress: first.poolAddress } : {}),
        strategyVersion: input.strategyVersion,
        detectedAt: first.observedAt,
        observedPriceUsd: first.observedEntryPriceUsd,
        observedLiquidityUsd: first.observedLiquidityUsd,
        confidence,
        status: strongestStatus,
        walletAddresses: walletScores.map((score) => score.walletAddress),
        evidence: {
          researchOnly: true,
          independentQualifiedWallets: walletScores.length,
          walletStatuses: Object.fromEntries(
            walletScores.map((score) => [score.walletAddress, score.status])
          ),
          tokenRiskKnown: true,
          tokenRiskPassed: true,
          poolAgeMinutes: numberField(first.flowEvidence.poolAgeMinutes),
          sourceEntryKeys: ordered.map((entry) => entry.idempotencyKey)
        }
      } satisfies WalletAlphaSignalEvidence;
    })
    .sort((a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime());
}

export function walletEntryRiskGateStatus(
  entry: WalletEntrySignalEvidence
): WalletEntryRiskGateStatus {
  if (entry.flowEvidence.tokenRiskKnown !== true) return "unknown";
  return entry.flowEvidence.tokenRiskPassed === true ? "passed" : "failed";
}

function walletFollowabilityReturns(
  entries: WalletEntrySignalEvidence[],
  matureOutcomeByEntry: Map<string, WalletSignalOutcomeEvidence>
): WalletAlphaReturnObservation[] {
  const walletEntries = entries
    .filter(
      (entry) =>
        isSourceLinkedWalletEntry(entry) &&
        entry.cohort !== "excluded-uncontrolled-flow" &&
        walletEntryRiskGateStatus(entry) === "passed" &&
        isNewTokenEntry(numberField(entry.flowEvidence.poolAgeMinutes))
    )
    .sort(compareObservedAt);
  const firstByToken = new Map<string, WalletEntrySignalEvidence>();
  for (const entry of walletEntries) {
    if (!firstByToken.has(entry.tokenAddress)) firstByToken.set(entry.tokenAddress, entry);
  }
  return [...firstByToken.values()]
    .map((entry) => matureOutcomeByEntry.get(entry.idempotencyKey))
    .filter((outcome): outcome is WalletSignalOutcomeEvidence => Boolean(outcome))
    .map((outcome) => ({
      value: outcome.netReturnPct!,
      observedAt: outcome.observedAt,
      rugged: outcome.rugged
    }))
    .sort((a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime());
}

function groupByWallet<T extends { walletAddress: string }>(items: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const current = grouped.get(item.walletAddress);
    if (current) current.push(item);
    else grouped.set(item.walletAddress, [item]);
  }
  return grouped;
}

interface WalletAlphaGateInput {
  profitability: WalletAlphaReturnMetrics;
  followability: WalletAlphaReturnMetrics;
  profitabilitySamples: number;
  followabilitySamples: number;
  activeDays: number;
  highQualityExecutionCoverage: number;
}

function buildFixedHorizonGates(input: WalletAlphaGateInput) {
  return {
    observed: input.profitabilitySamples >= 3 || input.followabilitySamples >= 3,
    watch:
      input.profitabilitySamples >= 8 &&
      input.activeDays >= 4 &&
      robustGate(input.profitability, {
        minimumHitRate: 0.5,
        minimumProfitFactor: 1.1,
        minimumWorstReturnPct: -100
      }) &&
      input.followabilitySamples >= 8 &&
      robustGate(input.followability, {
        minimumHitRate: 0.5,
        minimumProfitFactor: 1.1,
        minimumWorstReturnPct: -35
      }),
    candidate:
      input.profitabilitySamples >= 15 &&
      input.activeDays >= 7 &&
      input.highQualityExecutionCoverage >= 0.9 &&
      input.profitability.bestWinnerShare <= 0.4 &&
      robustGate(input.profitability, {
        minimumHitRate: 0.55,
        minimumProfitFactor: 1.2,
        minimumWorstReturnPct: -100
      }) &&
      input.followabilitySamples >= 15 &&
      input.followability.bestWinnerShare <= 0.4 &&
      robustGate(input.followability, {
        minimumHitRate: 0.55,
        minimumProfitFactor: 1.2,
        minimumWorstReturnPct: -35
      }),
    validatedPaper: false
  };
}

function buildManagedExitGates(input: WalletAlphaGateInput) {
  const watch = MANAGED_EXIT_V2_POLICY.watch;
  const candidate = MANAGED_EXIT_V2_POLICY.candidate;
  return {
    observed: input.profitabilitySamples >= 3 || input.followabilitySamples >= 3,
    watch:
      input.profitabilitySamples >= watch.minimumProfitabilitySamples &&
      input.activeDays >= watch.minimumActiveDays &&
      robustGate(input.profitability, {
        minimumHitRate: 0.5,
        minimumProfitFactor: 1.1,
        minimumWorstReturnPct: -100
      }) &&
      input.followabilitySamples >= watch.minimumFollowabilitySamples &&
      robustGate(input.followability, {
        minimumHitRate: watch.minimumFollowabilityHitRate,
        minimumProfitFactor: watch.minimumFollowabilityProfitFactor
      }) &&
      managedTailRiskGate(input.followability, watch),
    candidate:
      input.profitabilitySamples >= candidate.minimumProfitabilitySamples &&
      input.activeDays >= candidate.minimumActiveDays &&
      input.highQualityExecutionCoverage >= candidate.minimumHighQualityExecutionCoverage &&
      input.profitability.bestWinnerShare <= candidate.maximumBestWinnerShare &&
      robustGate(input.profitability, {
        minimumHitRate: candidate.minimumHitRate,
        minimumProfitFactor: candidate.minimumProfitFactor,
        minimumWorstReturnPct: -100
      }) &&
      input.followabilitySamples >= candidate.minimumFollowabilitySamples &&
      input.followability.bestWinnerShare <= candidate.maximumBestWinnerShare &&
      robustGate(input.followability, {
        minimumHitRate: candidate.minimumHitRate,
        minimumProfitFactor: candidate.minimumProfitFactor
      }) &&
      managedTailRiskGate(input.followability, candidate),
    validatedPaper: false
  };
}

function managedTailRiskGate(
  metrics: WalletAlphaReturnMetrics,
  thresholds: ManagedTailRiskThresholds
): boolean {
  return (
    metrics.ruggedOutcomeRate !== undefined &&
    metrics.catastrophicLossRate !== undefined &&
    metrics.ruggedOutcomeRate <= thresholds.maximumRuggedOutcomeRate &&
    metrics.catastrophicLossRate <= thresholds.maximumCatastrophicLossRate
  );
}

function indexMatureOutcomes(
  outcomes: WalletSignalOutcomeEvidence[],
  exitStrategy: WalletSignalOutcomeEvidence["exitStrategy"]
): Map<string, WalletSignalOutcomeEvidence> {
  const indexed = new Map<string, WalletSignalOutcomeEvidence>();
  for (const outcome of outcomes) {
    if (
      outcome.status !== "mature" ||
      outcome.exitStrategy !== exitStrategy ||
      !Number.isFinite(outcome.netReturnPct)
    ) {
      continue;
    }
    const existing = indexed.get(outcome.entryIdempotencyKey);
    if (!existing || compareObservedAt(outcome, existing) < 0) {
      indexed.set(outcome.entryIdempotencyKey, outcome);
    }
  }
  return indexed;
}

function summarizeReturnObservations(
  observations: WalletAlphaReturnObservation[]
): WalletAlphaReturnMetricsV2 {
  if (observations.length === 0) return emptyReturnMetrics();
  const chronological = [...observations].sort((a, b) => compareObservedAt(a, b));
  const values = chronological.map((observation) => observation.value);
  const sorted = [...values].sort((a, b) => a - b);
  const average = mean(values);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  const withoutBest = sorted.slice(0, -1);
  const positives = values.filter((value) => value > 0);
  const wins = positives.length;
  const positiveSum = positives.reduce((sum, value) => sum + value, 0);
  const lossSum = Math.abs(
    values.filter((value) => value < 0).reduce((sum, value) => sum + value, 0)
  );
  const hitRate = wins / values.length;
  const ruggedOutcomeCount = chronological.filter((observation) => observation.rugged).length;
  const catastrophicLossCount = values.filter(
    (value) => value <= MANAGED_EXIT_V2_POLICY.catastrophicLossBoundaryPct
  ).length;
  const lowerTailSize = Math.max(1, Math.ceil(values.length * 0.1));
  return {
    sampleCount: values.length,
    averageReturnPct: average,
    medianReturnPct: median,
    averageReturnExBestPct: withoutBest.length > 0 ? mean(withoutBest) : 0,
    bestWinnerShare: positiveSum > 0 ? Math.max(...positives) / positiveSum : 0,
    hitRate,
    profitFactor: lossSum > 0 ? positiveSum / lossSum : positiveSum > 0 ? 99 : 0,
    worstReturnPct: Math.min(...values),
    maxDrawdownPct: maxDrawdown(values),
    hitRateWilsonLowerBound: wilsonLowerBound(wins, values.length),
    shrunkHitRate: (wins + 5) / (values.length + 10),
    sampleReliability: values.length / (values.length + 10),
    ruggedOutcomeCount,
    ruggedOutcomeRate: ruggedOutcomeCount / values.length,
    catastrophicLossCount,
    catastrophicLossRate: catastrophicLossCount / values.length,
    lowerTailAverageReturnPct: mean(sorted.slice(0, lowerTailSize)),
    maximumConsecutiveLosses: maximumConsecutiveLosses(values)
  };
}

function chronologicalHoldoutsPass(
  values: WalletAlphaReturnObservation[],
  scoringPolicy: WalletAlphaScoringPolicy,
  axis: "profitability" | "followability"
): boolean {
  if (values.length < 30) return false;
  const ordered = [...values].sort(
    (a, b) => new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime()
  );
  const holdouts = [
    summarizeReturnObservations(ordered.slice(-20, -10)),
    summarizeReturnObservations(ordered.slice(-10))
  ];
  if (scoringPolicy === "fixed-horizon-v1" || axis === "profitability") {
    return holdouts.every((metrics) =>
      robustGate(metrics, {
        minimumHitRate: 0.5,
        minimumProfitFactor: 1.2,
        minimumWorstReturnPct: -35
      })
    );
  }
  return holdouts.every(
    (metrics) =>
      robustGate(metrics, {
        minimumHitRate: 0.5,
        minimumProfitFactor: 1.2
      }) &&
      managedTailRiskGate(metrics, {
        maximumRuggedOutcomeRate:
          MANAGED_EXIT_V2_POLICY.validatedPaper.holdoutMaximumRuggedOutcomeRate,
        maximumCatastrophicLossRate:
          MANAGED_EXIT_V2_POLICY.validatedPaper.holdoutMaximumCatastrophicLossRate
      })
  );
}

function robustGate(
  metrics: WalletAlphaReturnMetrics,
  thresholds: {
    minimumHitRate: number;
    minimumProfitFactor: number;
    minimumWorstReturnPct?: number;
  }
): boolean {
  return (
    metrics.medianReturnPct >= 0 &&
    metrics.averageReturnExBestPct > 0 &&
    metrics.hitRate >= thresholds.minimumHitRate &&
    metrics.profitFactor >= thresholds.minimumProfitFactor &&
    (thresholds.minimumWorstReturnPct === undefined ||
      metrics.worstReturnPct >= thresholds.minimumWorstReturnPct)
  );
}

function scoreReturnQuality(
  metrics: WalletAlphaReturnMetricsV2,
  sampleCount: number,
  scoringPolicy: WalletAlphaScoringPolicy
): number {
  if (sampleCount === 0) return 0;
  const sampleScore = Math.min(20, sampleCount * 1.25);
  const medianScore = Math.max(0, Math.min(20, metrics.medianReturnPct + 10));
  const hitScore = Math.max(0, Math.min(20, metrics.hitRateWilsonLowerBound * 30));
  const profitFactorScore = Math.max(0, Math.min(15, metrics.profitFactor * 10));
  const exBestScore = Math.max(0, Math.min(15, metrics.averageReturnExBestPct + 5));
  const tailRiskReference =
    scoringPolicy === "managed-exit-v2"
      ? (metrics.lowerTailAverageReturnPct ?? metrics.worstReturnPct)
      : metrics.worstReturnPct;
  const riskScore = Math.max(0, Math.min(10, 10 + tailRiskReference / 10));
  const concentrationPenalty = Math.max(0, (metrics.bestWinnerShare - 0.35) * 40);
  const rawScore = Math.max(
    0,
    Math.min(
      100,
      sampleScore +
        medianScore +
        hitScore +
        profitFactorScore +
        exBestScore +
        riskScore -
        concentrationPenalty
    )
  );
  return round(rawScore * (0.5 + 0.5 * metrics.sampleReliability));
}

function blendedWindowScore(
  metrics30d: WalletAlphaReturnMetricsV2,
  metrics90d: WalletAlphaReturnMetricsV2,
  decayFactor: number,
  scoringPolicy: WalletAlphaScoringPolicy
): number {
  const score90d = scoreReturnQuality(metrics90d, metrics90d.sampleCount, scoringPolicy);
  const score30d = scoreReturnQuality(metrics30d, metrics30d.sampleCount, scoringPolicy);
  const windowBlend = metrics30d.sampleCount > 0 ? score30d * 0.65 + score90d * 0.35 : score90d;
  return round(windowBlend * (0.75 + 0.25 * decayFactor));
}

function buildReasons(input: {
  status: WalletAlphaScoreSnapshot["status"];
  positions: WalletClosedPosition[];
  followabilityCount: number;
  profitability: WalletAlphaReturnMetrics;
  followability: WalletAlphaReturnMetrics;
  activeDays: number;
  highQualityExecutionCoverage: number;
  directCreator: boolean;
  scoringPolicy: WalletAlphaScoringPolicy;
  followabilityExitStrategy: WalletSignalOutcomeEvidence["exitStrategy"];
  watchPassed: boolean;
}): string[] {
  if (input.directCreator) return ["Wallet is the observed creator of at least one tracked token."];
  const reasons = [
    `${input.positions.length} completed new-token positions across ${input.activeDays} active days.`,
    `${input.followabilityCount} source-linked follower outcomes were measured from the bot observation price.`,
    `Realized median=${round(input.profitability.medianReturnPct)}%, hit=${round(input.profitability.hitRate * 100)}%, PF=${round(input.profitability.profitFactor)}.`,
    `Followable median=${round(input.followability.medianReturnPct)}%, hit=${round(input.followability.hitRate * 100)}%.`,
    `${round(input.highQualityExecutionCoverage * 100)}% of realized episodes use execution/oracle-quality price evidence.`
  ];
  if (input.scoringPolicy === "managed-exit-v2") {
    reasons.push(
      `Followability uses ${input.followabilityExitStrategy}; rug rate=${round((input.followability.ruggedOutcomeRate ?? 0) * 100)}%, catastrophic-loss rate=${round((input.followability.catastrophicLossRate ?? 0) * 100)}%, lower-tail average=${round(input.followability.lowerTailAverageReturnPct ?? 0)}%.`
    );
    if (!input.watchPassed) {
      reasons.push(
        "Managed watch requires 30 followable outcomes, four active days, PF at least 1.2, hit rate at least 55%, and no more than 5% rug or catastrophic-loss exposure."
      );
    }
  }
  if (input.status === "insufficient" || input.status === "observed") {
    reasons.push(
      "The wallet does not yet have enough completed and followable trades for a paper signal."
    );
  }
  if (input.profitability.bestWinnerShare > 0.4) {
    reasons.push(
      "One winner contributes too much of the positive return and blocks candidate status."
    );
  }
  if (input.highQualityExecutionCoverage < 0.9) {
    reasons.push("High-quality execution coverage is below the 90% candidate gate.");
  }
  return reasons;
}

function usdValue(trade: WalletTradeEvidence): number | null {
  const quoteValue = positiveDecimal(trade.quoteValueUsdDecimal ?? trade.quoteValueUsd);
  if (quoteValue !== undefined) return quoteValue;
  const executionPrice = positiveDecimal(trade.executionPriceUsdDecimal ?? trade.executionPriceUsd);
  if (executionPrice !== undefined) {
    const quantity = trade.baseTokenAmount
      ? tokenAmountAsNumber(trade.baseTokenAmount)
      : trade.baseAmount;
    if (Number.isFinite(quantity) && quantity > 0) return quantity * executionPrice;
  }
  return null;
}

function isNewTokenEntry(poolAgeMinutes: number | undefined): boolean {
  return poolAgeMinutes !== undefined && poolAgeMinutes >= 0 && poolAgeMinutes <= 30;
}

function normalizedPriceQuality(trade: WalletTradeEvidence): WalletTradePriceQuality {
  if (trade.priceQuality) return trade.priceQuality;
  switch (trade.dataQuality) {
    case "observed-execution":
    case "historical-observed":
      return "observed-execution";
    case "oracle-converted":
      return "oracle-converted";
    case "historical-estimate":
      return "historical-estimate";
    case "market-proxy":
    case "observed-balance":
    case "price-proxy":
      return "market-proxy";
  }
}

function isHighQualityPrice(quality: WalletTradePriceQuality): boolean {
  return quality === "observed-execution" || quality === "oracle-converted";
}

function combinePriceQualities(qualities: WalletTradePriceQuality[]): WalletTradePriceQuality {
  if (qualities.every((quality) => quality === "observed-execution")) {
    return "observed-execution";
  }
  if (qualities.every(isHighQualityPrice)) return "oracle-converted";
  if (qualities.some((quality) => quality === "historical-estimate")) {
    return "historical-estimate";
  }
  return "market-proxy";
}

function deduplicateTrades(trades: WalletTradeEvidence[]): WalletTradeEvidence[] {
  const ordered = [...trades].sort(
    (a, b) =>
      compareEvidenceOrder(a, b) || compareCodeUnits(canonicalTradeKey(a), canonicalTradeKey(b))
  );
  const unique = new Map<string, WalletTradeEvidence>();
  for (const trade of ordered) {
    if (!unique.has(trade.idempotencyKey)) unique.set(trade.idempotencyKey, trade);
  }
  return [...unique.values()];
}

function canonicalTradeKey(trade: WalletTradeEvidence): string {
  return [
    trade.walletAddress,
    trade.tokenAddress,
    trade.side,
    trade.baseTokenAmount?.rawAmount ?? trade.baseAmount.toString(),
    trade.baseTokenAmount?.decimals?.toString() ?? "",
    trade.quoteValueUsdDecimal ?? trade.quoteValueUsd?.toString() ?? "",
    trade.executionPriceUsdDecimal ?? trade.executionPriceUsd?.toString() ?? "",
    trade.priceQuality ?? trade.dataQuality
  ].join(":");
}

function commonBaseDecimals(trades: WalletTradeEvidence[]): number {
  const decimals = trades.map((trade) =>
    validTokenAmount(trade.baseTokenAmount) ? trade.baseTokenAmount.decimals : 12
  );
  return Math.max(0, ...decimals);
}

function normalizedTradeQuantity(
  trade: WalletTradeEvidence,
  targetDecimals: number
): NormalizedTradeQuantity | null {
  if (validTokenAmount(trade.baseTokenAmount)) {
    const raw = parseRawAmount(trade.baseTokenAmount.rawAmount);
    if (raw === null) return null;
    return {
      units: scaleRawAmount(raw, trade.baseTokenAmount.decimals, targetDecimals),
      decimals: targetDecimals
    };
  }
  if (!Number.isFinite(trade.baseAmount) || trade.baseAmount <= 0) return null;
  return {
    units: decimalNumberToRaw(trade.baseAmount, targetDecimals),
    decimals: targetDecimals
  };
}

function validTokenAmount(value: TokenAmount | undefined): value is TokenAmount {
  return Boolean(
    value &&
    /^\d+$/.test(value.rawAmount) &&
    Number.isInteger(value.decimals) &&
    value.decimals >= 0 &&
    value.decimals <= 30
  );
}

function parseRawAmount(value: string): bigint | null {
  try {
    return /^\d+$/.test(value) ? BigInt(value) : null;
  } catch {
    return null;
  }
}

function scaleRawAmount(raw: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (toDecimals === fromDecimals) return raw;
  if (toDecimals > fromDecimals) {
    return raw * 10n ** BigInt(toDecimals - fromDecimals);
  }
  return raw / 10n ** BigInt(fromDecimals - toDecimals);
}

function decimalNumberToRaw(value: number, decimals: number): bigint {
  const [coefficient = "0", exponentText = "0"] = value.toString().toLowerCase().split("e");
  const exponent = Number(exponentText);
  const [whole = "0", fraction = ""] = coefficient.split(".");
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "");
  const rawDigits = BigInt(digits || "0");
  const shift = decimals + exponent - fraction.length;
  if (shift >= 0) return rawDigits * 10n ** BigInt(shift);
  const divisor = 10n ** BigInt(-shift);
  return (rawDigits + divisor / 2n) / divisor;
}

function tokenAmountAsNumber(amount: TokenAmount): number {
  const raw = parseRawAmount(amount.rawAmount);
  if (raw === null || !Number.isInteger(amount.decimals)) return Number.NaN;
  return Number(raw) / 10 ** amount.decimals;
}

function tokenAmount(units: bigint, decimals: number): TokenAmount {
  return { rawAmount: units.toString(), decimals };
}

function inventoryUnits(lots: WalletInventoryLot[]): bigint {
  return lots.reduce((sum, lot) => sum + lot.units, 0n);
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function bigintRatio(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n || numerator <= 0n) return 0;
  if (numerator === denominator) return 1;
  const precision = 1_000_000_000_000n;
  return Number((numerator * precision) / denominator) / Number(precision);
}

function positiveDecimal(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function earlierIso(a: string, b: string): string {
  return (validTimestamp(a) ?? Number.POSITIVE_INFINITY) <=
    (validTimestamp(b) ?? Number.POSITIVE_INFINITY)
    ? a
    : b;
}

function compareEvidenceOrder(
  a: Pick<
    WalletTradeEvidence,
    | "slot"
    | "observedAt"
    | "signature"
    | "idempotencyKey"
  >,
  b: Pick<
    WalletTradeEvidence,
    | "slot"
    | "observedAt"
    | "signature"
    | "idempotencyKey"
  >
): number {
  return (
    a.slot - b.slot ||
    (validTimestamp(a.observedAt) ?? 0) - (validTimestamp(b.observedAt) ?? 0) ||
    compareCodeUnits(a.signature, b.signature) ||
    compareCodeUnits(a.idempotencyKey, b.idempotencyKey)
  );
}

function compareRealizedEpisodes(a: WalletClosedPosition, b: WalletClosedPosition): number {
  return (
    (validTimestamp(a.closedAt) ?? 0) - (validTimestamp(b.closedAt) ?? 0) ||
    compareCodeUnits(a.walletAddress, b.walletAddress) ||
    compareCodeUnits(a.tokenAddress, b.tokenAddress) ||
    a.roundTripIndex - b.roundTripIndex ||
    compareCodeUnits(a.sellIdempotencyKey, b.sellIdempotencyKey) ||
    compareCodeUnits(a.episodeId, b.episodeId)
  );
}

function withinDays<T extends { observedAt: string }>(
  values: T[],
  calculatedAtMs: number,
  days: number
): T[] {
  return values.filter((value) => isWithinDays(value.observedAt, calculatedAtMs, days));
}

function isWithinDays(value: string, calculatedAtMs: number, days: number): boolean {
  const timestamp = validTimestamp(value);
  if (timestamp === undefined || timestamp > calculatedAtMs) return false;
  return timestamp >= calculatedAtMs - days * 24 * 60 * 60 * 1_000;
}

function recencyDecayFactor(values: Array<{ observedAt: string }>, calculatedAtMs: number): number {
  if (values.length === 0) return 0;
  const halfLifeMs = 30 * 24 * 60 * 60 * 1_000;
  return mean(
    values.map((value) => {
      const timestamp = validTimestamp(value.observedAt) ?? calculatedAtMs;
      const ageMs = Math.max(0, calculatedAtMs - timestamp);
      return Math.exp((-Math.LN2 * ageMs) / halfLifeMs);
    })
  );
}

function wilsonLowerBound(wins: number, sampleCount: number): number {
  if (sampleCount <= 0) return 0;
  const z = 1.959963984540054;
  const proportion = wins / sampleCount;
  const zSquared = z * z;
  const denominator = 1 + zSquared / sampleCount;
  const center = proportion + zSquared / (2 * sampleCount);
  const margin =
    z * Math.sqrt((proportion * (1 - proportion) + zSquared / (4 * sampleCount)) / sampleCount);
  return Math.max(0, (center - margin) / denominator);
}

function validTimestamp(value: string): number | undefined {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function maxDrawdown(returns: number[]): number {
  let equity = 100;
  let peak = equity;
  let worst = 0;
  for (const value of returns) {
    equity *= 1 + Math.max(-100, value) / 100;
    peak = Math.max(peak, equity);
    worst = Math.max(worst, peak > 0 ? ((peak - equity) / peak) * 100 : 100);
  }
  return worst;
}

function maximumConsecutiveLosses(returns: number[]): number {
  let current = 0;
  let maximum = 0;
  for (const value of returns) {
    if (value < 0) {
      current += 1;
      maximum = Math.max(maximum, current);
    } else {
      current = 0;
    }
  }
  return maximum;
}

function emptyReturnMetrics(): WalletAlphaReturnMetricsV2 {
  return {
    sampleCount: 0,
    averageReturnPct: 0,
    medianReturnPct: 0,
    averageReturnExBestPct: 0,
    bestWinnerShare: 0,
    hitRate: 0,
    profitFactor: 0,
    worstReturnPct: 0,
    maxDrawdownPct: 0,
    hitRateWilsonLowerBound: 0,
    shrunkHitRate: 0.5,
    sampleReliability: 0,
    ruggedOutcomeCount: 0,
    ruggedOutcomeRate: 0,
    catastrophicLossCount: 0,
    catastrophicLossRate: 0,
    lowerTailAverageReturnPct: 0,
    maximumConsecutiveLosses: 0
  };
}

function compareObservedAt(
  a: { observedAt: string; slot?: number; idempotencyKey?: string },
  b: { observedAt: string; slot?: number; idempotencyKey?: string }
): number {
  return (
    (validTimestamp(a.observedAt) ?? 0) - (validTimestamp(b.observedAt) ?? 0) ||
    (a.slot ?? 0) - (b.slot ?? 0) ||
    compareCodeUnits(a.idempotencyKey ?? "", b.idempotencyKey ?? "")
  );
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function numberField(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function statusRank(status: WalletAlphaScoreSnapshot["status"]): number {
  return {
    excluded: -1,
    insufficient: 0,
    observed: 1,
    watch: 2,
    candidate: 3,
    "validated-paper": 4
  }[status];
}
