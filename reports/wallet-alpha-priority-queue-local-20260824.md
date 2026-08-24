# Wallet-alpha Priority Queue — Local Completion Evidence

Generated: 2026-08-24 (Europe/Istanbul)

Status: **Local pre-rollout evidence; subsequently deployed and operationally canaried.** Live
execution remains disabled. Production evidence and residual gates are recorded in
`reports/wallet-alpha-priority-r13-rollout-20260824.md`.

## Outcome

The wallet-alpha worker no longer has to treat every historical revision as equally urgent. It
keeps one durable, revision-safe PostgreSQL row per wallet/strategy and schedules three lanes:

| Priority | Meaning         | Producers                                                       |
| -------: | --------------- | --------------------------------------------------------------- |
|        2 | signal-relevant | source-linked + controlled-flow + known/passed token-risk entry |
|        1 | score-changing  | other entry evidence, sells, outcome transitions                |
|        0 | background      | buys, price enrichment, historical materialization              |

Priority changes scheduling only. It does not weaken score, risk, coverage, paper or alpha gates.
Unknown/failed risk cannot enter priority 2. Producers coalesce into the existing row by incrementing
its revision and retaining the greatest pending priority. Completing revision `N` cannot clear a
newer revision `N+1` that arrived during the lease.

The single existing worker now stays alive, claims highest priority first and uses commit-bound
`LISTEN/NOTIFY` to wake for priority 1/2 work. PostgreSQL remains the durable truth: notification
loss or listener failure falls back to a 30-second backlog poll and 300-second idle poll. Listener
reconnect uses bounded exponential backoff. No second scorer or increased CPU/RAM ceiling was added.

## Verification

- TypeScript typecheck: passed.
- ESLint: passed.
- Targeted memory/migration/scheduler/report tests: passed.
- Disposable PostgreSQL 16 evidence integration: 27/27 passed after the final migration revision.
- Priority-specific suite: fail-closed classification, priority order, revision race, old-release
  rollout normalization, commit-bound notification and wake coalescing passed.
- Production web build and Compose configuration validation: passed.
- Full workspace test: 338 passed, 36 skipped; two unrelated archive-artifact tests could not start
  because the Windows host has no `zstd` executable (`spawn zstd ENOENT`). The changed queue path has
  no failure, and the PostgreSQL suite ran separately rather than being counted as a skip.
- Disposable 10,000-pending-row plan: `idx_wallet_alpha_work_priority_claim`, execution 0.201 ms,
  eight shared-buffer hits.
- Local end-to-end wake canary: committed priority-2 entry to immediate signal refresh 181 ms;
  cycle 166 ms, zero queue failure, zero residual pending, 67.65 MiB RSS. This is not a production
  latency claim.

## Production rollout gate used after this local validation

1. Verify a fresh on-host and off-host backup generation, disk/WAL/temp reserve, live-execution
   false, current mounts and exact service/image inventory.
2. Build and test one immutable artifact. Both evidence producers and `wallet-alpha` need the new
   repository contract; do not deploy only the consumer and mistake priority-0 compatibility mode
   for the completed feature.
3. Apply additive migration 043. It is compatible with the old direct upsert during the short
   container replacement window and requires no destructive table rewrite.
4. Recreate only explicitly authorized Walletscaner services with `--no-deps`; do not use `down`,
   global prune, host tuning or any protected co-tenant operation.
5. Prove `listener=listening`, priority-2 oldest age/queue-to-refresh p95 below 3 seconds and p99
   below 10 seconds, no failed growth, background net drain, no OOM/restart, and unchanged 7% CPU /
   160 MiB container limits over a bounded canary and then 24 hours.
6. Roll back by restoring the prior immutable service image references and recreating only those
   named Walletscaner services. Leave migration 043 in place: it is additive and old releases ignore
   the extra scheduling metadata safely.
