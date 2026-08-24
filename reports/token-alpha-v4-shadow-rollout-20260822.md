# Token Alpha V4 Shadow Rollout — 2026-08-22

## Outcome

- `qualified-pool-paper-v3-strict-flow` is paused with $85.837661809865 cash,
  -$14.1623381901 realized PnL and zero open positions.
- Migration 039 froze `strict-flow-v4-causal-shadow-20260822` at
  `2026-08-22T20:00:10.081341Z` with paper, Telegram and live execution disabled.
- `telegram-notifier` runs immutable image `signal-causal-shadow-r8-20260822`
  (`sha256:4fffea6a9436...`) with `QUALIFIED_POOL_DELIVERY_MODE=shadow`.
- Future strict-flow candidates are retained as non-deliverable `shadow` decisions. They cannot be
  claimed by Telegram or consumed by the paused v3 paper portfolio.
- `paper-alert` is rebound to the same R8 image but remains in Compose `created`/stopped state.

## Causal audit decision

The read-only PostgreSQL 16 clone contained 177 distinct historical strict-flow exact markets.
Strict-v2 failed every chronological window. The final holdout had 35 markets, 9.73% median return,
-1.52% average return after removing the best winner, 1.00 profit factor, 11.43% catastrophic-loss
rate and a -107.09% worst outcome after a 7.1% modeled round-trip cost.

The audit reconstructed wallet quality only from outcomes frozen before each market decision.
Twenty-six markets had at least one safe-3 supporter and seven had at least one safe-6 supporter,
but none of 5,760 causal-wallet parameter combinations passed both train and validation. No paper
v4 was authorized.

## Verification

- TypeScript and ESLint passed.
- Focused v4/config/store/migration/deployment tests passed.
- Fresh PostgreSQL 16 applied migrations 001-039.
- PostgreSQL evidence and discovery-coverage integration passed 25/25.
- In the Linux R8 image, zstd/archive and PostgreSQL integration passed. The aggregate image run
  passed 325/329 tests; the four failures were Python deployment-script tests because the minimal
  worker image intentionally has no Python. Those same scripts passed on the Windows/Python host.
- The production image/source transfer matched byte length and SHA-256. The latest 1,207,388,330
  byte server dump and offsite acknowledgement matched SHA-256 before migration.

## Operational incident and recovery

While rebinding the stopped paper container, `docker compose create paper-alert` unexpectedly
recreated the dependency PostgreSQL container; a subsequent scoped `up postgres redis` also
recreated Redis. No volume, image prune or data deletion command ran. PostgreSQL and Redis returned
healthy on their existing named volumes, the database remained 13,186,612,247 bytes, migration 039
and the v3 portfolio were intact, and all application workers reconnected.

Ingestion restarted twice during the brief database/DNS interruption. Its fail-closed supervisor
opened four `backfill_truncated` coverage incidents and closed them after two fresh healthy samples
with resolution `transport_recovered_gap_unreconciled`. Those historical intervals remain
alpha-excluded; they are not represented as reconstructed. The later recovery canary had zero open
coverage incidents, 227/227 discovery candidates decoded, 459 canonical completions, 72 entries,
one active exact-pool trade subscription and three-second wallet-trade freshness, with zero
unmatched/parser failures, queue/drop/pressure or sampling errors. A transient two-pending/one-
processing inbox snapshot drained through the normal worker path; no dead letter appeared.

Do not use dependency-following `docker compose create` to rebind a stopped worker on this host.
Use `up --no-deps` for a service that should run, or create a stopped replacement directly with the
reviewed Docker container configuration after proving the dependency graph will not be touched.

## Next gate

Keep the shadow unchanged for at least seven complete UTC days and 30 distinct future exact
markets. Promotion requires exact-pool fill replay, positive median and average excluding the best
winner, at least 60% hit rate, at least 1.2 profit factor, at most 5% rug/catastrophic loss, worst
return no lower than -35%, best-winner share at most 40%, and creator/funder/cluster independence.
Changing a threshold requires a new version and activation boundary.
