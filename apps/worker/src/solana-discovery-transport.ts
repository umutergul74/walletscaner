import { websocketProviderLabel } from "./solana-trade-transport.js";

export interface DiscoveryWebSocketRouteOptions {
  configuredWsUrl: string;
  programIds: string[];
  secondaryWsUrl?: string;
  secondaryProgramIdsJson?: string;
}

export interface DiscoveryWebSocketRoute {
  programId: string;
  wsUrl: string;
  websocketProvider: string;
  route: "primary" | "secondary";
}

export function resolveDiscoveryWebSocketRoutes(
  options: DiscoveryWebSocketRouteOptions
): DiscoveryWebSocketRoute[] {
  const configuredWsUrl = requiredValue(options.configuredWsUrl, "configuredWsUrl");
  const programIds = [...new Set(options.programIds.map((value) => value.trim()).filter(Boolean))];
  if (programIds.length !== options.programIds.length) {
    throw new Error("Discovery program ids must be non-empty and unique.");
  }

  const secondaryWsUrl = options.secondaryWsUrl?.trim();
  const secondaryProgramIds = parseSecondaryProgramIds(options.secondaryProgramIdsJson);
  if (
    (secondaryWsUrl && secondaryProgramIds.length === 0) ||
    (!secondaryWsUrl && secondaryProgramIds.length > 0)
  ) {
    throw new Error(
      "SOLANA_DISCOVERY_WS_SECONDARY_URL and a non-empty SOLANA_DISCOVERY_WS_SECONDARY_PROGRAMS_JSON must be configured together."
    );
  }

  const configuredPrograms = new Set(programIds);
  for (const programId of secondaryProgramIds) {
    if (!configuredPrograms.has(programId)) {
      throw new Error(`Secondary discovery WebSocket route names an unknown program: ${programId}`);
    }
  }
  const secondaryPrograms = new Set(secondaryProgramIds);

  return programIds.map((programId) => {
    const secondary = secondaryPrograms.has(programId);
    const wsUrl = secondary ? secondaryWsUrl! : configuredWsUrl;
    return {
      programId,
      wsUrl,
      websocketProvider: websocketProviderLabel(wsUrl),
      route: secondary ? "secondary" : "primary"
    };
  });
}

function parseSecondaryProgramIds(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("SOLANA_DISCOVERY_WS_SECONDARY_PROGRAMS_JSON must be valid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("SOLANA_DISCOVERY_WS_SECONDARY_PROGRAMS_JSON must be a JSON string array.");
  }
  const programIds = parsed.map((entry) => entry.trim()).filter(Boolean);
  if (programIds.length !== parsed.length || new Set(programIds).size !== programIds.length) {
    throw new Error(
      "SOLANA_DISCOVERY_WS_SECONDARY_PROGRAMS_JSON entries must be non-empty and unique."
    );
  }
  return programIds;
}

function requiredValue(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must be non-empty.`);
  return normalized;
}
