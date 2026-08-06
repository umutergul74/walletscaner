interface CacheEntry<V> {
  value: V;
  expiresAtMs: number;
}

/**
 * Insertion-ordered TTL cache with bounded memory and amortized expiry sweeps.
 * Addressed reads always enforce TTL; a full scan runs only at the configured
 * interval instead of on every high-volume insertion.
 */
export class BoundedTtlMap<K, V> {
  private readonly entries = new Map<K, CacheEntry<V>>();
  private nextSweepAtMs = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly sweepIntervalMs = 60_000
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error("maxEntries must be a positive integer.");
    }
    if (!Number.isFinite(sweepIntervalMs) || sweepIntervalMs <= 0) {
      throw new Error("sweepIntervalMs must be positive.");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: K, nowMs = Date.now()): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAtMs <= nowMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: K, nowMs = Date.now()): boolean {
    return this.get(key, nowMs) !== undefined;
  }

  set(key: K, value: V, expiresAtMs: number, nowMs = Date.now()): void {
    this.maybeSweep(nowMs);
    this.entries.delete(key);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) return;
    this.entries.set(key, { value, expiresAtMs });
    this.trimToCapacity();
  }

  sweep(nowMs = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs > nowMs) continue;
      this.entries.delete(key);
      removed += 1;
    }
    this.nextSweepAtMs = nowMs + this.sweepIntervalMs;
    return removed;
  }

  private maybeSweep(nowMs: number): void {
    if (nowMs >= this.nextSweepAtMs) this.sweep(nowMs);
  }

  private trimToCapacity(): void {
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value as K | undefined;
      if (oldestKey === undefined) return;
      this.entries.delete(oldestKey);
    }
  }
}
