import { describe, expect, it } from "vitest";
import {
  buildHypothesisDecision,
  type HypothesisHistoryInput,
  type HypothesisInput
} from "./hypothesis-validation.js";

const candidate: HypothesisInput = {
  key: "tp15/sl20/20m / balanced-flow",
  verdict: "candidate",
  signalCount: 6,
  signalKeys: ["a", "b", "c", "d", "e", "f"],
  outcomes: [
    { key: "a", returnPct: 5 },
    { key: "b", returnPct: 4 },
    { key: "c", returnPct: 3 },
    { key: "d", returnPct: 2 },
    { key: "e", returnPct: -2 },
    { key: "f", returnPct: 1 }
  ]
};

describe("hypothesis persistence", () => {
  it("does not validate a first-run candidate", () => {
    const decision = buildHypothesisDecision([candidate], [], "2026-07-04T12:00:00.000Z");

    expect(decision.rawCandidateKey).toBe(candidate.key);
    expect(decision.rawWatchKey).toBeNull();
    expect(decision.watchKey).toBeNull();
    expect(decision.validatedKey).toBeNull();
  });

  it("allows watch after time persistence but requires sample growth for validation", () => {
    const unchangedHistory: HypothesisHistoryInput[] = [
      {
        runAt: "2026-07-04T10:00:00.000Z",
        evidence: [candidate]
      },
      {
        runAt: "2026-07-04T11:00:00.000Z",
        evidence: [candidate]
      }
    ];
    const unchanged = buildHypothesisDecision(
      [candidate],
      unchangedHistory,
      "2026-07-04T12:00:00.000Z"
    );
    const grown = buildHypothesisDecision(
      [
        {
          ...candidate,
          signalCount: 8,
          signalKeys: [...candidate.signalKeys!, "g", "h"],
          outcomes: [...candidate.outcomes!, { key: "g", returnPct: 5 }, { key: "h", returnPct: 4 }]
        }
      ],
      unchangedHistory,
      "2026-07-04T12:00:00.000Z"
    );

    expect(unchanged.watchKey).toBe(candidate.key);
    expect(unchanged.validatedKey).toBeNull();
    expect(grown.validatedKey).toBe(candidate.key);
    expect(grown.leadingSampleGrowth).toBe(2);
    expect(grown.holdoutCount).toBe(2);
    expect(grown.holdoutPassed).toBe(true);
  });

  it("resets persistence when evidence disappears for one run", () => {
    const decision = buildHypothesisDecision(
      [candidate],
      [
        {
          runAt: "2026-07-04T10:00:00.000Z",
          evidence: [candidate]
        },
        {
          runAt: "2026-07-04T11:00:00.000Z",
          evidence: []
        }
      ],
      "2026-07-04T12:00:00.000Z"
    );

    expect(decision.leadingCandidateStreak).toBe(1);
    expect(decision.watchKey).toBeNull();
    expect(decision.validatedKey).toBeNull();
  });
});
