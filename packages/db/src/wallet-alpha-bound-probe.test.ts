import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const repositoryPath = new URL("./postgres-repository.ts", import.meta.url);
const migrationPath = new URL(
  "../../../scripts/migrations/058_wallet_trade_fifo_order_index.sql",
  import.meta.url
);

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
    expect(method).toContain("ROW(trade.slot, trade.observed_at) >=");
    expect(source).toContain("Wallet-alpha ${stage} bound probe failed: ${message}");
  });

  it("seeks FIFO continuation probes with a compact deterministic-order prefix", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain("-- migrate:no-transaction");
    expect(migration).toContain(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_wallet_trade_events_fifo_order_prefix"
    );
    expect(migration).toMatch(
      /chain,\s*wallet_address,\s*strategy_version,\s*slot,\s*observed_at/u
    );
  });
});
