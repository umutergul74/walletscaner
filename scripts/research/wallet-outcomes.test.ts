import { describe, expect, it } from "vitest";
import { calculateWalletSignalOutcomes } from "./wallet-outcomes.js";

describe("wallet entry outcomes", () => {
  it("measures from the observed wallet entry rather than the token's earlier price", () => {
    const outcomes = calculateWalletSignalOutcomes(
      [
        {
          tokenAddress: "token-a",
          observedAt: "2026-07-04T12:00:00.000Z",
          observedEntryPriceUsd: 2,
          observedLiquidityUsd: 50_000
        }
      ],
      new Map([
        [
          "token-a",
          [
            { observedAt: "2026-07-04T12:00:00.000Z", priceUsd: 2 },
            { observedAt: "2026-07-04T12:22:00.000Z", priceUsd: 3 }
          ]
        ]
      ]),
      "2026-07-04T12:30:00.000Z"
    );

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.returnPct).toBe(50);
    expect(outcomes[0]?.mature).toBe(true);
    expect(outcomes[0]?.status).toBe("mature");
  });

  it("keeps the earliest observed entry per token", () => {
    const outcomes = calculateWalletSignalOutcomes(
      [
        {
          tokenAddress: "token-a",
          observedAt: "2026-07-04T12:05:00.000Z",
          observedEntryPriceUsd: 3,
          observedLiquidityUsd: 60_000
        },
        {
          tokenAddress: "token-a",
          observedAt: "2026-07-04T12:00:00.000Z",
          observedEntryPriceUsd: 2,
          observedLiquidityUsd: 50_000
        }
      ],
      new Map([
        [
          "token-a",
          [
            { observedAt: "2026-07-04T12:00:00.000Z", priceUsd: 2 },
            { observedAt: "2026-07-04T12:22:00.000Z", priceUsd: 3 }
          ]
        ]
      ]),
      "2026-07-04T12:30:00.000Z"
    );

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.observedEntryPriceUsd).toBe(2);
    expect(outcomes[0]?.returnPct).toBe(50);
  });

  it("keeps young outcomes provisional even when they spike", () => {
    const outcomes = calculateWalletSignalOutcomes(
      [
        {
          tokenAddress: "token-a",
          observedAt: "2026-07-04T12:00:00.000Z",
          observedEntryPriceUsd: 2,
          observedLiquidityUsd: 50_000
        }
      ],
      new Map([
        [
          "token-a",
          [
            { observedAt: "2026-07-04T12:00:00.000Z", priceUsd: 2 },
            { observedAt: "2026-07-04T12:05:00.000Z", priceUsd: 4 }
          ]
        ]
      ]),
      "2026-07-04T12:05:00.000Z"
    );

    expect(outcomes[0]?.returnPct).toBe(100);
    expect(outcomes[0]?.ageMinutes).toBe(5);
    expect(outcomes[0]?.mature).toBe(false);
    expect(outcomes[0]?.status).toBe("provisional");
  });

  it("keeps missed horizon observations out of provisional outcomes", () => {
    const outcomes = calculateWalletSignalOutcomes(
      [
        {
          tokenAddress: "token-a",
          observedAt: "2026-07-04T12:00:00.000Z",
          observedEntryPriceUsd: 2,
          observedLiquidityUsd: 50_000
        }
      ],
      new Map([
        [
          "token-a",
          [
            { observedAt: "2026-07-04T12:00:00.000Z", priceUsd: 2 },
            { observedAt: "2026-07-04T12:05:00.000Z", priceUsd: 4 }
          ]
        ]
      ]),
      "2026-07-04T12:45:00.000Z"
    );

    expect(outcomes[0]?.mature).toBe(false);
    expect(outcomes[0]?.status).toBe("unresolved");
  });
});
