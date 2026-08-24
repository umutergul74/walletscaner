import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PaperTrade, QualifiedPoolNotification } from "@memecoin-alpha/shared";
import { PaperTradingStore } from "./paper-trading-store";
import { PostgresRepository } from "./postgres-repository";
import type { IngestionCoverageIncidentOpenInput } from "./repository";
import { TelegramNotificationStore } from "./telegram-notification-store";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integrationDescribe = databaseUrl ? describe : describe.skip;
const coverageMigration = "038_ingestion_coverage_incidents.sql";
const safeRepairBoundaryMigration = "045_safe_discovery_repair_boundary.sql";
const upgradeFixtureSource = "coverage-populated-upgrade";
const upgradeExactAddress = "CoverageUpgradeExactProgram111";
const upgradeMissingAddress = "CoverageUpgradeMissingProgram111";
const upgradeExpectedOccurredAt = "2026-08-21T06:55:00.000Z";

integrationDescribe("PostgreSQL ingestion coverage safety", () => {
  const adminPool = new pg.Pool({ connectionString: databaseUrl });
  const schema = `coverage_test_${Date.now()}`;
  let testPool: pg.Pool;
  let repository: PostgresRepository;
  let telegramStore: TelegramNotificationStore;
  let paperStore: PaperTradingStore;

  beforeAll(async () => {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    testPool = new pg.Pool({
      connectionString: databaseUrl,
      options: `-c search_path=${schema},public`,
      max: 8
    });
    const migrations = (await readdir("scripts/migrations"))
      .filter((filename) => /^\d+.*\.sql$/.test(filename))
      .sort();
    let populatedUpgradeSeeded = false;
    for (const migration of migrations) {
      if (migration === coverageMigration) {
        await seedPopulatedCoverageUpgradeFixture();
        populatedUpgradeSeeded = true;
      }
      if (migration === safeRepairBoundaryMigration) {
        await seedUnsafeRepairBoundaryUpgradeFixture();
      }
      await testPool.query(await readFile(`scripts/migrations/${migration}`, "utf8"));
    }
    if (!populatedUpgradeSeeded) {
      throw new Error(`Expected ${coverageMigration} in the migration set.`);
    }
    repository = new PostgresRepository(testPool);
    telegramStore = new TelegramNotificationStore(testPool);
    paperStore = new PaperTradingStore(testPool);
  }, 120_000);

  afterAll(async () => {
    if (testPool) await testPool.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await adminPool.end();
  });

  it("backfills exact cursor chain time on a populated 037-to-038 upgrade and leaves unknown evidence fail-closed", async () => {
    const result = await testPool.query<{
      address: string;
      last_event_occurred_at: string | Date | null;
    }>(
      `SELECT address, last_event_occurred_at
       FROM ingestion_cursors
       WHERE source = $1
         AND address = ANY($2::text[])
       ORDER BY address`,
      [upgradeFixtureSource, [upgradeExactAddress, upgradeMissingAddress]]
    );

    expect(result.rows).toHaveLength(2);
    const byAddress = new Map(result.rows.map((row) => [row.address, row]));
    expect(
      new Date(String(byAddress.get(upgradeExactAddress)?.last_event_occurred_at)).toISOString()
    ).toBe(upgradeExpectedOccurredAt);
    expect(byAddress.get(upgradeMissingAddress)?.last_event_occurred_at).toBeNull();

    const preflight = await testPool.query<{
      unresolved_count: number;
      preflight_passed: boolean;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE last_event_occurred_at IS NULL)::integer AS unresolved_count,
         BOOL_AND(last_event_occurred_at IS NOT NULL) AS preflight_passed
       FROM ingestion_cursors
       WHERE source = $1
         AND address = ANY($2::text[])`,
      [upgradeFixtureSource, [upgradeExactAddress, upgradeMissingAddress]]
    );
    expect(preflight.rows[0]).toEqual({ unresolved_count: 1, preflight_passed: false });
  });

  it("contains populated migration-044 live-cursor repairs without claiming coverage", async () => {
    const result = await testPool.query<{
      status: string;
      last_error: string;
      closed_at: string | Date | null;
      coverage_reconciled_at: string | Date | null;
      coverage_repair_id: string | null;
    }>(
      `SELECT repair.status, repair.last_error, incident.closed_at,
              incident.coverage_reconciled_at, incident.coverage_repair_id
       FROM ingestion_gap_repairs repair
       JOIN ingestion_coverage_incidents incident
         ON incident.idempotency_key = repair.incident_id
       WHERE repair.repair_id = 'unsafe-upgrade-repair'`
    );
    expect(result.rows[0]).toMatchObject({
      status: "failed",
      last_error: "unsafe-live-cursor-boundary-r16",
      coverage_reconciled_at: null,
      coverage_repair_id: null
    });
    expect(result.rows[0]?.closed_at).not.toBeNull();
  });

  it("serializes concurrent opens and preserves monotonic immutable lifecycle evidence", async () => {
    const first = incidentInput({
      id: "concurrent-coverage-a",
      program: "ConcurrentCoverage111",
      gapStartedAt: "2026-08-21T00:00:00.000Z",
      openedAt: "2026-08-21T00:01:00.000Z"
    });
    const second = { ...first, idempotencyKey: "concurrent-coverage-b" };
    const peerRepository = new PostgresRepository(testPool);

    const [winnerA, winnerB] = await Promise.all([
      repository.openIngestionCoverageIncident(first),
      peerRepository.openIngestionCoverageIncident(second)
    ]);

    expect(winnerA.idempotencyKey).toBe(winnerB.idempotencyKey);
    expect(
      await testPool.query(
        `SELECT COUNT(*)::integer AS count
         FROM ingestion_coverage_incidents
         WHERE provider = $1 AND program_address = $2 AND closed_at IS NULL`,
        [first.provider, first.programAddress]
      )
    ).toMatchObject({ rows: [{ count: 1 }] });

    const incidentId = winnerA.idempotencyKey;
    await expect(
      repository.markIngestionCoverageIncidentRestart(
        incidentId,
        "attempted",
        "2026-08-21T00:01:10.000Z"
      )
    ).resolves.toBe(true);
    await expect(
      repository.markIngestionCoverageIncidentRestart(
        incidentId,
        "completed",
        "2026-08-21T00:01:20.000Z"
      )
    ).resolves.toBe(true);
    await expect(
      testPool.query(
        `UPDATE ingestion_coverage_incidents
         SET restart_attempt_count = 0
         WHERE idempotency_key = $1`,
        [incidentId]
      )
    ).rejects.toThrow(/restart count cannot decrease/);
    await expect(
      testPool.query(
        `UPDATE ingestion_coverage_incidents
         SET restart_attempted_at = '2026-08-21T00:01:11.000Z'
         WHERE idempotency_key = $1`,
        [incidentId]
      )
    ).rejects.toThrow(/first ingestion coverage restart attempt is immutable/);
    await expect(
      testPool.query(
        `UPDATE ingestion_coverage_incidents
         SET last_restart_attempted_at = '2026-08-21T00:01:09.000Z'
         WHERE idempotency_key = $1`,
        [incidentId]
      )
    ).rejects.toThrow(/last ingestion coverage restart attempt cannot move backward/);
    await expect(
      repository.closeIngestionCoverageIncident(incidentId, {
        closedAt: "2026-08-21T00:02:00.000Z",
        clusterSlot: 1_100,
        sourceSlot: 1_099,
        metadata: { proof: "integration" }
      })
    ).resolves.toBe(true);
    await expect(repository.openIngestionCoverageIncident(first)).resolves.toEqual(
      expect.objectContaining({ idempotencyKey: incidentId, closedAt: "2026-08-21T00:02:00.000Z" })
    );

    await expect(
      testPool.query(
        `UPDATE ingestion_coverage_incidents
         SET restart_attempt_count = 0
         WHERE idempotency_key = $1`,
        [incidentId]
      )
    ).rejects.toThrow(/closed ingestion coverage incident evidence is immutable/);
    await expect(
      testPool.query(
        `UPDATE ingestion_coverage_incidents
         SET closed_at = NULL, resolution = NULL, close_metadata = NULL
         WHERE idempotency_key = $1`,
        [incidentId]
      )
    ).rejects.toThrow(/closed ingestion coverage incident evidence is immutable/);

    const truncated = await repository.openIngestionCoverageIncident(
      incidentInput({
        id: "backfill-truncated-coverage",
        program: "TruncatedCoverage111",
        gapStartedAt: "2026-08-21T01:00:00.000Z",
        openedAt: "2026-08-21T01:01:00.000Z",
        reason: "backfill_truncated"
      })
    );
    expect(truncated.reason).toBe("backfill_truncated");
    await expect(
      repository.closeIngestionCoverageIncident(truncated.idempotencyKey, {
        closedAt: "2026-08-21T00:59:00.000Z",
        metadata: { proof: "invalid" }
      })
    ).rejects.toThrow();
    await expect(
      repository.closeIngestionCoverageIncident(truncated.idempotencyKey, {
        closedAt: "2026-08-21T01:02:00.000Z",
        metadata: { proof: "integration" }
      })
    ).resolves.toBe(true);
  });

  it("persists a restart-safe oldest-first repair and requires its completion before reconciliation", async () => {
    const incident = await repository.openIngestionCoverageIncident(
      incidentInput({
        id: "durable-repair-coverage",
        program: "DurableRepairCoverage111",
        gapStartedAt: "2026-08-21T01:00:00.000Z",
        openedAt: "2026-08-21T01:01:00.000Z"
      })
    );
    const repairId = "durable-repair-session-1";
    await repository.getOrCreateIngestionGapRepair({
      repairId,
      incidentId: incident.idempotencyKey,
      provider: incident.provider,
      programAddress: incident.programAddress,
      cursorSignature: "cursor-old",
      cursorSlot: 100,
      boundarySource: "truncation_cursor"
    });
    await repository.stageIngestionGapRepairPage({
      repairId,
      signatures: [
        { signature: "head-new", slot: 103, positionFromHead: 0 },
        { signature: "middle", slot: 102, positionFromHead: 1 },
        { signature: "oldest", slot: 101, positionFromHead: 2 }
      ],
      boundaryReached: true,
      targetSignature: "head-new",
      targetSlot: 103
    });

    expect(
      (await repository.listPendingIngestionGapRepairSignatures(repairId, 3)).map(
        (item) => item.signature
      )
    ).toEqual(["oldest", "middle", "head-new"]);
    await expect(
      repository.closeIngestionCoverageIncident(incident.idempotencyKey, {
        closedAt: "2026-08-21T01:02:00.000Z",
        coverageReconciledAt: "2026-08-21T01:02:00.000Z",
        coverageRepairId: repairId,
        metadata: { proof: "must-not-close-before-replay" }
      })
    ).resolves.toBe(false);

    await repository.completeIngestionGapRepairSignature(repairId, "oldest");
    await repository.completeIngestionGapRepairSignature(repairId, "middle");
    await repository.completeIngestionGapRepairSignature(repairId, "head-new");
    await expect(
      repository.completeIngestionGapRepair(repairId, {
        signature: "moving-live-cursor",
        slot: 999,
        completedAt: "2026-08-21T01:02:20.000Z"
      })
    ).resolves.toBe(false);
    await expect(
      repository.completeIngestionGapRepair(repairId, {
        signature: "head-new",
        slot: 103,
        completedAt: "2026-08-21T01:02:30.000Z"
      })
    ).resolves.toBe(true);
    await expect(
      repository.closeIngestionCoverageIncident(incident.idempotencyKey, {
        closedAt: "2026-08-21T01:02:40.000Z",
        coverageReconciledAt: "2026-08-21T01:02:40.000Z",
        coverageRepairId: repairId,
        metadata: { proof: "must-not-close-before-exact-target-finality" }
      })
    ).resolves.toBe(false);
    await expect(
      repository.verifyIngestionGapRepairTarget(repairId, {
        signature: "head-new",
        slot: 103,
        confirmationStatus: "finalized",
        verifiedAt: "2026-08-21T01:02:45.000Z"
      })
    ).resolves.toBe(true);
    await expect(
      repository.closeIngestionCoverageIncident(incident.idempotencyKey, {
        closedAt: "2026-08-21T01:03:00.000Z",
        coverageReconciledAt: "2026-08-21T01:03:00.000Z",
        coverageRepairId: repairId,
        metadata: { proof: "durable-oldest-first-replay-and-exact-finalized-target" }
      })
    ).resolves.toBe(true);

    const proof = await testPool.query<{
      coverage_repair_id: string;
      coverage_reconciled_at: string | Date;
      repair_status: string;
      confirmation_status: string;
    }>(
      `SELECT incident.coverage_repair_id,
              incident.coverage_reconciled_at,
              repair.status AS repair_status,
              target_proof.confirmation_status
       FROM ingestion_coverage_incidents incident
       JOIN ingestion_gap_repairs repair
         ON repair.repair_id = incident.coverage_repair_id
       JOIN ingestion_gap_repair_target_proofs target_proof
         ON target_proof.repair_id = repair.repair_id
       WHERE incident.idempotency_key = $1`,
      [incident.idempotencyKey]
    );
    expect(proof.rows[0]).toMatchObject({
      coverage_repair_id: repairId,
      repair_status: "completed",
      confirmation_status: "finalized"
    });
    expect(new Date(proof.rows[0]!.coverage_reconciled_at).toISOString()).toBe(
      "2026-08-21T01:03:00.000Z"
    );
  });

  it("excludes the closed gap interval while admitting later and different-program pools", async () => {
    const now = Date.now();
    const program = "StrictCoverageProgram111";
    const gapStartedAt = iso(now - 12 * 60_000);
    const openedAt = iso(now - 11 * 60_000);
    const inGapAt = iso(now - 9 * 60_000);
    const closedAt = iso(now - 8 * 60_000);
    const afterGapAt = iso(now - 6 * 60_000);
    const opened = await repository.openIngestionCoverageIncident(
      incidentInput({ id: "strict-temporal-gap", program, gapStartedAt, openedAt })
    );
    await repository.closeIngestionCoverageIncident(opened.idempotencyKey, {
      closedAt,
      metadata: { proof: "integration" }
    });

    await seedStrictPool({
      token: "StrictInGapMint111",
      pool: "StrictInGapPool111",
      program,
      createdAt: inGapAt
    });
    await seedStrictPool({
      token: "StrictBoundaryMint111",
      pool: "StrictBoundaryPool111",
      program,
      createdAt: closedAt
    });
    await seedStrictPool({
      token: "StrictAfterMint111",
      pool: "StrictAfterPool111",
      program,
      createdAt: afterGapAt
    });
    await seedStrictPool({
      token: "StrictOtherMint111",
      pool: "StrictOtherPool111",
      program: "StrictOtherProgram111",
      createdAt: inGapAt
    });

    const result = await telegramStore.enqueueQualifiedPools({
      startedAt: iso(now - 15 * 60_000),
      maxAgeMinutes: 30,
      minimumLiquidityUsd: 10_000,
      minimumVolume5mUsd: 5_000,
      excludedTokenAddresses: ["So11111111111111111111111111111111111111112"]
    });
    expect(result.inserted).toBe(2);
    const rows = await testPool.query<{ source_key: string }>(
      `SELECT source_key
       FROM telegram_notification_outbox
       WHERE event_type = 'qualified-pool'
         AND source_key LIKE 'strict-flow-v2-20260817:Strict%'
       ORDER BY source_key`
    );
    expect(rows.rows.map((row) => row.source_key)).toEqual([
      "strict-flow-v2-20260817:StrictAfterMint111",
      "strict-flow-v2-20260817:StrictOtherMint111"
    ]);
    const claimed = await telegramStore.claim({
      workerId: "temporal-worker",
      limit: 10,
      leaseSeconds: 60
    });
    expect(claimed).toHaveLength(2);
    for (const message of claimed) {
      expect(await telegramStore.complete(message.id, "temporal-worker")).toBe(true);
    }
  });

  it("never claims more than the bounded suppression batch of coverage-tainted messages", async () => {
    const now = Date.now();
    const program = "SuppressionCoverageProgram111";
    await repository.openIngestionCoverageIncident(
      incidentInput({
        id: "suppression-open-gap",
        program,
        gapStartedAt: iso(now - 30 * 60_000),
        openedAt: iso(now - 29 * 60_000)
      })
    );

    for (let index = 0; index < 22; index += 1) {
      const token = `SuppressedMint${index}`;
      const pool = `SuppressedPool${index}`;
      const createdAt = iso(now - 20 * 60_000 + index * 1_000);
      await seedStrictPool({ token, pool, program, createdAt });
      await insertQualifiedMessage({
        id: `suppressed-message-${index}`,
        token,
        pool,
        program,
        createdAt,
        qualificationVersion: "strict-flow-v2-20260817",
        outboxCreatedAt: iso(now - 60 * 60_000 + index * 1_000)
      });
    }
    await insertQualifiedMessage({
      id: "suppressed-malformed-message",
      token: "MissingCanonicalMint111",
      pool: "MissingCanonicalPool111",
      program,
      createdAt: "not-a-timestamp",
      qualificationVersion: "strict-flow-v2-20260817",
      outboxCreatedAt: iso(now - 59 * 60_000)
    });
    const unknownTime = iso(now - 18 * 60_000);
    await seedStrictPool({
      token: "SuppressedUnknownTimeMint111",
      pool: "SuppressedUnknownTimePool111",
      program: "SuppressionHealthyProgram111",
      createdAt: unknownTime
    });
    await testPool.query(
      `UPDATE pools SET created_at = NULL
       WHERE chain = 'solana' AND pool_address = 'SuppressedUnknownTimePool111'`
    );
    await insertQualifiedMessage({
      id: "suppressed-unknown-time-message",
      token: "SuppressedUnknownTimeMint111",
      pool: "SuppressedUnknownTimePool111",
      program: "SuppressionHealthyProgram111",
      createdAt: unknownTime,
      qualificationVersion: "strict-flow-v2-20260817",
      outboxCreatedAt: iso(now - 58 * 60_000)
    });
    const healthyCreatedAt = iso(now - 10 * 60_000);
    await seedStrictPool({
      token: "SuppressionHealthyMint111",
      pool: "SuppressionHealthyPool111",
      program: "SuppressionHealthyProgram111",
      createdAt: healthyCreatedAt
    });
    await insertQualifiedMessage({
      id: "suppression-healthy-message",
      token: "SuppressionHealthyMint111",
      pool: "SuppressionHealthyPool111",
      program: "SuppressionHealthyProgram111",
      createdAt: healthyCreatedAt,
      qualificationVersion: "strict-flow-v2-20260817",
      outboxCreatedAt: iso(now - 5 * 60_000)
    });

    const firstClaim = await telegramStore.claim({
      workerId: "suppression-worker",
      limit: 1,
      leaseSeconds: 60
    });
    expect(firstClaim.map((message) => message.id)).toEqual(["suppression-healthy-message"]);
    expect(await telegramStore.complete(firstClaim[0]!.id, "suppression-worker")).toBe(true);
    expect(
      await testPool.query<{ status: string; count: number }>(
        `SELECT status, COUNT(*)::integer AS count
         FROM telegram_notification_outbox
         WHERE id LIKE 'suppressed-%'
         GROUP BY status
         ORDER BY status`
      )
    ).toMatchObject({
      rows: [
        { status: "pending", count: 4 },
        { status: "suppressed", count: 20 }
      ]
    });

    await expect(
      telegramStore.claim({ workerId: "suppression-worker", limit: 1, leaseSeconds: 60 })
    ).resolves.toEqual([]);
    expect(
      await testPool.query<{ count: number }>(
        `SELECT COUNT(*)::integer AS count
         FROM telegram_notification_outbox
         WHERE id LIKE 'suppressed-%'
           AND status = 'suppressed'`
      )
    ).toMatchObject({ rows: [{ count: 24 }] });
  });

  it("rechecks claimed Telegram and paper candidates against canonical exact-pool coverage", async () => {
    const now = Date.now();
    const version = "coverage-paper-v1";
    const activatedAt = iso(now - 60 * 60_000);
    await paperStore.initializePortfolio({
      strategyVersion: version,
      startingBalanceUsd: 100,
      activatedAt,
      config: { integration: true }
    });

    const claimedCreatedAt = iso(now - 10 * 60_000);
    await seedStrictPool({
      token: "ClaimRaceMint111",
      pool: "ClaimRacePool111",
      program: "ClaimRaceProgram111",
      createdAt: claimedCreatedAt
    });
    await insertQualifiedMessage({
      id: "claim-race-message",
      token: "ClaimRaceMint111",
      pool: "ClaimRacePool111",
      program: "ClaimRaceProgram111",
      createdAt: claimedCreatedAt,
      qualificationVersion: "strict-flow-v2-20260817"
    });
    const claimed = await telegramStore.claim({
      workerId: "claim-race-worker",
      limit: 1,
      leaseSeconds: 60
    });
    expect(claimed[0]?.id).toBe("claim-race-message");
    await repository.openIngestionCoverageIncident(
      incidentInput({
        id: "claim-race-gap",
        program: "ClaimRaceProgram111",
        gapStartedAt: iso(now - 20 * 60_000),
        openedAt: iso(now - 5 * 60_000)
      })
    );
    await expect(
      telegramStore.suppressClaimedCoverageTainted("claim-race-message", "claim-race-worker")
    ).resolves.toBe(true);

    const gapAt = iso(now - 15 * 60_000);
    const raceAt = iso(now - 12 * 60_000);
    const cleanAt = iso(now - 9 * 60_000);
    await seedStrictPool({
      token: "PaperGapMint111",
      pool: "PaperGapPool111",
      program: "PaperGapProgram111",
      createdAt: gapAt
    });
    await seedStrictPool({
      token: "PaperRaceMint111",
      pool: "PaperRacePool111",
      program: "PaperRaceProgram111",
      createdAt: raceAt
    });
    await seedStrictPool({
      token: "PaperCleanMint111",
      pool: "PaperCleanPool111",
      program: "PaperCleanProgram111",
      createdAt: cleanAt
    });
    await seedStrictPool({
      token: "PaperNullTimeMint111",
      pool: "PaperNullTimePool111",
      program: "PaperNullTimeProgram111",
      createdAt: cleanAt
    });
    await testPool.query(
      `UPDATE pools SET created_at = NULL
       WHERE chain = 'solana' AND pool_address = 'PaperNullTimePool111'`
    );
    await repository.openIngestionCoverageIncident(
      incidentInput({
        id: "paper-existing-gap",
        program: "PaperGapProgram111",
        gapStartedAt: iso(now - 20 * 60_000),
        openedAt: iso(now - 14 * 60_000)
      })
    );
    for (const candidate of [
      ["paper-gap-message", "PaperGapMint111", "PaperGapPool111", "PaperGapProgram111", gapAt],
      ["paper-race-message", "PaperRaceMint111", "PaperRacePool111", "PaperRaceProgram111", raceAt],
      [
        "paper-clean-message",
        "PaperCleanMint111",
        "PaperCleanPool111",
        "PaperCleanProgram111",
        cleanAt
      ],
      [
        "paper-null-time-message",
        "PaperNullTimeMint111",
        "PaperNullTimePool111",
        "PaperNullTimeProgram111",
        cleanAt
      ]
    ] as const) {
      await insertQualifiedMessage({
        id: candidate[0],
        token: candidate[1],
        pool: candidate[2],
        program: candidate[3],
        createdAt: candidate[4],
        qualificationVersion: version,
        status: "delivered"
      });
    }
    await insertQualifiedMessage({
      id: "paper-missing-message",
      token: "PaperMissingMint111",
      pool: "PaperMissingPool111",
      program: "PaperMissingProgram111",
      createdAt: "invalid-legacy-value",
      qualificationVersion: version,
      status: "delivered"
    });

    const candidates = await paperStore.listQualifiedPoolCandidates(version, 0, 10, version);
    expect(
      Object.fromEntries(
        candidates.map((candidate) => [
          candidate.notificationId,
          candidate.currentDiscoveryCoveragePassed
        ])
      )
    ).toEqual({
      "paper-gap-message": false,
      "paper-race-message": true,
      "paper-clean-message": true,
      "paper-null-time-message": false,
      "paper-missing-message": false
    });
    await expect(
      paperStore.isQualifiedPoolCandidateCoverageEligible("paper-gap-message")
    ).resolves.toBe(false);
    await expect(
      paperStore.isQualifiedPoolCandidateCoverageEligible("paper-missing-message")
    ).resolves.toBe(false);
    await expect(
      paperStore.isQualifiedPoolCandidateCoverageEligible("paper-null-time-message")
    ).resolves.toBe(false);
    await expect(
      recordOpening("paper-null-time-message", "PaperNullTimeMint111", "paper-null-time-trade")
    ).resolves.toBe(false);

    await repository.openIngestionCoverageIncident(
      incidentInput({
        id: "paper-late-race-gap",
        program: "PaperRaceProgram111",
        gapStartedAt: iso(now - 20 * 60_000),
        openedAt: iso(now - 4 * 60_000)
      })
    );
    await expect(
      paperStore.isQualifiedPoolCandidateCoverageEligible("paper-race-message")
    ).resolves.toBe(false);
    await expect(
      recordOpening("paper-race-message", "PaperRaceMint111", "paper-race-trade")
    ).resolves.toBe(false);
    expect(
      await testPool.query<{ count: number }>(
        `SELECT COUNT(*)::integer AS count FROM paper_trades WHERE id = 'paper-race-trade'`
      )
    ).toMatchObject({ rows: [{ count: 0 }] });

    await expect(
      recordOpening(
        "paper-clean-message",
        "PaperCleanMint111",
        "paper-clean-wrong-version-trade",
        version,
        "wrong-qualification-version"
      )
    ).resolves.toBe(false);
    await expect(
      recordOpening(
        "paper-clean-message",
        "PaperCleanMint111",
        "paper-clean-missing-version-trade",
        version,
        ""
      )
    ).resolves.toBe(false);
    await expect(
      recordOpening("paper-clean-message", "PaperCleanMint111", "paper-clean-trade")
    ).resolves.toBe(true);
  });

  it("serializes a concurrently committing incident before the final paper opening guard", async () => {
    const now = Date.now();
    const version = "coverage-paper-lock-v1";
    const program = "PaperLockProgram111";
    const token = "PaperLockMint111";
    const poolAddress = "PaperLockPool111";
    const messageId = "paper-lock-message";
    const tradeId = "paper-lock-trade";
    const createdAt = iso(now - 10 * 60_000);
    await paperStore.initializePortfolio({
      strategyVersion: version,
      startingBalanceUsd: 100,
      activatedAt: iso(now - 60 * 60_000),
      config: { integration: true }
    });
    await seedStrictPool({ token, pool: poolAddress, program, createdAt });
    await insertQualifiedMessage({
      id: messageId,
      token,
      pool: poolAddress,
      program,
      createdAt,
      qualificationVersion: version,
      status: "delivered"
    });

    const incidentClient = await testPool.connect();
    try {
      await incidentClient.query("BEGIN");
      await incidentClient.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('walletscaner:discovery-coverage:' || $1::text, 0)
         )`,
        [program]
      );
      const opening = recordOpening(messageId, token, tradeId, version, version);
      await waitForAdvisoryWaiter();
      await incidentClient.query(
        `INSERT INTO ingestion_coverage_incidents (
           idempotency_key, chain, provider, program_address, reason,
           gap_started_at, opened_at, subscription_ack_timeout_count,
           successful_subscription_ack_count, open_metadata
         ) VALUES (
           'paper-lock-incident', 'solana', 'solana-rpc-discovery', $1,
           'head_slot_lag', $2, $3, 0, 1,
           '{"coverageDisposition":"alpha_excluded_unreconciled"}'::jsonb
         )`,
        [program, iso(now - 20 * 60_000), iso(now - 5 * 60_000)]
      );
      await incidentClient.query("COMMIT");

      await expect(opening).resolves.toBe(false);
      expect(
        await testPool.query<{ count: number }>(
          `SELECT COUNT(*)::integer AS count FROM paper_trades WHERE id = $1`,
          [tradeId]
        )
      ).toMatchObject({ rows: [{ count: 0 }] });
    } catch (error) {
      await incidentClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      incidentClient.release();
    }
  });

  async function seedStrictPool(input: {
    token: string;
    pool: string;
    program: string;
    createdAt: string;
  }): Promise<void> {
    await testPool.query(
      `INSERT INTO tokens (chain, address, symbol, name, first_seen_at)
       VALUES ('solana', $1, 'TEST', 'Coverage Test', $2)`,
      [input.token, input.createdAt]
    );
    await testPool.query(
      `INSERT INTO pools (
         chain, pool_address, dex, base_token_address, quote_token_address,
         created_at, liquidity_usd, token_symbol, token_name, volume_5m_usd,
         price_usd, market_cap_usd, raw
       ) VALUES (
         'solana', $1, $2, $3, 'So11111111111111111111111111111111111111112',
         $4, 25000, 'TEST', 'Coverage Test', 8000, 0.001, 100000,
         '{"buys5m":11,"sells5m":9,"tradeCoverage":{"complete":true}}'::jsonb
       )`,
      [input.pool, input.program, input.token, input.createdAt]
    );
    await testPool.query(
      `INSERT INTO token_risk_assessments (
         chain, token_address, calculated_at, score, risk_score, confidence,
         sub_scores, reasons, warnings
       ) VALUES (
         'solana', $1, NOW(), 100, 0, 90,
         '{"holderDistribution":82}', '["passed"]', '[]'
       )`,
      [input.token]
    );
  }

  async function seedPopulatedCoverageUpgradeFixture(): Promise<void> {
    await testPool.query(
      `INSERT INTO chain_event_inbox (
         idempotency_key, chain, signature, slot, transaction_index, instruction_index,
         event_type, occurred_at, received_at, processed_at, commitment, source,
         decoder_version, status, payload
       ) VALUES
         (
           'coverage-upgrade-exact-event', 'solana', 'coverage-upgrade-exact-signature',
           91001, 0, 0, 'solana_transaction', $1, $2, $2, 'confirmed',
           'coverage-upgrade-fixture', 'coverage-upgrade-v1', 'processed', '{}'::jsonb
         ),
         (
           'coverage-upgrade-wrong-signature', 'solana', 'coverage-upgrade-other-signature',
           91001, 0, 0, 'solana_transaction', '2026-08-21T06:50:00.000Z', $2, $2,
           'confirmed', 'coverage-upgrade-fixture', 'coverage-upgrade-v1', 'processed', '{}'::jsonb
         ),
         (
           'coverage-upgrade-wrong-slot', 'solana', 'coverage-upgrade-exact-signature',
           91000, 0, 0, 'solana_transaction', '2026-08-21T06:49:00.000Z', $2, $2,
           'confirmed', 'coverage-upgrade-fixture', 'coverage-upgrade-v1', 'processed', '{}'::jsonb
         ),
         (
           'coverage-upgrade-wrong-chain', 'not-solana', 'coverage-upgrade-exact-signature',
           91001, 0, 0, 'solana_transaction', '2026-08-21T06:48:00.000Z', $2, $2,
           'confirmed', 'coverage-upgrade-fixture', 'coverage-upgrade-v1', 'processed', '{}'::jsonb
         ),
         (
           'coverage-upgrade-missing-near-match', 'solana', 'coverage-upgrade-missing-signature',
           92000, 0, 0, 'solana_transaction', '2026-08-21T06:47:00.000Z', $2, $2,
           'confirmed', 'coverage-upgrade-fixture', 'coverage-upgrade-v1', 'processed', '{}'::jsonb
         )`,
      [upgradeExpectedOccurredAt, "2026-08-21T07:00:00.000Z"]
    );
    await testPool.query(
      `INSERT INTO ingestion_cursors (
         source, address, chain, last_signature, last_slot, idempotency_key,
         signature, slot, provider, observed_at, strategy_version
       ) VALUES
         (
           $1, $2, 'solana', 'coverage-upgrade-exact-signature', 91001,
           'coverage-upgrade-exact-cursor', 'coverage-upgrade-exact-signature', 91001,
           'coverage-upgrade-provider', '2026-08-21T07:01:00.000Z', 'coverage-upgrade-v1'
         ),
         (
           $1, $3, 'solana', 'coverage-upgrade-missing-signature', 92001,
           'coverage-upgrade-missing-cursor', 'coverage-upgrade-missing-signature', 92001,
           'coverage-upgrade-provider', '2026-08-21T07:01:00.000Z', 'coverage-upgrade-v1'
         )`,
      [upgradeFixtureSource, upgradeExactAddress, upgradeMissingAddress]
    );
  }

  async function seedUnsafeRepairBoundaryUpgradeFixture(): Promise<void> {
    await testPool.query(
      `INSERT INTO ingestion_coverage_incidents (
         idempotency_key, chain, provider, program_address, reason,
         gap_started_at, opened_at, subscription_ack_timeout_count,
         successful_subscription_ack_count, open_metadata
       ) VALUES (
         'unsafe-upgrade-incident', 'solana', 'solana-rpc-discovery',
         'UnsafeUpgradeProgram111', 'backfill_truncated',
         '2026-08-24T06:00:00.000Z', '2026-08-24T06:01:00.000Z',
         0, 1, '{"coverageDisposition":"alpha_excluded_unreconciled"}'::jsonb
       )`
    );
    await testPool.query(
      `INSERT INTO ingestion_gap_repairs (
         repair_id, incident_id, provider, program_address,
         cursor_signature, cursor_slot, status, boundary_reached,
         fetched_signature_count, completed_signature_count
       ) VALUES (
         'unsafe-upgrade-repair', 'unsafe-upgrade-incident',
         'solana-rpc-discovery', 'UnsafeUpgradeProgram111',
         'already-advanced-live-cursor', 500, 'collecting', FALSE, 0, 0
       )`
    );
  }

  async function insertQualifiedMessage(input: {
    id: string;
    token: string;
    pool: string;
    program: string;
    createdAt: string;
    qualificationVersion: string;
    status?: "pending" | "delivered";
    outboxCreatedAt?: string;
  }): Promise<void> {
    const payload: QualifiedPoolNotification = {
      qualificationVersion: input.qualificationVersion,
      tokenAddress: input.token,
      poolAddress: input.pool,
      tokenSymbol: "TEST",
      tokenName: "Coverage Test",
      dex: input.program,
      createdAt: input.createdAt,
      liquidityUsd: 25_000,
      volume5mUsd: 8_000,
      priceUsd: 0.001,
      riskScore: 0,
      riskConfidence: 90
    };
    const status = input.status ?? "pending";
    await testPool.query(
      `INSERT INTO telegram_notification_outbox (
         id, event_type, source_key, payload, status, created_at, delivered_at
       ) VALUES (
         $1, 'qualified-pool', $2, $3::jsonb, $4, COALESCE($5::timestamptz, NOW()),
         CASE WHEN $4 = 'delivered' THEN NOW() ELSE NULL END
       )`,
      [
        input.id,
        `${input.qualificationVersion}:${input.token}`,
        JSON.stringify(payload),
        status,
        input.outboxCreatedAt ?? null
      ]
    );
  }

  async function recordOpening(
    signalId: string,
    tokenAddress: string,
    tradeId: string,
    strategyVersion = "coverage-paper-v1",
    qualificationVersion = strategyVersion
  ): Promise<boolean> {
    const occurredAt = new Date().toISOString();
    const trade: PaperTrade = {
      id: tradeId,
      signalId,
      strategyVersion,
      chain: "solana",
      tokenAddress,
      side: "buy",
      status: "open",
      quantity: 1_000,
      priceUsd: 0.001,
      notionalUsd: 6,
      feesUsd: 0.018,
      slippageBps: 250,
      openedAt: occurredAt,
      reason: "integration",
      raw: {}
    };
    return paperStore.recordTradeEvent(
      trade,
      {
        id: `${tradeId}:opened`,
        tradeId,
        strategyVersion: trade.strategyVersion,
        eventType: "opened",
        quantity: trade.quantity,
        priceUsd: trade.priceUsd,
        grossValueUsd: trade.notionalUsd - trade.feesUsd,
        feesUsd: trade.feesUsd,
        cashDeltaUsd: -trade.notionalUsd,
        realizedPnlUsd: 0,
        slippageBps: trade.slippageBps,
        occurredAt,
        reason: trade.reason
      },
      { qualificationVersion }
    );
  }

  async function waitForAdvisoryWaiter(): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await testPool.query<{ count: number }>(
        `SELECT COUNT(*)::integer AS count
         FROM pg_locks
         WHERE locktype = 'advisory' AND NOT granted`
      );
      if ((waiting.rows[0]?.count ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Paper opening did not wait on the incident advisory lock.");
  }
});

function incidentInput(input: {
  id: string;
  program: string;
  gapStartedAt: string;
  openedAt: string;
  reason?: IngestionCoverageIncidentOpenInput["reason"];
}): IngestionCoverageIncidentOpenInput {
  return {
    idempotencyKey: input.id,
    chain: "solana",
    provider: "solana-rpc-discovery",
    programAddress: input.program,
    reason: input.reason ?? "head_slot_lag",
    gapStartedAt: input.gapStartedAt,
    openedAt: input.openedAt,
    clusterSlot: 1_000,
    sourceSlot: 700,
    slotLag: 300,
    subscriptionAckTimeoutCount: 0,
    successfulSubscriptionAckCount: 1,
    metadata: { coverageDisposition: "alpha_excluded_unreconciled" }
  };
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}
