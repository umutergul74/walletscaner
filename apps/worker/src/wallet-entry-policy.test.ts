import { describe, expect, it } from "vitest";
import {
  isWalletEntryOutcomeEligible,
  walletEntryMaterializationDecision
} from "./wallet-entry-policy";

describe("wallet entry materialization policy", () => {
  it("materializes only controlled-flow entries that passed complete risk evidence", () => {
    expect(
      walletEntryMaterializationDecision({
        controlledFlow: true,
        tokenRiskKnown: true,
        tokenRiskPassed: true
      })
    ).toBe("materialize");
    expect(
      walletEntryMaterializationDecision({
        controlledFlow: false,
        tokenRiskKnown: true,
        tokenRiskPassed: true
      })
    ).toBe("skip-uncontrolled-flow");
    expect(
      walletEntryMaterializationDecision({
        controlledFlow: true,
        tokenRiskKnown: false,
        tokenRiskPassed: false
      })
    ).toBe("defer-unknown-risk");
    expect(
      walletEntryMaterializationDecision({
        controlledFlow: true,
        tokenRiskKnown: true,
        tokenRiskPassed: false
      })
    ).toBe("skip-failed-risk");
  });

  it("blocks outcome sampling for legacy excluded or risk-failed entries", () => {
    expect(
      isWalletEntryOutcomeEligible({
        cohort: "controlled-flow-control",
        flowEvidence: {
          controlledFlow: true,
          tokenRiskKnown: true,
          tokenRiskPassed: true
        }
      })
    ).toBe(true);
    expect(
      isWalletEntryOutcomeEligible({
        cohort: "controlled-flow-control",
        flowEvidence: {
          controlledFlow: true,
          tokenRiskKnown: true,
          tokenRiskPassed: false
        }
      })
    ).toBe(false);
    expect(
      isWalletEntryOutcomeEligible({
        cohort: "excluded-uncontrolled-flow",
        flowEvidence: {
          controlledFlow: true,
          tokenRiskKnown: true,
          tokenRiskPassed: true
        }
      })
    ).toBe(false);
  });
});
