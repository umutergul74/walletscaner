import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  calculateWalletSignalOutcome,
  canonicalizeHistoricalPriceObservations,
  recordFirstWalletEntry
} from "@memecoin-alpha/core";
import { loadRuntimeConfig } from "@memecoin-alpha/config";
import { PostgresRepository } from "@memecoin-alpha/db";
import {
  createParsedInstructionPoolDecoder,
  createRawInstructionPoolDecoder,
  decodePoolDiscoveries,
  decodeWalletBuys,
  HeliusEnhancedClient,
  type HeliusAsset,
  type HeliusEnhancedTransaction,
  type HeliusSwapEvent,
  type HeliusSwapTokenLeg,
  type PoolEventDecoder,
  type RawBuyInstructionDefinition,
  type SolanaChainEvent
} from "@memecoin-alpha/providers";
import type {
  HistoricalMarketObservation,
  OnchainSwapEvidence,
  PoolSnapshot,
  PriceObservationEvidence
} from "@memecoin-alpha/shared";

interface ProgramConfig {
  programId: string;
  instructionTypes?: string[];
  rawInstructions?: Array<{
    name: string;
    discriminatorHex: string;
    poolAccountIndex: number;
    baseTokenAccountIndex: number;
    quoteTokenAccountIndex?: number;
  }>;
}

interface BackfillArgs {
  runId: string;
  days: number;
  maxPages: number;
  maxPools: number;
  poolPages: number;
  maxMints: number;
  mintPages: number;
  maxAssets: number;
  assetBatchSize: number;
  sliceMinutes: number;
  maxSlices: number;
  pageLimit: number;
  requestsPerSecond: number;
  creditBudget: number;
  solUsd: number;
  endpoint: string;
}

interface BackfillWindow {
  startMs: number;
  endMs: number;
  startUnix: number;
  endUnix: number;
  startTime: string;
  endTime: string;
}

interface BackfillStats {
  address: string;
  pagesFetched: number;
  transactionsFetched: number;
  discoveredPools: number;
  insertedPools: number;
  insertedPriceObservations: number;
  insertedMarketObservations: number;
  decodedBuys: number;
  insertedSwaps: number;
  insertedWalletEntries: number;
  windowsCompleted: number;
  windowsSaturated: number;
  windowsSkipped: number;
}

interface CreditUsage {
  budget: number;
  estimatedUsed: number;
  remaining: number;
  legacyEnhancedHistoryRequests: number;
  dasRequests: number;
}

interface HeliusHistoricalReport {
  runId: string;
  generatedAt: string;
  mode: "historical-backfill";
  provider: "helius";
  days: number;
  startTime: string;
  endTime: string;
  freePlanSafe: boolean;
  pageLimit: number;
  maxPagesPerAddress: number;
  maxPools: number;
  poolPagesPerAddress: number;
  maxMints: number;
  mintPagesPerAddress: number;
  maxAssets: number;
  assetBatchSize: number;
  sliceMinutes: number;
  slicesEvaluated: number;
  programSampling: {
    candidateWindows: number;
    selectedWindows: number;
    selectedWindowRate: number;
  };
  requestsPerSecond: number;
  solUsdEstimate: number;
  programCount: number;
  totals: Omit<BackfillStats, "address">;
  creditUsage: CreditUsage;
  metadata: {
    requestedAssets: number;
    returnedAssets: number;
    updatedTokens: number;
    batches: number;
  };
  marketBucketsMaterialized: number;
  walletFlowsMaterialized: number;
  outcomes: {
    entriesEvaluated: number;
    matureFixedHorizon: number;
    maturePaperExit: number;
  };
  addressStats: BackfillStats[];
  limitations: string[];
}

interface BackfillProgressSnapshot {
  runId: string;
  status: "running" | "partial" | "completed" | "paused-credit-budget" | "error";
  generatedAt: string;
  updatedAt: string;
  strategyVersion: string;
  window: BackfillWindow;
  args: Omit<BackfillArgs, "endpoint"> & { endpoint: string };
  current?: {
    stage:
      | "program"
      | "pool"
      | "mint"
      | "metadata"
      | "outcomes"
      | "buckets"
      | "flows"
      | "report";
    address?: string;
    page?: number;
    windowStartUnix?: number;
    windowEndUnix?: number;
    cursorSource?: string;
  };
  totals: Omit<BackfillStats, "address">;
  creditUsage?: CreditUsage;
  addressStats: BackfillStats[];
  reports: string[];
  error?: string;
}

interface PriceCandidate {
  tokenAddress: string;
  tokenAmount: number;
  solAmount: number;
  side: "buy" | "sell";
  priceSource: string;
  confidence: number;
}

interface TimeWindow {
  startUnix: number;
  endUnix: number;
}

const wrappedSolMint = "So11111111111111111111111111111111111111112";
const generatedAt = new Date().toISOString();
const config = loadRuntimeConfig();
const args = parseArgs(process.argv.slice(2));
const strategyVersion = process.env.ALPHA_STRATEGY_VERSION ?? "evidence-v1";
const progressPath = progressPathForRun(args.runId);
const latestProgressPath = "reports/helius-historical-backfill-progress.json";
const heliusApiKey = config.solana.heliusApiKey;
if (!heliusApiKey) {
  throw new Error("HELIUS_API_KEY is required for historical Helius backfill.");
}

const repository = new PostgresRepository(config.databaseUrl);
const helius = new HeliusEnhancedClient(heliusApiKey, args.endpoint);
const programs = parsePrograms(process.env.SOLANA_POOL_PROGRAMS_JSON);
const decoders = buildPoolDecoders(programs);
const buyDefinitions = buildBuyDefinitions();
const persistedProgress = await loadReusableProgress(args.runId);
const backfillWindow = persistedProgress?.window ?? createBackfillWindow(args.days);
const startMs = backfillWindow.startMs;
const endMs = backfillWindow.endMs;
const startUnix = backfillWindow.startUnix;
const endUnix = backfillWindow.endUnix;
const candidateProgramWindows = buildTimeWindows(startUnix, endUnix, args.sliceMinutes);
const programWindows = selectTimeWindows(candidateProgramWindows, args.maxSlices);
const pageDelayMs = Math.ceil(1_000 / args.requestsPerSecond);
let nextRequestAt = 0;
const addressStats: BackfillStats[] = [...(persistedProgress?.addressStats ?? [])];
const databaseHistoryRequests = await repository.getHistoricalBackfillRequestCount(args.runId);
const persistedDasRequests = persistedProgress?.creditUsage?.dasRequests ?? 0;
const estimatedUsed = Math.max(
  persistedProgress?.creditUsage?.estimatedUsed ?? 0,
  databaseHistoryRequests * 100 + persistedDasRequests * 10
);
const creditUsage: CreditUsage = {
  budget: args.creditBudget,
  estimatedUsed,
  remaining: Math.max(0, args.creditBudget - estimatedUsed),
  legacyEnhancedHistoryRequests: Math.max(
    persistedProgress?.creditUsage?.legacyEnhancedHistoryRequests ?? 0,
    databaseHistoryRequests
  ),
  dasRequests: persistedDasRequests
};
let creditBudgetExhausted = creditUsage.remaining < 10;
const finalWindowSummaryState: {
  value?: { completed: number; saturated: number; running: number; error: number };
} = {};

await writeProgress("running");

for (const program of programs) {
  if (creditBudgetExhausted) break;
  addressStats.push(
    await backfillAddress(program.programId, {
      stage: "program",
      cursorSource: `helius-history-program:${args.days}d`,
      maxPages: args.maxPages,
      tokenAccounts: "none",
      windows: programWindows
    })
  );
}

const poolsForBackfill = await selectWalletEntryPoolsForBackfill();
for (const pool of poolsForBackfill) {
  if (creditBudgetExhausted) break;
  addressStats.push(
    await backfillAddress(pool.address, {
      stage: "pool",
      cursorSource: `helius-history-pool:${args.days}d`,
      maxPages: args.poolPages,
      tokenAccounts: "all",
      windows: [poolWindow(pool.firstObservedAt)]
    })
  );
}

const mintsForBackfill = await selectMintWindowsForBackfill();
for (const mint of mintsForBackfill) {
  if (creditBudgetExhausted) break;
  addressStats.push(
    await backfillAddress(mint.address, {
      stage: "mint",
      cursorSource: `helius-history-mint:${args.days}d`,
      maxPages: args.mintPages,
      tokenAccounts: "all",
      windows: [mint.window]
    })
  );
}

await writeProgress("running", { stage: "metadata" });
const metadata = creditBudgetExhausted
  ? { requestedAssets: 0, returnedAssets: 0, updatedTokens: 0, batches: 0 }
  : await enrichTokenMetadata();

await writeProgress("running", { stage: "outcomes" });
const outcomes = await materializeHistoricalOutcomes();
await writeProgress("running", { stage: "buckets" });
const marketBucketsMaterialized =
  await repository.materializeHistoricalMarketBuckets(strategyVersion, 5);
await writeProgress("running", { stage: "flows" });
const walletFlowsMaterialized =
  await repository.materializeHistoricalWalletFlowEvidence(strategyVersion);
const accumulatedTotals = addressStats.reduce<Omit<BackfillStats, "address">>(
  (sum, stat) => ({
    pagesFetched: sum.pagesFetched + stat.pagesFetched,
    transactionsFetched: sum.transactionsFetched + stat.transactionsFetched,
    discoveredPools: sum.discoveredPools + stat.discoveredPools,
    insertedPools: sum.insertedPools + stat.insertedPools,
    insertedPriceObservations:
      sum.insertedPriceObservations + stat.insertedPriceObservations,
    insertedMarketObservations:
      sum.insertedMarketObservations + stat.insertedMarketObservations,
    decodedBuys: sum.decodedBuys + stat.decodedBuys,
    insertedSwaps: sum.insertedSwaps + stat.insertedSwaps,
    insertedWalletEntries: sum.insertedWalletEntries + stat.insertedWalletEntries,
    windowsCompleted: sum.windowsCompleted + stat.windowsCompleted,
    windowsSaturated: sum.windowsSaturated + stat.windowsSaturated,
    windowsSkipped: sum.windowsSkipped + stat.windowsSkipped
  }),
  {
    pagesFetched: 0,
    transactionsFetched: 0,
    discoveredPools: 0,
    insertedPools: 0,
    insertedPriceObservations: 0,
    insertedMarketObservations: 0,
    decodedBuys: 0,
    insertedSwaps: 0,
    insertedWalletEntries: 0,
    windowsCompleted: 0,
    windowsSaturated: 0,
    windowsSkipped: 0
  }
);
finalWindowSummaryState.value =
  await repository.getHistoricalBackfillWindowSummary(args.runId);
const totals: Omit<BackfillStats, "address"> = {
  ...accumulatedTotals,
  windowsCompleted: finalWindowSummaryState.value.completed,
  windowsSaturated: finalWindowSummaryState.value.saturated,
  windowsSkipped: accumulatedTotals.windowsSkipped
};

const report: HeliusHistoricalReport = {
  runId: args.runId,
  generatedAt,
  mode: "historical-backfill",
  provider: "helius",
  days: args.days,
  startTime: new Date(startMs).toISOString(),
  endTime: new Date(endMs).toISOString(),
  freePlanSafe: args.requestsPerSecond <= 1,
  pageLimit: args.pageLimit,
  maxPagesPerAddress: args.maxPages,
  maxPools: args.maxPools,
  poolPagesPerAddress: args.poolPages,
  maxMints: args.maxMints,
  mintPagesPerAddress: args.mintPages,
  maxAssets: args.maxAssets,
  assetBatchSize: args.assetBatchSize,
  sliceMinutes: args.sliceMinutes,
  slicesEvaluated: programWindows.length,
  programSampling: {
    candidateWindows: candidateProgramWindows.length,
    selectedWindows: programWindows.length,
    selectedWindowRate:
      candidateProgramWindows.length > 0
        ? programWindows.length / candidateProgramWindows.length
        : 0
  },
  requestsPerSecond: args.requestsPerSecond,
  solUsdEstimate: args.solUsd,
  programCount: programs.length,
  totals,
  creditUsage,
  metadata,
  marketBucketsMaterialized,
  walletFlowsMaterialized,
  outcomes,
  addressStats,
  limitations: [
    "This command backfills parsed Helius address history for configured launch/DEX programs using stratified time windows.",
    "Coverage is explicit: completed windows are exhaustive at the configured page limit, while saturated windows still need more pages.",
    "Historical token price observations preserve SOL-denominated price and amounts; USD fields use the configured SOL/USD estimate.",
    "Historical pool liquidity is not reconstructed from reserves yet, so replay liquidity gating remains weaker than live evidence.",
    "Helius legacy Enhanced History is estimated at 100 credits per request and DAS batches at 10 credits; the run stops before its configured credit budget."
  ]
};

await mkdir("reports", { recursive: true });
await writeFile("reports/helius-historical-backfill-latest.json", JSON.stringify(report, null, 2));
await writeFile("reports/helius-historical-backfill-latest.md", renderMarkdown(report));
await writeProgress(
  creditBudgetExhausted
    ? "paused-credit-budget"
    : totals.windowsSaturated > 0
      ? "partial"
      : "completed",
  { stage: "report" }
);

console.log(
  JSON.stringify(
    {
      generatedAt,
      mode: report.mode,
      days: report.days,
      totals: report.totals,
      creditUsage: report.creditUsage,
      metadata: report.metadata,
      marketBucketsMaterialized: report.marketBucketsMaterialized,
      walletFlowsMaterialized: report.walletFlowsMaterialized,
      outcomes: report.outcomes,
      reports: [
        "reports/helius-historical-backfill-latest.json",
        "reports/helius-historical-backfill-latest.md"
      ]
    },
    null,
    2
  )
);

async function backfillAddress(
  address: string,
  options: {
    stage: "program" | "pool" | "mint";
    cursorSource: string;
    maxPages: number;
    tokenAccounts: "none" | "balanceChanged" | "all";
    windows: TimeWindow[];
  }
): Promise<BackfillStats> {
  const stats: BackfillStats = {
    address,
    pagesFetched: 0,
    transactionsFetched: 0,
    discoveredPools: 0,
    insertedPools: 0,
    insertedPriceObservations: 0,
    insertedMarketObservations: 0,
    decodedBuys: 0,
    insertedSwaps: 0,
    insertedWalletEntries: 0,
    windowsCompleted: 0,
    windowsSaturated: 0,
    windowsSkipped: 0
  };
  for (const window of options.windows) {
    if (creditBudgetExhausted) break;
    const persistedWindow = await repository.getHistoricalBackfillWindow(
      args.runId,
      options.stage,
      address,
      window.startUnix,
      window.endUnix
    );
    if (persistedWindow?.status === "completed") {
      stats.windowsSkipped += 1;
      continue;
    }
    const pagesRemainingForWindow = Math.max(
      0,
      options.maxPages - (persistedWindow?.pagesFetched ?? 0)
    );
    if (pagesRemainingForWindow === 0) {
      stats.windowsSkipped += 1;
      continue;
    }

    const cursorSource = `${options.cursorSource}:${window.startUnix}:${window.endUnix}`;
    const cursor = await repository.getIngestionCursor(cursorSource, address);
    let afterSignature = persistedWindow?.lastSignature ?? cursor?.lastSignature;
    let lastSlot = persistedWindow?.lastSlot ?? cursor?.lastSlot;
    let windowPagesFetched = persistedWindow?.pagesFetched ?? 0;
    let windowTransactionsFetched = persistedWindow?.transactionsFetched ?? 0;
    let windowStatus: "running" | "completed" | "saturated" | "error" = "running";

    await saveWindowProgress({
      stage: options.stage,
      address,
      window,
      status: "running",
      pagesFetched: windowPagesFetched,
      transactionsFetched: windowTransactionsFetched,
      ...(afterSignature ? { lastSignature: afterSignature } : {}),
      ...(lastSlot !== undefined ? { lastSlot } : {}),
      cursorSource
    });

    for (let page = 0; page < pagesRemainingForWindow; page += 1) {
      if (!reserveCredits("legacy-enhanced-history", 100)) {
        creditBudgetExhausted = true;
        windowStatus = afterSignature ? "saturated" : "running";
        break;
      }

      let transactions: HeliusEnhancedTransaction[];
      try {
        await waitForRequestSlot();
        transactions = await helius.getTransactionsByAddress(address, {
          ...(afterSignature ? { afterSignature } : {}),
          commitment: "finalized",
          sortOrder: "asc",
          tokenAccounts: options.tokenAccounts,
          gteTime: window.startUnix,
          lteTime: window.endUnix,
          limit: args.pageLimit
        });
      } catch (error) {
        windowStatus = "error";
        await saveWindowProgress({
          stage: options.stage,
          address,
          window,
          status: "error",
          pagesFetched: windowPagesFetched,
          transactionsFetched: windowTransactionsFetched,
          ...(afterSignature ? { lastSignature: afterSignature } : {}),
          ...(lastSlot !== undefined ? { lastSlot } : {}),
          cursorSource,
          error: errorMessage(error)
        });
        await writeProgress(
          "error",
          {
            stage: options.stage,
            address,
            page: windowPagesFetched + 1,
            windowStartUnix: window.startUnix,
            windowEndUnix: window.endUnix,
            cursorSource
          },
          [stats],
          errorMessage(error)
        );
        throw error;
      }
      stats.pagesFetched += 1;
      stats.transactionsFetched += transactions.length;
      windowPagesFetched += 1;
      windowTransactionsFetched += transactions.length;
      if (transactions.length === 0) {
        windowStatus = "completed";
        await saveWindowProgress({
          stage: options.stage,
          address,
          window,
          status: windowStatus,
          pagesFetched: windowPagesFetched,
          transactionsFetched: windowTransactionsFetched,
          ...(afterSignature ? { lastSignature: afterSignature } : {}),
          ...(lastSlot !== undefined ? { lastSlot } : {}),
          cursorSource
        });
        break;
      }

      for (const transaction of transactions) {
        const processed = await processTransaction(address, transaction);
        stats.discoveredPools += processed.discoveredPools;
        stats.insertedPools += processed.insertedPools;
        stats.insertedPriceObservations += processed.insertedPriceObservations;
        stats.insertedMarketObservations += processed.insertedMarketObservations;
        stats.decodedBuys += processed.decodedBuys;
        stats.insertedSwaps += processed.insertedSwaps;
        stats.insertedWalletEntries += processed.insertedWalletEntries;
      }

      const last = transactions[transactions.length - 1];
      if (last?.signature && last.slot !== undefined) {
        afterSignature = last.signature;
        lastSlot = last.slot;
        await repository.upsertIngestionCursor({
          idempotencyKey: createHash("sha256")
            .update([cursorSource, address, last.signature, strategyVersion].join(":"))
            .digest("hex"),
          chain: "solana",
          source: cursorSource,
          address,
          lastSignature: last.signature,
          lastSlot: last.slot,
          signature: last.signature,
          slot: last.slot,
          provider: "helius",
          observedAt: generatedAt,
          strategyVersion
        });
      }

      windowStatus = transactions.length < args.pageLimit ? "completed" : "saturated";
      await saveWindowProgress({
        stage: options.stage,
        address,
        window,
        status: windowStatus,
        pagesFetched: windowPagesFetched,
        transactionsFetched: windowTransactionsFetched,
        ...(afterSignature ? { lastSignature: afterSignature } : {}),
        ...(lastSlot !== undefined ? { lastSlot } : {}),
        cursorSource
      });
      await writeProgress(
        "running",
        {
          stage: options.stage,
          address,
          page: windowPagesFetched,
          windowStartUnix: window.startUnix,
          windowEndUnix: window.endUnix,
          cursorSource
        },
        [stats]
      );

      if (windowStatus === "completed") break;
    }
    if (windowStatus === "completed") stats.windowsCompleted += 1;
    if (windowStatus === "saturated") stats.windowsSaturated += 1;
  }

  return stats;
}

async function processTransaction(
  address: string,
  transaction: HeliusEnhancedTransaction
): Promise<Omit<BackfillStats, "address" | "pagesFetched" | "transactionsFetched">> {
  const event = toSolanaChainEvent(address, transaction);
  const stats = {
    discoveredPools: 0,
    insertedPools: 0,
    insertedPriceObservations: 0,
    insertedMarketObservations: 0,
    decodedBuys: 0,
    insertedSwaps: 0,
    insertedWalletEntries: 0,
    windowsCompleted: 0,
    windowsSaturated: 0,
    windowsSkipped: 0
  };
  if (!event.signature) return stats;

  const discoveries = decodePoolDiscoveries(event, decoders);
  stats.discoveredPools += discoveries.length;
  for (const discovery of discoveries) {
    await repository.upsertToken({
      chain: "solana",
      address: discovery.baseTokenAddress,
      symbol: shortAddress(discovery.baseTokenAddress),
      name: "Historical on-chain discovered token",
      firstSeenAt: discovery.createdAt,
      metadata: {
        discoveryProvider: "helius-history",
        discoveryProgramId: discovery.programId,
        discoverySignature: discovery.signature
      }
    });
    await repository.upsertPool(toPoolSnapshot(discovery));
    stats.insertedPools += 1;
  }

  const buys = decodeWalletBuys(event, buyDefinitions);
  stats.decodedBuys += buys.length;
  const priceObservations = inferPriceObservations(event, transaction);
  for (const observation of priceObservations) {
    if (await repository.savePriceObservation(observation)) {
      stats.insertedPriceObservations += 1;
    }
  }
  for (const observation of toHistoricalMarketObservations(
    event,
    transaction,
    priceObservations,
    buys
  )) {
    if (await repository.saveHistoricalMarketObservation(observation)) {
      stats.insertedMarketObservations += 1;
    }
  }

  for (const buy of buys) {
    const price = choosePriceForBuy(buy.outputTokenAddress, priceObservations);
    const outputTokenAddress = price?.tokenAddress ?? buy.outputTokenAddress;
    const idempotencyKey = createHash("sha256")
      .update(
        [
          "helius-history-buy",
          buy.signature,
          buy.poolAddress,
          buy.traderAddress,
          outputTokenAddress,
          strategyVersion
        ].join(":")
      )
      .digest("hex");
    const swap: OnchainSwapEvidence = {
      idempotencyKey,
      chain: "solana",
      poolAddress: buy.poolAddress,
      traderAddress: buy.traderAddress,
      inputTokenAddress: buy.inputTokenAddress,
      outputTokenAddress,
      ...(price?.priceUsd ? { priceUsd: price.priceUsd } : {}),
      signature: buy.signature,
      slot: buy.slot,
      provider: "helius-history",
      observedAt: buy.observedAt,
      strategyVersion,
      raw: {
        buy: buy.raw,
        inferredPrice: price?.raw ?? null,
        heliusType: transaction.type,
        heliusSource: transaction.source
      }
    };
    if (await repository.saveOnchainSwap(swap)) stats.insertedSwaps += 1;
    if (price?.priceUsd && price.priceUsd > 0) {
      const repeatWalletCount = await repository.countPriorWalletEntryTokens(
        buy.traderAddress,
        buy.observedAt,
        strategyVersion
      );
      const { inserted } = await recordFirstWalletEntry(repository, {
        chain: "solana",
        walletAddress: buy.traderAddress,
        tokenAddress: outputTokenAddress,
        poolAddress: buy.poolAddress,
        sourceSwapIdempotencyKey: idempotencyKey,
        observedEntryPriceUsd: price.priceUsd,
        observedLiquidityUsd: price.liquidityUsd,
        cohort: "excluded-uncontrolled-flow",
        repeatWalletCount,
        flowEvidence: {
          source: "helius-history",
          controlledFlow: false,
          liquidityUsd: price.liquidityUsd,
          volume5mUsd: 0,
          volume1hUsd: 0,
          buys5m: 0,
          sells5m: 0,
          swaps5m: 0,
          buyShare5m: 0,
          volumeLiquidityRatio: 0,
          poolAgeMinutes: 0,
          priceSource: price.raw.priceSource
        },
        signature: buy.signature,
        slot: buy.slot,
        provider: "helius-history",
        observedAt: buy.observedAt,
        strategyVersion
      });
      if (inserted) stats.insertedWalletEntries += 1;
    }
  }

  return stats;
}

async function materializeHistoricalOutcomes(): Promise<HeliusHistoricalReport["outcomes"]> {
  const [entries, observations] = await Promise.all([
    repository.listWalletEntrySignals(),
    repository.listPriceObservations()
  ]);
  const historicalEntries = entries.filter(
    (entry) => entry.provider === "helius-history" && entry.strategyVersion === strategyVersion
  );
  const observationsByToken = groupObservationsByToken(
    canonicalizeHistoricalPriceObservations(
      observations.filter((observation) => observation.strategyVersion === strategyVersion)
    )
  );
  let matureFixedHorizon = 0;
  let maturePaperExit = 0;
  const currentObservedAt = new Date(endMs).toISOString();

  for (const entry of historicalEntries) {
    const tokenObservations = observationsByToken.get(entry.tokenAddress) ?? [];
    const fixed = calculateWalletSignalOutcome(entry, tokenObservations, currentObservedAt, {
      horizonMinutes: 20,
      maxDelayMinutes: 20,
      estimatedRoundTripCostPct: 3,
      exitStrategy: "fixed-horizon"
    });
    if (await repository.saveWalletSignalOutcome(fixed)) {
      if (fixed.status === "mature") matureFixedHorizon += 1;
    }
    const paperExit = calculateWalletSignalOutcome(entry, tokenObservations, currentObservedAt, {
      horizonMinutes: 20,
      maxDelayMinutes: 20,
      estimatedRoundTripCostPct: 3,
      exitStrategy: "tp15-sl20-20m"
    });
    if (await repository.saveWalletSignalOutcome(paperExit)) {
      if (paperExit.status === "mature") maturePaperExit += 1;
    }
  }

  return {
    entriesEvaluated: historicalEntries.length,
    matureFixedHorizon,
    maturePaperExit
  };
}

async function selectWalletEntryPoolsForBackfill(): Promise<Array<{
  address: string;
  firstObservedAt: string;
  count: number;
}>> {
  const entries = await repository.listWalletEntrySignals();
  const pools = new Map<string, { address: string; firstObservedAt: string; count: number }>();
  for (const entry of entries) {
    if (
      entry.provider !== "helius-history" ||
      !entry.poolAddress ||
      entry.strategyVersion !== strategyVersion
    ) {
      continue;
    }
    const existing = pools.get(entry.poolAddress);
    if (!existing) {
      pools.set(entry.poolAddress, {
        address: entry.poolAddress,
        firstObservedAt: entry.observedAt,
        count: 1
      });
      continue;
    }
    existing.count += 1;
    if (new Date(entry.observedAt).getTime() < new Date(existing.firstObservedAt).getTime()) {
      existing.firstObservedAt = entry.observedAt;
    }
  }
  return [...pools.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, args.maxPools);
}

async function selectMintWindowsForBackfill(): Promise<Array<{
  address: string;
  window: TimeWindow;
  count: number;
}>> {
  const [entries, observations] = await Promise.all([
    repository.listWalletEntrySignals(),
    repository.listPriceObservations()
  ]);
  const observationsByToken = groupObservationsByToken(
    canonicalizeHistoricalPriceObservations(
      observations.filter((observation) => observation.strategyVersion === strategyVersion)
    )
  );
  const candidates = new Map<
    string,
    { address: string; window: TimeWindow; count: number; observedAt: string }
  >();
  for (const entry of entries) {
    if (
      entry.provider !== "helius-history" ||
      entry.strategyVersion !== strategyVersion ||
      entry.tokenAddress === wrappedSolMint ||
      entry.tokenAddress === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    ) {
      continue;
    }
    const entryTime = new Date(entry.observedAt).getTime();
    const hasPostHorizonObservation = (
      observationsByToken.get(entry.tokenAddress) ?? []
    ).some((observation) => {
      const observedTime = new Date(observation.observedAt).getTime();
      return observedTime >= entryTime + 20 * 60_000 && observedTime <= entryTime + 40 * 60_000;
    });
    if (hasPostHorizonObservation) continue;
    const window = mintHorizonWindow(entry.observedAt);
    const key = `${entry.tokenAddress}:${window.startUnix}:${window.endUnix}`;
    const existing = candidates.get(key);
    candidates.set(key, {
      address: entry.tokenAddress,
      window,
      count: (existing?.count ?? 0) + 1 + entry.repeatWalletCount,
      observedAt: existing?.observedAt ?? entry.observedAt
    });
  }
  return [...candidates.values()]
    .sort(
      (a, b) =>
        b.count - a.count ||
        new Date(a.observedAt).getTime() - new Date(b.observedAt).getTime()
    )
    .slice(0, args.maxMints)
    .map((candidate) => ({
      address: candidate.address,
      count: candidate.count,
      window: candidate.window
    }));
}

async function enrichTokenMetadata(): Promise<HeliusHistoricalReport["metadata"]> {
  const [tokens, entries] = await Promise.all([
    repository.listRecentTokens(Math.max(args.maxAssets * 4, 10_000)),
    repository.listWalletEntrySignals()
  ]);
  const tokenByAddress = new Map(tokens.map((token) => [token.address, token]));
  const candidateAddresses = [
    ...new Set([
      ...entries
        .filter(
          (entry) =>
            entry.provider === "helius-history" &&
            entry.strategyVersion === strategyVersion
        )
        .map((entry) => entry.tokenAddress),
      ...tokens
        .filter((token) => token.metadata.discoveryProvider === "helius-history")
        .map((token) => token.address)
    ])
  ]
    .filter(
      (address) =>
        address !== wrappedSolMint &&
        address !== "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    )
    .filter((address) => !tokenByAddress.get(address)?.metadata.heliusAssetEnrichedAt)
    .slice(0, args.maxAssets);

  const result = {
    requestedAssets: candidateAddresses.length,
    returnedAssets: 0,
    updatedTokens: 0,
    batches: 0
  };
  for (const ids of chunks(candidateAddresses, args.assetBatchSize)) {
    if (!reserveCredits("das", 10)) {
      creditBudgetExhausted = true;
      break;
    }
    await waitForRequestSlot();
    const assets = await helius.getAssetBatch(ids);
    result.batches += 1;
    result.returnedAssets += assets.length;
    for (const asset of assets) {
      if (!asset.id) continue;
      const existing = tokenByAddress.get(asset.id);
      const parsed = parseHeliusAsset(asset);
      const creatorAddress = parsed.creatorAddress ?? existing?.creatorAddress;
      await repository.upsertToken({
        chain: "solana",
        address: asset.id,
        symbol: parsed.symbol || existing?.symbol || shortAddress(asset.id),
        name: parsed.name || existing?.name || "Historical Solana token",
        ...(parsed.decimals !== undefined
          ? { decimals: parsed.decimals }
          : existing?.decimals !== undefined
            ? { decimals: existing.decimals }
            : {}),
        ...(creatorAddress ? { creatorAddress } : {}),
        firstSeenAt: existing?.firstSeenAt ?? generatedAt,
        metadata: {
          ...(existing?.metadata ?? {}),
          heliusAssetEnrichedAt: new Date().toISOString(),
          heliusAsset: parsed.metadata
        }
      });
      result.updatedTokens += 1;
    }
    await writeProgress("running", { stage: "metadata" });
  }
  return result;
}

function parseHeliusAsset(asset: HeliusAsset): {
  symbol?: string;
  name?: string;
  decimals?: number;
  creatorAddress?: string;
  metadata: Record<string, unknown>;
} {
  const contentMetadata = asset.content?.metadata;
  const tokenInfo = asset.token_info;
  const creatorAddress =
    asset.authorities?.find((authority) => authority.address)?.address ??
    asset.creators?.find((creator) => creator.verified && creator.address)?.address ??
    asset.creators?.find((creator) => creator.address)?.address;
  const symbol = tokenInfo?.symbol ?? contentMetadata?.symbol;
  return {
    ...(symbol ? { symbol } : {}),
    ...(contentMetadata?.name ? { name: contentMetadata.name } : {}),
    ...(tokenInfo?.decimals !== undefined ? { decimals: tokenInfo.decimals } : {}),
    ...(creatorAddress ? { creatorAddress } : {}),
    metadata: {
      interface: asset.interface,
      mutable: asset.mutable,
      burnt: asset.burnt,
      jsonUri: asset.content?.json_uri,
      content: contentMetadata,
      authorities: asset.authorities ?? [],
      creators: asset.creators ?? [],
      tokenInfo: tokenInfo
        ? {
            supply: tokenInfo.supply,
            decimals: tokenInfo.decimals,
            tokenProgram: tokenInfo.token_program,
            mintAuthority: tokenInfo.mint_authority,
            freezeAuthority: tokenInfo.freeze_authority,
            priceInfo: tokenInfo.price_info
          }
        : undefined
    }
  };
}

function inferPriceObservations(
  event: SolanaChainEvent,
  transaction: HeliusEnhancedTransaction
): PriceObservationEvidence[] {
  const swap = transaction.events?.swap;
  const observedAt = event.observedAt;
  const candidates = swap
    ? inferSwapEventPriceCandidates(swap)
    : inferTransferPriceCandidates(transaction);

  return candidates.map((candidate, index) => {
    const priceSol = candidate.solAmount / candidate.tokenAmount;
    const priceUsd = priceSol * args.solUsd;
    const raw = {
      priceSource: candidate.priceSource,
      priceSol,
      solUsdEstimate: args.solUsd,
      side: candidate.side,
      tokenAmount: candidate.tokenAmount,
      solAmount: candidate.solAmount,
      quoteTokenAddress: wrappedSolMint,
      confidence: candidate.confidence,
      heliusType: transaction.type,
      heliusSource: transaction.source
    };
    return {
      idempotencyKey: createHash("sha256")
        .update(
          [
            "helius-history-price",
            event.signature,
            candidate.tokenAddress,
            index,
            strategyVersion
          ].join(":")
        )
        .digest("hex"),
      chain: "solana",
      tokenAddress: candidate.tokenAddress,
      priceUsd,
      liquidityUsd: 0,
      rugged: false,
      signature: event.signature,
      slot: event.slot,
      provider: "helius-history",
      observedAt,
      strategyVersion,
      raw
    };
  });
}

function toHistoricalMarketObservations(
  event: SolanaChainEvent,
  transaction: HeliusEnhancedTransaction,
  priceObservations: PriceObservationEvidence[],
  buys: Array<{
    outputTokenAddress: string;
    poolAddress: string;
    traderAddress: string;
  }>
): HistoricalMarketObservation[] {
  return priceObservations.flatMap((observation) => {
    const baseAmount = Number(observation.raw.tokenAmount ?? 0);
    const quoteAmount = Number(observation.raw.solAmount ?? 0);
    const priceQuote = Number(observation.raw.priceSol ?? 0);
    const side = observation.raw.side;
    if (
      baseAmount <= 0 ||
      quoteAmount <= 0 ||
      priceQuote <= 0 ||
      (side !== "buy" && side !== "sell")
    ) {
      return [];
    }
    const matchingBuy = buys.find(
      (buy) => buy.outputTokenAddress === observation.tokenAddress
    );
    const priceSource = String(observation.raw.priceSource ?? "unknown");
    const rawConfidence = Math.max(
      0,
      Math.min(1, Number(observation.raw.confidence ?? 0))
    );
    const confidence =
      matchingBuy && priceSource === "helius-transfer-derived"
        ? Math.max(rawConfidence, 0.75)
        : rawConfidence;
    return [
      {
        idempotencyKey: createHash("sha256")
          .update(
            [
              "helius-history-market",
              observation.idempotencyKey,
              matchingBuy?.poolAddress ?? "unresolved",
              strategyVersion
            ].join(":")
          )
          .digest("hex"),
        chain: "solana",
        tokenAddress: observation.tokenAddress,
        quoteTokenAddress: wrappedSolMint,
        ...(matchingBuy?.poolAddress ? { poolAddress: matchingBuy.poolAddress } : {}),
        ...(matchingBuy?.traderAddress || transaction.feePayer
          ? { traderAddress: matchingBuy?.traderAddress ?? transaction.feePayer }
          : {}),
        side,
        baseAmount,
        quoteAmount,
        priceQuote,
        priceUsdEstimate: observation.priceUsd,
        volumeUsdEstimate: quoteAmount * args.solUsd,
        priceSource,
        confidence,
        signature: event.signature,
        slot: event.slot,
        provider: "helius-history",
        observedAt: event.observedAt,
        strategyVersion,
        raw: {
          heliusType: transaction.type,
          heliusSource: transaction.source,
          solUsdEstimate: args.solUsd,
          sourcePriceObservation: observation.idempotencyKey
        }
      }
    ];
  });
}

function inferSwapEventPriceCandidates(swap: HeliusSwapEvent): PriceCandidate[] {
  const candidates: PriceCandidate[] = [];
  const nativeInputSol = lamportsToSol(swap.nativeInput?.amount);
  const nativeOutputSol = lamportsToSol(swap.nativeOutput?.amount);

  if (nativeInputSol > 0) {
    for (const [mint, tokenAmount] of aggregateSwapTokenLegs(swap.tokenOutputs ?? [])) {
      if (mint !== wrappedSolMint && tokenAmount > 0) {
        candidates.push({
          tokenAddress: mint,
          tokenAmount,
          solAmount: nativeInputSol,
          side: "buy",
          priceSource: "helius-enhanced-swap-event",
          confidence: 0.9
        });
      }
    }
  }
  if (nativeOutputSol > 0) {
    for (const [mint, tokenAmount] of aggregateSwapTokenLegs(swap.tokenInputs ?? [])) {
      if (mint !== wrappedSolMint && tokenAmount > 0) {
        candidates.push({
          tokenAddress: mint,
          tokenAmount,
          solAmount: nativeOutputSol,
          side: "sell",
          priceSource: "helius-enhanced-swap-event",
          confidence: 0.9
        });
      }
    }
  }

  return candidates;
}

function inferTransferPriceCandidates(transaction: HeliusEnhancedTransaction): PriceCandidate[] {
  const feePayer = transaction.feePayer;
  const tokenTransfers = (transaction.tokenTransfers ?? []).filter(
    (transfer) =>
      transfer.mint &&
      transfer.mint !== wrappedSolMint &&
      Number(transfer.tokenAmount ?? 0) > 0
  );
  if (!feePayer || tokenTransfers.length === 0) return [];

  const nativeTransfers = transaction.nativeTransfers ?? [];
  const nativeSentByFeePayer = lamportsToSol(
    nativeTransfers
      .filter((transfer) => transfer.fromUserAccount === feePayer)
      .reduce((sum, transfer) => sum + Number(transfer.amount ?? 0), 0)
  );
  const nativeReceivedByFeePayer = lamportsToSol(
    nativeTransfers
      .filter((transfer) => transfer.toUserAccount === feePayer)
      .reduce((sum, transfer) => sum + Number(transfer.amount ?? 0), 0)
  );

  const incoming = aggregateTransferTokenAmounts(
    tokenTransfers.filter((transfer) => transfer.toUserAccount === feePayer)
  );
  const outgoing = aggregateTransferTokenAmounts(
    tokenTransfers.filter((transfer) => transfer.fromUserAccount === feePayer)
  );
  const candidates: PriceCandidate[] = [];
  if (incoming.size === 1 && nativeSentByFeePayer > 0) {
    const [tokenAddress, tokenAmount] = [...incoming.entries()][0]!;
    candidates.push({
      tokenAddress,
      tokenAmount,
      solAmount: nativeSentByFeePayer,
      side: "buy",
      priceSource: "helius-transfer-derived",
      confidence: 0.55
    });
  }
  if (outgoing.size === 1 && nativeReceivedByFeePayer > 0) {
    const [tokenAddress, tokenAmount] = [...outgoing.entries()][0]!;
    candidates.push({
      tokenAddress,
      tokenAmount,
      solAmount: nativeReceivedByFeePayer,
      side: "sell",
      priceSource: "helius-transfer-derived",
      confidence: 0.55
    });
  }
  return candidates;
}

function aggregateSwapTokenLegs(
  legs: HeliusSwapTokenLeg[]
): Map<string, number> {
  const amounts = new Map<string, number>();
  for (const leg of legs) {
    if (!leg.mint) continue;
    const amount = tokenAmountValue(leg);
    if (amount <= 0) continue;
    amounts.set(leg.mint, (amounts.get(leg.mint) ?? 0) + amount);
  }
  return amounts;
}

function aggregateTransferTokenAmounts(
  transfers: NonNullable<HeliusEnhancedTransaction["tokenTransfers"]>
): Map<string, number> {
  const amounts = new Map<string, number>();
  for (const transfer of transfers) {
    if (!transfer.mint) continue;
    const amount = Number(transfer.tokenAmount ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    amounts.set(transfer.mint, (amounts.get(transfer.mint) ?? 0) + amount);
  }
  return amounts;
}

function choosePriceForBuy(
  outputTokenAddress: string,
  observations: PriceObservationEvidence[]
): PriceObservationEvidence | undefined {
  return (
    observations.find((observation) => observation.tokenAddress === outputTokenAddress) ??
    (observations.length === 1 ? observations[0] : undefined)
  );
}

function toSolanaChainEvent(
  address: string,
  transaction: HeliusEnhancedTransaction
): SolanaChainEvent {
  const observedAt = transaction.timestamp
    ? new Date(transaction.timestamp * 1_000).toISOString()
    : generatedAt;
  return {
    address,
    signature: transaction.signature ?? `missing-signature:${address}:${observedAt}`,
    slot: transaction.slot ?? 0,
    observedAt,
    transaction: {
      ...(transaction.timestamp !== undefined ? { blockTime: transaction.timestamp } : {}),
      meta: {
        err: transaction.transactionError ?? null
      },
      transaction: {
        message: {
          instructions: flattenInstructions(transaction.instructions ?? [])
        }
      }
    }
  };
}

function flattenInstructions(instructions: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return instructions.flatMap((instruction) => [
    instruction,
    ...((instruction.innerInstructions as Array<Record<string, unknown>> | undefined) ?? [])
  ]);
}

function toPoolSnapshot(discovery: {
  poolAddress: string;
  programId: string;
  baseTokenAddress: string;
  quoteTokenAddress?: string;
  createdAt: string;
  raw: Record<string, unknown>;
}): PoolSnapshot {
  return {
    chain: "solana",
    poolAddress: discovery.poolAddress,
    dex: discovery.programId,
    baseTokenAddress: discovery.baseTokenAddress,
    ...(discovery.quoteTokenAddress ? { quoteTokenAddress: discovery.quoteTokenAddress } : {}),
    createdAt: discovery.createdAt,
    liquidityUsd: 0,
    volume5mUsd: 0,
    volume1hUsd: 0,
    txns5m: { buys: 0, sells: 0 },
    raw: {
      ...discovery.raw,
      provider: "helius-history"
    }
  };
}

function buildPoolDecoders(programsToDecode: ProgramConfig[]): PoolEventDecoder[] {
  return programsToDecode.flatMap((program) => [
    ...(program.instructionTypes?.length
      ? [
          createParsedInstructionPoolDecoder({
            programId: program.programId,
            instructionTypes: program.instructionTypes
          })
        ]
      : []),
    ...(program.rawInstructions?.length
      ? [
          createRawInstructionPoolDecoder({
            programId: program.programId,
            instructions: program.rawInstructions
          })
        ]
      : [])
  ]);
}

function buildBuyDefinitions(): RawBuyInstructionDefinition[] {
  const pumpProgramId = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
  const pumpSwapProgramId = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
  return [
    {
      name: "pump-buy",
      programId: pumpProgramId,
      discriminatorHex: "66063d1201daebea",
      poolAccountIndex: 3,
      outputTokenAccountIndex: 2,
      traderAccountIndex: 6,
      staticInputTokenAddress: wrappedSolMint
    },
    {
      name: "pump-buy-exact-sol-in",
      programId: pumpProgramId,
      discriminatorHex: "38fc74089edfcd5f",
      poolAccountIndex: 3,
      outputTokenAccountIndex: 2,
      traderAccountIndex: 6,
      staticInputTokenAddress: wrappedSolMint
    },
    {
      name: "pump-buy-v2",
      programId: pumpProgramId,
      discriminatorHex: "b817ee6167c5d33d",
      poolAccountIndex: 10,
      outputTokenAccountIndex: 1,
      inputTokenAccountIndex: 2,
      traderAccountIndex: 13
    },
    {
      name: "pump-buy-exact-quote-in-v2",
      programId: pumpProgramId,
      discriminatorHex: "c2ab1c46684d5b2f",
      poolAccountIndex: 10,
      outputTokenAccountIndex: 1,
      inputTokenAccountIndex: 2,
      traderAccountIndex: 13
    },
    {
      name: "pumpswap-buy",
      programId: pumpSwapProgramId,
      discriminatorHex: "66063d1201daebea",
      poolAccountIndex: 0,
      traderAccountIndex: 1,
      outputTokenAccountIndex: 3,
      inputTokenAccountIndex: 4
    },
    {
      name: "pumpswap-buy-exact-quote-in",
      programId: pumpSwapProgramId,
      discriminatorHex: "c62e1552b4d9e870",
      poolAccountIndex: 0,
      traderAccountIndex: 1,
      outputTokenAccountIndex: 3,
      inputTokenAccountIndex: 4
    }
  ];
}

function parsePrograms(raw: string | undefined): ProgramConfig[] {
  if (!raw) {
    throw new Error("SOLANA_POOL_PROGRAMS_JSON is required for historical backfill.");
  }
  const programsToParse = JSON.parse(raw) as ProgramConfig[];
  if (!Array.isArray(programsToParse) || programsToParse.length === 0) {
    throw new Error("SOLANA_POOL_PROGRAMS_JSON must contain at least one program.");
  }
  return programsToParse;
}

function parseArgs(argv: string[]): BackfillArgs {
  const days = numberArg(argv, "days", 30);
  return {
    runId: stringArg(argv, "run-id", `helius-history-${days}d`),
    days,
    maxPages: numberArg(argv, "max-pages", numberFromEnv("HELIUS_BACKFILL_MAX_PAGES", 5)),
    maxPools: numberArg(argv, "max-pools", numberFromEnv("HELIUS_BACKFILL_MAX_POOLS", 25)),
    poolPages: numberArg(argv, "pool-pages", numberFromEnv("HELIUS_BACKFILL_POOL_PAGES", 2)),
    maxMints: numberArg(argv, "max-mints", numberFromEnv("HELIUS_BACKFILL_MAX_MINTS", 50)),
    mintPages: numberArg(argv, "mint-pages", numberFromEnv("HELIUS_BACKFILL_MINT_PAGES", 1)),
    maxAssets: numberArg(
      argv,
      "max-assets",
      numberFromEnv("HELIUS_BACKFILL_MAX_ASSETS", 5_000)
    ),
    assetBatchSize: Math.min(
      1_000,
      numberArg(
        argv,
        "asset-batch-size",
        numberFromEnv("HELIUS_BACKFILL_ASSET_BATCH_SIZE", 1_000)
      )
    ),
    sliceMinutes:
      optionalNumberArg(argv, "slice-minutes") ??
      (optionalNumberArg(argv, "slice-hours") ?? numberFromEnv("HELIUS_BACKFILL_SLICE_HOURS", 1)) *
        60,
    maxSlices: numberArg(argv, "max-slices", numberFromEnv("HELIUS_BACKFILL_MAX_SLICES", 24)),
    pageLimit: Math.min(100, numberArg(argv, "page-limit", numberFromEnv("HELIUS_BACKFILL_PAGE_LIMIT", 100))),
    requestsPerSecond: numberArg(
      argv,
      "rps",
      numberFromEnv("HELIUS_BACKFILL_REQUESTS_PER_SECOND", 1)
    ),
    creditBudget: numberArg(
      argv,
      "credit-budget",
      numberFromEnv("HELIUS_BACKFILL_CREDIT_BUDGET", 500_000)
    ),
    solUsd: numberArg(argv, "sol-usd", numberFromEnv("HISTORICAL_SOL_USD", 150)),
    endpoint: stringArg(argv, "endpoint", process.env.HELIUS_API_ENDPOINT ?? "https://mainnet.helius-rpc.com")
  };
}

function numberArg(argv: string[], name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const value = argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalNumberArg(argv: string[], name: string): number | undefined {
  const prefix = `--${name}=`;
  const value = argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function stringArg(argv: string[], name: string, fallback: string): string {
  const prefix = `--${name}=`;
  return argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

async function loadReusableProgress(runId: string): Promise<BackfillProgressSnapshot | undefined> {
  const runProgress = await loadProgressFromPath(progressPath, runId);
  if (runProgress) return runProgress;
  return loadProgressFromPath(latestProgressPath, runId);
}

async function loadProgressFromPath(
  path: string,
  runId: string
): Promise<BackfillProgressSnapshot | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as BackfillProgressSnapshot;
    if (parsed.runId !== runId) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function createBackfillWindow(days: number): BackfillWindow {
  const end = Date.now();
  const start = end - days * 86_400_000;
  return {
    startMs: start,
    endMs: end,
    startUnix: Math.floor(start / 1_000),
    endUnix: Math.floor(end / 1_000),
    startTime: new Date(start).toISOString(),
    endTime: new Date(end).toISOString()
  };
}

async function saveWindowProgress(input: {
  stage: "program" | "pool" | "mint";
  address: string;
  window: TimeWindow;
  status: "running" | "completed" | "saturated" | "error";
  pagesFetched: number;
  transactionsFetched: number;
  lastSignature?: string;
  lastSlot?: number;
  cursorSource: string;
  error?: string;
}): Promise<void> {
  await repository.upsertHistoricalBackfillWindow({
    runId: args.runId,
    stage: input.stage,
    address: input.address,
    windowStartUnix: input.window.startUnix,
    windowEndUnix: input.window.endUnix,
    status: input.status,
    pagesFetched: input.pagesFetched,
    transactionsFetched: input.transactionsFetched,
    ...(input.lastSignature ? { lastSignature: input.lastSignature } : {}),
    ...(input.lastSlot !== undefined ? { lastSlot: input.lastSlot } : {}),
    provider: "helius",
    strategyVersion,
    updatedAt: new Date().toISOString(),
    raw: {
      cursorSource: input.cursorSource,
      ...(input.error ? { error: input.error } : {})
    }
  });
}

function reserveCredits(service: "legacy-enhanced-history" | "das", cost: number): boolean {
  if (creditUsage.estimatedUsed + cost > creditUsage.budget) {
    creditUsage.remaining = Math.max(0, creditUsage.budget - creditUsage.estimatedUsed);
    return false;
  }
  creditUsage.estimatedUsed += cost;
  creditUsage.remaining = Math.max(0, creditUsage.budget - creditUsage.estimatedUsed);
  if (service === "legacy-enhanced-history") {
    creditUsage.legacyEnhancedHistoryRequests += 1;
  } else {
    creditUsage.dasRequests += 1;
  }
  return true;
}

async function writeProgress(
  status: BackfillProgressSnapshot["status"],
  current?: BackfillProgressSnapshot["current"],
  currentAddressStats: BackfillStats[] = [],
  error?: string
): Promise<void> {
  const stats = [...addressStats, ...currentAddressStats];
  const snapshot: BackfillProgressSnapshot = {
    runId: args.runId,
    status,
    generatedAt,
    updatedAt: new Date().toISOString(),
    strategyVersion,
    window: backfillWindow,
    args: {
      ...args,
      endpoint: redactEndpoint(args.endpoint)
    },
    creditUsage,
    ...(current ? { current } : {}),
    totals: sumAddressStats(stats),
    addressStats: stats,
  reports: [
      progressPath,
      latestProgressPath,
      "reports/helius-historical-backfill-latest.json",
      "reports/helius-historical-backfill-latest.md"
    ],
    ...(error ? { error } : {})
  };
  await writeJsonAtomic(progressPath, snapshot);
  await writeJsonAtomic(latestProgressPath, snapshot);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const serialized = JSON.stringify(value, null, 2);
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, serialized);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(tmpPath, path);
      return;
    } catch (error) {
      if (!isRetryableFileReplaceError(error) || attempt === 4) break;
      await sleep(50 * 2 ** attempt);
    }
  }

  // PostgreSQL cursors remain authoritative; a locked Windows report file must not halt ingestion.
  await writeFile(path, serialized);
  await unlink(tmpPath).catch(() => undefined);
}

function isRetryableFileReplaceError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

function sumAddressStats(stats: BackfillStats[]): Omit<BackfillStats, "address"> {
  const totals = stats.reduce<Omit<BackfillStats, "address">>(
    (sum, stat) => ({
      pagesFetched: sum.pagesFetched + stat.pagesFetched,
      transactionsFetched: sum.transactionsFetched + stat.transactionsFetched,
      discoveredPools: sum.discoveredPools + stat.discoveredPools,
      insertedPools: sum.insertedPools + stat.insertedPools,
      insertedPriceObservations:
        sum.insertedPriceObservations + stat.insertedPriceObservations,
      insertedMarketObservations:
        sum.insertedMarketObservations + stat.insertedMarketObservations,
      decodedBuys: sum.decodedBuys + stat.decodedBuys,
      insertedSwaps: sum.insertedSwaps + stat.insertedSwaps,
      insertedWalletEntries: sum.insertedWalletEntries + stat.insertedWalletEntries,
      windowsCompleted: sum.windowsCompleted + stat.windowsCompleted,
      windowsSaturated: sum.windowsSaturated + stat.windowsSaturated,
      windowsSkipped: sum.windowsSkipped + stat.windowsSkipped
    }),
    {
      pagesFetched: 0,
      transactionsFetched: 0,
      discoveredPools: 0,
      insertedPools: 0,
      insertedPriceObservations: 0,
      insertedMarketObservations: 0,
      decodedBuys: 0,
      insertedSwaps: 0,
      insertedWalletEntries: 0,
      windowsCompleted: 0,
      windowsSaturated: 0,
      windowsSkipped: 0
    }
  );
  return finalWindowSummaryState.value
    ? {
        ...totals,
        windowsCompleted: finalWindowSummaryState.value.completed,
        windowsSaturated: finalWindowSummaryState.value.saturated
      }
    : totals;
}

function redactEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (url.searchParams.has("api-key")) url.searchParams.set("api-key", "redacted");
    return url.toString();
  } catch {
    return endpoint;
  }
}

function progressPathForRun(runId: string): string {
  return `reports/backfills/${safeFilePart(runId)}-progress.json`;
}

function safeFilePart(value: string): string {
  const cleaned = value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return cleaned || "helius-history";
}

function numberFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function tokenAmountValue(leg: HeliusSwapTokenLeg): number {
  if (leg.tokenAmount !== undefined) return Number(leg.tokenAmount);
  const rawAmount = Number(leg.rawTokenAmount?.tokenAmount ?? 0);
  const decimals = Number(leg.rawTokenAmount?.decimals ?? 0);
  return rawAmount / 10 ** decimals;
}

function lamportsToSol(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed / 1_000_000_000 : 0;
}

function buildTimeWindows(start: number, end: number, minutes: number): TimeWindow[] {
  const width = Math.max(1, Math.floor(minutes)) * 60;
  const windows: TimeWindow[] = [];
  for (let cursor = start; cursor < end; cursor += width) {
    windows.push({ startUnix: cursor, endUnix: Math.min(end, cursor + width - 1) });
  }
  return windows;
}

function selectTimeWindows(windows: TimeWindow[], maxWindows: number): TimeWindow[] {
  if (windows.length <= maxWindows) return windows;
  if (maxWindows <= 1) return [windows[0]!];
  const selected: TimeWindow[] = [];
  const step = (windows.length - 1) / (maxWindows - 1);
  const seen = new Set<number>();
  for (let index = 0; index < maxWindows; index += 1) {
    const windowIndex = Math.round(index * step);
    if (!seen.has(windowIndex) && windows[windowIndex]) {
      selected.push(windows[windowIndex]);
      seen.add(windowIndex);
    }
  }
  return selected;
}

function poolWindow(createdAt: string): TimeWindow {
  const start = Math.floor(new Date(createdAt).getTime() / 1_000);
  return {
    startUnix: start,
    endUnix: Math.min(endUnix, start + 2 * 3_600)
  };
}

function mintHorizonWindow(firstObservedAt: string): TimeWindow {
  const start = Math.floor(new Date(firstObservedAt).getTime() / 1_000) + 20 * 60;
  return {
    startUnix: start,
    endUnix: start + 20 * 60
  };
}

function shortAddress(address: string): string {
  return address.length > 8 ? `${address.slice(0, 4)}...${address.slice(-4)}` : address;
}

function groupObservationsByToken(
  observations: PriceObservationEvidence[]
): Map<string, PriceObservationEvidence[]> {
  const grouped = new Map<string, PriceObservationEvidence[]>();
  for (const observation of observations) {
    const existing = grouped.get(observation.tokenAddress) ?? [];
    existing.push(observation);
    grouped.set(observation.tokenAddress, existing);
  }
  return grouped;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/api-key=[^&\s]+/gi, "api-key=redacted").slice(0, 1_000);
}

async function waitForRequestSlot(): Promise<void> {
  const waitMs = Math.max(0, nextRequestAt - Date.now());
  if (waitMs > 0) await sleep(waitMs);
  nextRequestAt = Date.now() + pageDelayMs;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderMarkdown(report: HeliusHistoricalReport): string {
  return [
    "# Helius Historical Backfill",
    "",
    `Run ID: ${report.runId}`,
    `Generated: ${report.generatedAt}`,
    `Window: ${report.startTime} to ${report.endTime}`,
    `Days: ${report.days}`,
    `Free-plan safe: ${report.freePlanSafe ? "yes" : "no"}`,
    `Max pools: ${report.maxPools}`,
    `Pool pages/address: ${report.poolPagesPerAddress}`,
    `Max mints: ${report.maxMints}`,
    `Mint pages/address: ${report.mintPagesPerAddress}`,
    `Max metadata assets: ${report.maxAssets}`,
    `Metadata batch size: ${report.assetBatchSize}`,
    `Slice minutes: ${report.sliceMinutes}`,
    `Program slices evaluated: ${report.slicesEvaluated}`,
    `Program sampling: ${report.programSampling.selectedWindows}/${report.programSampling.candidateWindows} windows (${(report.programSampling.selectedWindowRate * 100).toFixed(2)}%)`,
    "",
    "Research and paper mode only. This is not financial advice.",
    "",
    "## Totals",
    "",
    `Programs: ${report.programCount}`,
    `Pages fetched: ${report.totals.pagesFetched}`,
    `Transactions fetched: ${report.totals.transactionsFetched}`,
    `Discovered pools: ${report.totals.discoveredPools}`,
    `Inserted price observations: ${report.totals.insertedPriceObservations}`,
    `Inserted market observations: ${report.totals.insertedMarketObservations}`,
    `Decoded buys: ${report.totals.decodedBuys}`,
    `Inserted swaps: ${report.totals.insertedSwaps}`,
    `Inserted wallet entries: ${report.totals.insertedWalletEntries}`,
    `Completed windows: ${report.totals.windowsCompleted}`,
    `Saturated windows: ${report.totals.windowsSaturated}`,
    `Skipped completed windows: ${report.totals.windowsSkipped}`,
    `Materialized 5m market buckets: ${report.marketBucketsMaterialized}`,
    `Materialized pre-entry wallet flows: ${report.walletFlowsMaterialized}`,
    "",
    "## Credit Budget",
    "",
    `Budget: ${report.creditUsage.budget}`,
    `Estimated used: ${report.creditUsage.estimatedUsed}`,
    `Estimated remaining: ${report.creditUsage.remaining}`,
    `Legacy Enhanced History requests: ${report.creditUsage.legacyEnhancedHistoryRequests}`,
    `DAS requests: ${report.creditUsage.dasRequests}`,
    "",
    "## Token Metadata",
    "",
    `Requested assets: ${report.metadata.requestedAssets}`,
    `Returned assets: ${report.metadata.returnedAssets}`,
    `Updated tokens: ${report.metadata.updatedTokens}`,
    `Batches: ${report.metadata.batches}`,
    "",
    "## Outcomes",
    "",
    `Entries evaluated: ${report.outcomes.entriesEvaluated}`,
    `Mature fixed-horizon outcomes: ${report.outcomes.matureFixedHorizon}`,
    `Mature paper-exit outcomes: ${report.outcomes.maturePaperExit}`,
    "",
    "## Address Stats",
    "",
    "| Address | Pages | Txs | Pools | Prices | Market | Buys | Swaps | Entries | Done | Saturated |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...report.addressStats.map((stat) =>
      [
        stat.address,
        stat.pagesFetched,
        stat.transactionsFetched,
        stat.discoveredPools,
        stat.insertedPriceObservations,
        stat.insertedMarketObservations,
        stat.decodedBuys,
        stat.insertedSwaps,
        stat.insertedWalletEntries,
        stat.windowsCompleted,
        stat.windowsSaturated
      ].join(" | ")
    ),
    "",
    "## Limitations",
    "",
    ...report.limitations.map((item) => `- ${item}`)
  ].join("\n");
}
