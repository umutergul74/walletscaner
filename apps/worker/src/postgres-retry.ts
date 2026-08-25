const TRANSIENT_POSTGRES_CODES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available / lock_timeout
  "57014", // query_canceled / statement_timeout
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03" // cannot_connect_now
]);

export interface PostgresRetryDecision {
  code: string;
  transient: boolean;
  delayMs: number;
}

/**
 * Canonical claims are lease-safe, single-statement transactions. A database
 * abort therefore leaves no partially claimed row and may be retried without
 * advancing a partition cursor. Keep the retry bounded so a persistent schema
 * or connectivity fault is visible in health telemetry instead of creating an
 * unhandled promise rejection that restarts ingestion and opens a coverage gap.
 */
export function canonicalClaimRetryDecision(
  error: unknown,
  consecutiveFailures: number,
  random: () => number = Math.random
): PostgresRetryDecision {
  const code = postgresErrorCode(error);
  const transient = TRANSIENT_POSTGRES_CODES.has(code);
  const baseMs = transient ? 250 : 5_000;
  const maximumMs = transient ? 10_000 : 60_000;
  const exponent = Math.min(6, Math.max(0, Math.trunc(consecutiveFailures) - 1));
  const withoutJitter = Math.min(maximumMs, baseMs * 2 ** exponent);
  const jitter = 0.8 + Math.min(1, Math.max(0, random())) * 0.4;
  return {
    code,
    transient,
    delayMs: Math.max(1, Math.round(withoutJitter * jitter))
  };
}

export function postgresErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return "unknown";
  const code = String(error.code ?? "").trim();
  return code || "unknown";
}
