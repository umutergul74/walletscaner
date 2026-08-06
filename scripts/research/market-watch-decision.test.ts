import { describe, expect, it } from "vitest";
import { decideMarketWatchMode } from "./market-watch-decision.js";

const empty = {
  validatedMethod: false,
  validatedRule: false,
  validatedPaperExit: false,
  validatedWallet: false,
  watchMethod: false,
  watchRule: false,
  watchPaperExit: false,
  watchWallet: false,
  canonicalReplayPassed: false
};

describe("market-watch mode decision", () => {
  it("does not elevate the whole system for a watch-only wallet", () => {
    const decision = decideMarketWatchMode({ ...empty, watchWallet: true });

    expect(decision.recommendedMode).toBe("observe-only");
    expect(decision.systemWatch).toBe(false);
  });

  it("reports a validated wallet as paper-watch without validating a system", () => {
    const decision = decideMarketWatchMode({ ...empty, validatedWallet: true });

    expect(decision.recommendedMode).toBe("paper-watch");
    expect(decision.walletOnlyCandidate).toBe(true);
    expect(decision.systemCandidate).toBe(false);
  });

  it("requires method, rule, exit and replay together for system validation", () => {
    const incomplete = decideMarketWatchMode({
      ...empty,
      validatedMethod: true,
      validatedRule: true,
      validatedPaperExit: true
    });
    const complete = decideMarketWatchMode({
      ...empty,
      validatedMethod: true,
      validatedRule: true,
      validatedPaperExit: true,
      canonicalReplayPassed: true
    });

    expect(incomplete.recommendedMode).toBe("observe-only");
    expect(complete.recommendedMode).toBe("paper-validate candidate");
  });

  it("allows a persistent system component to remain paper-watch", () => {
    expect(decideMarketWatchMode({ ...empty, watchPaperExit: true }).recommendedMode).toBe(
      "paper-watch"
    );
  });
});
