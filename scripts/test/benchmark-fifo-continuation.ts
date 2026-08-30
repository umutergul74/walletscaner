import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { WalletTradeEvidence } from "@memecoin-alpha/shared";
import { advanceWalletLedger, buildWalletLedger } from "@memecoin-alpha/core";

// Generated CPU/state-volume regression only: not a production or profitability validation.
function trades(roundTrips: number, offset = 0): WalletTradeEvidence[] {
  return Array.from({ length: roundTrips * 3 }, (_, index) => {
    const sequence = index + offset;
    const buy = sequence % 3 === 0;
    return {
      idempotencyKey: `event-${sequence}`,
      chain: "solana",
      strategyVersion: "fixture",
      walletAddress: "Wallet",
      tokenAddress: `Token-${Math.floor(sequence / 3) % 20}`,
      signature: `signature-${sequence}`,
      slot: sequence + 1,
      observedAt: new Date(Date.UTC(2026, 7, 1) + sequence * 1000).toISOString(),
      provider: "generated",
      side: buy ? "buy" : "sell",
      baseAmount: buy ? 2 : 1,
      baseTokenAmount: { rawAmount: buy ? "2000000" : "1000000", decimals: 6 },
      quoteValueUsd: buy ? 2 : 1.1,
      poolAgeMinutes: 5,
      dataQuality: "oracle-converted",
      raw: {}
    };
  });
}

const history = trades(3_000);
const suffix = trades(40, history.length);
const before = performance.now();
const seed = advanceWalletLedger(history);
const seedMs = performance.now() - before;
const fullStart = performance.now();
const full = buildWalletLedger([...history, ...suffix]);
const fullMs = performance.now() - fullStart;
const incrementalStart = performance.now();
const incremental = advanceWalletLedger(suffix, seed.checkpoint);
const incrementalMs = performance.now() - incrementalStart;
const byId = <T extends { episodeId: string }>(values: T[]) =>
  [...values].sort((a, b) => a.episodeId.localeCompare(b.episodeId));
assert.deepEqual(
  byId([...seed.ledger.realizedEpisodes, ...incremental.ledger.realizedEpisodes]),
  byId(full.realizedEpisodes)
);
assert.deepEqual(incremental.ledger.openInventory, full.openInventory);
const episodes = new Map([
  ...seed.ledger.positionEpisodes.map((p) => [p.episodeId, p] as const),
  ...incremental.ledger.positionEpisodes.map((p) => [p.episodeId, p] as const)
]);
assert.deepEqual(byId([...episodes.values()]), byId(full.positionEpisodes));
console.log(
  JSON.stringify({
    type: "fifo-continuation-generated-benchmark",
    sourceTrades: history.length,
    suffixTrades: suffix.length,
    settledPartialSales: seed.ledger.realizedEpisodes.length,
    checkpointBytes: Buffer.byteLength(seed.checkpoint.payload),
    seedMs,
    fullReplayMs: fullMs,
    incrementalMs,
    peakRssMiB: process.resourceUsage().maxRSS / 1024,
    parity: "exact",
    productionValidated: false
  })
);
