import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("migration 038 ingestion coverage contract", () => {
  it("keeps one open incident per provider/program and preserves unreconciled history", async () => {
    const sql = await readFile("scripts/migrations/038_ingestion_coverage_incidents.sql", "utf8");

    expect(sql).toContain("WHERE closed_at IS NULL");
    expect(sql).toContain("idx_ingestion_coverage_incidents_one_open");
    expect(sql).toContain("transport_recovered_gap_unreconciled");
    expect(sql).toContain("last_event_occurred_at TIMESTAMPTZ");
    expect(sql).toContain("event.slot = cursor.last_slot");
    expect(sql).toContain("event.signature = cursor.last_signature");
    expect(sql).toContain("'backfill_truncated'");
    expect(sql).toContain("'source_start_failed'");
    expect(sql).toContain("'suppressed'");
    expect(sql).toContain("NOT VALID");
    expect(sql).toContain("VALIDATE CONSTRAINT telegram_notification_outbox_status_check");
    expect(sql).toContain("BEFORE UPDATE OR DELETE ON ingestion_coverage_incidents");
    expect(sql).toContain("opening evidence is immutable");
    expect(sql).toContain("closed ingestion coverage incident evidence is immutable");
    expect(sql).toContain("restart count cannot decrease");
    expect(sql).toContain("history is append-only");
    expect(sql).not.toMatch(/DROP\s+TABLE\s+ingestion_coverage_incidents/i);
  });
});
