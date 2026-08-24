# Discovery transport R20 rollout — 2026-08-24

## Outcome

R20 removes the recurring LaunchLab incident/recovery loop without weakening coverage. Four
independent discovery subscriptions are split across two free standard-RPC WebSocket providers,
historical gaps use durable exact-boundary repair, and a repair that exceeds its reviewed capacity
is preserved failed and permanently alpha-excluded instead of retried without bound. Live execution
remains disabled; no strategy, score, risk or paper threshold changed.

At the 07:46 UTC canary boundary, Pump.fun, PumpSwap and LaunchLab current transport were `ok`.
CPMM live transport was current at zero slot lag but retained one open historical incident while its
verified 11,143-signature repair replayed oldest-first. This single converging repair is the only
reason aggregate discovery remains temporarily `degraded`.

## Root cause

- CPU, RAM and queue pressure were not the incident trigger. Discovery had zero queued, dropped,
  unresolved and handler-rejected signatures.
- The production PublicNode path acknowledged all four independent `logsSubscribe` sockets but
  delivered program notifications only to two sockets from the host. Application `getHealth`
  heartbeat proved the connections were open, not that program notifications were complete.
- An independent activity probe saw LaunchLab/CPMM chain activity ahead of their silent sockets and
  correctly reopened fail-closed incidents. Suppressing raw-silence alarms would therefore have
  hidden real coverage loss.
- A controlled 15-second two-program comparison received 199 notifications from PublicNode and 202
  from `api.mainnet-beta.solana.com`, with both endpoints acknowledging both subscriptions and
  reaching the same latest slot. This isolated per-host/multi-socket delivery as the failure mode.

## Implementation

- `SOLANA_DISCOVERY_WS_SECONDARY_URL` and
  `SOLANA_DISCOVERY_WS_SECONDARY_PROGRAMS_JSON` define one static reviewed split. Startup rejects
  incomplete, duplicate or unknown routes.
- Production keeps Pump.fun/PumpSwap on PublicNode and sends LaunchLab/CPMM to the official Solana
  standard endpoint. HTTP transaction fetch, current cursor and gap repair remain on PublicNode.
- Health exposes only route names and endpoint hostnames. Credential-bearing URLs are never logged.
  The production route uses no new credential and spends no Helius discovery credits.
- Standard sockets retain ACK deadlines, 30-second application heartbeat and generation fencing.
  Activity probes remain independent disambiguation evidence, not a second ingest feed.
- Migrations 044-045 persist repair sessions and staged signatures. Repair collection never moves
  the live cursor; replay begins only after the exact truncation cursor is found and runs
  oldest-first in bounded 50-signature cycles.
- A database trigger permits `coverage_reconciled_at` only for a completed repair whose
  `boundary_source` is `truncation_cursor` and whose incident matches.
- A `gap-repair-signature-cap-*` result is terminal for that repair. After two fresh current-live
  samples, R20 closes only transport state as `transport_recovered_gap_unreconciled`, keeps the
  failed repair and interval, and clears the process-local historical-degradation marker. Strict
  consumers still exclude every unreconciled interval.

## Unsafe R16 canary containment

The first R16 canary exposed that a repair could snapshot the current live cursor after an incident
opened. The worker was stopped before any repair completed or any coverage proof closed. Migration
045 preserved and failed all three sessions as `unsafe-live-cursor-boundary-r16`, closed their
incidents only as unreconciled and added the database proof trigger. Fifty Pump.fun signatures had
already been replayed idempotently; they remain evidence rows but are not and cannot become coverage
proof. No row, volume, B2 object or canonical evidence was deleted.

## Production evidence

- Migration 045 checksum:
  `4cc6064289fde1a7b48f566d7db1eb6c9d5478c7617c27e5c710a4f1e896a4e8`.
- R20 image: `walletscaner-worker:discovery-repair-cap-r20-20260824`.
- Production image ID: `sha256:ec85cedd23f36bafaded3b0130018c0c3f48434353ad1be331f4160f7c5d36c4`.
- Source label: `417578088d87b120d5be6e8edc9ff802f8dea823497054fa65ed92f147ae1964`.
- Linux architecture: `amd64`.
- Pump.fun and PumpSwap each stopped at exactly 20,000 collected signatures, status `failed`, error
  `gap-repair-signature-cap-20000`; neither has a coverage reconciliation timestamp.
- Their current transports closed at 07:46:21 UTC only as unreconciled after fresh live evidence.
- CPMM reached its exact boundary at 11,143 staged signatures and was at 1,200 completed signatures
  at the 07:46 health boundary. Its incident remains open and alpha-excluded.
- First post-close per-program sample: Pump.fun `ok`, PumpSwap `ok`, LaunchLab `ok` with two fresh
  notifications and 10-slot lag, CPMM current with 13,384 notifications and zero slot lag.
- Aggregate counters: zero reconnect, ACK timeout, heartbeat timeout, discovery queue, dropped
  signature and handler rejection.
- Telegram delivered both cap-retirement transitions once. The outbox had only delivered, shadow
  and suppressed rows; no pending, retry or dead-letter row.
- Ingestion, notifier, wallet-alpha, sampler and maintenance had restart count zero, OOM false and
  no error/fatal log match. `ENABLE_LIVE_EXECUTION=false` was read back from ingestion.
- Three resource samples placed ingestion at 6.13-10.51% CPU and 66.93-69.51 MiB of its 160 MiB
  limit. PostgreSQL was 14.56-18.73% CPU and 172.1-211.3 MiB of its 256 MiB limit. No limit was
  raised. Host storage remained about 70% used with about 21 GB free.

## Verification

- TypeScript: passed.
- ESLint: passed.
- Route plus updater tests: 5/5 passed.
- Provider/supervisor tests after cap behavior: 70/70 passed.
- Exact R20 image route/provider/supervisor/migration suite: 79/79 passed locally and 79/79 on the
  production host.
- Disposable PostgreSQL 16 populated migration-045 integration: 8/8 passed earlier in this rollout.
- Broader workspace build passed. The broader Windows suite passed 350 tests with 38 intentional
  skips; two archive-artifact cases require an external `zstd` executable on Windows and pass in the
  exact Linux runtime. This environment limitation is unrelated to discovery.

## Rollback

The exact pre-R19 and pre-R20 `.env.server` copies were retained. R19, R18 and the earlier R13 image
remain available. Roll back by atomically restoring the exact route/image pre-state and recreating
only `solana-ingestion --no-deps`. Migrations 044-045 are additive and fail-closed; do not edit or
remove them. R16 must never be selected as a runtime rollback because its boundary choice is unsafe.

## Residual gates

- Wait for CPMM replay, independent repaired-head match and post-incident WebSocket evidence. Only
  then may its incident receive a real coverage reconciliation timestamp and one final Telegram
  transition.
- Keep watching the split route through natural reconnects. This canary is operational evidence,
  not the independent 99% supported-program denominator or forced fork/rollback gate.
- Historical Pump.fun/PumpSwap intervals are intentionally unreconciled and permanently excluded.
  They must not be relabelled or used to tune a frozen alpha cohort.
- Current discovery transport health does not establish profitable alpha or authorize live capital.
