import "dotenv/config";
import { createHash } from "node:crypto";
import { DexScreenerClient } from "@memecoin-alpha/providers";
import type { DexScreenerPair } from "@memecoin-alpha/providers";
import { PostgresRepository } from "@memecoin-alpha/db";
import { calculateWalletSignalOutcome } from "@memecoin-alpha/core";
import type { WalletSignalOutcomeEvidence } from "@memecoin-alpha/shared";
import {
  chunksOf,
  classifyMissingExactPair,
  compactDexScreenerPair,
  dexScreenerObservationSignature,
  groupEvidenceMarkets,
  sampleBucketStart,
  selectEvidencePair,
  shouldPersistOutcomeTransition,
  walletOutcomeLifecycleKey
} from "./evidence-sampling.js";
import { isWalletEntryOutcomeEligible } from "./wallet-entry-policy.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");

const intervalSeconds = boundedInt(process.env.EVIDENCE_SAMPLER_INTERVAL_SECONDS, 120, 30, 3_600);
const intervalMs = intervalSeconds * 1_000;
const bucketSeconds = boundedInt(
  process.env.EVIDENCE_SAMPLER_BUCKET_SECONDS,
  intervalSeconds,
  intervalSeconds,
  3_600
);
const fetchConcurrency = boundedInt(process.env.DEXSCREENER_SAMPLE_CONCURRENCY, 2, 1, 4);
const maxActiveTokens = boundedInt(process.env.EVIDENCE_SAMPLER_MAX_ACTIVE_TOKENS, 500, 1, 2_000);
const outcomeWriteBatchSize = boundedInt(
  process.env.EVIDENCE_OUTCOME_WRITE_BATCH_SIZE,
  200,
  1,
  500
);
const maxPairConfirmations = boundedInt(
  process.env.EVIDENCE_SAMPLER_MAX_PAIR_CONFIRMATIONS,
  20,
  1,
  100
);
const terminalMissingSamples = boundedInt(
  process.env.EVIDENCE_SAMPLER_TERMINAL_MISSING_SAMPLES,
  3,
  2,
  10
);
const strategyVersion = process.env.ALPHA_STRATEGY_VERSION ?? "evidence-v1";
const roundTripCostPct = Number(process.env.MARKET_WATCH_PAPER_ROUND_TRIP_COST_PCT ?? 3);
const repository = new PostgresRepository(databaseUrl);
const dexScreener = new DexScreenerClient(process.env.DEXSCREENER_BASE_URL);
let stopping = false;

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

while (!stopping) {
  const startedAt = new Date();
  const cycleStartedAtMs = startedAt.getTime();
  try {
    const minObservedTime = new Date(startedAt.getTime() - 45 * 60 * 1000).toISOString();
    const initialReadStartedAtMs = Date.now();
    const entries = await repository.listWalletEntrySignals(
      undefined,
      strategyVersion,
      minObservedTime
    );
    const outcomes = await repository.listWalletSignalOutcomes(
      undefined,
      strategyVersion,
      minObservedTime
    );
    let databaseReadDurationMs = Date.now() - initialReadStartedAtMs;
    const matureFixedEntries = new Set(
      outcomes
        .filter(
          (outcome) => outcome.status === "mature" && outcome.exitStrategy === "fixed-horizon"
        )
        .map((outcome) => outcome.entryIdempotencyKey)
    );
    const outcomeStatusByLifecycleKey = new Map(
      outcomes.map((outcome) => [walletOutcomeLifecycleKey(outcome), outcome.status])
    );
    let ineligibleEntriesSkipped = 0;
    const activeEntries = entries.filter((entry) => {
      const ageMinutes = (startedAt.getTime() - new Date(entry.observedAt).getTime()) / 60_000;
      const eligible = isWalletEntryOutcomeEligible(entry);
      if (!eligible) ineligibleEntriesSkipped += 1;
      return eligible && !matureFixedEntries.has(entry.idempotencyKey) && ageMinutes <= 40;
    });
    const entriesByToken = new Map<string, typeof activeEntries>();
    for (const entry of activeEntries) {
      const tokenEntries = entriesByToken.get(entry.tokenAddress) ?? [];
      tokenEntries.push(entry);
      entriesByToken.set(entry.tokenAddress, tokenEntries);
    }
    const selectedEntriesByToken = new Map(
      [...entriesByToken.entries()]
        .sort(
          ([, a], [, b]) =>
            Math.min(...a.map((entry) => new Date(entry.observedAt).getTime())) -
            Math.min(...b.map((entry) => new Date(entry.observedAt).getTime()))
        )
        .slice(0, maxActiveTokens)
    );

    let observationsSaved = 0;
    let outcomesEvaluated = 0;
    let providerErrors = 0;
    let exactPoolMisses = 0;
    let pairConfirmationRequests = 0;
    let pairConfirmationErrors = 0;
    let pairConfirmationsDeferred = 0;
    let missingMarketObservationsSaved = 0;
    let terminalRugObservationsSaved = 0;
    let invalidPriceMarkets = 0;
    let activeMarkets = 0;
    let marketsSampled = 0;
    let outcomeTransitionsSaved = 0;
    let outcomesQueuedForPersistence = 0;
    let outcomeWriteBatches = 0;
    let databaseWriteDurationMs = 0;
    const pendingOutcomes: WalletSignalOutcomeEvidence[] = [];
    const queueOutcomeTransition = (outcome: WalletSignalOutcomeEvidence): void => {
      const lifecycleKey = walletOutcomeLifecycleKey(outcome);
      if (
        !shouldPersistOutcomeTransition(
          outcomeStatusByLifecycleKey.get(lifecycleKey),
          outcome.status
        )
      ) {
        return;
      }
      outcomeStatusByLifecycleKey.set(lifecycleKey, outcome.status);
      pendingOutcomes.push(outcome);
      outcomesQueuedForPersistence += 1;
    };
    const flushOutcomes = async (): Promise<void> => {
      while (pendingOutcomes.length >= outcomeWriteBatchSize) {
        const batch = pendingOutcomes.splice(0, outcomeWriteBatchSize);
        const writeStartedAtMs = Date.now();
        outcomeTransitionsSaved += await repository.saveWalletSignalOutcomes(batch);
        databaseWriteDurationMs += Date.now() - writeStartedAtMs;
        outcomeWriteBatches += 1;
      }
    };
    const pairsByToken = new Map<string, DexScreenerPair[]>();
    const tokenBatches = chunksOf([...selectedEntriesByToken.keys()], 30);
    const providerStartedAtMs = Date.now();
    await runWithConcurrency(tokenBatches, fetchConcurrency, async (tokenBatch) => {
      try {
        const pairs = await dexScreener.fetchTokenPairsBatch("solana", tokenBatch);
        for (const tokenAddress of tokenBatch) {
          pairsByToken.set(
            tokenAddress,
            pairs.filter(
              (pair) =>
                pair.baseToken?.address === tokenAddress ||
                pair.quoteToken?.address === tokenAddress
            )
          );
        }
      } catch (error) {
        providerErrors += 1;
        console.error(
          JSON.stringify({
            type: "evidence-price-provider-error",
            provider: "dexscreener",
            observedAt: new Date().toISOString(),
            tokenCount: tokenBatch.length,
            message: error instanceof Error ? error.message : String(error)
          })
        );
      }
    });
    const providerDurationMs = Date.now() - providerStartedAtMs;

    for (const [tokenAddress, tokenEntries] of selectedEntriesByToken) {
      const pairs = pairsByToken.get(tokenAddress) ?? [];
      const observedAtDate = new Date();
      const observedAt = observedAtDate.toISOString();
      const bucketStart = sampleBucketStart(observedAtDate, bucketSeconds);
      const marketGroups = groupEvidenceMarkets(tokenEntries);
      activeMarkets += marketGroups.length;
      const writtenObservationKeys = new Set<string>();
      // Active entries are at most 40 minutes old. Restricting this lookup to
      // the same evidence window prevents every cycle from loading the token's
      // entire retained price history. New observations are appended locally
      // after persistence so the outcome calculation sees this exact cycle.
      const historyReadStartedAtMs = Date.now();
      const history = await repository.listPriceObservations(
        tokenAddress,
        strategyVersion,
        minObservedTime
      );
      databaseReadDurationMs += Date.now() - historyReadStartedAtMs;
      for (const market of marketGroups) {
        let pair = selectEvidencePair(pairs, market.poolAddress);
        if (!pair && market.poolAddress) {
          exactPoolMisses += 1;
          if (pairConfirmationRequests >= maxPairConfirmations) {
            pairConfirmationsDeferred += 1;
            continue;
          }
          pairConfirmationRequests += 1;
          try {
            const exactPairs = await dexScreener.fetchPair("solana", market.poolAddress);
            pair = selectEvidencePair(exactPairs, market.poolAddress);
          } catch (error) {
            pairConfirmationErrors += 1;
            console.error(
              JSON.stringify({
                type: "evidence-exact-pair-confirmation-error",
                provider: "dexscreener",
                poolAddress: market.poolAddress,
                observedAt,
                message: error instanceof Error ? error.message : String(error)
              })
            );
            continue;
          }
          if (!pair) {
            const missing = classifyMissingExactPair(
              history,
              market.poolAddress,
              terminalMissingSamples
            );
            const signature = dexScreenerObservationSignature(
              market.poolAddress,
              tokenAddress,
              bucketStart
            );
            if (writtenObservationKeys.has(signature)) continue;
            writtenObservationKeys.add(signature);
            const observation = {
              idempotencyKey: createHash("sha256").update(signature).digest("hex"),
              chain: "solana" as const,
              tokenAddress,
              poolAddress: market.poolAddress,
              priceUsd: 0,
              liquidityUsd: 0,
              rugged: missing.rugged,
              signature,
              slot: Math.max(...market.entries.map((entry) => entry.slot), 0),
              provider: "dexscreener-exact-pair",
              observedAt,
              strategyVersion,
              raw: {
                source: "dexscreener-exact-pair-availability-v1",
                pairAddress: market.poolAddress,
                marketState: "pair-missing-confirmed",
                marketExecutable: false,
                missingStreak: missing.missingStreak,
                terminalMissingSamples,
                lastSellableObservedAt: missing.lastSellableObservedAt ?? null,
                lastSellablePriceUsd: missing.lastSellablePriceUsd ?? null,
                lastSellableLiquidityUsd: missing.lastSellableLiquidityUsd ?? null
              }
            };
            const writeStartedAtMs = Date.now();
            if (await repository.savePriceObservation(observation)) {
              observationsSaved += 1;
              missingMarketObservationsSaved += 1;
              if (observation.rugged) terminalRugObservationsSaved += 1;
            }
            databaseWriteDurationMs += Date.now() - writeStartedAtMs;
            history.push(observation);
            continue;
          }
        }
        if (!pair) {
          continue;
        }
        const priceUsd = Number(pair.priceUsd ?? 0);
        const liquidityUsd = pair.liquidity?.usd ?? 0;
        if (priceUsd <= 0 && liquidityUsd > 0) {
          invalidPriceMarkets += 1;
          continue;
        }
        marketsSampled += 1;
        const signature = dexScreenerObservationSignature(
          pair.pairAddress,
          tokenAddress,
          bucketStart
        );
        if (writtenObservationKeys.has(signature)) continue;
        writtenObservationKeys.add(signature);
        const observation = {
          idempotencyKey: createHash("sha256").update(signature).digest("hex"),
          chain: "solana" as const,
          tokenAddress,
          ...(pair.pairAddress ? { poolAddress: pair.pairAddress } : {}),
          priceUsd: Math.max(0, priceUsd),
          liquidityUsd,
          rugged: liquidityUsd <= 0,
          signature,
          slot: Math.max(...market.entries.map((entry) => entry.slot), 0),
          provider: "dexscreener",
          observedAt,
          strategyVersion,
          raw: {
            ...compactDexScreenerPair(pair),
            marketState: liquidityUsd <= 0 ? "liquidity-zero" : "live",
            marketExecutable: liquidityUsd > 0 && priceUsd > 0
          }
        };
        const writeStartedAtMs = Date.now();
        if (await repository.savePriceObservation(observation)) {
          observationsSaved += 1;
          if (observation.rugged) terminalRugObservationsSaved += 1;
        }
        databaseWriteDurationMs += Date.now() - writeStartedAtMs;
        history.push(observation);
      }
      for (const entry of tokenEntries) {
        queueOutcomeTransition(
          calculateWalletSignalOutcome(entry, history, observedAt, {
            horizonMinutes: 20,
            maxDelayMinutes: 20,
            estimatedRoundTripCostPct: roundTripCostPct,
            exitStrategy: "fixed-horizon"
          })
        );
        queueOutcomeTransition(
          calculateWalletSignalOutcome(entry, history, observedAt, {
            horizonMinutes: 20,
            maxDelayMinutes: 20,
            estimatedRoundTripCostPct: roundTripCostPct,
            exitStrategy: "tp15-sl20-20m"
          })
        );
        outcomesEvaluated += 2;
        await flushOutcomes();
      }
    }
    if (pendingOutcomes.length > 0) {
      const writeStartedAtMs = Date.now();
      outcomeTransitionsSaved += await repository.saveWalletSignalOutcomes(
        pendingOutcomes.splice(0, pendingOutcomes.length)
      );
      databaseWriteDurationMs += Date.now() - writeStartedAtMs;
      outcomeWriteBatches += 1;
    }

    console.log(
      JSON.stringify({
        type: "evidence-price-sampler",
        observedAt: new Date().toISOString(),
        activeEntries: activeEntries.length,
        ineligibleEntriesSkipped,
        activeTokens: entriesByToken.size,
        activeMarkets,
        tokensSampled: selectedEntriesByToken.size,
        tokensDeferred: entriesByToken.size - selectedEntriesByToken.size,
        marketsSampled,
        observationsSaved,
        outcomesEvaluated,
        outcomesQueuedForPersistence,
        outcomeTransitionsSaved,
        outcomeWriteBatches,
        outcomeWriteBatchSize,
        providerErrors,
        exactPoolMisses,
        pairConfirmationRequests,
        pairConfirmationErrors,
        pairConfirmationsDeferred,
        maxPairConfirmations,
        missingMarketObservationsSaved,
        terminalRugObservationsSaved,
        terminalMissingSamples,
        invalidPriceMarkets,
        providerRequests: tokenBatches.length + pairConfirmationRequests,
        providerDurationMs,
        databaseReadDurationMs,
        databaseWriteDurationMs,
        cycleDurationMs: Date.now() - cycleStartedAtMs,
        intervalSeconds,
        bucketSeconds
      })
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "evidence-price-sampler-error",
        observedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error)
      })
    );
  }

  await sleep(Math.max(0, intervalMs - (Date.now() - cycleStartedAtMs)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async (_, worker) => {
    for (let index = worker; index < items.length; index += concurrency) {
      await task(items[index]!);
    }
  });
  await Promise.all(workers);
}

function boundedInt(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  const parsed = Math.trunc(Number(value ?? fallback));
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}
