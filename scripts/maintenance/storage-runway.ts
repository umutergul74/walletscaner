import { readFile, rename, writeFile } from "node:fs/promises";

export interface StorageSample {
  checkedAt: string;
  databaseBytes: number;
  diskAvailableBytes: number;
}

export interface StorageRunway {
  sampleCount: number;
  spanHours: number;
  databaseGrowthBytesPerDay: number | null;
  diskConsumptionBytesPerDay: number | null;
  conservativeGrowthBytesPerDay: number | null;
  reserveBytes: number;
  runwayDays: number | null;
  mature: boolean;
  windows: {
    recent24h: StorageGrowthWindow;
    baseline7d: StorageGrowthWindow;
  };
}

export interface StorageGrowthWindow {
  sampleCount: number;
  spanHours: number;
  databaseGrowthBytesPerDay: number | null;
  diskConsumptionBytesPerDay: number | null;
  mature: boolean;
}

const HOUR_MS = 3_600_000;

export async function updateStorageHistory(
  path: string,
  current: StorageSample,
  options: { reserveBytes: number; minimumSpanHours?: number; retentionDays?: number }
): Promise<StorageRunway> {
  const minimumSpanHours = options.minimumSpanHours ?? 24;
  const retentionDays = options.retentionDays ?? 30;
  const currentMs = validTimestamp(current.checkedAt);
  const cutoffMs = currentMs - retentionDays * 24 * HOUR_MS;
  const existing = await readStorageHistory(path);
  const retained = existing.filter((sample) => validTimestamp(sample.checkedAt) >= cutoffMs);
  const last = retained.at(-1);
  const shouldPersist = !last || currentMs - validTimestamp(last.checkedAt) >= HOUR_MS;
  const samples = shouldPersist ? [...retained, current] : [...retained, current];
  if (shouldPersist) {
    const body = `${[...retained, current].map((sample) => JSON.stringify(sample)).join("\n")}\n`;
    await writeFile(`${path}.tmp`, body);
    await rename(`${path}.tmp`, path);
  }
  return calculateStorageRunway(samples, options.reserveBytes, minimumSpanHours);
}

export function calculateStorageRunway(
  samples: StorageSample[],
  reserveBytes: number,
  minimumSpanHours = 24
): StorageRunway {
  const ordered = [...samples]
    .filter(isValidSample)
    .sort((a, b) => validTimestamp(a.checkedAt) - validTimestamp(b.checkedAt));
  const first = ordered[0];
  const latest = ordered.at(-1);
  const spanHours =
    first && latest
      ? Math.max(0, (validTimestamp(latest.checkedAt) - validTimestamp(first.checkedAt)) / HOUR_MS)
      : 0;
  const recent24h = calculateGrowthWindow(
    selectTrailingWindow(ordered, 24),
    minimumSpanHours
  );
  const baseline7d = calculateGrowthWindow(
    selectTrailingWindow(ordered, 7 * 24),
    minimumSpanHours
  );
  const mature = recent24h.mature;
  // A cleanup inside the longer history must not erase a current leak. Use the
  // fastest positive rate seen in either the operational 24-hour window or the
  // seven-day baseline. Negative rates are reported as zero, never as runway.
  const databaseGrowthBytesPerDay = maximumMeasuredRate(
    recent24h.databaseGrowthBytesPerDay,
    baseline7d.databaseGrowthBytesPerDay
  );
  const diskConsumptionBytesPerDay = maximumMeasuredRate(
    recent24h.diskConsumptionBytesPerDay,
    baseline7d.diskConsumptionBytesPerDay
  );
  const conservativeGrowthBytesPerDay =
    databaseGrowthBytesPerDay === null || diskConsumptionBytesPerDay === null
      ? null
      : Math.max(databaseGrowthBytesPerDay, diskConsumptionBytesPerDay);
  const runwayDays =
    latest && conservativeGrowthBytesPerDay !== null && conservativeGrowthBytesPerDay > 0
      ? Math.max(0, latest.diskAvailableBytes - reserveBytes) / conservativeGrowthBytesPerDay
      : null;
  return {
    sampleCount: ordered.length,
    spanHours: round(spanHours),
    databaseGrowthBytesPerDay:
      databaseGrowthBytesPerDay === null ? null : Math.round(databaseGrowthBytesPerDay),
    diskConsumptionBytesPerDay:
      diskConsumptionBytesPerDay === null ? null : Math.round(diskConsumptionBytesPerDay),
    conservativeGrowthBytesPerDay:
      conservativeGrowthBytesPerDay === null
        ? null
        : Math.round(conservativeGrowthBytesPerDay),
    reserveBytes,
    runwayDays: runwayDays === null ? null : round(runwayDays),
    mature,
    windows: { recent24h, baseline7d }
  };
}

function calculateGrowthWindow(
  samples: StorageSample[],
  minimumSpanHours: number
): StorageGrowthWindow {
  const first = samples[0];
  const latest = samples.at(-1);
  const spanHours =
    first && latest
      ? Math.max(0, (validTimestamp(latest.checkedAt) - validTimestamp(first.checkedAt)) / HOUR_MS)
      : 0;
  const mature = samples.length >= 2 && spanHours >= minimumSpanHours;
  const databaseGrowthBytesPerDay = mature
    ? Math.max(0, linearSlopePerDay(samples, (sample) => sample.databaseBytes))
    : null;
  const availableSlope = mature
    ? linearSlopePerDay(samples, (sample) => sample.diskAvailableBytes)
    : null;
  return {
    sampleCount: samples.length,
    spanHours: round(spanHours),
    databaseGrowthBytesPerDay:
      databaseGrowthBytesPerDay === null ? null : Math.round(databaseGrowthBytesPerDay),
    diskConsumptionBytesPerDay:
      availableSlope === null ? null : Math.round(Math.max(0, -availableSlope)),
    mature
  };
}

function selectTrailingWindow(samples: StorageSample[], windowHours: number): StorageSample[] {
  const latest = samples.at(-1);
  if (!latest) return [];
  const cutoff = validTimestamp(latest.checkedAt) - windowHours * HOUR_MS;
  const firstInside = samples.findIndex((sample) => validTimestamp(sample.checkedAt) >= cutoff);
  if (firstInside <= 0) return samples;
  if (validTimestamp(samples[firstInside]!.checkedAt) === cutoff) {
    return samples.slice(firstInside);
  }
  // Keep the sample immediately before the cutoff so an hourly monitor still
  // has a true >=24h span instead of oscillating between 23h and 24h maturity.
  return samples.slice(firstInside - 1);
}

function maximumMeasuredRate(...rates: Array<number | null>): number | null {
  const measured = rates.filter((rate): rate is number => rate !== null);
  return measured.length === 0 ? null : Math.max(...measured);
}

async function readStorageHistory(path: string): Promise<StorageSample[]> {
  try {
    return (await readFile(path, "utf8"))
      .split(/\r?\n/u)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as StorageSample;
          return isValidSample(parsed) ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function linearSlopePerDay(
  samples: StorageSample[],
  value: (sample: StorageSample) => number
): number {
  const origin = validTimestamp(samples[0]!.checkedAt);
  const points = samples.map((sample) => ({
    day: (validTimestamp(sample.checkedAt) - origin) / (24 * HOUR_MS),
    value: value(sample)
  }));
  const meanDay = points.reduce((sum, point) => sum + point.day, 0) / points.length;
  const meanValue = points.reduce((sum, point) => sum + point.value, 0) / points.length;
  const numerator = points.reduce(
    (sum, point) => sum + (point.day - meanDay) * (point.value - meanValue),
    0
  );
  const denominator = points.reduce(
    (sum, point) => sum + (point.day - meanDay) ** 2,
    0
  );
  return denominator === 0 ? 0 : numerator / denominator;
}

function isValidSample(sample: StorageSample): boolean {
  return (
    Number.isFinite(Date.parse(sample.checkedAt)) &&
    Number.isFinite(sample.databaseBytes) &&
    sample.databaseBytes >= 0 &&
    Number.isFinite(sample.diskAvailableBytes) &&
    sample.diskAvailableBytes >= 0
  );
}

function validTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid storage sample timestamp: ${value}`);
  return timestamp;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
