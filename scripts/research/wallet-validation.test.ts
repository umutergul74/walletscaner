import { describe, expect, it } from "vitest";
import {
  buildWalletDecision,
  evaluateWallet,
  type WalletEvidence,
  type WalletValidationInput
} from "./wallet-validation.js";

const candidateWallet: WalletValidationInput = {
  wallet: "candidate-wallet",
  walletScore: 84,
  walletConfidence: "high",
  tokenOutcomeCount: 5,
  matureSignalKeys: ["a", "b", "c", "d", "e"],
  avgTokenReturnPct: 14,
  worstTokenReturnPct: -18,
  tokenHitRate: 0.8,
  labels: ["net recent accumulator"]
};

describe("wallet validation", () => {
  it("rejects an attractive one-token wallet", () => {
    expect(
      evaluateWallet({
        ...candidateWallet,
        wallet: "one-token-wallet",
        walletScore: 72,
        walletConfidence: "early",
        tokenOutcomeCount: 1,
        avgTokenReturnPct: 35,
        worstTokenReturnPct: 0,
        tokenHitRate: 1
      })
    ).toBe("reject");
  });

  it("does not rank a one-outcome wallet above meaningful mature evidence", () => {
    const decision = buildWalletDecision(
      [
        {
          ...candidateWallet,
          wallet: "one-outcome",
          walletScore: 99,
          walletConfidence: "early",
          tokenOutcomeCount: 1
        },
        {
          ...candidateWallet,
          wallet: "four-outcome-risky",
          walletScore: 60,
          walletConfidence: "medium",
          tokenOutcomeCount: 4,
          avgTokenReturnPct: 5,
          worstTokenReturnPct: -22,
          tokenHitRate: 0.5,
          labels: ["fast churn seller"]
        }
      ],
      []
    );

    expect(decision.leadingWallet).toBe("four-outcome-risky");
    expect(decision.leadingWalletVerdict).toBe("reject");
    expect(decision.walletEvidence.map((wallet) => wallet.wallet)).not.toContain("one-outcome");
  });

  it("requires three consecutive candidate runs before validation", () => {
    const evidence = (
      persistenceRuns: number,
      signalKeys = candidateWallet.matureSignalKeys!
    ): WalletEvidence => ({
      wallet: candidateWallet.wallet,
      verdict: "candidate",
      walletScore: candidateWallet.walletScore,
      walletConfidence: candidateWallet.walletConfidence,
      tokenOutcomeCount: signalKeys.length,
      avgTokenReturnPct: candidateWallet.avgTokenReturnPct,
      worstTokenReturnPct: candidateWallet.worstTokenReturnPct,
      tokenHitRate: candidateWallet.tokenHitRate,
      persistenceRuns,
      watchPersistenceRuns: persistenceRuns,
      candidatePersistenceRuns: persistenceRuns,
      sampleGrowth: 0,
      signalKeys
    });

    const first = buildWalletDecision([candidateWallet], []);
    const second = buildWalletDecision([candidateWallet], [{ walletEvidence: [evidence(1)] }]);
    const third = buildWalletDecision(
      [
        {
          ...candidateWallet,
          tokenOutcomeCount: 6,
          matureSignalKeys: [...candidateWallet.matureSignalKeys!, "f"]
        }
      ],
      [{ walletEvidence: [evidence(1)] }, { walletEvidence: [evidence(2)] }]
    );

    expect(first.validatedWallet).toBeNull();
    expect(first.watchWallet).toBeNull();
    expect(second.validatedWallet).toBeNull();
    expect(second.watchWallet).toBe(candidateWallet.wallet);
    expect(third.validatedWallet).toBe(candidateWallet.wallet);
    expect(third.leadingWalletStreak).toBe(3);
    expect(third.leadingWalletSampleGrowth).toBe(1);
  });

  it("does not validate repeated runs without a new mature token outcome", () => {
    const evidence: WalletEvidence = {
      wallet: candidateWallet.wallet,
      verdict: "candidate",
      walletScore: candidateWallet.walletScore,
      walletConfidence: candidateWallet.walletConfidence,
      tokenOutcomeCount: candidateWallet.tokenOutcomeCount,
      avgTokenReturnPct: candidateWallet.avgTokenReturnPct,
      worstTokenReturnPct: candidateWallet.worstTokenReturnPct,
      tokenHitRate: candidateWallet.tokenHitRate,
      persistenceRuns: 1,
      watchPersistenceRuns: 1,
      candidatePersistenceRuns: 1,
      sampleGrowth: 0,
      signalKeys: candidateWallet.matureSignalKeys!
    };

    const decision = buildWalletDecision(
      [candidateWallet],
      [{ walletEvidence: [evidence] }, { walletEvidence: [{ ...evidence, persistenceRuns: 2 }] }]
    );

    expect(decision.leadingWalletStreak).toBe(3);
    expect(decision.leadingWalletSampleGrowth).toBe(0);
    expect(decision.validatedWallet).toBeNull();
  });

  it("resets persistence when a run loses wallet evidence", () => {
    const decision = buildWalletDecision(
      [candidateWallet],
      [
        {
          walletEvidence: [
            {
              wallet: candidateWallet.wallet,
              verdict: "candidate",
              walletScore: 84,
              walletConfidence: "high",
              tokenOutcomeCount: 5,
              avgTokenReturnPct: 14,
              worstTokenReturnPct: -18,
              tokenHitRate: 0.8,
              persistenceRuns: 1,
              watchPersistenceRuns: 1,
              candidatePersistenceRuns: 1,
              sampleGrowth: 0,
              signalKeys: candidateWallet.matureSignalKeys!
            }
          ]
        },
        { walletEvidence: [] }
      ]
    );

    expect(decision.leadingWalletStreak).toBe(1);
    expect(decision.watchWallet).toBeNull();
    expect(decision.validatedWallet).toBeNull();
  });
});
