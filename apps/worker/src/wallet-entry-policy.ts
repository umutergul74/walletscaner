export type WalletEntryMaterializationDecision =
  | "materialize"
  | "skip-uncontrolled-flow"
  | "defer-unknown-risk"
  | "skip-failed-risk";

export function walletEntryMaterializationDecision(evidence: {
  controlledFlow: boolean;
  tokenRiskKnown: boolean;
  tokenRiskPassed: boolean;
}): WalletEntryMaterializationDecision {
  if (!evidence.controlledFlow) return "skip-uncontrolled-flow";
  if (!evidence.tokenRiskKnown) return "defer-unknown-risk";
  if (!evidence.tokenRiskPassed) return "skip-failed-risk";
  return "materialize";
}

export function isWalletEntryOutcomeEligible(entry: {
  cohort: string;
  flowEvidence: Record<string, unknown>;
}): boolean {
  return (
    entry.cohort !== "excluded-uncontrolled-flow" &&
    walletEntryMaterializationDecision({
      controlledFlow: entry.flowEvidence.controlledFlow === true,
      tokenRiskKnown: entry.flowEvidence.tokenRiskKnown === true,
      tokenRiskPassed: entry.flowEvidence.tokenRiskPassed === true
    }) === "materialize"
  );
}
