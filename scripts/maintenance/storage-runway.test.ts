import { describe, expect, it } from "vitest";

import { calculateStorageRunway } from "./storage-runway";

describe("storage runway", () => {
  it("reports a conservative runway from database and filesystem trends", () => {
    const gib = 1024 ** 3;
    const result = calculateStorageRunway(
      [
        {
          checkedAt: "2026-08-14T00:00:00.000Z",
          databaseBytes: 10 * gib,
          diskAvailableBytes: 12 * gib
        },
        {
          checkedAt: "2026-08-15T00:00:00.000Z",
          databaseBytes: 10.5 * gib,
          diskAvailableBytes: 11.25 * gib
        },
        {
          checkedAt: "2026-08-16T00:00:00.000Z",
          databaseBytes: 11 * gib,
          diskAvailableBytes: 10.5 * gib
        }
      ],
      8 * gib
    );
    expect(result.mature).toBe(true);
    expect(result.databaseGrowthBytesPerDay).toBe(Math.round(0.5 * gib));
    expect(result.diskConsumptionBytesPerDay).toBe(Math.round(0.75 * gib));
    expect(result.runwayDays).toBeCloseTo(10 / 3, 2);
    expect(result.windows.recent24h.mature).toBe(true);
  });

  it("does not claim a runway before the observation window matures", () => {
    const result = calculateStorageRunway(
      [
        { checkedAt: "2026-08-16T00:00:00.000Z", databaseBytes: 10, diskAvailableBytes: 20 },
        { checkedAt: "2026-08-16T06:00:00.000Z", databaseBytes: 11, diskAvailableBytes: 19 }
      ],
      8
    );
    expect(result.mature).toBe(false);
    expect(result.runwayDays).toBeNull();
  });

  it("does not let an older reclaim hide current 24-hour growth", () => {
    const gib = 1024 ** 3;
    const samples = Array.from({ length: 7 }, (_, day) => ({
      checkedAt: new Date(Date.UTC(2026, 7, 1 + day)).toISOString(),
      databaseBytes: (20 - day) * gib,
      diskAvailableBytes: (20 + day) * gib
    }));
    samples.push(
      {
        checkedAt: "2026-08-08T00:00:00.000Z",
        databaseBytes: 13 * gib,
        diskAvailableBytes: 28 * gib
      },
      {
        checkedAt: "2026-08-08T12:00:00.000Z",
        databaseBytes: 13.5 * gib,
        diskAvailableBytes: 27.5 * gib
      },
      {
        checkedAt: "2026-08-09T00:00:00.000Z",
        databaseBytes: 14 * gib,
        diskAvailableBytes: 27 * gib
      }
    );

    const result = calculateStorageRunway(samples, 8 * gib);

    expect(result.windows.recent24h.databaseGrowthBytesPerDay).toBe(Math.round(gib));
    expect(result.windows.recent24h.diskConsumptionBytesPerDay).toBe(Math.round(gib));
    expect(result.databaseGrowthBytesPerDay).toBe(Math.round(gib));
    expect(result.diskConsumptionBytesPerDay).toBe(Math.round(gib));
    expect(result.runwayDays).toBe(19);
  });
});
