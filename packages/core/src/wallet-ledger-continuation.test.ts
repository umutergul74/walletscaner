import { describe, expect, it } from "vitest";
import type { WalletTradeEvidence } from "@memecoin-alpha/shared";
import {
  advanceWalletLedger,
  buildWalletLedger,
  buildWalletAlphaScores,
  walletLedgerCheckpointOrder,
  type WalletLedger
} from "./wallet-alpha-engine";

function trade(
  index: number,
  side: "buy" | "sell",
  raw: string,
  usd: number,
  token = "Token",
  quality: WalletTradeEvidence["dataQuality"] = "oracle-converted"
): WalletTradeEvidence {
  return {
    idempotencyKey: `trade-${index}`,
    chain: "solana",
    strategyVersion: "evidence-v1",
    walletAddress: "Wallet",
    tokenAddress: token,
    poolAddress: `pool-${token}`,
    side,
    baseAmount: Number(raw) / 1e6,
    baseTokenAmount: { rawAmount: raw, decimals: 6 },
    quoteValueUsd: usd,
    dataQuality: quality,
    poolAgeMinutes: 5,
    signature: `sig-${index}`,
    slot: 100 + index,
    observedAt: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(),
    provider: "fixture",
    raw: { verboseProviderPayload: "x".repeat(8192) }
  };
}

const fixture = () => [
  trade(1, "sell", "1000000", 10), // unmatched pre-buy sell
  trade(2, "buy", "100000000", 100),
  trade(3, "buy", "50000000", 80, "Other"),
  trade(4, "sell", "40000000", 75), // partial realization before cutoff
  trade(5, "buy", "50000000", 45),
  trade(6, "sell", "60000000", 110, "Token", "price-proxy"),
  trade(7, "sell", "50000000", 110, "Other"),
  trade(8, "sell", "50000000", 65), // closes first Token round trip
  trade(9, "buy", "20000000", 20), // reopened round trip must retain ordinal/id
  trade(10, "sell", "5000000", 8),
  trade(11, "buy", "8000000", 5, "Third"),
  trade(12, "sell", "3000000", 4, "Third")
];

function mergeDeltas(ledgers: WalletLedger[]): WalletLedger {
  const episodes = new Map(
    ledgers.flatMap((l) => l.positionEpisodes.map((p) => [p.episodeId, p] as const))
  );
  const lots = new Map(ledgers.flatMap((l) => l.positionLots.map((p) => [p.lotId, p] as const)));
  return {
    realizedEpisodes: ledgers.flatMap((l) => l.realizedEpisodes),
    openInventory: ledgers.at(-1)!.openInventory,
    positionEpisodes: [...episodes.values()],
    positionLots: [...lots.values()]
  };
}

function normalized(ledger: WalletLedger) {
  return {
    realizedEpisodes: [...ledger.realizedEpisodes].sort((a, b) =>
      a.episodeId.localeCompare(b.episodeId)
    ),
    openInventory: [...ledger.openInventory].sort((a, b) =>
      a.tokenAddress.localeCompare(b.tokenAddress)
    ),
    positionEpisodes: [...ledger.positionEpisodes].sort((a, b) =>
      a.episodeId.localeCompare(b.episodeId)
    ),
    positionLots: [...ledger.positionLots].sort((a, b) => a.lotId.localeCompare(b.lotId))
  };
}

describe("bounded FIFO continuation (not yet a production reader)", () => {
  it("preserves complete scores from sale facts/open inventory without historical trade rows", () => {
    const values = fixture();
    const first = advanceWalletLedger(values.slice(0, 6));
    const next = advanceWalletLedger(values.slice(6), first.checkpoint);
    const ledger = normalized(mergeDeltas([first.ledger, next.ledger]));
    const common = {
      entries: [],
      outcomes: [],
      strategyVersion: "evidence-v1",
      calculatedAt: "2026-08-02T00:00:00.000Z"
    };
    const expected = buildWalletAlphaScores({ ...common, trades: values });
    expect(
      buildWalletAlphaScores({
        ...common,
        trades: [],
        prebuiltLedgers: new Map([["Wallet", ledger]])
      })
    ).toEqual(expected);
  });
  it("matches the unchanged full ledger at every split, including partial sells and reopen", () => {
    const trades = fixture();
    const full = normalized(buildWalletLedger(trades));
    for (let split = 1; split < trades.length; split += 1) {
      const first = advanceWalletLedger(trades.slice(0, split));
      const second = advanceWalletLedger(
        trades.slice(split),
        JSON.parse(JSON.stringify(first.checkpoint))
      );
      expect(normalized(mergeDeltas([first.ledger, second.ledger])), `split${split}`).toEqual(full);
    }
  });

  it("matches full rebuild when every trade is a restart boundary", () => {
    const trades = fixture();
    let checkpoint;
    const parts: WalletLedger[] = [];
    for (const value of trades) {
      const next = advanceWalletLedger([value], checkpoint);
      checkpoint = JSON.parse(JSON.stringify(next.checkpoint));
      parts.push(next.ledger);
    }
    expect(normalized(mergeDeltas(parts))).toEqual(normalized(buildWalletLedger(trades)));
  });

  it("does not collapse two partial-sales into one profitability sample", () => {
    const first = advanceWalletLedger(fixture().slice(0, 4));
    const next = advanceWalletLedger(fixture().slice(4, 6), first.checkpoint);
    expect(first.ledger.realizedEpisodes).toHaveLength(1);
    expect(next.ledger.realizedEpisodes).toHaveLength(1);
    expect(next.ledger.positionEpisodes.filter((e) => e.tokenAddress === "Token")).toHaveLength(1);
    expect(
      next.ledger.openInventory.find((e) => e.tokenAddress === "Token")?.remainingBaseAmount
        .rawAmount
    ).toBe("50000000");
  });

  it("retains exact raw quantity beyond JS safe integers across checkpoint serialization", () => {
    const trades = [
      trade(1, "buy", "9007199254740993", 100),
      trade(2, "sell", "9007199254740992", 120),
      trade(3, "sell", "1", 0.001)
    ];
    const first = advanceWalletLedger(trades.slice(0, 2));
    expect(first.ledger.openInventory[0]!.remainingBaseAmount.rawAmount).toBe("1");
    const next = advanceWalletLedger(trades.slice(2), first.checkpoint);
    expect(normalized(mergeDeltas([first.ledger, next.ledger]))).toEqual(
      normalized(buildWalletLedger(trades))
    );
  });

  it("is duplicate/order invariant within a batch and retry deterministic from the same checkpoint", () => {
    const values = fixture();
    const first = advanceWalletLedger(values.slice(0, 5));
    const original = JSON.stringify(first.checkpoint);
    const suffix = values.slice(5);
    const next = advanceWalletLedger(suffix, first.checkpoint);
    expect(advanceWalletLedger([...suffix, ...suffix].reverse(), first.checkpoint)).toEqual(next);
    expect(JSON.stringify(first.checkpoint)).toBe(original);
    expect(advanceWalletLedger(suffix, first.checkpoint)).toEqual(next);
  });

  it("uses PostgreSQL C/code-unit ordering instead of host locale ordering", () => {
    const firstTrade = {
      ...trade(1, "buy", "1000000", 1),
      idempotencyKey: "z-first",
      signature: "Z-signature",
      slot: 500,
      observedAt: "2026-08-01T00:00:00.000Z"
    };
    const secondTrade = {
      ...trade(2, "sell", "1000000", 2),
      idempotencyKey: "A-second",
      signature: "a-signature",
      slot: 500,
      observedAt: "2026-08-01T00:00:00.000Z"
    };
    // Many host locales place lowercase before uppercase even though PostgreSQL COLLATE "C"
    // and JavaScript code-unit order place "Z" before "a".
    const first = advanceWalletLedger([firstTrade]);
    const second = advanceWalletLedger([secondTrade], first.checkpoint);
    expect(normalized(mergeDeltas([first.ledger, second.ledger]))).toEqual(
      normalized(buildWalletLedger([secondTrade, firstTrade]))
    );
  });

  it("rejects late arrivals or historical corrections instead of silently skipping them", () => {
    const values = fixture();
    const first = advanceWalletLedger(values.slice(0, 5));
    expect(() => advanceWalletLedger([values[3]!], first.checkpoint)).toThrow(/requires rebuild/);
    expect(() =>
      advanceWalletLedger([{ ...values[3]!, quoteValueUsd: 999 }], first.checkpoint)
    ).toThrow(/requires rebuild/);
  });

  it("rejects changed precision that would alter old ledger quantities", () => {
    const first = advanceWalletLedger([trade(1, "buy", "1000000", 1)]);
    const suffix = {
      ...trade(2, "sell", "1000000", 2),
      baseTokenAmount: { rawAmount: "10000000", decimals: 7 }
    };
    expect(() => advanceWalletLedger([suffix], first.checkpoint)).toThrow(
      /changed token precision/
    );
  });

  it("retains invalid first-entry and pre-buy ordering decisions", () => {
    const values = [
      { ...trade(1, "buy", "1000000", 1), poolAgeMinutes: 90 },
      trade(2, "buy", "1000000", 1),
      trade(3, "sell", "2000000", 10)
    ];
    const first = advanceWalletLedger(values.slice(0, 1));
    const next = advanceWalletLedger(values.slice(1), first.checkpoint);
    expect(normalized(mergeDeltas([first.ledger, next.ledger]))).toEqual(
      normalized(buildWalletLedger(values))
    );
    expect(next.ledger.realizedEpisodes).toHaveLength(0);
  });

  it("emits no duplicate realized history on an empty continuation", () => {
    const first = advanceWalletLedger(fixture());
    const next = advanceWalletLedger([], first.checkpoint);
    expect(next.checkpoint).toEqual(first.checkpoint);
    expect(next.ledger.realizedEpisodes).toEqual([]);
    expect(next.ledger.openInventory).toEqual(first.ledger.openInventory);
  });

  it("exposes only an integrity-checked continuation boundary", () => {
    const first = advanceWalletLedger(fixture().slice(0, 5));
    expect(walletLedgerCheckpointOrder(first.checkpoint)).toMatchObject({
      slot: 105,
      idempotencyKey: "trade-5"
    });
    expect(() =>
      walletLedgerCheckpointOrder({
        ...first.checkpoint,
        payload: first.checkpoint.payload.replace("trade-5", "trade-X")
      })
    ).toThrow(/integrity/);
  });

  it("omits provider payloads and consumed lots from the retained state", () => {
    const first = advanceWalletLedger(fixture().slice(0, 8));
    expect(first.checkpoint.payload).not.toContain("verboseProviderPayload");
    expect(
      JSON.parse(first.checkpoint.payload).markets.every(
        (m: { lots: unknown[] }) => m.lots.length === 0
      )
    ).toBe(true);
    expect(Buffer.byteLength(first.checkpoint.payload)).toBeLessThan(3000);
  });

  it("fails closed for scope, policy or integrity mismatch", () => {
    const first = advanceWalletLedger([trade(1, "buy", "1000000", 1)]);
    expect(() =>
      advanceWalletLedger([trade(2, "sell", "1000000", 2)], first.checkpoint, 4)
    ).toThrow(/policy mismatch/);
    expect(() =>
      advanceWalletLedger(
        [{ ...trade(2, "sell", "1000000", 2), walletAddress: "Other" }],
        first.checkpoint
      )
    ).toThrow(/scope mismatch/);
    expect(() =>
      advanceWalletLedger([], { ...first.checkpoint, payload: first.checkpoint.payload + " " })
    ).toThrow(/integrity/);
    expect(() => advanceWalletLedger([])).toThrow(/scope/);
  });

  it("enforces bounded input and inventory cardinality", () => {
    expect(() =>
      advanceWalletLedger(Array.from({ length: 10001 }, () => trade(1, "buy", "1", 1)))
    ).toThrow(/trade budget/);
    expect(() =>
      advanceWalletLedger(
        Array.from({ length: 2001 }, (_, i) => trade(i, "buy", "1", 1, `Token${i}`))
      )
    ).toThrow(/inventory budget/);
  });
});
