import "dotenv/config";
import { createHash } from "node:crypto";
import { DexScreenerClient } from "@memecoin-alpha/providers";
import type { DexScreenerPair } from "@memecoin-alpha/providers";
import { PostgresRepository } from "@memecoin-alpha/db";
import { evaluateAndSaveWalletOutcome } from "@memecoin-alpha/core";
import {
  chunksOf,
  compactDexScreenerPair,
  dexScreenerObservationSignature,
  sampleBucketStart
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
  try {
    const minObservedTime = new Date(startedAt.getTime() - 45 * 60 * 1000).toISOString();
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
    const matureFixedEntries = new Set(
      outcomes
        .filter(
          (outcome) => outcome.status === "mature" && outcome.exitStrategy === "fixed-horizon"
        )
        .map((outcome) => outcome.entryIdempotencyKey)
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
    const pairsByToken = new Map<string, DexScreenerPair[]>();
    const tokenBatches = chunksOf([...selectedEntriesByToken.keys()], 30);
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

    for (const [tokenAddress, tokenEntries] of selectedEntriesByToken) {
      const pairs = pairsByToken.get(tokenAddress) ?? [];
      const preferredPool = tokenEntries.find((entry) => entry.poolAddress)?.poolAddress;
      const pair =
        pairs.find((candidate) => candidate.pairAddress === preferredPool) ??
        [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      const priceUsd = Number(pair?.priceUsd ?? 0);
      if (!pair || priceUsd <= 0) continue;

      const observedAtDate = new Date();
      const observedAt = observedAtDate.toISOString();
      const bucketStart = sampleBucketStart(observedAtDate, bucketSeconds);
      const signature = dexScreenerObservationSignature(
        pair.pairAddress,
        tokenAddress,
        bucketStart
      );
      const observation = {
        idempotencyKey: createHash("sha256").update(signature).digest("hex"),
        chain: "solana" as const,
        tokenAddress,
        ...(pair.pairAddress ? { poolAddress: pair.pairAddress } : {}),
        priceUsd,
        liquidityUsd: pair.liquidity?.usd ?? 0,
        rugged: false,
        signature,
        slot: Math.max(...tokenEntries.map((entry) => entry.slot), 0),
        provider: "dexscreener",
        observedAt,
        strategyVersion,
        raw: compactDexScreenerPair(pair)
      };
      if (await repository.savePriceObservation(observation)) {
        observationsSaved += 1;
      }
      // Active entries are at most 40 minutes old. Restricting this lookup to
      // the same evidence window prevents every 30-second cycle from loading
      // the token's entire retained price history.
      const history = await repository.listPriceObservations(
        tokenAddress,
        strategyVersion,
        minObservedTime
      );
      for (const entry of tokenEntries) {
        await evaluateAndSaveWalletOutcome(repository, entry, history, observedAt, {
          horizonMinutes: 20,
          maxDelayMinutes: 20,
          estimatedRoundTripCostPct: roundTripCostPct,
          exitStrategy: "fixed-horizon"
        });
        await evaluateAndSaveWalletOutcome(repository, entry, history, observedAt, {
          horizonMinutes: 20,
          maxDelayMinutes: 20,
          estimatedRoundTripCostPct: roundTripCostPct,
          exitStrategy: "tp15-sl20-20m"
        });
        outcomesEvaluated += 2;
      }
    }

    console.log(
      JSON.stringify({
        type: "evidence-price-sampler",
        observedAt: new Date().toISOString(),
        activeEntries: activeEntries.length,
        ineligibleEntriesSkipped,
        activeTokens: entriesByToken.size,
        tokensSampled: selectedEntriesByToken.size,
        tokensDeferred: entriesByToken.size - selectedEntriesByToken.size,
        observationsSaved,
        outcomesEvaluated,
        providerErrors,
        providerRequests: tokenBatches.length,
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

  await sleep(intervalMs);
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
