# Discovery Coverage Proof R22 Rollout — 2026-08-24

## Outcome

R22 removes the moving-head reconciliation bug from Solana discovery repairs. A completed repair
is now bound to the immutable signature/slot captured at collection start, independently checked
with `getSignatureStatuses(searchTransactionHistory=true)`, required to be successful and
`finalized`, and persisted in an append-only PostgreSQL proof row before an incident can be marked
reconciled. Live execution remained disabled.

The deployment also removed a live transport fault found during the rollout. PublicNode
acknowledged the Pump.fun and PumpSwap `logsSubscribe` requests but delivered zero notifications.
Bounded canaries against `api.mainnet-beta.solana.com` delivered 24,169 Pump.fun notifications in
20 seconds and 15,449 PumpSwap notifications in 23 seconds. Discovery WebSockets now use the
official endpoint for all four reviewed programs, while historical transaction fetch and repair
stay on PublicNode. Helius discovery credits are not consumed.

## Safety and release identity

- Only the Walletscaner `solana-ingestion` service was recreated. PostgreSQL, Redis, backup,
  archive, maintenance, notifier, sampler, wallet-alpha and operations containers were not
  restarted.
- `ENABLE_LIVE_EXECUTION=false` was verified in the running container.
- Runtime image: `walletscaner-worker:discovery-coverage-proof-r22-20260824`.
- Runtime source SHA-256 label:
  `13413cee1b9ff81b89af4bc3d51a4be5dd95f555d9406446e04c4cfeb1232222`.
- Runtime revision label: `2666a81`.
- The two changed runtime files had identical SHA-256 values locally and on the server.
- Rollback is the guarded image transition from R22 to
  `walletscaner-worker:discovery-repair-cap-r20-20260824`, recreating only
  `solana-ingestion`. Migration 046 is additive and remains in place on rollback.

## Database migration and proof

Migration `046_exact_finalized_discovery_repair_proof.sql` was applied online while the scheduled
`pg_dump` continued. Its production checksum is
`696e762ec22aff6134fd775c11baf3228bc8be3237a0c57f72a6a13bba8f05fb`. The final design creates an
append-only `ingestion_gap_repair_target_proofs` relation and trigger gates; it does not rewrite or
take an access-exclusive schema lock on the active repair table.

The rollout produced exact finalized proofs for the previously completed CPMM and Pump.fun
repairs. Each proof retained the pre-fix moving cursor slot in `previous_covered_through_slot`,
normalized the repair to the immutable target slot, and closed the incident with proof label
`durable-oldest-first-replay-and-exact-finalized-target`.

No gap is declared complete merely because the current transport recovered. Oversized historical
intervals remain excluded and are closed only as unreconciled after the configured repair capacity
is exhausted and two fresh healthy transport samples exist.

## Verification

- TypeScript typecheck: passed.
- ESLint: passed.
- Workspace production builds: passed.
- Target discovery/provider/migration tests in the exact Linux runtime: 74/74 passed.
- Disposable PostgreSQL 16 ingestion-coverage integration: 8/8 passed.
- Broader Windows suite: 363 passed, 39 skipped; two archive tests could not find local `zstd` and
  passed in the Linux image where `zstd` exists.
- The exact Linux critical suite including backup/archive tooling passed 78/78 before the online
  migration redesign; the redesigned migration and repository path then passed the targeted and
  PostgreSQL integration gates above.

## Live capacity evidence

After all four discovery programs were placed on the official WebSocket, the observed active
programs reported current source slots. Ingestion settled near 6.5% CPU and 71.5 MiB of its 160 MiB
limit; the host retained about 1.0 GiB available memory. The scheduled 2026-08-24 PostgreSQL dump
was not interrupted and completed archive-list plus local SHA validation at 1,692,713,492 bytes;
it still awaits off-host verification, while the verified 2026-08-23 server/off-host generation
remains. The root filesystem had about 19 GiB available at 73% used.

Startup/re-route backfills opened bounded repair sessions. Their historical intervals remain alpha
excluded until exact repair proof or explicit capacity retirement. The Pump.fun, PumpSwap and CPMM
startup repairs each reached the 20,000-signature cap, were stored as terminal `failed`, and closed
with `current-transport-healthy-repair-cap-exhausted` / `alpha_excluded_unreconciled`. At the final
observation, open incidents were zero; all four program transports reported `ok`, with Pump.fun,
PumpSwap and CPMM at zero slot lag and LaunchLab at two. This is not a claim of full discovery
validation.

The canonical inbox had 7 pending and 1 processing row as a normal live working set, no dead-letter
row, and the newest pool was 13 seconds old. Telegram had no pending, retry, processing or
dead-letter message. The database size was 14,525,111,319 bytes.

The aggregate operations monitor still reports `degraded` for separate, real storage lifecycle
reasons: the new dump awaits off-host acknowledgement, database size exceeds its 12 GiB warning,
chain-payload compaction lag is about 14.1 hours, and the conservative runway is 2.61 days above the
8 GiB reserve. Discovery transport health must not be inferred from that aggregate label alone.

One residual design gap remains explicit: the durable discovery cursor advances after an accepted
candidate or after transaction-level backfill exclusion, not for every live raw notification that
the in-memory exact-log prefilter rejects. A restart on very high-volume programs can therefore
saturate the 500-signature startup window even when the pre-restart socket was current. The present
fail-closed behavior bounds the repair at 20,000 signatures, permanently excludes an unrepaired
interval, and then admits future live data; it no longer loops incidents or fabricates coverage.
A later release should add a bounded, ordered, durable transport checkpoint that cannot overtake a
candidate awaiting PostgreSQL admission. That optimization was not mixed into this incident
rollout because it changes the cursor correctness contract and requires replay/crash testing.
