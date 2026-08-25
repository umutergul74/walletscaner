# Pipeline/storage R23 rollout ledger

- Release: `pipeline-storage-r23-20260825`
- Source revision: `8fbe97f`
- Image ID: `sha256:b803377462b6167e9f3ea7a5d1b3120877cc1a20e1e300eb0723da97a97f7c7a`
- Export bytes: `463393792`
- Export SHA-256: `a11fc58d9199cab9703cf4f81ffc0e652d9e32b749efc3aef8449c8a1ab5b983`
- Migration: `047_wallet_alpha_evidence_quarantine.sql`
- Live execution: `false`

## Recovery point

- PostgreSQL dump: `memecoin_alpha_20260824T150923Z.dump`
- Dump bytes: `1692713492`
- Dump SHA-256: `13e1fdeddef5f6ea90482e3d592aeaa45b280070de2c95f642fc3117215cd574`
- Local/server byte identity, PostgreSQL 16 archive-list and off-site acknowledgement passed at
  `2026-08-25T09:13:42Z`.
- Pre-release images and exact container identities were captured in the active task evidence.

## Current phase

- Status: `r25-storage-accepted-r26-query-plan-passed-r27-refresh-gate-required`
- Completed: local gates; exact Linux zstd/PostgreSQL 16 gate; production backup, disk, migration,
  invalid-index, resource and co-tenant-safe preflight; resumable image transfer; remote SHA/image
  label verification.
- No canonical data, B2 object, volume or unrelated service was deleted.

R23 migration and six-service rollout succeeded with exact image identity, restart/OOM zero and
unchanged resource limits. Wallet-alpha P2 moved `252 -> 178 -> 1`; the remaining item is an active
`evidence_limit` quarantine and the second cycle processed 100 revisions in 22.382 seconds with zero
failure. The first normal maintenance cycle compacted 2,500 payloads in 23.587 seconds, then its
sixth batch hit the five-second statement timeout. Live inspection proved that its three-day lower
bound excluded the monitor's oldest verified/recoverable uncompacted row. R23 remains operationally
safe. R24 removed that contradictory lower bound, passed its exact-image test gate and was loaded
on the host without changing the running image selectors. Its advisory-lock-protected one-shot
canary completed in 11.906 seconds but compacted zero rows because the first archive/day-first query
hit the dedicated 7.5-second statement timeout. No source row was retired by that failed stage.

Production `EXPLAIN ANALYZE` then isolated the remaining bottleneck: the query walked archive days
and broad `received_at` ranges before reaching the oldest uncompacted row. The R25 candidate-first
query walks `idx_chain_event_inbox_prehashed_compaction` in canonical age order, bounds the batch at
500 and checks verified/locked archive coverage per candidate. Its read-only production plan
selected 500 rows in 6.541 milliseconds. The exact R25 image passed both its one-shot and normal
recurring production cycles: each compacted 8,000 archive-covered payloads with zero timeout. The
oldest uncompacted boundary advanced `2026-08-22T06:41:18.999Z -> 07:45:13.251Z -> 10:39:17.344Z`.
At the 30-minute production interval this is 16,000 rows/hour, above the measured peak ingress.
Only the operations selector and `data-maintenance`/`operations-monitor` were moved to R25; the
ingestion, research and notifier services remained on identical R23 application code and were not
restarted. Three exact temporary transfer tar files were removed after both R23 rollback and R25
images were reverified, increasing disk headroom to approximately 18.99 GB. No canonical/B2/backup
data or Docker image was removed.

The post-storage SQL delta identified the remaining research bottleneck as the one-wallet trade
loader: passing a one-element `ANY(text[])` forced an external sort despite the existing
`(strategy_version, wallet_address, observed_at)` index. The R26 research-only change uses scalar
wallet equality for one-wallet rebuilds, allowing the existing index plus bounded incremental sort;
multi-wallet research semantics remain unchanged and no additional production index/disk is needed.
R26 passed 57 exact-image tests and its production scalar-query path used the intended existing
index, but the live canary exposed an independent N+1 refresh bottleneck: every processed P2 wallet
ran the global signal scan even when its newly persisted score was not `watch` or better. Four such
wallets produced zero signals while new P2 work outpaced completion. R27 keeps the final per-cycle
global correctness refresh, but permits an immediate refresh only when the just-built score is
`watch`, `candidate` or `validated-paper`. No score/risk threshold is relaxed.

## Next safe command group

1. Build and pass the exact Linux/PostgreSQL gate for R27.
2. Transfer and SHA-verify the immutable R27 image; no migration is required.
3. Gracefully stop R26, atomically update only `WALLETSCANER_RESEARCH_IMAGE` from exact R26 to R27,
   and recreate only `wallet-alpha`.
4. Verify P2 drain, actual/skipped immediate refresh counts, final refresh correctness, restart/OOM,
   RSS/CPU and `pg_stat_statements` deltas. Do not restart ingestion or notifier.
5. Record final discovery-repair progress, background research-lane slope, compaction catch-up and
   disk headroom. Historical excluded intervals stay fail closed until proven repair.

Do not use Compose `down`, a host build, a global prune, a volume command or a B2 delete/lifecycle
action for this rollout.
