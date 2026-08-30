import { readFile, stat } from "node:fs/promises";

export interface MaintenanceHealth {
  status: string;
  checkedAt: string | null;
  ageSeconds: number | null;
  reason?: string;
}

export function evaluateMaintenanceHealth(
  report: unknown,
  now: Date,
  maximumAgeSeconds: number
): MaintenanceHealth {
  const unavailable: MaintenanceHealth = {
    status: "unknown",
    checkedAt: null,
    ageSeconds: null,
    reason: "maintenance report missing or invalid"
  };
  if (
    !report ||
    typeof report !== "object" ||
    !Number.isFinite(maximumAgeSeconds) ||
    maximumAgeSeconds <= 0 ||
    !Number.isFinite(now.getTime())
  )
    return unavailable;
  const value = report as Record<string, unknown>;
  if (
    value.type !== "operational-maintenance" ||
    typeof value.checkedAt !== "string" ||
    !["completed", "partial", "failed", "dry-run"].includes(String(value.status))
  )
    return unavailable;
  const timestamp = Date.parse(value.checkedAt);
  if (!Number.isFinite(timestamp) || timestamp > now.getTime() + 60_000) return unavailable;
  const ageSeconds = Math.max(0, (now.getTime() - timestamp) / 1_000);
  const result: MaintenanceHealth = {
    status: String(value.status),
    checkedAt: new Date(timestamp).toISOString(),
    ageSeconds
  };
  if (ageSeconds > maximumAgeSeconds) result.reason = "maintenance report stale";
  else if (value.status === "failed") result.reason = "latest maintenance attempt failed";
  else if (value.status === "partial")
    result.reason = "latest maintenance attempt has incomplete stages";
  else if (value.status === "dry-run")
    result.reason = "maintenance is dry-run; retention not applied";
  return result;
}

export async function inspectMaintenanceReport(
  path: string,
  now: Date,
  maximumAgeSeconds: number
): Promise<MaintenanceHealth> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > 64 * 1024) throw new Error("Invalid report size");
    const content = await readFile(path, "utf8");
    if (content.length > 64 * 1024) throw new Error("Invalid report size");
    return evaluateMaintenanceHealth(JSON.parse(content), now, maximumAgeSeconds);
  } catch {
    return evaluateMaintenanceHealth(null, now, maximumAgeSeconds);
  }
}
