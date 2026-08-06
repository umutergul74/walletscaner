import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { PostgresRepository } from "@memecoin-alpha/db";
import {
  buildCanonicalEvidenceReport,
  renderCanonicalEvidenceMarkdown
} from "./evidence-report-builder.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to generate the canonical evidence report.");
}

const strategyVersion = process.env.ALPHA_STRATEGY_VERSION ?? "evidence-v1";
const rpcUrl = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const repository = new PostgresRepository(databaseUrl);
const report = await buildCanonicalEvidenceReport(repository, strategyVersion, {
  providerStatus: /api\.mainnet-beta\.solana\.com/i.test(rpcUrl)
    ? "degraded"
    : "ok"
});

await mkdir("reports", { recursive: true });
await writeFile(
  "reports/evidence-latest.json",
  JSON.stringify(report, null, 2)
);
await writeFile(
  "reports/evidence-latest.md",
  renderCanonicalEvidenceMarkdown(report)
);

console.log(
  JSON.stringify(
    {
      generatedAt: report.generatedAt,
      mode: report.recommendedMode,
      completed: report.goalCompletionAudit.completed,
      reports: ["reports/evidence-latest.json", "reports/evidence-latest.md"]
    },
    null,
    2
  )
);
