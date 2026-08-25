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

- Status: `r23-canary-partial-r24-compaction-hotfix-required`
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
safe, but storage capacity is not accepted until R24 removes that contradictory lower bound and a
normal/one-shot canary advances the oldest boundary above measured ingress.

## Next safe command group

1. Pass type/lint/tests and exact Linux image gates for the R24 compaction-only hotfix.
2. Transfer and SHA-verify the immutable R24 image; no migration is required.
3. Atomically update the same four guarded image keys from exact R23 to exact R24.
4. Recreate only `data-maintenance`; run one advisory-lock-protected normal cycle and prove the
   oldest uncompacted boundary advances with rows/hour above peak ingress.
5. Recreate the remaining five R24 services only after the maintenance canary passes, then finish
   the 15-minute restart/OOM/discovery/queue/resource canary.

Do not use Compose `down`, a host build, a global prune, a volume command or a B2 delete/lifecycle
action for this rollout.
