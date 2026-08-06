# Walletscaner Task Playbook

This file routes recurring Walletscaner tasks to the correct sources, workflow, invariants, and
verification. It complements the mandatory repository contract in `AGENTS.md`; it is not a generic
technology wish list.

Read only the routes relevant to the task, but always read `AGENTS.md` first.

## Route selection

| Task or trigger                                              | Primary route            | Required sources                                        |
| ------------------------------------------------------------ | ------------------------ | ------------------------------------------------------- |
| Understand, audit, diagnose, status, plan                    | Repository investigation | README, build context, architecture, operations         |
| Solana pool/trade discovery, RPC, WebSocket, Helius, decoder | Ingestion and providers  | architecture, providers, worker/provider source         |
| PostgreSQL schema, migration, query, retention, storage      | Database and storage     | data model, migrations, repository, operations          |
| Wallet PnL, FIFO, scoring, followability, signals            | Wallet intelligence      | wallet intelligence, scoring, backtesting, alpha source |
| Price sampling, outcomes, evidence quality                   | Evidence sampling        | backtesting, providers, sampler/repository source       |
| Token safety, creators, authorities, clusters                | Risk analysis            | risk, scoring, worker risk source                       |
| Replay, strategy validation, paper trading                   | Research validation      | backtesting, scoring, paper-trading source              |
| API or dashboard                                             | Product surfaces         | API source/tests, shared types, dashboard               |
| Server health, start/stop, deploy, incident                  | Operations               | `AGENTS.md`, operations, Compose, maintenance scripts   |
| Release readiness                                            | Release and handoff      | CI, tests, docs, migration and operations gates         |

## Shared method

Use this sequence for every route:

1. Define the exact question or outcome.
2. Read the listed sources and inspect current implementation.
3. Verify runtime/data state when the claim depends on it.
4. Write down the invariant and measurable acceptance criteria.
5. Reproduce or characterize the baseline.
6. Implement the smallest coherent change when implementation is authorized.
7. Run route-specific checks and the repository validation gate.
8. Report evidence, limitations, operational impact, and next gate.

Use precise status language:

- **Implemented**: the code path exists and tests pass.
- **Operational**: the live path is running and current health checks pass.
- **Validated**: defined real-data acceptance gates pass.
- **Waiting**: the system is healthy but required future/mature data does not exist yet.
- **Blocked**: a concrete dependency prevents further progress.

Do not substitute one status for another.

## Repository investigation

Use for requests such as “understand the project,” “review current state,” “why is this failing,”
or “what should we build next?”

Read:

- `README.md`
- `.superstack/build-context.md`
- `docs/architecture.md`
- `docs/operations.md`
- the task-specific route below

Workflow:

1. Map source → durable ingestion → normalization → evidence → scoring → outbox → consumer/API.
2. Identify canonical versus legacy/offline paths.
3. Inspect service ownership, schemas, provider roles, and acceptance gates.
4. Compare documentation with actual code and deployment configuration.
5. For live questions, inspect process state, logs, API health, data freshness, growth, and resource
   saturation. Use read-only checks first.
6. Stress-test conclusions: look for stale reports, hidden retries, coverage gaps, skipped tests,
   biased samples, and resource failure modes.

Expected output:

- concise architecture summary;
- verified current state;
- data maturity assessment;
- root causes and risks ranked by urgency;
- go/no-go decision;
- staged plan with measurable exit gates.

## Solana ingestion and provider adapters

Use for launch-program discovery, pool tracking, swap ingestion, Helius/Public RPC/Pyth/DexScreener
work, WebSockets, HTTP gap repair, parser changes, and provider cost optimization.

Read:

- `docs/architecture.md`
- `docs/providers.md`
- `docs/data_model.md`
- `docs/operations.md`
- `apps/worker/src/watch-solana.ts`
- `packages/providers/src/solana-event-source.ts`
- `packages/providers/src/solana-ws.ts`
- relevant provider/decoder files and tests

Required design:

- Write every accepted source event to `chain_event_inbox` before side effects.
- Derive stable idempotency from signature, slot, transaction/instruction position, and event role.
- Preserve per-partition ordering and do not skip unresolved older events.
- Keep discovery and trade transport roles explicit.
- Bound subscriptions, repair windows, concurrency, retries, and provider-credit usage.
- Parse exact raw amounts and retain slot, block time, commitment, and decoder version.
- Accept traders only from signer/fee-payer or verified venue-authority evidence.
- Keep pool/vault/program addresses out of wallet evidence.
- Emit structured diagnostics for reconnects, duplicates, unresolved transactions, repair events,
  provider latency, active subscriptions, and cost rate.

Required validation:

- recorded real-mainnet fixtures for every supported instruction variant;
- malformed and partial payload tests;
- duplicate and out-of-order replay;
- reconnect plus bounded gap-repair test;
- cursor/watermark non-advancement on unresolved history;
- parser coverage report by program and instruction;
- ingest latency percentiles and gap-closure time;
- provider failure/fallback and rate-limit tests.

Do not infer coverage from zero backlog. A transaction that never entered the inbox is not visible
to backlog metrics.

## Database, schema, and storage

Use for migrations, repository queries, indexes, retention, backups, table growth, partitions, and
performance work.

Read:

- `docs/data_model.md`
- `docs/operations.md`
- `scripts/migrations/*.sql`
- `packages/db/src/repository.ts`
- `packages/db/src/postgres-repository.ts`
- `scripts/maintenance/prune-operational-data.ts`
- `scripts/maintenance/check-operational-health.ts`

Workflow:

1. Identify the access pattern, cardinality, ingest rate, retention, and correctness key.
2. Measure current table/index size, query latency, dead tuples, and growth before changing schema.
3. Design an additive migration and rollback/forward-repair strategy.
4. Test clean install and upgrade on PostgreSQL 16 with representative data.
5. Inspect the query plan and lock behavior.
6. Deploy only with an external verified backup and sufficient data/WAL/temp headroom.
7. Verify counts, constraints, indexes, application health, and co-tenant health afterward.

Rules:

- Never edit an applied migration.
- Never use floating-point accounting for token raw quantities.
- Never add an index without a demonstrated query pattern.
- Never retain full raw payloads without a bounded purpose and retention plan.
- Prefer daily/time partitions for high-volume observations and events.
- Ensure deletion/partition-retirement capacity exceeds peak insertion rate.
- Remember that `DELETE` and normal vacuum may not return disk to the filesystem.
- Avoid full-table read/transform/write jobs. Use watermarks and dirty partitions.
- Do not run heavy maintenance on the shared server merely to “see if it helps.” Rehearse it on a
  clone and quantify locks, disk, WAL, and duration.

Performance evidence should include rows scanned/returned, execution time, memory, CPU, I/O,
database growth rate, and forecasted exhaustion date.

## Wallet trade evidence and FIFO ledger

Use for wallet trade normalization, position lots/episodes, realized PnL, partial sells, transfers,
and deterministic ledger behavior.

Read:

- `docs/wallet_intelligence.md`
- `docs/data_model.md`
- `packages/core/src/wallet-alpha-engine.ts`
- `packages/db/src/postgres-repository.ts`
- relevant wallet trade and alpha tests

Rules:

- Preserve exact raw amount plus decimals through ingestion and ledger materialization.
- Use same-transaction quote evidence for execution price; stable quotes are observed USD and SOL
  quotes require time-aligned Pyth conversion.
- Treat DEX market price as a proxy/outcome mark, never as historical execution price.
- Realize sells against oldest open lots.
- Keep partial-sale remainder open.
- Close an episode only when inventory reaches zero or a documented terminal-risk rule applies.
- Start a new episode after a closed position is reopened.
- Make duplicate delivery and input order produce identical episode/lot hashes.
- Do not infer wallet PnL from later token price outcomes.

Validation cases:

- multiple buys then partial sells;
- exact close and reopen;
- duplicate and reversed input order;
- mixed data-quality levels;
- missing quote/price evidence;
- transfer/airdrop/infrastructure-address exclusion;
- raw amounts beyond safe JavaScript integer range.

## Wallet-alpha scoring and signal qualification

Use for profitability, followability, reliability, status gates, holdouts, alpha reports, and wallet
signals.

Read:

- `docs/wallet_intelligence.md`
- `docs/scoring.md`
- `docs/backtesting.md`
- `scripts/research/wallet-alpha.ts`
- `scripts/research/wallet-alpha-report-builder.ts`
- `packages/core/src/wallet-alpha-engine.ts`
- `packages/core/src/signal-generator.ts`

Required model:

- Score realized profitability and post-detection followability separately.
- Use 30/90-day views, recency decay, sample shrinkage, Wilson lower bounds, diversity,
  concentration, drawdown, and robust central tendency.
- Require active-day and sample maturity, not merely many events from one day.
- Use chronological holdouts; never randomize away temporal leakage.
- Exclude direct creators and block unknown/failed critical risk.
- Keep candidate thresholds conservative and explain every gate decision.
- Persist signals and paper/alert outbox messages atomically.

Scaling requirement:

- Do not fetch all 90-day trades, entries, and outcomes into one process.
- Maintain per-wallet or per-partition dirty watermarks.
- Update ledger/scoring incrementally from durable state.
- Stream or paginate inputs and bound retained intermediate data.
- Persist score snapshots only when materially changed or at a justified cadence.
- Add stale-report and crash-loop monitoring.

Historical incident and anti-regression rule: the former full evidence load and full-ledger rewrite
hit the Node heap in production. The current design uses a revisioned dirty-wallet queue, bounded
claims and wallet-scoped persistence. Verify those properties and the production-scale memory
benchmark whenever this path changes. A larger heap on the shared host is not an acceptable durable
fix, and local success does not replace the seven-day shared-host shadow gate.

Required validation:

- deterministic scores under replay;
- boundary tests for every status gate;
- chronological holdout tests;
- creator/risk exclusion tests;
- selection-bias and negative-control cohort report;
- production-scale memory/runtime benchmark;
- restart/resume behavior with no duplicate score/signal delivery.

## Evidence price sampling and outcome resolution

Use for DexScreener observations, followability horizons, outcome freezing, sampling cadence, and
time-series retention.

Read:

- `apps/worker/src/sample-evidence-prices.ts`
- `packages/providers/src/dexscreener.ts`
- evidence/outcome methods in `packages/db/src/postgres-repository.ts`
- `docs/backtesting.md`
- migrations for `price_observations`, wallet entries, outcomes, and historical buckets

Rules:

- Fetch once per token/pool/time bucket, not once per wallet.
- Align sampling resolution with the strategy horizon and latency model.
- Use deterministic bucket-based idempotency keys.
- Store compact canonical fields on every observation.
- Store full raw provider payload only at a bounded diagnostic cadence or in cheaper cold storage.
- Freeze mature outcomes deterministically and never revise them using future information.
- Separate provider observation time, chain/event time, and processing time.
- Monitor active entries, tokens sampled, observations inserted, provider errors, resolution lag,
  and rows/bytes per hour.

Before increasing sampling frequency, calculate provider cost, database bytes/day, index/WAL
amplification, retention equilibrium, and shared-host headroom.

Known issue: repeated full DexScreener payloads have dominated database growth. Fix bucketing and
storage shape before resuming a long collection run.

## Token risk and wallet provenance

Use for mint/freeze authority, supply, holder concentration, creator enrichment, funder/cluster
relationships, and fail-closed gates.

Read:

- `docs/risk.md`
- `docs/scoring.md`
- `apps/worker/src/token-risk.ts`
- risk-related provider adapters, migrations, and tests

Required behavior:

- Distinguish `passed`, `failed`, and `unknown`; never coerce unknown into safe.
- Record evidence source, observation time, failure reason, and confidence.
- Keep primary RPC and fallback behavior explicit and measurable.
- Exclude direct creators from wallet-alpha eligibility.
- Report creator enrichment coverage and misses.
- Treat missing funder/cluster/insider implementation as a rollout gap.
- Cache immutable or slow-changing evidence with justified invalidation.
- Avoid expensive enrichment before cheap market/risk gates.

Validate against known safe, known risky, missing-data, transport-failure, and conflicting-provider
fixtures.

## Research, backtesting, and paper trading

Use for strategy experiments, historical replay, cohort analysis, paper portfolio rules, and
evidence reports.

Read:

- `docs/backtesting.md`
- `docs/scoring.md`
- `packages/backtesting/src/replay.ts`
- `packages/paper-trading/src/simulator.ts`
- relevant `scripts/research/*` files and tests

Requirements:

- Reconstruct what was knowable at event time.
- Include detection/provider latency, fees, slippage, liquidity, sizing, failed fills, rugs, and
  exit constraints.
- Separate model selection from untouched chronological validation.
- Preserve a baseline/control and report all attempted strategies, not only winners.
- Report sample count, active days, unique tokens/wallets, concentration, uncertainty, and tail
  losses with headline returns.
- Keep generated research paths out of the canonical production writer flow.
- Paper execution remains the terminal execution boundary.

A valid report must say whether it is a real evaluation, an incomplete/waiting state, or an
operational diagnostic. Never label one as another.

## API and dashboard

Use for Express endpoints, PostgreSQL reads, shared contracts, dashboard behavior, pagination, and
health surfaces.

Read:

- `apps/api/src/app.ts`
- `apps/api/src/server.ts`
- `apps/api/tests/app.test.ts`
- `apps/web/components/dashboard.tsx`
- `packages/shared/src/index.ts`
- relevant repository query methods

Rules:

- Production API requires PostgreSQL and must fail startup when the repository is unavailable.
- Memory repositories are test/demo only.
- Preserve typed `{ "data": ... }` envelopes for list endpoints.
- Bound list queries with filters, limit, offset/cursor, deterministic ordering, and supporting
  indexes.
- Cache expensive health summaries briefly, but expose observation time and staleness.
- Health must separate process/database availability, ingestion freshness, queue health, coverage,
  report freshness, storage growth, and provider diagnostics.
- Never return secrets or raw private configuration from `/api/config` or diagnostics.
- UI must handle loading, empty, stale, degraded, error, and large-result states honestly.

Validation includes API contract tests, failure paths, pagination boundaries, production web build,
and a representative large-data query plan.

## Operations and incident response

Use for server inspection, start/stop, incidents, resource exhaustion, backups, maintenance, and
deployment. `AGENTS.md` is mandatory and takes precedence.

Read:

- `AGENTS.md`, especially Current operational hold and Protected co-tenant
- `docs/operations.md`
- `docker-compose.server.yml`
- `scripts/maintenance/*`
- `deploy/README.md` and SQL only when relevant

Read-only triage order:

1. Confirm host, time, uptime, disk, memory, swap, and load.
2. Enumerate Compose projects, working directories, services, state, and persistent mounts.
3. Inspect Walletscaner-only health endpoints, current reports, and bounded logs.
4. Measure database size, largest relations, growth, backlog, freshness, and report staleness using
   bounded read-only queries.
5. Verify backup time, size, checksum, location, and restore evidence.
6. Distinguish ingestion health, analysis health, storage health, and output maturity.

Mutation protocol:

1. Obtain explicit authority for the exact operation.
2. Record pre-state for both Compose projects.
3. Verify backup/rollback and headroom.
4. Target only `walletscaner` and named services.
5. Avoid host-wide changes and avoid `down` when `stop` satisfies the request.
6. Wait for graceful shutdown/start; record forced exits separately.
7. Verify Walletscaner state, persistent mounts/data, and Robinhoodscaner health afterward.

Never restart the intentionally paused stack merely to run a diagnostic.

## Performance and capacity engineering

Use when CPU, memory, swap, database size, query latency, backlog, or disk growth is involved.

Measure before optimizing:

- rows/events per second and bytes per hour/day;
- table, index, WAL, backup, and Docker storage growth;
- query plan and rows scanned versus returned;
- process RSS/heap, GC time, CPU, I/O, and runtime by stage;
- backlog age, report age, reconnect rate, unresolved delta, and retry/dead-letter rate;
- projected headroom at current and peak rate.

Prefer:

- incremental computation;
- bounded queues and concurrency;
- TTL/capacity-bounded process caches with amortized cleanup and size telemetry;
- database-side aggregation where it reduces data transfer safely;
- streaming/pagination;
- compact schemas and time buckets;
- partitions and cheap retention;
- immutable artifacts and checkpoints;
- circuit breakers and exponential backoff.

Reject “fixes” that only raise limits, hide alarms, increase retention without capacity, or move the
same unbounded work to another process.

## Release and deployment

Use only when the user asks to ship, deploy, start, restart, or prepare a release.

Pre-release:

1. Establish a versioned baseline and inspect the complete diff.
2. Confirm local critical-source hashes correspond to the intended server baseline.
3. Run typecheck, lint, full tests with PostgreSQL integration, and workspace builds.
4. Validate migrations on a representative PostgreSQL 16 clone.
5. Produce an immutable release identifier/image tag and rollback artifact.
6. Confirm external backup restore evidence and disk/WAL headroom.
7. Define exact services affected and co-tenant verification.

Deployment:

- Do not use floating images for rollback-sensitive work.
- Do not rebuild or restart unrelated services.
- Apply backward-compatible schema before code that requires it.
- Prefer a targeted service rollout and bounded canary/shadow verification.
- Keep live execution disabled.

Post-release:

- verify migrations, service health, logs, lag, backlog, report freshness, resource use, storage
  growth, and idempotent delivery;
- verify Robinhoodscaner remains healthy;
- record the deployed version, evidence, and rollback point;
- roll back or stop when a hard acceptance gate fails—do not normalize unexplained degradation.

## Review standard

When reviewing code or a plan, prioritize:

1. data correctness and temporal leakage;
2. secrets and production safety;
3. co-tenant impact;
4. idempotency, ordering, replay, and recovery;
5. bounded resource use and sustainable storage;
6. provider correctness and cost;
7. test coverage and observability;
8. API/product behavior;
9. maintainability and style.

Findings should include concrete evidence, impact, reproduction or failure path, and the smallest
credible remediation. Stress-test attractive results and suspected bugs before accepting them.

## Completion checklist

- Scope stayed within the user's request.
- Relevant route and source-of-truth documents were read.
- Current state was verified rather than assumed.
- Invariants and data maturity were preserved.
- Tests, integration checks, builds, and performance checks were run as applicable.
- Skipped checks are explicit.
- Migrations/config/docs/build context are synchronized.
- Server and co-tenant impact is known.
- No secret, volume, report, or unrelated user work was lost.
- The final handoff gives a truthful go/no-go decision and the next measurable gate.
