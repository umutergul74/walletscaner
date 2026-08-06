export interface RpcTradeWebSocketOptions {
  configuredWsUrl: string;
  explicitTradeWsUrl?: string;
  heliusApiKey?: string;
  heliusStandardEnabled: boolean;
}

export function resolveRpcTradeWsUrl(options: RpcTradeWebSocketOptions): string {
  const explicitTradeWsUrl = options.explicitTradeWsUrl?.trim();
  if (explicitTradeWsUrl) return explicitTradeWsUrl;

  if (!options.heliusStandardEnabled) return options.configuredWsUrl;
  const heliusApiKey = options.heliusApiKey?.trim();
  if (!heliusApiKey) {
    throw new Error("HELIUS_STANDARD_TRADE_WS_ENABLED=true requires a non-empty HELIUS_API_KEY.");
  }
  return `wss://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
}

export function websocketProviderLabel(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "invalid-websocket-url";
  }
}

export function isHeliusStandardWebSocket(value: string): boolean {
  return websocketProviderLabel(value) === "mainnet.helius-rpc.com";
}
