import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readOperationalHealthSummary } from "./operational-health-summary";

describe("operational health summary", () => {
  it("returns only bounded status fields from a fresh report", async () => {
    const directory = await mkdtemp(join(tmpdir(), "walletscaner-health-"));
    const path = join(directory, "health.json");
    await writeFile(
      path,
      JSON.stringify({
        checkedAt: "2026-08-25T09:00:00.000Z",
        status: "degraded",
        reasons: ["backup stale"],
        pipeline: { chainPayloadCompactionLagSeconds: 123 },
        archive: {
          walletEvidence: {
            pendingSegments: 4,
            lagSeconds: 321,
            compactPendingDays: 2,
            compactMismatchDays: 0,
            compactRetryDays: 1,
            compactLagSeconds: 90
          }
        },
        backup: { ageSeconds: 456, offsiteAcknowledged: false },
        resources: { diskAvailableBytes: 789, diskUsedPercent: 75, databaseBytes: 999 },
        ignored: { secret: "must-not-propagate" }
      })
    );

    await expect(
      readOperationalHealthSummary(path, 15 * 60_000, Date.parse("2026-08-25T09:05:00.000Z"))
    ).resolves.toEqual({
      checkedAt: "2026-08-25T09:00:00.000Z",
      status: "degraded",
      reasons: ["backup stale"],
      diskAvailableBytes: 789,
      diskUsedPercent: 75,
      databaseBytes: 999,
      chainPayloadCompactionLagSeconds: 123,
      walletArchivePendingSegments: 4,
      walletArchiveLagSeconds: 321,
      walletCompactPendingDays: 2,
      walletCompactMismatchDays: 0,
      walletCompactRetryDays: 1,
      walletCompactLagSeconds: 90,
      backupAgeSeconds: 456,
      backupOffsiteAcknowledged: false
    });
  });

  it("fails closed when the report is missing or stale", async () => {
    await expect(readOperationalHealthSummary("missing-health.json", 1, 10)).resolves.toMatchObject(
      {
        status: "unavailable"
      }
    );
  });
});
