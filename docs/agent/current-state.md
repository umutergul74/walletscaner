# Walletscaner Current State

This is a compact, dated handoff for agents. It is not production authority. Refresh live state
before every operational claim or mutation.

## Last verified boundary

- Observation: 2026-08-24 07:47 UTC, durable discovery-gap repair and split-WebSocket rollout plus
  staged shared-host production canary.
- Live capital: `ENABLE_LIVE_EXECUTION=false`; paper v3 is paused with zero open positions and v4
  remains a non-deliverable causal shadow.
- Releases: `solana-ingestion` runs immutable `discovery-repair-cap-r20-20260824` (production image
  `sha256:ec85cedd23f3...`, source SHA-256 `417578088d87...`). `telegram-notifier` and
  `data-maintenance` run the compatible R18 tree; `evidence-sampler` and `wallet-alpha` remain on
  immutable `wallet-alpha-priority-r13-20260824`; operations remains R9. API, web and paper-alert
  remain stopped. Migrations 044-045 are deployed after migration 043.
- Shared-host state: one Walletscaner Compose project was listed; no protected co-tenant service,
  secret or runtime was inspected or changed.

## Operational discovery transport and bounded repair

- **Operational — split standard WebSocket transport:** the production PublicNode endpoint
  acknowledged four independent per-program sockets but delivered traffic only to the first two
  from the host. R19/R20 keep Pump.fun and PumpSwap on PublicNode and route LaunchLab and CPMM to
  `api.mainnet-beta.solana.com`; HTTP transaction fetch, cursor and repair remain on PublicNode.
  The first R20 health sample showed LaunchLab `2` notifications / `10` slot lag and CPMM `13,384`
  notifications / `0` slot lag. All four sources had zero reconnect, ACK timeout, heartbeat timeout,
  queue, drop and handler-rejection counters. The route is static and hostname-only in telemetry;
  no Helius discovery credits or new credential are used.
- **Operational / converging — durable exact-boundary repair:** migrations 044-045 stage reconnect
  signatures durably, collect without moving the live cursor, replay oldest-first and allow coverage
  reconciliation only from an exact `truncation_cursor`. The unsafe R16 canary was stopped before
  any proof closed; its rows remain failed and its 50 idempotent replay attempts are not coverage.
  CPMM reached its exact boundary after 11,143 signatures and was replaying at 1,200/11,143 at the
  observation boundary. Its single incident remains open and alpha-excluded until full replay plus
  independent head match. This is the sole reason aggregate discovery remains `degraded`.
- **Operational — fail-closed repair-cap retirement:** Pump.fun and PumpSwap each reached the
  reviewed 20,000-signature cap before their old boundary. Both repairs remain `failed`; R20 closed
  only the current transport state after two fresh samples and permanently retained the historical
  intervals as `transport_recovered_gap_unreconciled`. Strict alpha consumers continue to exclude
  them. This prevents unbounded RPC/rows/replay and removes the incident/recovery notification loop
  without pretending the gap was repaired.
- **Operational — Telegram transition delivery:** the two cap-retirement recovery transitions were
  delivered once with one attempt; the outbox had no pending, retry or dead-letter row. One final
  CPMM reconciliation transition is expected only after the durable repair proof completes.

## Operational wallet-alpha priority queue

- **Operational — wallet-alpha priority wake queue:** migration 043 and the R13 worker keep one
  coalescing three-lane queue: background `0`, score-changing `1`, and
  fail-closed risk-passed source entry `2`. Highest ready priority is claimed first; a concurrent
  newer revision keeps its priority after an older lease completes. Commit-bound PostgreSQL
  `NOTIFY` wakes the single worker, with 30-second backlog and 300-second idle recovery polling.
  No second scorer was added; the existing 7% CPU, 112 MiB heap and 160 MiB container limits remain.
- PostgreSQL 16 migration, revision-race, priority-order, notification and worker checks pass. The
  exact production runtime tree passed 18/18 queue tests on the host; disposable PostgreSQL 16
  integration passed 27/27. The local 10,000-row synthetic queue used the priority partial index
  and claimed in 0.201 ms/eight buffers; local commit-to-refresh was 181 ms at 67.65 MiB RSS.
- The accepted one-CPU canary started ingestion alone, added sampler, then alpha. Final ingestion
  telemetry had four of four programs current, minimum 20 consecutive healthy samples and zero
  queue/active/in-flight/drop/reject/unresolved/open-incident/breach/parser/finality error. Sampler
  wrote live observations with zero provider error; alpha held one PostgreSQL listener, completed a
  243.117-second bounded cycle and refreshed one P2 wallet with zero refresh failure at 121.04 MiB
  RSS. Pre-alpha lanes were P2/P1/P0 `31/224/3,079`; 30 P2 rows drained in the first cycle.
- The remaining P2 row is the known over-10,000-trade wallet, deferred for about 24 hours rather
  than ready. Production future-event latency percentiles remain waiting; do not substitute the
  local 181 ms sample or this catch-up canary for the p95/p99 gate. Full evidence is in
  `reports/wallet-alpha-priority-r13-rollout-20260824.md`.

## Operational changes and evidence

- **Operational — bounded discovery reconnect repair:** R14 used a hard-coded five-signature
  discovery backfill on initial connection and every reconnect. LaunchLab reached seven reconnects
  and eight truncations before rollout; each reconnect opened and then closed a durable
  `backfill_truncated` incident and produced a Telegram incident/recovery pair. R15 uses a strict
  `100 x 5 = 500` signature scan profile with a product hard cap of 2,000, validates configuration
  at startup and exposes the active profile in health telemetry. The last pre-rollout LaunchLab
  cursor had 288 newer signatures, proving the new window could reach its boundary. R15 startup
  reached it with zero LaunchLab truncation, and a subsequent natural reconnect changed the live
  counters to `1 reconnect / 0 truncations`; status remained `ok`, coverage remained current, and
  queue/workers/dropped/unresolved remained `0/0/0/0`. Pump.fun, PumpSwap and CPMM each saturated
  the bounded startup window, correctly opened one fail-closed historical-gap incident, and closed
  it after two healthy samples; those three gaps remain excluded rather than being called repaired.

- **Operational — backup:** dump `memecoin_alpha_20260823T150923Z.dump` is 1,505,940,747 bytes,
  SHA-256 `2f8831a3a9bde0e6e19c89099444b2404bc950f30ae9c7f20865e38c0f43fdba`. Server,
  off-host bytes, PostgreSQL 16 archive-list, sidecar and acknowledgement passed; the scheduled
  task completed with result zero.
- **Operational — finality gate:** migrations 041-042 are deployed. The R10 terminal-state sweep
  repairs events that arrive after their signature was already finalized. The live mismatch count
  fell from three to zero, the blocked inbox fell from 803 to normal working-set levels, and the
  20:09 UTC monitor reported backlog/dead letters `0/0`. No restart or OOM occurred.
- **Operational — PostgreSQL-safe chain payload admission:** a live PumpSwap transaction contained
  `U+0000` in parsed JSON text. PostgreSQL JSONB rejected it, the per-address ordering barrier
  correctly refused to advance, but the source retried the same handler forever while its RAM queue
  grew from 574 to 729. R13/R14 replace only forbidden NUL code points with an explicit literal escape,
  adds an occurrence count plus original-payload SHA-256 marker, and purges queued work when a pool
  is fail-closed/unsubscribed. The first live R13 pool processed 122 backfill and 45 live events;
  queue/unresolved/dropped/parser failures were `0/0/0/0`, one subscription was active and fresh
  live provider latency was 1.80 seconds. R14 restores a zero-copy fast path for normal payloads and
  also covers NUL object keys. Its first sample processed 304 backfill events with queue, unresolved,
  dropped and parser failures all zero. Ingestion limits were not raised.
- **Operational — SQL telemetry:** migration 040 and PostgreSQL preload/I/O/slow-query settings are
  active. `pg_stat_statements` identified the real wallet-alpha scans.
- **Operational — wallet-alpha bottleneck:** R12 orders claims by the existing
  `(strategy_version, not_before, updated_at, wallet_address)` partial index and constrains both
  sides of the outcome join by strategy. Live means changed from 628.57 ms to 4.99 ms for claims
  and from 1,224.68 ms to 25.50 ms for outcomes. A 100-item cycle changed from 200-242 seconds to
  26.31 seconds without raising the 7% CPU, 112 MiB heap or 160 MiB container ceilings. Queue
  pending moved `475 -> 375 -> 275 -> 175 -> 75` before new R13 trade catch-up revisions arrived.
  A completed cycle reported 206 pending; a subsequent read-only sample saw 644 coalesced revisions
  while ingestion backfill was active. The next bounded cycle processed 45 admitted wallets in its
  240-second budget and reduced the queue to 265 with zero failure at 94.7 MiB RSS. This is a fresh
  transient producer/CPU-I/O-contention burst, not the former full-table claim bottleneck, and must
  still be watched for sustained net drain after ingestion catch-up.
  One wallet remains intentionally isolated by the 10,000-trade safety ceiling.
- **Operational — creator enrichment:** 1,798 of 1,868 tokens first seen after the R9 rollout have
  a creator address (96.25%). Pump instruction creator decoding is the dominant successful path.
- **Implemented / waiting — Token-2022:** dangerous extensions fail closed in code and tests, but
  the first 19 live post-rollout assessments contained no extension warning sample. This is not a
  production validation claim.
- **Operational / catching up — raw archive:** 22 verified chain-payload segments cover
  2026-07-31 through 2026-08-23 00:00 UTC and contain 765,680 source rows. Maintenance compacted
  4,000 payloads in its latest run with no timeout. At 20:13 UTC, 10,962 verified, retention-eligible
  payloads remained at 20:13 UTC. The next two successful runs compacted 4,000 and 3,000 payloads;
  the oldest uncompacted boundary advanced by about 32 minutes, but lag was still 7.80 hours at
  20:35 UTC. The recurring 30-minute worker is making net progress and must be observed until zero.

## Capacity and remaining hard gates

- At the R13 canary PostgreSQL was about 13.80 GB and the host had about 22.30 GB free / 70% used.
  The operations monitor remained degraded because database size exceeded its 12 GiB warning,
  payload compaction lag was about 9,326 seconds and the conservative recent-window runway was
  2.52 days above the 8 GiB reserve. Pipeline backlog/dead letters and unresolved finality were
  zero. Treat the runway as a capacity alarm, not as release failure or steady-state proof.
- The 95-day detailed wallet evidence layout is still not at proven disk equilibrium. Do not delete
  canonical trades, entries or outcomes until B2 wallet-evidence export, deterministic compact
  ledger dual-read parity, isolated restore, backup and stopped-cutover gates pass.
- Continuous WAL/PITR is not operational. The verified daily dump limits data loss but is not PITR.
  A bounded spool/sidecar, measured WAL rate, B2 restore rehearsal and reserve-failure behavior are
  required before enabling PostgreSQL archiving on this fixed disk.
- Jupiter exact/direct quote support is implemented but not operational because no approved API key
  is configured. DexScreener observations remain market context, not executable fills.
- Reviewed optional Meteora/Orca/Raydium manifests are implemented but disabled. Base ingestion
  must remain stable and each venue needs independent denominator/decoder proof before sockets are
  enabled; Raydium AMM v4 still needs a reviewed account-state adapter.
- Wallet-alpha signals remain `0`. There is no validated alpha or live-capital authorization. Keep
  the future-only seven-day/market, 14-day paper, exact-fill, rug/tail and independence gates.

## Verification summary

- R13 exact-image queue/wake tests passed 18/18 locally and on the production host. Disposable
  PostgreSQL 16 evidence integration passed 27/27; the scoped atomic image updater passed 3/3.
  Production runtime-tree SHA-256 was
  `399b9449952176b23a2e8115dbc2da9f5a9bd29830a39e19e92350c3c671cba3`.
- TypeScript, ESLint and the workspace production build passed after R15. The complete Windows
  suite passed 335 tests with 34 intentional skips once the verified zstd 1.5.7 binary was placed
  on the test-process PATH.
- Disposable PostgreSQL 16 evidence/coverage integration passed 30/30 and archive pipeline
  integration passed 4/4. The exact Linux/amd64 R15 image passed 67/67 critical discovery,
  supervisor, reconnect and archive-artifact tests.
- PostgreSQL 16 integration passed 24/24 locally, including NUL values and object keys. Exact R14
  image provider/queue plus Linux archive regressions passed 43/43; exact R12 image query tests
  passed 2/2.
- R10 finality PostgreSQL integration passed 21/21 and Linux critical zstd/finality/migration suite
  passed 19/19. The broader post-R13 Windows run passed 329 tests; two archive tests failed only
  because the Windows host lacks `zstd`, then passed 3/3 in the exact Linux R13 image.
- Rollback points include the immutable R14 ingestion image, older R13/R10 ingestion images and the
  verified current dump. R15 changed no schema or canonical row. Only the exact temporary R15 image
  transfer file created for this rollout was removed after SHA/image verification; no volume, B2
  object, canonical data or unrelated service was deleted.
