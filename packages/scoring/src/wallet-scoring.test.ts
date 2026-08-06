import { describe, expect, it } from "vitest";
import { SAMPLE_WALLET_FEATURES } from "@memecoin-alpha/shared";
import { scoreWallet } from "./wallet-scoring";

describe("scoreWallet", () => {
  it("separates copyable wallets from clustered wallets", () => {
    const [alphaFeatures, clusteredFeatures] = SAMPLE_WALLET_FEATURES;
    const alpha = scoreWallet(alphaFeatures!);
    const clustered = scoreWallet(clusteredFeatures!);

    expect(alpha.score).toBeGreaterThan(clustered.score);
    expect(clustered.category).toBe("bundler_cluster");
  });
});

