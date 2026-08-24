import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { createRawInstructionPoolDecoder } from "./pool-discovery";
import {
  REVIEWED_SOLANA_VENUE_PROGRAMS,
  WRAPPED_SOL_MINT
} from "./solana-venue-manifest";
import type { SolanaChainEvent } from "./solana-event-source";

describe("reviewed Solana venue manifest", () => {
  it("pins unique program IDs, discriminators and source commits", () => {
    expect(new Set(REVIEWED_SOLANA_VENUE_PROGRAMS.map((item) => item.programId)).size).toBe(5);
    for (const venue of REVIEWED_SOLANA_VENUE_PROGRAMS) {
      expect(venue.sourceCommit).toMatch(/^[0-9a-f]{40}$/u);
      expect(venue.instructions.length).toBeGreaterThan(0);
      expect(
        new Set(venue.instructions.map((instruction) => instruction.discriminatorHex)).size
      ).toBe(venue.instructions.length);
    }
  });

  it("orients canonical token pairs by a reviewed quote mint and captures creator provenance", () => {
    const venue = REVIEWED_SOLANA_VENUE_PROGRAMS.find(
      (item) => item.venue === "meteora-damm-v2"
    )!;
    const definition = venue.instructions.find(
      (item) => item.name === "damm-initialize-pool"
    )!;
    const accounts = Array.from({ length: 20 }, (_, index) => `Account${index}`);
    accounts[0] = "Creator111";
    accounts[6] = "Pool111";
    accounts[8] = WRAPPED_SOL_MINT;
    accounts[9] = "MemeMint111";
    const [discovery] = createRawInstructionPoolDecoder({
      programId: venue.programId,
      instructions: [definition]
    }).decode(event(venue.programId, accounts, definition.discriminatorHex));

    expect(discovery).toMatchObject({
      poolAddress: "Pool111",
      baseTokenAddress: "MemeMint111",
      quoteTokenAddress: WRAPPED_SOL_MINT,
      creatorAddress: "Creator111"
    });
  });

  it("fails closed when neither canonical mint is a reviewed quote asset", () => {
    const venue = REVIEWED_SOLANA_VENUE_PROGRAMS.find(
      (item) => item.venue === "meteora-dlmm"
    )!;
    const definition = venue.instructions[0]!;
    const accounts = Array.from({ length: 20 }, (_, index) => `UnknownMintOrAccount${index}`);
    expect(
      createRawInstructionPoolDecoder({
        programId: venue.programId,
        instructions: [definition]
      }).decode(event(venue.programId, accounts, definition.discriminatorHex))
    ).toEqual([]);
  });

  it("decodes the pinned Raydium CLMM create-pool account order", () => {
    const venue = REVIEWED_SOLANA_VENUE_PROGRAMS.find(
      (item) => item.venue === "raydium-clmm"
    )!;
    const definition = venue.instructions[0]!;
    const accounts = Array.from({ length: 13 }, (_, index) => `ClmmAccount${index}`);
    accounts[0] = "ClmmCreator111";
    accounts[2] = "ClmmPool111";
    accounts[3] = "ClmmMemeMint111";
    accounts[4] = WRAPPED_SOL_MINT;
    const [discovery] = createRawInstructionPoolDecoder({
      programId: venue.programId,
      instructions: [definition]
    }).decode(event(venue.programId, accounts, definition.discriminatorHex));
    expect(discovery).toMatchObject({
      poolAddress: "ClmmPool111",
      baseTokenAddress: "ClmmMemeMint111",
      quoteTokenAddress: WRAPPED_SOL_MINT,
      creatorAddress: "ClmmCreator111"
    });
  });
});

function event(programId: string, accounts: string[], discriminatorHex: string): SolanaChainEvent {
  return {
    address: programId,
    signature: "venue-signature",
    slot: 123,
    observedAt: "2026-08-23T00:00:00.000Z",
    transaction: {
      blockTime: 1_777_070_400,
      transaction: {
        message: {
          accountKeys: accounts,
          instructions: [
            {
              programId,
              accounts: accounts.map((_account, index) => index),
              data: bs58.encode(Buffer.from(discriminatorHex, "hex"))
            }
          ]
        }
      },
      meta: {}
    }
  };
}
