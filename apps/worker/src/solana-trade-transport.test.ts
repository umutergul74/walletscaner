import { describe, expect, it } from "vitest";
import {
  isHeliusStandardWebSocket,
  resolveRpcTradeWsUrl,
  websocketProviderLabel
} from "./solana-trade-transport";

describe("resolveRpcTradeWsUrl", () => {
  it("uses the normal Solana websocket when Helius standard websocket is disabled", () => {
    expect(
      resolveRpcTradeWsUrl({
        configuredWsUrl: "wss://solana-rpc.publicnode.com",
        heliusApiKey: "secret",
        heliusStandardEnabled: false
      })
    ).toBe("wss://solana-rpc.publicnode.com");
  });

  it("uses Helius standard websocket for the bounded RPC trade stream", () => {
    const value = resolveRpcTradeWsUrl({
      configuredWsUrl: "wss://solana-rpc.publicnode.com",
      heliusApiKey: "secret",
      heliusStandardEnabled: true
    });

    expect(value).toBe("wss://mainnet.helius-rpc.com/?api-key=secret");
    expect(isHeliusStandardWebSocket(value)).toBe(true);
    expect(websocketProviderLabel(value)).toBe("mainnet.helius-rpc.com");
  });

  it("lets an explicit trade websocket override the convenience Helius setting", () => {
    expect(
      resolveRpcTradeWsUrl({
        configuredWsUrl: "wss://solana-rpc.publicnode.com",
        explicitTradeWsUrl: "wss://trade.example",
        heliusApiKey: "secret",
        heliusStandardEnabled: true
      })
    ).toBe("wss://trade.example");
  });

  it("fails fast when Helius standard websocket is enabled without a key", () => {
    expect(() =>
      resolveRpcTradeWsUrl({
        configuredWsUrl: "wss://solana-rpc.publicnode.com",
        heliusStandardEnabled: true
      })
    ).toThrow(/HELIUS_API_KEY/);
  });
});
