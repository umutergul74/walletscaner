import { describe, expect, it } from "vitest";
import { resolveDiscoveryWebSocketRoutes } from "./solana-discovery-transport.js";

const programs = ["Pump111", "PumpSwap111", "LaunchLab111", "Cpmm111"];

describe("resolveDiscoveryWebSocketRoutes", () => {
  it("uses the configured primary websocket for every program by default", () => {
    expect(
      resolveDiscoveryWebSocketRoutes({
        configuredWsUrl: "wss://primary.example",
        programIds: programs
      })
    ).toEqual(
      programs.map((programId) => ({
        programId,
        wsUrl: "wss://primary.example",
        websocketProvider: "primary.example",
        route: "primary"
      }))
    );
  });

  it("routes only explicitly selected programs to the secondary websocket", () => {
    const routes = resolveDiscoveryWebSocketRoutes({
      configuredWsUrl: "wss://primary.example",
      programIds: programs,
      secondaryWsUrl: "wss://secondary.example",
      secondaryProgramIdsJson: JSON.stringify(["LaunchLab111", "Cpmm111"])
    });

    expect(routes).toEqual([
      expect.objectContaining({ programId: "Pump111", route: "primary" }),
      expect.objectContaining({ programId: "PumpSwap111", route: "primary" }),
      {
        programId: "LaunchLab111",
        wsUrl: "wss://secondary.example",
        websocketProvider: "secondary.example",
        route: "secondary"
      },
      {
        programId: "Cpmm111",
        wsUrl: "wss://secondary.example",
        websocketProvider: "secondary.example",
        route: "secondary"
      }
    ]);
  });

  it("fails closed on incomplete, duplicate, or unknown secondary routing", () => {
    expect(() =>
      resolveDiscoveryWebSocketRoutes({
        configuredWsUrl: "wss://primary.example",
        programIds: programs,
        secondaryWsUrl: "wss://secondary.example"
      })
    ).toThrow(/configured together/);
    expect(() =>
      resolveDiscoveryWebSocketRoutes({
        configuredWsUrl: "wss://primary.example",
        programIds: programs,
        secondaryProgramIdsJson: JSON.stringify(["LaunchLab111"])
      })
    ).toThrow(/configured together/);
    expect(() =>
      resolveDiscoveryWebSocketRoutes({
        configuredWsUrl: "wss://primary.example",
        programIds: programs,
        secondaryWsUrl: "wss://secondary.example",
        secondaryProgramIdsJson: JSON.stringify(["Unknown111"])
      })
    ).toThrow(/unknown program/);
    expect(() =>
      resolveDiscoveryWebSocketRoutes({
        configuredWsUrl: "wss://primary.example",
        programIds: programs,
        secondaryWsUrl: "wss://secondary.example",
        secondaryProgramIdsJson: JSON.stringify(["Cpmm111", "Cpmm111"])
      })
    ).toThrow(/unique/);
  });
});
