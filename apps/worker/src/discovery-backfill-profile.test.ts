import { describe, expect, it } from "vitest";
import { discoveryBackfillProfile } from "./discovery-backfill-profile.js";

describe("discoveryBackfillProfile", () => {
  it("uses the reviewed bounded LaunchLab recovery profile by default", () => {
    expect(discoveryBackfillProfile({})).toEqual({
      initialLimit: 100,
      pageLimit: 100,
      maxPages: 5,
      maximumReconnectSignatures: 500
    });
  });

  it("accepts an explicit profile inside the hard shared-host ceiling", () => {
    expect(
      discoveryBackfillProfile({
        SOLANA_DISCOVERY_INITIAL_BACKFILL_LIMIT: "250",
        SOLANA_DISCOVERY_BACKFILL_PAGE_LIMIT: "250",
        SOLANA_DISCOVERY_MAX_BACKFILL_PAGES: "4"
      })
    ).toEqual({
      initialLimit: 250,
      pageLimit: 250,
      maxPages: 4,
      maximumReconnectSignatures: 1_000
    });
  });

  it("fails startup on malformed or unbounded profiles instead of silently changing behavior", () => {
    expect(() =>
      discoveryBackfillProfile({ SOLANA_DISCOVERY_BACKFILL_PAGE_LIMIT: "many" })
    ).toThrow(/SOLANA_DISCOVERY_BACKFILL_PAGE_LIMIT/);
    expect(() =>
      discoveryBackfillProfile({
        SOLANA_DISCOVERY_BACKFILL_PAGE_LIMIT: "500",
        SOLANA_DISCOVERY_MAX_BACKFILL_PAGES: "5"
      })
    ).toThrow(/capped at 2000 signatures/);
  });
});
