import "dotenv/config";
import { hostname } from "node:os";
import pg from "pg";
import { loadRuntimeConfig } from "@memecoin-alpha/config";
import { ALPHA_DECISION_TAPE_VERSION, AlphaDecisionTapeStore } from "@memecoin-alpha/db";
import { DexScreenerClient, JupiterQuoteClient, PythPriceClient } from "@memecoin-alpha/providers";
import { collectAlphaDecisionCheckpoint } from "./alpha-decision-checkpoint.js";

const wrappedSolMint = "So11111111111111111111111111111111111111112";
const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const config = loadRuntimeConfig();
if (!config.alphaDecisionTape.enabled) {
  throw new Error("ALPHA_DECISION_TAPE_ENABLED=true is required to start this isolated worker.");
}
if (!config.alphaDecisionTape.jupiterApiKey) {
  throw new Error(
    "JUPITER_API_KEY is required before future executable quote evidence can be collected."
  );
}

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 2 });
const store = new AlphaDecisionTapeStore(pool);
const marketClient = new DexScreenerClient(config.dexscreener.baseUrl);
const quoteClient = new JupiterQuoteClient(
  config.alphaDecisionTape.jupiterApiKey,
  config.alphaDecisionTape.jupiterApiUrl,
  fetch,
  5_000
);
const pyth = new PythPriceClient({
  hermesUrl: config.quotePrices.pythHermesUrl,
  benchmarksUrl: config.quotePrices.pythBenchmarksUrl,
  ...(config.quotePrices.pythApiKey ? { apiKey: config.quotePrices.pythApiKey } : {}),
  maxStalenessSeconds: config.quotePrices.maxStalenessSeconds
});
const workerId = `${hostname()}:${process.pid}:alpha-decision-tape`;
const pollIntervalMs = config.alphaDecisionTape.pollIntervalMs;
const seedIntervalMs = config.alphaDecisionTape.seedIntervalSeconds * 1_000;
const healthIntervalMs = config.alphaDecisionTape.healthIntervalSeconds * 1_000;
let lastSeedAt = 0;
let lastHealthAt = 0;
let stopping = false;
let cachedSolUsd: { price: number; expiresAt: number } | undefined;

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

while (!stopping) {
  const cycleStartedAt = Date.now();
  let seeded = 0;
  let eligibleSeeded = 0;
  let claimed = 0;
  let completed = 0;
  let failed = 0;
  try {
    if (cycleStartedAt - lastSeedAt >= seedIntervalMs) {
      const result = await store.seedFutureDecisions();
      seeded = result.inserted;
      eligibleSeeded = result.researchEligible;
      lastSeedAt = cycleStartedAt;
      if (result.hasMore && result.dailyCapacityRemaining === 0) {
        console.warn(
          JSON.stringify({
            type: "alpha-decision-tape-daily-capacity",
            strategyVersion: ALPHA_DECISION_TAPE_VERSION,
            inspected: result.inspected,
            dailyCapacityRemaining: result.dailyCapacityRemaining,
            coverageComplete: false
          })
        );
      }
    }

    const claims = await store.claimDueCheckpoints({
      workerId,
      limit: 2,
      leaseSeconds: 90
    });
    claimed = claims.length;
    for (const claim of claims) {
      try {
        const observation = await collectAlphaDecisionCheckpoint(claim, {
          marketClient,
          quoteClient,
          quoteUsdPrice,
          measureFlow: (decisionId, observedAt) => store.measureFlow(decisionId, observedAt),
          slippageBps: 400
        });
        if (!(await store.completeCheckpoint(claim, workerId, observation))) {
          throw new Error("Checkpoint lease was lost before atomic completion.");
        }
        completed += 1;
      } catch (error) {
        failed += 1;
        const status = await store.failCheckpoint(claim, workerId, safeError(error), {
          retrySeconds: retryDelaySeconds(claim.attemptCount),
          maximumAttempts: 6
        });
        console.error(
          JSON.stringify({
            type: "alpha-decision-checkpoint-error",
            checkpointId: claim.checkpointId,
            decisionId: claim.decisionId,
            horizonSeconds: claim.horizonSeconds,
            attemptCount: claim.attemptCount,
            failureStatus: status,
            message: safeError(error)
          })
        );
      }
    }

    if (cycleStartedAt - lastHealthAt >= healthIntervalMs) {
      console.log(
        JSON.stringify({
          type: "alpha-decision-tape-health",
          workerId,
          strategyVersion: ALPHA_DECISION_TAPE_VERSION,
          seeded,
          eligibleSeeded,
          claimed,
          completed,
          failed,
          cycleDurationMs: Date.now() - cycleStartedAt,
          ...(await store.getSummary())
        })
      );
      lastHealthAt = cycleStartedAt;
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        type: "alpha-decision-tape-cycle-error",
        workerId,
        strategyVersion: ALPHA_DECISION_TAPE_VERSION,
        message: safeError(error)
      })
    );
  }
  await sleep(Math.max(0, pollIntervalMs - (Date.now() - cycleStartedAt)));
}

await pool.end();

async function quoteUsdPrice(mint: string): Promise<number> {
  if (mint === usdcMint) return 1;
  if (mint !== wrappedSolMint) throw new Error("Quote mint is unsupported by tape v1.");
  if (cachedSolUsd && cachedSolUsd.expiresAt > Date.now()) return cachedSolUsd.price;
  const quote = await pyth.latest(config.quotePrices.solUsdFeedId);
  if (quote.confidenceRatio > 0.01) {
    throw new Error("Pyth SOL/USD confidence interval exceeds 1%.");
  }
  cachedSolUsd = { price: quote.priceUsd, expiresAt: Date.now() + 15_000 };
  return quote.priceUsd;
}

function retryDelaySeconds(attemptCount: number): number {
  return Math.min(900, 15 * 2 ** Math.min(5, Math.max(0, attemptCount - 1)));
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1024) : String(error).slice(0, 1024);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
