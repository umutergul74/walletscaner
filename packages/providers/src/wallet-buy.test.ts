import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import { decodeWalletBuys } from "./wallet-buy";

describe("wallet buy decoder", () => {
  it("decodes raw buy instructions and deduplicates the same wallet-token buy", () => {
    const data = bs58.encode(Buffer.from("66063d1201daebea01020304", "hex"));
    const event = {
      address: "Pool111",
      signature: "buy-sig",
      slot: 123,
      observedAt: "2026-07-05T00:00:00.000Z",
      transaction: {
        transaction: {
          message: {
            accountKeys: [
              "PumpSwap111",
              "Pool111",
              "Trader111",
              "Mint111",
              "So11111111111111111111111111111111111111112"
            ],
            instructions: [
              {
                programIdIndex: 0,
                accounts: [1, 2, 3, 4],
                data
              },
              {
                programIdIndex: 0,
                accounts: [1, 2, 3, 4],
                data
              }
            ]
          }
        }
      }
    };

    expect(
      decodeWalletBuys(event, [
        {
          name: "pumpswap-buy",
          programId: "PumpSwap111",
          discriminatorHex: "66063d1201daebea",
          poolAccountIndex: 0,
          traderAccountIndex: 1,
          outputTokenAccountIndex: 2,
          inputTokenAccountIndex: 3
        }
      ])
    ).toEqual([
      expect.objectContaining({
        signature: "buy-sig",
        poolAddress: "Pool111",
        traderAddress: "Trader111",
        outputTokenAddress: "Mint111",
        inputTokenAddress: "So11111111111111111111111111111111111111112"
      })
    ]);
  });
});
