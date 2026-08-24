import { describe, expect, it, vi } from "vitest";
import {
  CAUSAL_WALLET_SHADOW_QUALIFICATION_VERSION,
  strictQualifiedPoolNotificationPolicy
} from "@memecoin-alpha/shared";
import { TelegramNotificationStore } from "./telegram-notification-store";

describe("TelegramNotificationStore pipeline status", () => {
  it("persists v4 research candidates as non-deliverable shadow decisions", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { scanned_pool_count: 1, risk_passed_pool_count: 1, strict_candidate_count: 1, inserted: 1 }
      ]
    });
    const store = new TelegramNotificationStore({ query } as never);

    await store.enqueueQualifiedPools({
      startedAt: "2026-08-22T00:00:00.000Z",
      maxAgeMinutes: 30,
      minimumLiquidityUsd: 10_000,
      minimumVolume5mUsd: 5_000,
      excludedTokenAddresses: [],
      deliveryMode: "shadow"
    });

    const sql = String(query.mock.calls[0]?.[0]);
    const parameters = query.mock.calls[0]?.[1] as unknown[];
    expect(sql).toContain("id, event_type, source_key, payload, status");
    expect(sql).toContain("'researchMode', $14::text");
    expect(parameters[12]).toBe(CAUSAL_WALLET_SHADOW_QUALIFICATION_VERSION);
    expect(parameters[13]).toBe("shadow");
    expect(parameters[14]).toBe(strictQualifiedPoolNotificationPolicy.version);
    expect(parameters[15]).toBe("shadow");
  });

  it("binds the active wallet-alpha strategy when counting pending work", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          checked_at: "2026-08-20T18:00:00.000Z",
          inbox_backlog: 0,
          dead_letters: 0,
          alpha_queue_pending: 3,
          signals_24h: 0,
          qualified_pools_24h: 0,
          last_pool_age_seconds: 30,
          last_wallet_trade_age_seconds: null,
          database_bytes: "1234",
          open_coverage_incident_count: 0,
          open_coverage_incidents: []
        }
      ]
    });
    const store = new TelegramNotificationStore({ query } as never);

    const status = await store.getPipelineStatus("  evidence-v1  ");

    expect(status.alphaQueuePending).toBe(3);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("WHERE strategy_version = $2"), [
      strictQualifiedPoolNotificationPolicy.version,
      "evidence-v1"
    ]);
  });

  it("rejects an empty strategy instead of hiding a configuration error", async () => {
    const query = vi.fn();
    const store = new TelegramNotificationStore({ query } as never);

    await expect(store.getPipelineStatus("   ")).rejects.toThrow(
      "Wallet-alpha strategy version is required"
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("fails pipeline status closed when an open discovery coverage incident exists", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          checked_at: "2026-08-21T00:00:00.000Z",
          inbox_backlog: 0,
          dead_letters: 0,
          alpha_queue_pending: 0,
          signals_24h: 0,
          qualified_pools_24h: 0,
          last_pool_age_seconds: 30,
          last_wallet_trade_age_seconds: 30,
          database_bytes: "1234",
          open_coverage_incident_count: 1,
          open_coverage_incidents: [
            {
              incidentId: "incident-1",
              programAddress: "Program111",
              provider: "solana-rpc-discovery",
              reason: "head_slot_lag",
              gapStartedAt: "2026-08-21T00:00:00.000Z",
              openedAt: "2026-08-21T00:00:30.000Z",
              clusterSlot: 1_000,
              sourceSlot: 700,
              slotLag: 300,
              coverageDisposition: "alpha_excluded_unreconciled"
            }
          ]
        }
      ]
    });
    const store = new TelegramNotificationStore({ query } as never);

    const status = await store.getPipelineStatus("evidence-v1");

    expect(status).toMatchObject({
      pipelineStatus: "degraded",
      openCoverageIncidentCount: 1,
      openCoverageIncidents: [
        {
          programAddress: "Program111",
          gapStartedAt: "2026-08-21T00:00:00.000Z",
          coverageDisposition: "alpha_excluded_unreconciled"
        }
      ]
    });
  });

  it("uses canonical exact-pool coverage in both bounded suppression and candidate admission", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const store = new TelegramNotificationStore({ query } as never);

    await store.claim({ workerId: "worker", limit: 5, leaseSeconds: 60 });

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("eligible_qualified AS MATERIALIZED");
    expect(sql).toContain("JOIN pools pool");
    expect(sql).toContain("pool.pool_address = message.payload->>'poolAddress'");
    expect(sql).toContain("pool.created_at IS NOT NULL");
    expect(sql).toContain("OR EXISTS (");
    expect(sql).toContain("LIMIT 20");
    expect(sql).not.toContain("(message.payload->>'createdAt')::timestamptz");
  });

  it("fails a claimed qualified message closed when canonical pool coverage is not provable", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: "message-1" }] });
    const store = new TelegramNotificationStore({ query } as never);

    await expect(store.suppressClaimedCoverageTainted("message-1", "worker")).resolves.toBe(true);

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("AND NOT EXISTS (");
    expect(sql).toContain("FROM pools pool");
    expect(sql).toContain("pool.created_at IS NOT NULL");
    expect(sql).not.toContain("(message.payload->>'createdAt')::timestamptz");
  });
});
