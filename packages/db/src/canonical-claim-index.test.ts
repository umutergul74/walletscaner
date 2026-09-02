import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const repositoryPath = new URL("./postgres-repository.ts", import.meta.url);
const contractMigrationPath = new URL(
  "../../../scripts/migrations/059_canonical_partition_key_contract.sql",
  import.meta.url
);
const indexMigrationPath = new URL(
  "../../../scripts/migrations/060_canonical_partition_head_index.sql",
  import.meta.url
);

describe("canonical partition-head claim path", () => {
  it("uses the durable partition column without touching archived payload JSON", async () => {
    const source = await readFile(repositoryPath, "utf8");
    const method = source.slice(
      source.indexOf("async claimChainEvents("),
      source.indexOf("async completeChainEvent(")
    );

    expect(method).toContain("event.partition_key");
    expect(method).not.toContain("event.payload->>'address'");
    expect(method).not.toContain("COALESCE(\n              NULLIF(event.partition_key");
  });

  it("repairs and enforces unresolved keys before installing a direct covering index", async () => {
    const contract = await readFile(contractMigrationPath, "utf8");
    const index = await readFile(indexMigrationPath, "utf8");

    expect(contract).toContain("WHERE status NOT IN ('processed', 'rolled_back')");
    expect(contract).toContain("chain_event_inbox_unresolved_partition_key_check");
    expect(contract).toContain(") NOT VALID");
    expect(index).toContain("-- migrate:no-transaction");
    expect(index).toContain(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chain_event_inbox_direct_partition_head"
    );
    expect(index).toMatch(
      /chain,\s*partition_key,\s*slot ASC NULLS LAST,\s*transaction_index ASC NULLS LAST/u
    );
  });
});
