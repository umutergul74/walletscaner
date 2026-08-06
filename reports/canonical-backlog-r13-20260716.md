# Canonical backlog and historical pricing rollout — r13

Date: 2026-07-16  
Host profile: fixed-disk, observe-only, shared with protected `robinhoodscaner-intel`

## Outcome

The immediate canonical processing bottleneck and historical-price request storm were removed
without changing live-execution state or restarting any protected co-tenant service.

- Canonical claims now select one unresolved head per partition through a recursive loose-index
  scan instead of ranking the full unresolved JSON working set.
- Claims are bounded to eight events, four independent partitions and a 90-second lease.
- Delayed swaps hydrate immutable pool context from PostgreSQL when the sampling cache has expired.
- Historical SOL/USD observations are reused from PostgreSQL and bounded memory caches.
- External Pyth requests are serialized with a 1.2-second minimum interval and bounded 429 backoff.
- The Pyth Benchmarks client now uses the single-timestamp endpoint. The interval endpoint returns
  an array and was the cause of valid responses being rejected as missing parsed price fields.

## Verification

- `npm ci`: passed, zero reported vulnerabilities.
- TypeScript typecheck: passed.
- ESLint: passed.
- PostgreSQL 16 integration plus full test suite: 39 files, 161/161 tests passed.
- Production workspace build: passed.
- Bounded real Pyth Benchmarks request: returned SOL/USD `77.33377604` for
  `2026-07-15T21:00:00Z`, matching the requested publish time with a confidence ratio below 0.001.
- r13 image SHA-256 and five critical source-file hashes matched before deployment.

## Initial live r13 evidence

- Canonical events completed: 1,314.
- Canonical failures: 0.
- Event-processing attempt failures: 0.
- Dead letters: 0.
- Historical price reuse: 477 memory hits and 318 PostgreSQL hits.
- Historical provider requests: 17.
- Historical provider errors / rate limits: 0 / 0.
- New durable Pyth historical observations: 27, spanning
  `2026-07-15 20:59 UTC` through `2026-07-16 10:54 UTC`.
- Unresolved queue: 34,172 before r13 to 32,211 after the initial sample while 413 new events
  arrived.
- Ingestion resource sample: 98.95 MiB / 160 MiB, about 11% container CPU, restart count 0,
  OOM false.
- PostgreSQL resource sample: 183.6 MiB / 256 MiB, constrained by its existing 18% CPU quota.
- `ENABLE_LIVE_EXECUTION=false`.
- Robinhoodscaner container identities and health remained unchanged.

## Data repair performed

Before r13, 21,799 delayed swap events that had been completed without durable pool context were
requeued in bounded 2,000-row batches. No row or payload was deleted; attempt history was retained.

## Remaining acceptance work

- Older wallet trades with explicit `priceEvidence.rejected='lookup-failed'` remain truthful but
  incomplete. They require a bounded, idempotent quote-enrichment phase that preserves provenance
  and requeues only affected wallet-alpha revisions.
- The seven-day shared-host shadow, 90% candidate high-quality execution coverage, finalized
  reconciliation, reconnect chaos, Meteora/Orca coverage and fourteen-day paper-only gates are not
  yet complete.
- Zero wallet-alpha signals is the current observed result; no risk or score threshold was relaxed.
