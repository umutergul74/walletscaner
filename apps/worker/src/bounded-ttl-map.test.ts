import { describe, expect, it } from "vitest";
import { BoundedTtlMap } from "./bounded-ttl-map";

describe("BoundedTtlMap", () => {
  it("expires addressed entries without requiring a full sweep", () => {
    const cache = new BoundedTtlMap<string, number>(10, 60_000);
    cache.set("short", 1, 1_010, 1_000);

    expect(cache.get("short", 1_009)).toBe(1);
    expect(cache.get("short", 1_010)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the oldest insertion at capacity", () => {
    const cache = new BoundedTtlMap<string, number>(2, 60_000);
    cache.set("first", 1, 10_000, 1_000);
    cache.set("second", 2, 10_000, 1_001);
    cache.set("third", 3, 10_000, 1_002);

    expect(cache.get("first", 1_003)).toBeUndefined();
    expect(cache.get("second", 1_003)).toBe(2);
    expect(cache.get("third", 1_003)).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("sweeps expired entries at an amortized interval", () => {
    const cache = new BoundedTtlMap<string, number>(10, 100);
    cache.set("expired-later", 1, 1_050, 1_000);
    cache.set("alive", 2, 2_000, 1_010);
    expect(cache.size).toBe(2);

    cache.set("trigger", 3, 2_000, 1_100);

    expect(cache.size).toBe(2);
    expect(cache.has("expired-later", 1_100)).toBe(false);
  });
});
