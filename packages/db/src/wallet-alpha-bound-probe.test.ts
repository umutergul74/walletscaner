import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const repositoryPath = new URL("./postgres-repository.ts", import.meta.url);

describe("wallet-alpha evidence bound probes", () => {
  it("gives each indexed relation its own bounded statement", async () => {
    const source = await readFile(repositoryPath, "utf8");
    const method = source.slice(
      source.indexOf("async probeWalletAlphaEvidenceBounds("),
      source.indexOf("async getWalletAlphaWorkSummary(")
    );

    expect(method).toContain("SET LOCAL statement_timeout = '5s'");
    expect(method.match(/boundedWalletAlphaProbe\(/g)).toHaveLength(3);
    expect(method).toContain('"trade-events"');
    expect(method).toContain('"entries"');
    expect(method).toContain('"outcomes"');
    expect(method).not.toContain("AS trade_events_exceeded");
    expect(source).toContain("Wallet-alpha ${stage} bound probe failed: ${message}");
  });
});
