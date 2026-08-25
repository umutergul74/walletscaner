import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const composePath = new URL("../../docker-compose.server.yml", import.meta.url);

describe("server archive scheduler images", () => {
  it("pins every archive worker to the reviewed operations release", async () => {
    const compose = await readFile(composePath, "utf8");
    const writer = serviceBlock(compose, "archive-writer", "archive-verifier");
    const verifier = serviceBlock(
      compose,
      "archive-verifier",
      "archive-writer-scheduler"
    );
    const materializer = serviceBlock(
      compose,
      "wallet-evidence-materializer-scheduler",
      "archive-database-backup-writer"
    );
    const derivedReclaim = serviceBlock(
      compose,
      "derived-ledger-reclaim",
      "archive-retirement-approval"
    );
    const operationsImage =
      "${WALLETSCANER_OPERATIONS_IMAGE:-walletscaner-worker:local}";

    expect(writer).toContain(`image: ${operationsImage}`);
    expect(verifier).toContain(`image: ${operationsImage}`);
    expect(materializer).toContain(`image: ${operationsImage}`);
    expect(materializer).toContain('cpus: "0.05"');
    expect(materializer).toContain("mem_limit: 80m");
    expect(derivedReclaim).toContain(`image: ${operationsImage}`);
    expect(derivedReclaim).toContain('cpus: "0.02"');
    expect(derivedReclaim).toContain("mem_limit: 64m");
    expect(derivedReclaim).toContain("./archive-staging/database-backup:/app/archive-staging:ro");
  });
});

function serviceBlock(compose: string, start: string, end: string): string {
  const startIndex = compose.indexOf(`  ${start}:`);
  const endIndex = compose.indexOf(`\n  ${end}:`, startIndex);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Missing Compose service boundary: ${start} -> ${end}`);
  }
  return compose.slice(startIndex, endIndex);
}
