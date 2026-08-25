import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportArchiveSegment, validateArchiveArtifact } from "./archive-artifact";
import { retireVerifiedPayloadPartitions } from "./archive-retention";
import { ArchiveStore } from "./archive-store";
import { PostgresRepository } from "./postgres-repository";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = databaseUrl ? describe : describe.skip;
const execFileAsync = promisify(execFile);

integrationDescribe("PostgreSQL cold archive pipeline", () => {
  const adminPool = new pg.Pool({ connectionString: databaseUrl });
  const schema = `archive_test_${Date.now()}`;
  let testPool: pg.Pool;
  let store: ArchiveStore;
  let repository: PostgresRepository;
  const temporaryDirectories: string[] = [];

  beforeAll(async () => {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    testPool = new pg.Pool({
      connectionString: databaseUrl,
      max: 3,
      options: `-c search_path=${schema},public`
    });
    const migrations = (await readdir("scripts/migrations"))
      .filter((filename) => /^\d+.*\.sql$/.test(filename))
      .sort();
    for (const migration of migrations) {
      await testPool.query(await readFile(`scripts/migrations/${migration}`, "utf8"));
    }
    store = new ArchiveStore(testPool);
    repository = new PostgresRepository(testPool);
  });

  afterAll(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true }))
    );
    if (testPool) await testPool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  });

  it("seeds a later partition after the first manifest window is already populated", async () => {
    const starts = Array.from(
      { length: 11 },
      (_, index) => new Date(Date.UTC(1999, 0, index + 1))
    );
    for (const [index, rangeStart] of starts.entries()) {
      const rangeEnd = new Date(rangeStart.getTime() + 86_400_000);
      const partitionName = `chain_event_payloads_${rangeStart
        .toISOString()
        .slice(0, 10)
        .replaceAll("-", "")}`;
      await testPool.query(
        `CREATE TABLE ${partitionName}
         PARTITION OF chain_event_payloads
         FOR VALUES FROM ('${rangeStart.toISOString()}') TO ('${rangeEnd.toISOString()}')`
      );
      if (index < 10) {
        await testPool.query(
          `INSERT INTO archive_segments (source_kind, range_start, range_end)
           VALUES ('chain-event-payloads', $1, $2)`,
          [rangeStart.toISOString(), rangeEnd.toISOString()]
        );
      }
    }

    await expect(store.seedEligibleDailySegments(1, 1)).resolves.toBe(1);
    const seeded = await testPool.query(
      `SELECT 1 FROM archive_segments
       WHERE source_kind = 'chain-event-payloads' AND range_start = $1`,
      [starts[10]!.toISOString()]
    );
    expect(seeded.rowCount).toBe(1);

    await testPool.query(
      `DELETE FROM archive_segments
       WHERE range_start >= $1 AND range_start < $2`,
      [starts[0]!.toISOString(), new Date(Date.UTC(1999, 0, 12)).toISOString()]
    );
    for (const rangeStart of starts) {
      await testPool.query(
        `DROP TABLE chain_event_payloads_${rangeStart
          .toISOString()
          .slice(0, 10)
          .replaceAll("-", "")}`
      );
    }
  });

  it("exports, restores and independently verifies one immutable daily segment", async () => {
    const rangeStart = utcDayOffset(-1);
    const rangeEnd = new Date(rangeStart.getTime() + 86_400_000);
    await repository.insertChainEvent(canonicalEvent("archive-event-1", rangeStart));
    await testPool.query(
      `INSERT INTO archive_segments (source_kind, range_start, range_end)
       VALUES ('chain-event-payloads', $1, $2)`,
      [rangeStart.toISOString(), rangeEnd.toISOString()]
    );

    const segment = await store.claimWriter({ workerId: "archive-writer-test", leaseSeconds: 300 });
    expect(segment).toBeDefined();
    const directory = await mkdtemp(join(tmpdir(), "walletscanner-pg-archive-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "segment.jsonl.zst");
    const client = await testPool.connect();
    let artifact;
    try {
      await expect(
        exportArchiveSegment({
          client,
          segment: segment!,
          outputPath: filePath,
          maximumArchiveBytes: 1
        })
      ).rejects.toThrow("disk-headroom ceiling");
      artifact = await exportArchiveSegment({ client, segment: segment!, outputPath: filePath });
    } finally {
      client.release();
    }
    expect(artifact.sourceRowCount).toBe(1);
    expect(artifact.canonicalMetadataRowCount).toBe(1);
    expect(artifact.recordTypeCounts).toEqual({ chain_event_payload: 1 });
    await expect(validateArchiveArtifact({ filePath, expected: artifact })).resolves.toMatchObject({
      sourceRowCount: 1,
      canonicalMetadataRowCount: 1,
      recordTypeCounts: { chain_event_payload: 1 }
    });
    expect(
      await store.markUploadForVerification({
        segment: segment!,
        workerId: "archive-writer-test",
        artifact,
        uploadSucceeded: true,
        etag: '"test-etag"',
        objectVersionId: "test-version"
      })
    ).toBe(true);

    const verifier = await store.claimVerifier({
      workerId: "archive-verifier-test",
      leaseSeconds: 300
    });
    expect(verifier?.objectKey).toBe(artifact.objectKey);
    const retainUntil = new Date(Date.now() + 30 * 86_400_000).toISOString();
    expect(
      await store.completeVerification({
        segment: verifier!,
        workerId: "archive-verifier-test",
        receipt: {
          etag: '"test-etag"',
          objectVersionId: "test-version",
          objectLockMode: "GOVERNANCE",
          objectLockEvidence: "api-verified",
          retainUntil
        },
        minimumRetainUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        details: { sourceRowCount: 1, canonicalMetadataRowCount: 1 }
      })
    ).toBe(true);
    expect((await store.summary()).verified).toBe(1);

    await expect(
      repository.insertChainEvent(canonicalEvent("archive-event-late", rangeStart, 60_000))
    ).rejects.toMatchObject({ code: "23514" });
    const lateInbox = await testPool.query(
      `SELECT 1 FROM chain_event_inbox WHERE idempotency_key = 'archive-event-late'`
    );
    expect(lateInbox.rowCount).toBe(0);
  });

  it("archives exact wallet evidence and preserves a verified generation across corrections", async () => {
    const rangeStart = utcDayOffset(-5);
    const observedAt = new Date(rangeStart.getTime() + 3_600_000).toISOString();
    await testPool.query(
      `INSERT INTO wallet_trade_events (
         idempotency_key, chain, wallet_address, token_address, quote_token_address,
         pool_address, side, base_amount, quote_amount, execution_price_usd,
         quote_value_usd, data_quality, signature, slot, provider, observed_at,
         strategy_version, raw
       ) VALUES (
         'wallet-trade-archive-1', 'solana', 'WalletArchive111', 'TokenArchive111',
         'So11111111111111111111111111111111111111112', 'PoolArchive111',
         'buy', 10, 2, 0.2, 2, 'observed-execution', 'wallet-trade-signature',
         10, 'archive-test', $1, 'evidence-v1', '{"full":"trade"}'::jsonb
       )`,
      [observedAt]
    );
    await testPool.query(
      `INSERT INTO wallet_entry_signals (
         idempotency_key, chain, wallet_address, token_address, pool_address,
         observed_entry_price_usd, observed_liquidity_usd, cohort,
         repeat_wallet_count, flow_evidence, signature, slot, provider,
         observed_at, strategy_version
       ) VALUES (
         'wallet-entry-archive-1', 'solana', 'WalletArchive111', 'TokenArchive111',
         'PoolArchive111', 0.2, 10000, 'safe', 1, '{"full":"entry"}'::jsonb,
         'wallet-entry-signature', 11, 'archive-test', $1, 'evidence-v1'
       )`,
      [observedAt]
    );
    await testPool.query(
      `INSERT INTO wallet_signal_outcomes (
         idempotency_key, entry_idempotency_key, chain, horizon_minutes, status,
         outcome_price_usd, frozen_at, gross_return_pct, net_return_pct,
         estimated_round_trip_cost_pct, exit_strategy, rugged, signature, slot,
         provider, observed_at, strategy_version, raw
       ) VALUES (
         'wallet-outcome-archive-1', 'wallet-entry-archive-1', 'solana', 60,
         'mature', 0.3, $1, 50, 47, 3, 'fixed-horizon', false,
         'wallet-outcome-signature', 12, 'archive-test', $1, 'evidence-v1',
         '{"full":"outcome"}'::jsonb
       )`,
      [observedAt]
    );
    await testPool.query(
      `INSERT INTO wallet_position_episodes (
         id, chain, wallet_address, token_address, strategy_version, episode_index,
         status, opened_at, cost_basis_usd, proceeds_usd, realized_pnl_usd,
         remaining_raw_amount, token_decimals, realized_lot_count,
         high_quality_price_coverage, metadata
       ) VALUES (
         'wallet-episode-archive-1', 'solana', 'WalletArchive111', 'TokenArchive111',
         'evidence-v1', 1, 'open', $1, 2, 0, 0, 10, 6, 0, 1, '{}'::jsonb
       )`,
      [observedAt]
    );
    await testPool.query(
      `INSERT INTO wallet_position_lots (
         id, episode_id, source_event_idempotency_key, lot_sequence, raw_amount,
         remaining_raw_amount, token_decimals, quote_cost_usd, fees_usd,
         slippage_usd, opened_at, status, metadata
       ) VALUES (
         'wallet-lot-archive-1', 'wallet-episode-archive-1', 'wallet-trade-archive-1',
         1, 10, 10, 6, 2, 0, 0, $1, 'open', '{}'::jsonb
       )`,
      [observedAt]
    );

    await expect(store.seedEligibleWalletEvidenceSegments(24, 1)).resolves.toBe(1);
    const segment = await store.claimWriter({
      workerId: "wallet-archive-writer-test",
      leaseSeconds: 300
    });
    expect(segment?.sourceKind).toBe("wallet-evidence");
    const directory = await mkdtemp(join(tmpdir(), "walletscanner-wallet-pg-archive-"));
    temporaryDirectories.push(directory);
    const filePath = join(directory, "wallet-segment.jsonl.zst");
    const client = await testPool.connect();
    let artifact;
    try {
      artifact = await exportArchiveSegment({ client, segment: segment!, outputPath: filePath });
    } finally {
      client.release();
    }
    expect(artifact.recordTypeCounts).toEqual({
      wallet_trade_event: 1,
      wallet_entry_signal: 1,
      wallet_signal_outcome: 1
    });
    await expect(validateArchiveArtifact({ filePath, expected: artifact })).resolves.toMatchObject({
      sourceRowCount: 3,
      canonicalMetadataRowCount: 3
    });
    expect(
      await store.markUploadForVerification({
        segment: segment!,
        workerId: "wallet-archive-writer-test",
        artifact,
        uploadSucceeded: true
      })
    ).toBe(true);
    const verifier = await store.claimVerifier({
      workerId: "wallet-archive-verifier-test",
      leaseSeconds: 300
    });
    const retainUntil = new Date(Date.now() + 30 * 86_400_000).toISOString();
    expect(
      await store.completeVerification({
        segment: verifier!,
        workerId: "wallet-archive-verifier-test",
        receipt: {
          objectLockMode: "GOVERNANCE",
          objectLockEvidence: "api-verified",
          retainUntil
        },
        minimumRetainUntil: new Date(Date.now() + 7 * 86_400_000).toISOString()
      })
    ).toBe(true);

    const scopedUrl = new URL(databaseUrl!);
    scopedUrl.searchParams.set("options", `-c search_path=${schema},public`);
    await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/archive/wallet-evidence-materializer.ts"],
      {
        env: {
          ...process.env,
          DATABASE_URL: scopedUrl.toString(),
          WALLET_EVIDENCE_MATERIALIZER_MAX_DAYS_PER_RUN: "1"
        },
        timeout: 30_000
      }
    );
    const compact = await testPool.query<{
      status: string;
      affected_episode_count: string;
      open_lot_count: string;
      mature_followability_count: string;
    }>(
      `SELECT status, affected_episode_count::text, open_lot_count::text,
              mature_followability_count::text
       FROM wallet_evidence_compact_days WHERE range_start=$1`,
      [rangeStart.toISOString()]
    );
    expect(compact.rows[0]).toMatchObject({
      status: "verified",
      affected_episode_count: "1",
      open_lot_count: "1",
      mature_followability_count: "1"
    });
    await expect(
      testPool.query("SELECT COUNT(*)::int AS rows FROM wallet_open_lot_facts")
    ).resolves.toMatchObject({ rows: [{ rows: 1 }] });

    await testPool.query(
      `UPDATE wallet_trade_events
       SET raw = raw || '{"corrected":true}'::jsonb
       WHERE idempotency_key = 'wallet-trade-archive-1'`
    );
    const active = await testPool.query<{ revision: number; status: string }>(
      `SELECT revision, status FROM archive_segments
       WHERE source_kind='wallet-evidence' AND range_start=$1`,
      [rangeStart.toISOString()]
    );
    expect(active.rows[0]).toMatchObject({ revision: 2, status: "pending" });
    const generation = await testPool.query(
      `SELECT 1 FROM archive_segment_generations
       WHERE segment_id=$1 AND revision=1`,
      [segment!.id]
    );
    expect(generation.rowCount).toBe(1);

    await testPool.query("DELETE FROM wallet_position_lots WHERE id='wallet-lot-archive-1'");
    await testPool.query(
      "DELETE FROM wallet_position_episodes WHERE id='wallet-episode-archive-1'"
    );
    const corrected = await store.claimWriter({
      workerId: "wallet-archive-writer-correction-test",
      leaseSeconds: 300
    });
    expect(corrected).toMatchObject({ id: segment!.id, revision: 2, sourceKind: "wallet-evidence" });
    const correctedPath = join(directory, "wallet-segment-r2.jsonl.zst");
    const correctedClient = await testPool.connect();
    let correctedArtifact;
    try {
      correctedArtifact = await exportArchiveSegment({
        client: correctedClient,
        segment: corrected!,
        outputPath: correctedPath
      });
    } finally {
      correctedClient.release();
    }
    await expect(
      validateArchiveArtifact({ filePath: correctedPath, expected: correctedArtifact })
    ).resolves.toMatchObject({ sourceRowCount: 3, canonicalMetadataRowCount: 3 });
    expect(
      await store.markUploadForVerification({
        segment: corrected!,
        workerId: "wallet-archive-writer-correction-test",
        artifact: correctedArtifact,
        uploadSucceeded: true
      })
    ).toBe(true);
    const correctedVerifier = await store.claimVerifier({
      workerId: "wallet-archive-verifier-correction-test",
      leaseSeconds: 300
    });
    expect(
      await store.completeVerification({
        segment: correctedVerifier!,
        workerId: "wallet-archive-verifier-correction-test",
        receipt: {
          objectLockMode: "GOVERNANCE",
          objectLockEvidence: "api-verified",
          retainUntil
        },
        minimumRetainUntil: new Date(Date.now() + 7 * 86_400_000).toISOString()
      })
    ).toBe(true);
    await execFileAsync(
      process.execPath,
      ["--import", "tsx", "scripts/archive/wallet-evidence-materializer.ts"],
      {
        env: {
          ...process.env,
          DATABASE_URL: scopedUrl.toString(),
          WALLET_EVIDENCE_MATERIALIZER_MAX_DAYS_PER_RUN: "1"
        },
        timeout: 30_000
      }
    );
    await expect(
      testPool.query(
        `SELECT archive_revision, status, affected_episode_count::int,
                open_lot_count::int, mature_followability_count::int
         FROM wallet_evidence_compact_days WHERE range_start=$1`,
        [rangeStart.toISOString()]
      )
    ).resolves.toMatchObject({
      rows: [
        {
          archive_revision: 2,
          status: "verified",
          affected_episode_count: 0,
          open_lot_count: 0,
          mature_followability_count: 1
        }
      ]
    });
    await expect(
      testPool.query("SELECT COUNT(*)::int AS rows FROM wallet_profitability_episode_facts")
    ).resolves.toMatchObject({ rows: [{ rows: 0 }] });
    await expect(
      testPool.query("SELECT COUNT(*)::int AS rows FROM wallet_open_lot_facts")
    ).resolves.toMatchObject({ rows: [{ rows: 0 }] });
  });

  it("invalidates an in-flight revision when its source window changes", async () => {
    const rangeStart = utcDayOffset(-2);
    const rangeEnd = new Date(rangeStart.getTime() + 86_400_000);
    await testPool.query(
      `INSERT INTO archive_segments (source_kind, range_start, range_end)
       VALUES ('chain-event-payloads', $1, $2)`,
      [rangeStart.toISOString(), rangeEnd.toISOString()]
    );
    const segment = await store.claimWriter({ workerId: "stale-writer", leaseSeconds: 300 });
    expect(segment?.rangeStart).toBe(rangeStart.toISOString());
    await repository.insertChainEvent(canonicalEvent("archive-event-revision", rangeStart));

    const current = await testPool.query<{ revision: number; status: string }>(
      `SELECT revision, status FROM archive_segments WHERE id = $1`,
      [segment!.id]
    );
    expect(current.rows[0]).toMatchObject({ revision: 2, status: "pending" });
  });

  it("blocks partition retirement until the matching locked archive is verified", async () => {
    const rangeStart = utcDayOffset(-20);
    const rangeEnd = new Date(rangeStart.getTime() + 86_400_000);
    const partitionName = `chain_event_payloads_${rangeStart
      .toISOString()
      .slice(0, 10)
      .replaceAll("-", "")}`;
    await testPool.query(
      `CREATE TABLE ${partitionName}
       PARTITION OF chain_event_payloads
       FOR VALUES FROM ('${rangeStart.toISOString()}') TO ('${rangeEnd.toISOString()}')`
    );
    await repository.insertChainEvent(canonicalEvent("archive-retirement-event", rangeStart));

    await expect(retireVerifiedPayloadPartitions(testPool, 72, true)).resolves.toMatchObject({
      partitions: 0,
      blockedPartitions: 1,
      policyReady: false
    });
    expect(
      await testPool.query(`SELECT 1 FROM ${partitionName} WHERE event_idempotency_key = $1`, [
        "archive-retirement-event"
      ])
    ).toHaveProperty("rowCount", 1);

    await testPool.query(
      `INSERT INTO archive_segments (
         source_kind, range_start, range_end, status, object_key,
         source_row_count, canonical_metadata_row_count, record_type_counts,
         source_bytes, source_sha256,
         archive_bytes, archive_sha256, content_md5_base64, object_lock_mode,
         object_lock_evidence,
         retain_until, uploaded_at, verified_at
       ) VALUES (
         'chain-event-payloads', $1, $2, 'verified', $3,
         1, 1, '{"chain_event_payload":1}'::jsonb, 1, $4, 1, $5, $6,
         'GOVERNANCE', 'attested-default-policy',
         NOW() + INTERVAL '30 days', NOW(), NOW()
       )`,
      [
        rangeStart.toISOString(),
        rangeEnd.toISOString(),
        `raw-solana/date=${rangeStart.toISOString().slice(0, 10)}/revision=000001/raw-solana-v1.jsonl.zst`,
        "d".repeat(64),
        "e".repeat(64),
        "dGVzdA=="
      ]
    );

    await expect(retireVerifiedPayloadPartitions(testPool, 72)).resolves.toMatchObject({
      partitions: 0,
      blockedPartitions: 1,
      runtimeEnabled: false
    });

    await expect(
      testPool.query("SELECT approve_chain_event_payload_retirement($1, 7)", [
        rangeStart.toISOString()
      ])
    ).rejects.toThrow("not wholly future-only");

    await testPool.query(
      `UPDATE archive_retirement_policies
       SET activated_at = $1
       WHERE source_kind = 'chain-event-payloads'`,
      [new Date(rangeStart.getTime() - 86_400_000).toISOString()]
    );
    await testPool.query("SELECT approve_chain_event_payload_retirement($1, 7)", [
      rangeStart.toISOString()
    ]);

    await expect(retireVerifiedPayloadPartitions(testPool, 72, true)).resolves.toMatchObject({
      partitions: 1,
      heldPayloads: 1,
      blockedPartitions: 0,
      runtimeEnabled: true,
      policyReady: true
    });
    const retired = await testPool.query<{ relation: string | null }>(
      "SELECT to_regclass($1)::text AS relation",
      [partitionName]
    );
    expect(retired.rows[0]?.relation).toBeNull();
    const held = await testPool.query(
      "SELECT 1 FROM chain_event_payload_holds WHERE event_idempotency_key = $1",
      ["archive-retirement-event"]
    );
    expect(held.rowCount).toBe(1);
  });

  function canonicalEvent(idempotencyKey: string, day: Date, offsetMs = 0) {
    const receivedAt = new Date(day.getTime() + 3_600_000 + offsetMs).toISOString();
    const payload = { signature: idempotencyKey, value: 1 };
    return {
      idempotencyKey,
      chain: "solana" as const,
      signature: idempotencyKey,
      slot: 1,
      transactionIndex: 0,
      instructionIndex: 0,
      eventType: "test-event",
      occurredAt: receivedAt,
      receivedAt,
      commitment: "confirmed" as const,
      source: "archive-integration-test",
      decoderVersion: "test-v1",
      payload: {
        ...payload,
        expectedSha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex")
      }
    };
  }
});

function utcDayOffset(days: number): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days));
}
