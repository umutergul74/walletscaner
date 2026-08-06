import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  decodeRaydiumTradeInstructions,
  type RaydiumTradeInstructionDefinition
} from "./raydium-manifest";
import type { SolanaChainEvent } from "./solana-event-source";

const definition: RaydiumTradeInstructionDefinition = {
  name: "fixture-swap",
  programId: "RaydiumFixtureProgram",
  discriminatorHex: "0102030405060708",
  side: "swap",
  traderAccountIndex: 0,
  poolAccountIndex: 1,
  inputMintAccountIndex: 2,
  outputMintAccountIndex: 3,
  infrastructureAccountIndices: [1, 4]
};

describe("decodeRaydiumTradeInstructions", () => {
  it("binds a verified signer to venue instruction and infrastructure evidence", () => {
    const [match] = decodeRaydiumTradeInstructions(event(1), [definition]);

    expect(match).toMatchObject({
      signature: "raydium-fixture-signature",
      transactionIndex: 4,
      instructionIndex: 0,
      name: "fixture-swap",
      poolAddress: "PoolFixture",
      traderAddress: "TraderFixture",
      inputTokenAddress: "InputMintFixture",
      outputTokenAddress: "OutputMintFixture",
      verifiedUserAuthorityAddresses: ["TraderFixture"],
      infrastructureAddresses: ["PoolFixture", "VaultFixture"]
    });
  });

  it("rejects the same instruction when the trader is not a message signer", () => {
    expect(decodeRaydiumTradeInstructions(event(0), [definition])).toEqual([]);
  });
});

function event(numRequiredSignatures: number): SolanaChainEvent {
  const data = bs58.encode(Buffer.from("0102030405060708aabb", "hex"));
  return {
    address: "PoolFixture",
    signature: "raydium-fixture-signature",
    slot: 123,
    transactionIndex: 4,
    occurredAt: "2026-07-11T10:00:00.000Z",
    observedAt: "2026-07-11T10:00:01.000Z",
    commitment: "confirmed",
    source: "fixture",
    transaction: {
      blockTime: 1_783_764_000,
      transaction: {
        message: {
          header: { numRequiredSignatures },
          accountKeys: [
            "TraderFixture",
            "PoolFixture",
            "InputMintFixture",
            "OutputMintFixture",
            "VaultFixture",
            definition.programId
          ],
          instructions: [
            {
              programId: definition.programId,
              accounts: [0, 1, 2, 3, 4],
              data
            }
          ]
        }
      },
      meta: {}
    }
  };
}
