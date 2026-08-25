import { readFile } from "node:fs/promises";

export interface OperationalHealthSummary {
  checkedAt: string;
  status: "ok" | "degraded" | "down" | "unavailable";
  reasons: string[];
  diskAvailableBytes?: number;
  diskUsedPercent?: number;
  databaseBytes?: number;
  chainPayloadCompactionLagSeconds?: number;
  backupAgeSeconds?: number;
  backupOffsiteAcknowledged?: boolean;
}

export async function readOperationalHealthSummary(
  path = "reports/operational-health.json",
  maximumAgeMs = 15 * 60_000,
  nowMs = Date.now()
): Promise<OperationalHealthSummary> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const checkedAt = stringValue(parsed.checkedAt);
    const checkedAtMs = checkedAt ? new Date(checkedAt).getTime() : Number.NaN;
    if (!checkedAt || !Number.isFinite(checkedAtMs)) {
      return unavailable("operational health report has no valid timestamp", nowMs);
    }
    if (nowMs - checkedAtMs > maximumAgeMs || checkedAtMs - nowMs > 60_000) {
      return unavailable("operational health report is stale", nowMs);
    }
    const reportedStatus = stringValue(parsed.status);
    if (!reportedStatus || !["ok", "degraded", "down"].includes(reportedStatus)) {
      return unavailable("operational health report has an invalid status", nowMs);
    }
    const resources = objectValue(parsed.resources);
    const pipeline = objectValue(parsed.pipeline);
    const backup = objectValue(parsed.backup);
    return {
      checkedAt: new Date(checkedAtMs).toISOString(),
      status: reportedStatus as "ok" | "degraded" | "down",
      reasons: Array.isArray(parsed.reasons)
        ? parsed.reasons
            .filter((reason): reason is string => typeof reason === "string")
            .slice(0, 10)
        : [],
      ...optionalNumber("diskAvailableBytes", resources.diskAvailableBytes),
      ...optionalNumber("diskUsedPercent", resources.diskUsedPercent),
      ...optionalNumber("databaseBytes", resources.databaseBytes),
      ...optionalNumber(
        "chainPayloadCompactionLagSeconds",
        pipeline.chainPayloadCompactionLagSeconds
      ),
      ...optionalNumber("backupAgeSeconds", backup.ageSeconds),
      ...(typeof backup.offsiteAcknowledged === "boolean"
        ? { backupOffsiteAcknowledged: backup.offsiteAcknowledged }
        : {})
    };
  } catch {
    return unavailable("operational health report is unavailable", nowMs);
  }
}

function unavailable(reason: string, nowMs: number): OperationalHealthSummary {
  return {
    checkedAt: new Date(nowMs).toISOString(),
    status: "unavailable",
    reasons: [reason]
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber<Key extends string>(
  key: Key,
  value: unknown
): { [Property in Key]?: number } {
  if (value === null || value === undefined || value === "") return {};
  const number = Number(value);
  return Number.isFinite(number) ? ({ [key]: number } as { [Property in Key]?: number }) : {};
}
