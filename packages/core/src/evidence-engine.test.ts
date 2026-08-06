import { describe, expect, it } from "vitest";
import { MemoryRepository } from "@memecoin-alpha/db";
import type {
  PriceObservationEvidence,
  WalletEntrySignalEvidence,
  WalletSignalOutcomeEvidence
} from "@memecoin-alpha/shared";
import {
  assessFixedHorizonEvidence,
  buildExperimentCohorts,
  calculateWalletSignalOutcome,
  canonicalizeHistoricalPriceObservations,
  recordFirstWalletEntry,
  scoreWalletFromEvidence
} from "./evidence-engine";

describe("wallet evidence engine", () => {
  it("stores only the first observed wallet-token buy per strategy version", async () => {
    const repository = new MemoryRepository();
    const input = {
      chain: "solana" as const,
      walletAddress: "Wallet111",
      tokenAddress: "Mint111",
      observedEntryPriceUsd: 1,
      observedLiquidityUsd: 10_000,
      cohort: "repeat-wallet+controlled-flow",
      repeatWalletCount: 2,
      flowEvidence: { controlledFlow: true },
      signature: "sig-1",
      slot: 1,
      provider: "solana-rpc",
      observedAt: "2026-07-05T00:00:00.000Z",
      strategyVersion: "evidence-v1"
    };

    const first = await recordFirstWalletEntry(repository, input);
    const duplicate = await recordFirstWalletEntry(repository, {
      ...input,
      signature: "sig-2",
      slot: 2,
      observedAt: "2026-07-05T00:01:00.000Z"
    });

    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    expect(await repository.listWalletEntrySignals()).toHaveLength(1);
  });

  it("keeps pre-horizon values provisional and freezes the first 20-40 minute observation", () => {
    const entry = makeEntry();
    const observations = [
      makePrice("price-10", 10, 1.2),
      makePrice("price-22", 22, 1.5),
      makePrice("price-30", 30, 0.5)
    ];

    const provisional = calculateWalletSignalOutcome(
      entry,
      observations,
      "2026-07-05T00:15:00.000Z"
    );
    const mature = calculateWalletSignalOutcome(entry, observations, "2026-07-05T00:35:00.000Z");

    expect(provisional).toMatchObject({
      status: "provisional",
      outcomePriceUsd: 1.2
    });
    expect(provisional.frozenAt).toBeUndefined();
    expect(mature).toMatchObject({
      status: "mature",
      outcomePriceUsd: 1.5,
      grossReturnPct: 50,
      netReturnPct: 47,
      frozenAt: "2026-07-05T00:22:00.000Z"
    });
  });

  it("keeps rugs in mature performance as terminal losses", () => {
    const outcome = calculateWalletSignalOutcome(
      makeEntry(),
      [makePrice("rug", 8, 0, true)],
      "2026-07-05T00:25:00.000Z"
    );

    expect(outcome).toMatchObject({
      status: "mature",
      rugged: true,
      grossReturnPct: -100,
      netReturnPct: -103
    });
  });

  it("excludes provisional outcomes from wallet score and deduplicates cohort tokens", () => {
    const entry = makeEntry();
    const secondEntry = {
      ...entry,
      idempotencyKey: "entry-2",
      tokenAddress: "Mint222",
      observedAt: "2026-07-05T00:01:00.000Z"
    };
    const thirdEntry = {
      ...entry,
      idempotencyKey: "entry-3",
      tokenAddress: "Mint333",
      observedAt: "2026-07-05T00:02:00.000Z"
    };
    const duplicateMethodEntry = {
      ...entry,
      idempotencyKey: "entry-duplicate-method",
      cohort: "controlled-flow-control",
      repeatWalletCount: 0,
      observedAt: "2026-07-05T00:03:00.000Z"
    };
    const outcomes = [
      makeOutcome(entry.idempotencyKey, "mature", 7),
      {
        ...makeOutcome(secondEntry.idempotencyKey, "mature", -2),
        frozenAt: "2026-07-05T00:21:00.000Z"
      },
      makeOutcome(thirdEntry.idempotencyKey, "provisional", 500)
    ];

    const score = scoreWalletFromEvidence(
      entry.walletAddress,
      [entry, secondEntry, thirdEntry],
      outcomes
    );
    const cohorts = buildExperimentCohorts([entry, duplicateMethodEntry]);

    expect(score).toMatchObject({
      matureOutcomeCount: 2,
      provisionalOutcomeCount: 1,
      score: 0,
      confidence: "insufficient"
    });
    expect(cohorts.primary).toHaveLength(1);
    expect(cohorts.control).toHaveLength(0);
  });

  it("does not promote wallets with a losing median or one outsized winner", () => {
    const entries = [
      makeEntry(),
      makeEntry({ idempotencyKey: "entry-2", tokenAddress: "Mint222" }),
      makeEntry({ idempotencyKey: "entry-3", tokenAddress: "Mint333" }),
      makeEntry({ idempotencyKey: "entry-4", tokenAddress: "Mint444" })
    ];
    const outcomes = [
      makeOutcome("entry-1", "mature", 900),
      makeOutcome("entry-2", "mature", -3),
      makeOutcome("entry-3", "mature", -3),
      makeOutcome("entry-4", "mature", -87)
    ];

    expect(scoreWalletFromEvidence("Wallet111", entries, outcomes)).toMatchObject({
      averageNetReturnPct: 201.75,
      medianNetReturnPct: -3,
      hitRate: 0.25,
      worstNetReturnPct: -87,
      score: 0,
      confidence: "insufficient"
    });
  });

  it("promotes only robust wallet evidence with positive median and hit rate", () => {
    const entries = [
      makeEntry(),
      makeEntry({ idempotencyKey: "entry-2", tokenAddress: "Mint222" }),
      makeEntry({ idempotencyKey: "entry-3", tokenAddress: "Mint333" }),
      makeEntry({ idempotencyKey: "entry-4", tokenAddress: "Mint444" })
    ];
    const outcomes = [
      makeOutcome("entry-1", "mature", 3),
      makeOutcome("entry-2", "mature", 3),
      makeOutcome("entry-3", "mature", 3),
      makeOutcome("entry-4", "mature", 3)
    ];

    expect(scoreWalletFromEvidence("Wallet111", entries, outcomes)).toMatchObject({
      matureOutcomeCount: 4,
      averageNetReturnPct: 3,
      medianNetReturnPct: 3,
      hitRate: 1,
      worstNetReturnPct: 3,
      confidence: "candidate"
    });
  });

  it("scores only source-linked fixed-horizon outcomes", () => {
    const entry = makeEntry();
    const unlinkedEntry = { ...entry };
    delete unlinkedEntry.sourceSwapIdempotencyKey;
    const fixed = makeOutcome(entry.idempotencyKey, "mature", 7);
    const thresholdExit = {
      ...fixed,
      idempotencyKey: "threshold-exit",
      exitStrategy: "tp15-sl20-20m" as const,
      netReturnPct: 15
    };

    expect(
      scoreWalletFromEvidence(entry.walletAddress, [entry], [fixed, thresholdExit])
    ).toMatchObject({ matureOutcomeCount: 1, averageNetReturnPct: 7 });
    expect(scoreWalletFromEvidence(entry.walletAddress, [unlinkedEntry], [fixed])).toMatchObject({
      matureOutcomeCount: 0,
      confidence: "insufficient"
    });
  });

  it("retains an early terminal rug but rejects a normal pre-horizon freeze", () => {
    const entry = makeEntry();
    const outcome = {
      ...makeOutcome(entry.idempotencyKey, "mature", -103),
      frozenAt: "2026-07-05T00:10:00.000Z"
    };

    expect(assessFixedHorizonEvidence(entry, { ...outcome, rugged: true })).toMatchObject({
      canonical: true,
      reason: "terminal-rug-before-horizon"
    });
    expect(assessFixedHorizonEvidence(entry, { ...outcome, rugged: false })).toMatchObject({
      canonical: false,
      reason: "outside-window"
    });
  });

  it("consolidates multi-leg Helius prices per transaction and token", () => {
    const base = {
      ...makePrice("leg-1", 20, 10),
      signature: "shared-signature",
      provider: "helius-history",
      raw: {
        priceSource: "helius-transfer-derived",
        side: "buy",
        tokenAmount: 10,
        solAmount: 1,
        solUsdEstimate: 100
      }
    };
    const observations = canonicalizeHistoricalPriceObservations([
      base,
      {
        ...base,
        idempotencyKey: "leg-2",
        raw: {
          ...base.raw,
          tokenAmount: 15
        }
      }
    ]);

    expect(observations).toHaveLength(1);
    expect(observations[0]?.priceUsd).toBe(4);
    expect(observations[0]?.raw.consolidatedLegCount).toBe(2);
  });
});

function makeEntry(overrides: Partial<WalletEntrySignalEvidence> = {}): WalletEntrySignalEvidence {
  const base: WalletEntrySignalEvidence = {
    idempotencyKey: "entry-1",
    chain: "solana",
    walletAddress: "Wallet111",
    tokenAddress: "Mint111",
    sourceSwapIdempotencyKey: "swap-1",
    observedEntryPriceUsd: 1,
    observedLiquidityUsd: 10_000,
    cohort: "repeat-wallet+controlled-flow",
    repeatWalletCount: 2,
    flowEvidence: { controlledFlow: true },
    signature: "entry-sig",
    slot: 1,
    provider: "solana-rpc",
    observedAt: "2026-07-05T00:00:00.000Z",
    strategyVersion: "evidence-v1"
  };
  return { ...base, ...overrides };
}

function makePrice(
  idempotencyKey: string,
  minute: number,
  priceUsd: number,
  rugged = false
): PriceObservationEvidence {
  return {
    idempotencyKey,
    chain: "solana",
    tokenAddress: "Mint111",
    priceUsd,
    liquidityUsd: rugged ? 0 : 10_000,
    rugged,
    signature: idempotencyKey,
    slot: minute,
    provider: "dexscreener",
    observedAt: `2026-07-05T00:${String(minute).padStart(2, "0")}:00.000Z`,
    strategyVersion: "evidence-v1",
    raw: {}
  };
}

function makeOutcome(
  entryIdempotencyKey: string,
  status: WalletSignalOutcomeEvidence["status"],
  netReturnPct: number
): WalletSignalOutcomeEvidence {
  return {
    idempotencyKey: `${entryIdempotencyKey}:${status}`,
    entryIdempotencyKey,
    chain: "solana",
    horizonMinutes: 20,
    status,
    outcomePriceUsd: 1,
    frozenAt: "2026-07-05T00:20:00.000Z",
    grossReturnPct: netReturnPct + 3,
    netReturnPct,
    estimatedRoundTripCostPct: 3,
    exitStrategy: "fixed-horizon",
    rugged: false,
    signature: "sig",
    slot: 1,
    provider: "dexscreener",
    observedAt: "2026-07-05T00:20:00.000Z",
    strategyVersion: "evidence-v1",
    raw: {}
  };
}
