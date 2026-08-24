# Walletscaner Agent Operating Contract

## Scope and precedence

This contract governs the repository. Apply instructions in this order:

1. The user's current request and explicit scope boundaries.
2. This file.
3. A matching repository skill under `.agents/skills/` and its route in `skills.md`.
4. Current-state, architecture, data, research and operations documents.
5. Existing implementation and tests.

Resolve conflicts explicitly from current code and runtime evidence. Never expand diagnosis into
implementation, local work into production mutation, paper research into live capital, or one
authorized operation into a broader one.

## Project boundary

Walletscaner is a Solana evidence, wallet-intelligence and paper-research system. It discovers
newly tradable tokens, records canonical chain evidence, derives verified wallet trades,
materializes deterministic FIFO ledgers, measures realized profitability and post-detection
followability separately, applies fail-closed risk gates, and emits explainable research or paper
signals.

It is not a live execution bot, blind copy trader, EVM indexer, price-momentum-only signal generator
or a production writer based on legacy `market-watch`/`live-alpha` file state.

Keep `ENABLE_LIVE_EXECUTION=false`. Do not add private keys, signing, transaction submission or
real-capital execution without a separately authorized security and acceptance phase.

## Efficient task routing

Use the smallest matching repository skill:

- `$walletscaner-audit`: read-only status, diagnosis, root cause, architecture review and planning.
- `$walletscaner-data-pipeline`: Solana ingestion, providers, PostgreSQL, replay, retention, backup
  and capacity engineering.
- `$walletscaner-alpha-research`: wallet/token risk, outcomes, scoring, backtests, signals and paper
  research.
- `$walletscaner-production-ops`: server, Compose, backup, migration, deploy, start/stop and incident
  work.

Read only the routes and sources required by that skill. For claims about the deployed system, read
`docs/agent/current-state.md` and refresh the relevant live state. Use
`docs/agent/operating-contract-history-20260823.md` only for release archaeology or past incident
evidence; it does not grant current authority.

## Status language

- **Implemented**: the code path exists and relevant tests pass.
- **Operational**: the intended live path is running and current health checks pass.
- **Validated**: predefined real-data acceptance gates pass.
- **Waiting**: the system is healthy but mature future evidence is not available.
- **Blocked**: a concrete dependency prevents progress.

Do not substitute liveness, elapsed time, zero backlog or a generated report for correctness,
coverage, validation or alpha.

## Production authority and shared-host safety

Production mutation requires explicit authority for the exact action in the current request. Begin
with read-only inventory. Before a mutation, verify exact targets, live-execution state, current
backup/restore evidence, disk/WAL/temp headroom, persistent mounts, rollback point and pre-state.

The production host is shared. The `robinhoodscaner-intel` Compose project and
`/root/RobinhoodScaner_new` are protected and outside scope. Do not change, stop, restart, rebuild,
inspect for secrets or otherwise disturb them. Host CPU, RAM, swap, disk, Docker daemon, networking,
firewall, packages and reboot state are shared resources.

For Walletscaner operations:

- work from `/opt/walletscaner` and target
  `docker compose -p walletscaner -f docker-compose.server.yml` plus named services;
- capture both Compose projects before and after a mutation;
- avoid `down` when `stop` satisfies the request;
- never use dependency-following `docker compose create` to rebind a stopped worker;
- use explicit `docker compose run -e` overrides for one-shot safety settings;
- never run global Docker/BuildKit/volume prune, wildcard target lists, host-wide changes,
  `VACUUM FULL` or destructive DDL without separate explicit authority and recovery proof;
- review `scripts/deploy.sh` line by line; it is not a safe default deploy command;
- keep API, web and legacy-research services stopped unless the current request authorizes them.

Do not infer restart, migration, deletion, provider purchase or host-change authority from a prior
session. A failed hard gate stops or rolls back the rollout; it is not normalized as degradation.

## Secrets and external systems

Never read, print, log, patch or commit `.env`, `.env.server`, credentials, tokens, passwords,
private keys, webhook URLs or full container environments. Inspect names and explicitly selected
non-secret operational values only. Redact logs and reports.

Backblaze B2 code and commands must never delete objects, manage buckets/lifecycle, alter Object
Lock or bypass governance. Keep policy attestation distinct from API-verified retention. At least one
verified server dump and two verified off-host generations must remain. Do not retire canonical
data without the documented SHA/restore/coverage/dual-read gates.

Add MCP or another connector only for a named live-data/action gap, with least-privilege credentials
outside the repository, explicit tool allow lists, bounded timeouts and write approvals. See
`docs/agent/codex-tooling.md`.

## Canonical architecture invariants

Preserve these unless the user explicitly authorizes an architecture change:

1. PostgreSQL is the production system of record; Redis is bounded hot/cache/rate-limit state.
2. Accepted chain events are durably and idempotently written to `chain_event_inbox` before parsing
   side effects.
3. Inbox/outbox work has intentional unique keys, leases, retries, attempts and dead-letter states.
4. Store Solana slot and chain event time; keep occurred, received, processed and finalized times
   semantically distinct.
5. Do not advance a partition cursor past an unresolved older event. Coverage gaps fail closed and
   remain excluded until separately verified repair.
6. Exact token quantities use raw decimal strings plus decimals. JavaScript `number` is not an
   accounting boundary.
7. Execution price has explicit provenance. Market snapshots are context/outcome evidence, not
   canonical fills.
8. Wallet identity requires signer, fee-payer or verified venue authority. Pool, vault, program and
   infrastructure addresses are not traders.
9. FIFO ledger, scores and replay hashes are deterministic under duplicates and input reordering.
10. Wallet realized profitability, bot followability, token/pool risk and executable fill quality
    remain separate measurements.
11. Unknown/failed critical risk, incomplete trade coverage, invalid timing or unresolved finality
    blocks downstream paper/alpha admission.
12. Direct creators are excluded. Missing creator/funder/cluster/insider coverage is reported as a
    gap, not treated as passed.
13. Paper/research strategy versions and activation boundaries are immutable; new thresholds create
    a new future-only version.
14. Every recurring job, queue, cache and dataset has bounded memory, concurrency, time, retries,
    retention, cleanup cost and progress/lag telemetry.
15. Live execution remains disabled.

Raw provider payloads require a replay/debug purpose, immutable digest, bounded retention and a
cheaper archive path. Do not create an unbounded JSON store.

## Engineering workflow

### Before editing

1. Inspect `git status --short --branch` and preserve unrelated/user changes.
2. Read the matching skill, its `skills.md` route and only the needed source-of-truth documents.
3. Map source -> durable state -> transformation -> consumer and name runtime ownership.
4. Reproduce or measure the baseline. Separate verified facts, inferences and hypotheses.
5. Define the invariant, acceptance criteria, failure path, rollback, data migration, provider cost
   and operational load.

### Implementation

- Prefer the smallest coherent fix, not a cosmetic symptom change.
- Keep provider I/O behind adapters and business logic deterministic.
- Use bounded pagination, streaming, watermarks, dirty entities or partitions for growing data.
- Never load or periodically rewrite an unbounded production table.
- Make retention capacity exceed measured peak ingress.
- Add a new numbered migration; never edit an applied migration.
- Design indexes from observed predicates/order and measure locks, WAL, temp disk and query plans.
- Keep code, tests, schema/config docs, operations docs and `.superstack/build-context.md` aligned.

### Verification

Run targeted checks first, then the applicable repository gate:

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build --workspaces --if-present
```

Use Node.js 22+; CI currently uses Node.js 24 and `package-lock.json` is authoritative. Database
integration requires disposable PostgreSQL 16 plus `TEST_DATABASE_URL`; skipped integration is not
a full gate.

Additional evidence:

- provider/parser: real-mainnet fixtures, malformed/partial input, duplicate/out-of-order replay,
  reconnect/gap repair, denominator coverage and latency percentiles;
- ledger/scoring/research: ordering invariance, partial sells/reopen, temporal-leakage controls,
  chronological holdout, negative controls, tail loss and fill realism;
- migration/storage: clean install, populated upgrade, plans/locks/WAL/temp/disk, restore and
  retirement parity;
- worker/performance: representative volume, runtime/RSS/CPU/I/O, queue lag and recovery;
- operations: immutable artifact identity, pre/post inventory, mounts, migrations, health,
  backup, resources and protected co-tenant verification.

If a required check cannot run, say why and do not silently downgrade the result.

## Production/research gates

Do not enable user-facing alpha delivery or advance a research phase until its relevant gates are
proven, including:

- independent supported-program coverage at least 99% with explicit source denominator;
- ingest lag p95 below 3 seconds and p99 below 10 seconds;
- reconnect gaps closed within 5 minutes and finalized rollback/reconciliation verified;
- no growing backlog, dead-letter accumulation, hidden drops or stale report;
- duplicate replay leaves canonical, ledger and score hashes unchanged;
- at least seven stable future-only shadow days and mature distinct-market count;
- at least fourteen paper-only days with chronological untouched holdout;
- exact-pool, size-aware fees/slippage/latency/failed-fill/rug modeling;
- sustainable measured storage, backup, restore and retention with reserve headroom.

Passing a time gate requires mature samples and successful measurements, not calendar time alone.
Do not lower risk/tail gates or tune a frozen cohort to manufacture a signal.

## Source-of-truth map

- `README.md`: product boundary, supported venues and public commands.
- `.superstack/build-context.md`: compact implementation handoff.
- `docs/architecture.md`, `docs/data_model.md`, `docs/providers.md`: canonical flow and persistence.
- `docs/wallet_intelligence.md`, `docs/scoring.md`, `docs/risk.md`, `docs/backtesting.md`: evidence,
  scoring, risk and research contracts.
- `docs/operations.md`, `docs/storage_lifecycle.md`: production, retention, archive and rollout.
- `docs/agent/current-state.md`: dated compact runtime/research handoff.
- `scripts/migrations/*.sql`: ordered database contract; applied migrations are immutable.
- `docker-compose.server.yml`: intended server topology.
- `reports/`: generated evidence, not canonical PostgreSQL state.

## Code review rules

Prioritize data loss/corruption, temporal leakage, secrets, production/co-tenant safety,
idempotency/order/replay/recovery, unbounded work, storage equilibrium, provider correctness/cost,
observability and tests before style. Every finding needs concrete evidence, impact, a failure path
and the smallest credible remediation.

## Definition of done and handoff

Work is done only when the requested outcome is complete within scope, invariants hold, applicable
tests/integration/performance checks pass, recovery paths are covered, docs/config/schema agree, no
secret or unrelated user work is lost, operational impact is understood and production changed only
when authorized and verified.

Report the outcome first, changed files/behavior, checks and skipped checks, migrations/operations,
current server state when touched, residual risk, rollback point and next measurable gate. Never
present placeholders, mocks, stale reports, process liveness or waiting artifacts as a real-world
validated result.
