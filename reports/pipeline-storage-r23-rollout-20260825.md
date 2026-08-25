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

- Status: `r24-canary-rejected-r25-candidate-first-hotfix-required`
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
selected 500 rows in 6.541 milliseconds. Storage capacity remains unaccepted until the exact R25
image passes a mutating canary and a normal recurring cycle advances the oldest boundary above
measured ingress.

## Next safe command group

1. Pass type/lint/tests and exact Linux image gates for the R25 candidate-first hotfix.
2. Transfer and SHA-verify the immutable R25 image; no migration is required.
3. Run an R25 one-shot canary without changing the persistent R23 image selectors.
4. If accepted, atomically update only the operations image selector to exact R25 and recreate
   `data-maintenance` plus `operations-monitor`; keep ingestion/research/notifier on identical R23
   application code to avoid an unnecessary discovery restart.
5. Run one advisory-lock-protected normal cycle and prove the
   oldest uncompacted boundary advances with rows/hour above peak ingress.
6. Finish restart/OOM/discovery/queue/resource and disk-headroom verification.

Do not use Compose `down`, a host build, a global prune, a volume command or a B2 delete/lifecycle
action for this rollout.
