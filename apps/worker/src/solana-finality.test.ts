import { describe, expect, it, vi } from "vitest";
import type {
  SolanaFinalityBatchResult,
  SolanaFinalityResult,
  SolanaFinalityWorkItem
} from "@memecoin-alpha/db";
import {
  createSolanaFinalityDiagnostics,
  reconcileSolanaFinalityCycle
} from "./solana-finality";

function repository(work: SolanaFinalityWorkItem[]) {
  const persisted: Array<{ signature: string; result: SolanaFinalityResult }> = [];
  return {
    persisted,
    value: {
      reconcileTerminalSolanaFinalityEvents: vi.fn(async () => ({
        checkedSignatures: 0,
        finalizedEvents: 0,
        rolledBackEvents: 0
      })),
      listPendingSolanaFinalities: vi.fn(async () => work),
      recordSolanaFinalities: vi.fn(
        async (results: Array<{ signature: string; result: SolanaFinalityResult }>) => {
        persisted.push(...results);
        return {
          checkedSignatures: results.length,
          finalizedEvents: results.filter((item) => item.result.status === "finalized").length,
          rolledBackEvents: results.filter((item) =>
            ["failed", "unresolved"].includes(item.result.status)
          ).length
        } satisfies SolanaFinalityBatchResult;
        }
      )
    }
  };
}

const work = (signature: string, slot: number, firstSeenAt: string): SolanaFinalityWorkItem => ({
  chain: "solana",
  signature,
  slot,
  firstSeenAt,
  attemptCount: 0
});

describe("Solana finality reconciliation", () => {
  it("finalizes successful rooted signatures and fails transaction errors closed", async () => {
    const repo = repository([
      work("finalized", 100, "2026-08-23T00:00:00.000Z"),
      work("failed", 101, "2026-08-23T00:00:00.000Z")
    ]);
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            context: { slot: 300 },
            value: [
              { slot: 100, err: null, confirmationStatus: "finalized" },
              {
                slot: 101,
                err: { InstructionError: [0, "Custom"] },
                confirmationStatus: "confirmed"
              }
            ]
          }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    await reconcileSolanaFinalityCycle({
      repository: repo.value,
      rpcUrl: "https://rpc.example",
      fetchImpl,
      now: () => new Date("2026-08-23T00:01:00.000Z")
    });

    expect(repo.persisted.map((item) => item.result.status)).toEqual(["finalized", "failed"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rolls an old absent signature back only after the finalized root safety window", async () => {
    const repo = repository([work("missing", 100, "2026-08-23T00:00:00.000Z")]);
    const fetchImpl = vi.fn(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result:
            request.method === "getSlot"
              ? 400
              : { context: { slot: 400 }, value: [null] }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });

    await reconcileSolanaFinalityCycle({
      repository: repo.value,
      rpcUrl: "https://rpc.example",
      fetchImpl,
      now: () => new Date("2026-08-23T00:10:00.000Z"),
      unresolvedAfterSeconds: 300,
      minimumRootDistanceSlots: 150
    });

    expect(repo.persisted[0]?.result).toMatchObject({ status: "unresolved", rootSlot: 400 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps recent confirmed evidence pending", async () => {
    const repo = repository([work("confirmed", 100, "2026-08-23T00:00:55.000Z")]);
    const diagnostics = createSolanaFinalityDiagnostics();
    await reconcileSolanaFinalityCycle(
      {
        repository: repo.value,
        rpcUrl: "https://rpc.example",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: {
                context: { slot: 120 },
                value: [{ slot: 100, err: null, confirmationStatus: "confirmed" }]
              }
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          ),
        now: () => new Date("2026-08-23T00:01:00.000Z")
      },
      diagnostics
    );
    expect(repo.persisted[0]?.result.status).toBe("pending");
    expect(diagnostics.pendingSignatureCount).toBe(1);
  });

  it("reconciles late terminal events even when no signature RPC work remains", async () => {
    const repo = repository([]);
    repo.value.reconcileTerminalSolanaFinalityEvents.mockResolvedValueOnce({
      checkedSignatures: 0,
      finalizedEvents: 7,
      rolledBackEvents: 2
    });
    const fetchImpl = vi.fn();
    const diagnostics = createSolanaFinalityDiagnostics();

    const result = await reconcileSolanaFinalityCycle(
      {
        repository: repo.value,
        rpcUrl: "https://rpc.example",
        fetchImpl
      },
      diagnostics
    );

    expect(result).toEqual({ checkedSignatures: 0, finalizedEvents: 7, rolledBackEvents: 2 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(diagnostics.terminalFinalizedEventCount).toBe(7);
    expect(diagnostics.terminalRolledBackEventCount).toBe(2);
  });
});
