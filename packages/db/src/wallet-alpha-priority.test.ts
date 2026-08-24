import { describe, expect, it } from "vitest";
import type { WalletEntrySignalEvidence } from "@memecoin-alpha/shared";
import { classifyWalletAlphaEntryWork } from "./repository";

describe("wallet-alpha entry work classification", () => {
  it("reserves priority 2 for fully proven signal-relevant entries", () => {
    expect(classifyWalletAlphaEntryWork(entry())).toEqual({
      priority: 2,
      reason: "risk-passed-source-entry"
    });
  });

  const blockedCases: Array<[string, (subject: WalletEntrySignalEvidence) => void]> = [
    ["missing source", (subject) => delete subject.sourceSwapIdempotencyKey],
    [
      "uncontrolled flow",
      (subject) => {
        subject.flowEvidence = { tokenRiskKnown: true, tokenRiskPassed: true };
      }
    ],
    [
      "unknown risk",
      (subject) => {
        subject.flowEvidence = {
          controlledFlow: true,
          tokenRiskKnown: false,
          tokenRiskPassed: false
        };
      }
    ],
    [
      "failed risk",
      (subject) => {
        subject.flowEvidence = {
          controlledFlow: true,
          tokenRiskKnown: true,
          tokenRiskPassed: false
        };
      }
    ],
    [
      "excluded cohort",
      (subject) => {
        subject.cohort = "excluded-uncontrolled-flow";
      }
    ]
  ];

  it.each(blockedCases)("keeps %s out of the signal lane", (_case, mutate) => {
    const subject = entry();
    mutate(subject);
    expect(classifyWalletAlphaEntryWork(subject)).toEqual({
      priority: 1,
      reason: "entry-evidence"
    });
  });
});

function entry(): WalletEntrySignalEvidence {
  return {
    idempotencyKey: "priority-entry",
    chain: "solana",
    walletAddress: "PriorityWallet",
    tokenAddress: "PriorityMint",
    poolAddress: "PriorityPool",
    sourceSwapIdempotencyKey: "priority-swap",
    observedEntryPriceUsd: 1,
    observedLiquidityUsd: 25_000,
    cohort: "controlled-flow-control",
    repeatWalletCount: 1,
    flowEvidence: {
      controlledFlow: true,
      tokenRiskKnown: true,
      tokenRiskPassed: true
    },
    signature: "priority-signature",
    slot: 1,
    provider: "test",
    observedAt: "2026-08-24T00:00:00.000Z",
    strategyVersion: "evidence-v1"
  };
}
