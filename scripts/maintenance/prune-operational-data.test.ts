import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const scriptPath = new URL("./prune-operational-data.ts", import.meta.url);
const rejectedRetentionMigrationPath = new URL(
  "../migrations/036_rejected_wallet_evidence_retention.sql",
  import.meta.url
);
const scoreSupersessionMigrationPath = new URL(
  "../migrations/037_wallet_alpha_score_supersessions.sql",
  import.meta.url
);
const postgresRepositoryPath = new URL(
  "../../packages/db/src/postgres-repository.ts",
  import.meta.url
);

describe("operational maintenance SQL contract", () => {
  it("claims the oldest bounded prehashed batch and verifies archive coverage per row", async () => {
    const source = await readFile(scriptPath, "utf8");
    const compaction = source.slice(
      source.indexOf("compactedChainEventPayloads = await pruneInBatches("),
      source.indexOf("deletedRejectedWalletOutcomes = await pruneInBatches(")
    );

    expect(compaction).toContain("WITH candidates AS MATERIALIZED");
    expect(compaction).toContain("FROM chain_event_inbox AS target");
    expect(compaction).toContain("AND EXISTS (");
    expect(compaction).toContain("FROM archive_segments AS archive");
    expect(compaction).toContain(
      "ORDER BY COALESCE(target.processed_at, target.received_at),\n                    target.idempotency_key"
    );
    expect(compaction).toContain("LIMIT $2");
    expect(compaction).toContain("FOR UPDATE OF target SKIP LOCKED");
    expect(compaction).toContain("NOW() + make_interval(days => $3::integer)");
    expect(compaction).not.toContain("COALESCE(target.processed_at, target.received_at) >=");
    expect(compaction).not.toContain("WITH eligible_archive AS MATERIALIZED");
    expect(compaction).not.toContain("CROSS JOIN LATERAL");
  });

  it("carries the canonical receive time into both payload deletes", async () => {
    const source = await readFile(scriptPath, "utf8");
    const compaction = source.slice(
      source.indexOf("compactedChainEventPayloads = await pruneInBatches("),
      source.indexOf("deletedRejectedWalletOutcomes = await pruneInBatches(")
    );

    expect(compaction.match(/payload\.received_at = candidates\.received_at/g)).toHaveLength(2);
    expect(
      compaction.match(/payload\.event_idempotency_key = candidates\.idempotency_key/g)
    ).toHaveLength(2);
    expect(compaction).toContain("target.received_at, target.payload_sha256");
  });

  it("attributes bounded statement timeouts to the failing maintenance stage", async () => {
    const source = await readFile(scriptPath, "utf8");

    expect(source).toContain("queryTimeoutsByStage");
    expect(source).toContain('"chain-event-inbox"');
    expect(source).toContain('"chain-event-payloads"');
    expect(source).toContain(
      "queryTimeoutsByStage[stage] = (queryTimeoutsByStage[stage] ?? 0) + 1"
    );
  });

  it("prioritizes overdue payload compaction over competing inbox metadata retirement", async () => {
    const source = await readFile(scriptPath, "utf8");

    expect(source).toContain("chain_event_payloads_overdue");
    expect(source).toContain("MAINTENANCE_COMPACTION_PRIORITY_LAG_SECONDS");
    expect(source).toContain("if (!eligible.rows[0]?.chain_event_payloads_overdue)");
    expect(source).toContain("maintenanceStartedAt + totalBudgetMs * 0.92");
    expect(source).toContain("MAINTENANCE_COMPACTION_STATEMENT_TIMEOUT_MS");
    expect(source).toContain("`${compactionStatementTimeoutMs}ms`");
  });

  it("uses one pinned PostgreSQL session for the advisory lock lifecycle", async () => {
    const source = await readFile(scriptPath, "utf8");

    expect(source).toContain("max: 2");
    expect(source).toContain("lockClient = await pool.connect()");
    expect(source).toContain(
      'await lockClient.query<{ locked: boolean }>(\n    "SELECT pg_try_advisory_lock'
    );
    expect(source).toContain('await lockClient.query("SELECT pg_advisory_unlock');
    expect(source).toContain("lockClient?.release()");
    expect(source).not.toContain('await pool.query("SELECT pg_advisory_unlock');
  });

  it("retires each rejected-entry batch atomically under retained row locks", async () => {
    const source = await readFile(scriptPath, "utf8");
    const rejectedRetention = source.slice(
      source.indexOf("async function pruneRejectedWalletEvidence("),
      source.indexOf("async function pruneInBatches(")
    );

    expect(rejectedRetention).toContain('await client.query("BEGIN")');
    expect(rejectedRetention).toContain("FOR UPDATE OF entry SKIP LOCKED");
    expect(rejectedRetention).toContain(
      "DELETE FROM wallet_signal_outcomes\n           WHERE entry_idempotency_key = ANY($1::text[])"
    );
    expect(rejectedRetention).toContain(
      "DELETE FROM wallet_entry_signals\n           WHERE idempotency_key = ANY($1::text[])"
    );
    expect(rejectedRetention).toContain('await client.query("COMMIT")');
    expect(rejectedRetention).toContain('await client.query("ROLLBACK")');
    expect(rejectedRetention.indexOf("DELETE FROM wallet_signal_outcomes")).toBeLessThan(
      rejectedRetention.indexOf("DELETE FROM wallet_entry_signals")
    );
    expect(
      rejectedRetention.match(/entry\.flow_evidence @> '\{"tokenRiskKnown":true\}'::jsonb/g)
    ).toHaveLength(1);
    expect(
      rejectedRetention.match(/entry\.flow_evidence @> '\{"tokenRiskPassed":true\}'::jsonb/g)
    ).toHaveLength(1);
    expect(rejectedRetention).toContain('stage = "rejected-wallet-outcomes"');
    expect(rejectedRetention).toContain('stage = "rejected-wallet-entries"');
  });

  it("splits hard-expired and queue-backed superseded score retention", async () => {
    const source = await readFile(scriptPath, "utf8");
    const scores = source.slice(
      source.indexOf("deletedExpiredWalletAlphaScores = await pruneInBatches("),
      source.indexOf("const priceRetentionState")
    );

    expect(scores).toContain('"wallet-alpha-scores-hard-expiry"');
    expect(scores).toContain('"wallet-alpha-scores-superseded"');
    expect(scores).toContain("walletEvidenceRetentionDays");
    expect(scores).toContain("scoreRetentionDays");
    expect(scores.match(/inboxBatchSize/g)).toHaveLength(2);
    expect(scores).toContain("FROM wallet_alpha_score_supersessions AS supersession");
    expect(scores).toContain(
      "ORDER BY supersession.calculated_at, supersession.chain,\n                    supersession.wallet_address, supersession.strategy_version"
    );
    expect(scores).not.toContain("FROM wallet_alpha_scores AS newer");
    expect(scores).toContain(
      "deletedExpiredWalletAlphaScores + deletedSupersededWalletAlphaScores"
    );
    expect(source).toContain("walletAlphaScoresHardExpiry: deletedExpiredWalletAlphaScores");
    expect(source).toContain("walletAlphaScoresSuperseded: deletedSupersededWalletAlphaScores");
  });

  it("adds the exact rejected-evidence predicate as a concurrent partial index", async () => {
    const migration = await readFile(rejectedRetentionMigrationPath, "utf8");

    expect(migration).toContain("-- migrate:no-transaction");
    expect(migration).toContain("CREATE INDEX CONCURRENTLY IF NOT EXISTS");
    expect(migration).toContain("idx_wallet_entry_signals_rejected_retention");
    expect(migration).toContain("ON wallet_entry_signals (observed_at, idempotency_key)");
    expect(migration).toContain("flow_evidence @> '{\"tokenRiskKnown\":true}'::jsonb");
    expect(migration).toContain("AND NOT (flow_evidence @> '{\"tokenRiskPassed\":true}'::jsonb)");
  });

  it("materializes score supersession with a cascading full-key retention queue", async () => {
    const migration = await readFile(scoreSupersessionMigrationPath, "utf8");

    expect(migration).toContain("CREATE TABLE IF NOT EXISTS wallet_alpha_score_supersessions");
    expect(migration).toContain(
      "PRIMARY KEY (chain, wallet_address, strategy_version, calculated_at)"
    );
    expect(migration).toContain("REFERENCES wallet_alpha_scores (");
    expect(migration).toContain("ON DELETE CASCADE");
    expect(migration).toContain("LAG(score.calculated_at) OVER");
    expect(migration).toContain(
      "ON CONFLICT (chain, wallet_address, strategy_version, calculated_at) DO NOTHING"
    );
    expect(migration).toContain("idx_wallet_alpha_score_supersessions_retention");
    expect(migration).toContain("calculated_at, chain, wallet_address, strategy_version");
  });

  it("queues supersession only from a successful changed-score insert", async () => {
    const repository = await readFile(postgresRepositoryPath, "utf8");
    const saveScore = repository.slice(
      repository.indexOf("async saveWalletAlphaScore("),
      repository.indexOf("async replaceWalletPositionLedger(")
    );

    expect(saveScore).toContain("), changed AS (");
    expect(saveScore).toContain("RETURNING chain, wallet_address, strategy_version, calculated_at");
    expect(saveScore).toContain("), superseded AS (");
    expect(saveScore.match(/CROSS JOIN changed/g)).toHaveLength(2);
    expect(saveScore).toContain("latest.calculated_at < changed.calculated_at");
    expect(saveScore).toContain("changed.calculated_at < latest.calculated_at");
    expect(saveScore).toContain(
      "ON CONFLICT (chain, wallet_address, strategy_version, calculated_at) DO NOTHING"
    );
  });
});
