import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportArchiveSegment, validateArchiveArtifact } from "./archive-artifact";
import { retireVerifiedPayloadPartitions } from "./archive-retention";
import { ArchiveStore } from "./archive-store";
import { PostgresRepository } from "./postgres-repository";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = databaseUrl ? describe : describe.skip;

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
    await expect(validateArchiveArtifact({ filePath, expected: artifact })).resolves.toMatchObject({
      sourceRowCount: 1,
      canonicalMetadataRowCount: 1
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
         source_row_count, canonical_metadata_row_count, source_bytes, source_sha256,
         archive_bytes, archive_sha256, content_md5_base64, object_lock_mode,
         object_lock_evidence,
         retain_until, uploaded_at, verified_at
       ) VALUES (
         'chain-event-payloads', $1, $2, 'verified', $3,
         1, 1, 1, $4, 1, $5, $6, 'GOVERNANCE', 'attested-default-policy',
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
