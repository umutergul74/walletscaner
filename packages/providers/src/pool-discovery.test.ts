import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  activePoolSampleDelayMs,
  createParsedInstructionPoolDecoder,
  createRawInstructionPoolDecoder,
  decodePumpCreatorAddress,
  decodePoolDiscoveries,
  dueActivePools
} from "./pool-discovery";

describe("pool discovery", () => {
  it("decodes configured parsed pool instructions without duplicate pools", () => {
    const decoder = createParsedInstructionPoolDecoder({
      programId: "Dex111",
      instructionTypes: ["initializePool"]
    });
    const event = {
      address: "Dex111",
      signature: "sig",
      slot: 42,
      observedAt: "2026-07-05T00:00:00.000Z",
      transaction: {
        blockTime: 1783209540,
        transaction: {
          message: {
            instructions: [
              {
                programId: "Dex111",
                parsed: {
                  type: "initializePool",
                  info: { pool: "Pool111", baseMint: "Mint111", quoteMint: "So111" }
                }
              },
              {
                programId: "Dex111",
                parsed: {
                  type: "initializePool",
                  info: { pool: "Pool111", baseMint: "Mint111", quoteMint: "So111" }
                }
              }
            ]
          }
        }
      }
    };

    expect(decodePoolDiscoveries(event, [decoder])).toEqual([
      expect.objectContaining({
        poolAddress: "Pool111",
        baseTokenAddress: "Mint111",
        quoteTokenAddress: "So111",
        createdAt: "2026-07-04T23:59:00.000Z",
        instructionIndex: 0
      })
    ]);
  });

  it("decodes parsed pool creation invoked through an inner instruction", () => {
    const decoder = createParsedInstructionPoolDecoder({
      programId: "Dex111",
      instructionTypes: ["initializePool"]
    });
    const event = {
      address: "Dex111",
      signature: "parsed-inner-sig",
      slot: 43,
      observedAt: "2026-07-05T00:00:00.000Z",
      transaction: {
        transaction: {
          message: {
            instructions: [{ programId: "Router111", parsed: { type: "route", info: {} } }]
          }
        },
        meta: {
          innerInstructions: [
            {
              index: 0,
              instructions: [
                {
                  programId: "Dex111",
                  parsed: {
                    type: "initializePool",
                    info: { pool: "Pool111", baseMint: "Mint111", quoteMint: "So111" }
                  }
                }
              ]
            }
          ]
        }
      }
    };

    expect(decodePoolDiscoveries(event, [decoder])).toEqual([
      expect.objectContaining({
        poolAddress: "Pool111",
        instructionIndex: 0,
        innerInstructionIndex: 0
      })
    ]);
  });

  it("uses 30-second then 2-minute sampling and expires after 120 minutes", () => {
    expect(activePoolSampleDelayMs(5)).toBe(30_000);
    expect(activePoolSampleDelayMs(40)).toBe(120_000);
    expect(activePoolSampleDelayMs(121)).toBeNull();
    expect(
      dueActivePools(
        [
          {
            poolAddress: "due",
            createdAt: "2026-07-05T00:00:00.000Z",
            lastSampledAt: "2026-07-05T00:39:00.000Z"
          },
          {
            poolAddress: "not-due",
            createdAt: "2026-07-05T00:00:00.000Z",
            lastSampledAt: "2026-07-05T00:39:30.000Z"
          },
          {
            poolAddress: "expired",
            createdAt: "2026-07-04T22:00:00.000Z"
          }
        ],
        "2026-07-05T00:39:50.000Z"
      ).map((pool) => pool.poolAddress)
    ).toEqual(["due"]);
  });

  it("decodes raw custom-program instructions from a verified discriminator layout", () => {
    const decoder = createRawInstructionPoolDecoder({
      programId: "Dex111",
      instructions: [
        {
          name: "initialize-pool",
          discriminatorHex: "01020304",
          poolAccountIndex: 0,
          baseTokenAccountIndex: 1,
          quoteTokenAccountIndex: 2
        }
      ]
    });
    const event = {
      address: "Dex111",
      signature: "raw-sig",
      slot: 99,
      observedAt: "2026-07-05T00:00:00.000Z",
      transaction: {
        transaction: {
          message: {
            accountKeys: ["Dex111", "Pool111", "Mint111", "So111"],
            instructions: [
              {
                programIdIndex: 0,
                accounts: [1, 2, 3],
                data: bs58.encode(Buffer.from("01020304aabb", "hex"))
              }
            ]
          }
        }
      }
    };

    expect(decodePoolDiscoveries(event, [decoder])).toEqual([
      expect.objectContaining({
        poolAddress: "Pool111",
        baseTokenAddress: "Mint111",
        quoteTokenAddress: "So111",
        instructionIndex: 0
      })
    ]);
  });

  it("derives Pump creator provenance from bounded Borsh instruction data", () => {
    const creator = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
    const borshString = (value: string) => {
      const body = Buffer.from(value, "utf8");
      const length = Buffer.alloc(4);
      length.writeUInt32LE(body.length);
      return Buffer.concat([length, body]);
    };
    const data = Buffer.concat([
      Buffer.from("181ec828051c0777", "hex"),
      borshString("Token name"),
      borshString("TKN"),
      borshString("https://example.invalid/meta.json"),
      creator
    ]);
    const decoder = createRawInstructionPoolDecoder({
      programId: "Pump111",
      instructions: [
        {
          name: "pump-create",
          discriminatorHex: "181ec828051c0777",
          poolAccountIndex: 0,
          baseTokenAccountIndex: 1,
          creatorDataEncoding: "pump-borsh-after-3-strings"
        }
      ]
    });
    const event = {
      address: "Pump111",
      signature: "pump-create-sig",
      slot: 101,
      observedAt: "2026-07-05T00:00:00.000Z",
      transaction: {
        transaction: {
          message: {
            accountKeys: ["Pump111", "Pool111", "Mint111"],
            instructions: [
              {
                programIdIndex: 0,
                accounts: [1, 2],
                data: bs58.encode(data)
              }
            ]
          }
        }
      }
    };

    expect(decodePumpCreatorAddress(data)).toBe(bs58.encode(creator));
    expect(decodePumpCreatorAddress(data.subarray(0, data.length - 31))).toBeUndefined();
    expect(decodePoolDiscoveries(event, [decoder])).toEqual([
      expect.objectContaining({
        poolAddress: "Pool111",
        baseTokenAddress: "Mint111",
        creatorAddress: bs58.encode(creator),
        raw: expect.objectContaining({ creatorSource: "pump-create-instruction-data" })
      })
    ]);
  });

  it("resolves loaded addresses and decodes raw inner instructions without failing on malformed data", () => {
    const decoder = createRawInstructionPoolDecoder({
      programId: "Dex111",
      instructions: [
        {
          name: "initialize-pool",
          discriminatorHex: "01020304",
          poolAccountIndex: 0,
          baseTokenAccountIndex: 1,
          quoteTokenAccountIndex: 2
        }
      ]
    });
    const event = {
      address: "Dex111",
      signature: "raw-inner-sig",
      slot: 100,
      observedAt: "2026-07-05T00:00:00.000Z",
      transaction: {
        transaction: {
          message: {
            accountKeys: ["Router111"],
            instructions: [{ programIdIndex: 0, accounts: [], data: "" }]
          }
        },
        meta: {
          loadedAddresses: {
            writable: ["Pool111", "Mint111", "So111", "Dex111"],
            readonly: []
          },
          innerInstructions: [
            {
              index: 0,
              instructions: [
                { programIdIndex: 4, accounts: [1, 2, 3], data: "!not-base58!" },
                {
                  programIdIndex: 4,
                  accounts: [1, 2, 3],
                  data: bs58.encode(Buffer.from("01020304aabb", "hex"))
                }
              ]
            }
          ]
        }
      }
    };

    expect(decodePoolDiscoveries(event, [decoder])).toEqual([
      expect.objectContaining({
        poolAddress: "Pool111",
        baseTokenAddress: "Mint111",
        quoteTokenAddress: "So111",
        instructionIndex: 0,
        innerInstructionIndex: 1
      })
    ]);
  });
});
