import { describe, expect, it } from "vitest";
import { decodeWalletTrades } from "./wallet-trade";

const wallet = "Wallet1111111111111111111111111111111111111";
const token = "Token11111111111111111111111111111111111111";
const quote = "So11111111111111111111111111111111111111112";
const pool = "Pool111111111111111111111111111111111111111";

describe("decodeWalletTrades", () => {
  it("decodes a buy from token and native balance deltas", () => {
    const trades = decodeWalletTrades(
      makeEvent({ preBase: 0, postBase: 100, preLamports: 2_000_000_000, postLamports: 999_995_000 }),
      { poolAddress: pool, tokenAddress: token, quoteTokenAddress: quote, poolCreatedAt: "2026-07-10T00:00:00.000Z" }
    );

    expect(trades).toEqual([
      expect.objectContaining({
        walletAddress: wallet,
        side: "buy",
        baseAmount: 100,
        quoteAmount: 1.000005,
        poolAgeMinutes: 1
      })
    ]);
  });

  it("decodes a sell and prefers an observed quote-token delta", () => {
    const event = makeEvent({
      preBase: 100,
      postBase: 40,
      preLamports: 1_000_000_000,
      postLamports: 1_000_000_000,
      preQuote: 0,
      postQuote: 0.75
    });
    const trades = decodeWalletTrades(event, {
      poolAddress: pool,
      tokenAddress: token,
      quoteTokenAddress: quote
    });

    expect(trades).toEqual([
      expect.objectContaining({
        walletAddress: wallet,
        side: "sell",
        baseAmount: 60,
        quoteAmount: 0.75
      })
    ]);
  });

  it("does not emit a trade without a base-token balance change", () => {
    expect(
      decodeWalletTrades(
        makeEvent({ preBase: 10, postBase: 10, preLamports: 1, postLamports: 1 }),
        { poolAddress: pool, tokenAddress: token }
      )
    ).toEqual([]);
  });

  it("fails closed when the message explicitly declares no signers", () => {
    const base = makeEvent({
      preBase: 0,
      postBase: 100,
      preLamports: 2_000_000_000,
      postLamports: 1_000_000_000
    });
    const event = {
      ...base,
      transaction: {
        ...base.transaction,
        transaction: {
          message: {
            ...base.transaction.transaction.message,
            header: { numRequiredSignatures: 0 }
          }
        }
      }
    };

    expect(
      decodeWalletTrades(event, {
        poolAddress: pool,
        tokenAddress: token,
        quoteTokenAddress: quote
      })
    ).toEqual([]);
  });
});

function makeEvent(values: {
  preBase: number;
  postBase: number;
  preLamports: number;
  postLamports: number;
  preQuote?: number;
  postQuote?: number;
}) {
  const preTokenBalances = [tokenRow(token, values.preBase)];
  const postTokenBalances = [tokenRow(token, values.postBase)];
  if (values.preQuote !== undefined) preTokenBalances.push(tokenRow(quote, values.preQuote));
  if (values.postQuote !== undefined) postTokenBalances.push(tokenRow(quote, values.postQuote));
  return {
    address: pool,
    signature: "trade-signature",
    slot: 123,
    observedAt: "2026-07-10T00:01:05.000Z",
    transaction: {
      blockTime: Date.parse("2026-07-10T00:01:00.000Z") / 1_000,
      transaction: { message: { accountKeys: [{ pubkey: wallet }] } },
      meta: {
        preTokenBalances,
        postTokenBalances,
        preBalances: [values.preLamports],
        postBalances: [values.postLamports]
      }
    }
  };
}

function tokenRow(mint: string, amount: number) {
  return { owner: wallet, mint, uiTokenAmount: { uiAmountString: String(amount) } };
}
