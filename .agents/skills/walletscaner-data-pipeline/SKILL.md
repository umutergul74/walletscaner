---
name: walletscaner-data-pipeline
description: "Design, implement, or review Walletscaner Solana ingestion, provider adapters, canonical persistence, replay, retention, backup, and performance changes. Use for data-pipeline correctness or capacity work; not for strategy tuning alone."
---

# Walletscaner Data Pipeline

Build a complete, bounded change whose correctness can be replayed and measured.

1. Read the root `AGENTS.md`, `skills.md` routes **Solana ingestion and provider adapters**,
   **Database, schema, and storage**, and `docs/agent/current-state.md`. Select only the relevant
   architecture/provider/data-model/storage documents and source files.
2. Define the canonical event, idempotency key, ordering/finality semantics, retry/dead-letter path,
   coverage denominator, retention owner, and measurable performance budget before editing.
3. Preserve inbox-before-side-effects, exact raw token quantities, event/receive/process/finality
   times, fail-closed coverage, provider isolation, and deterministic replay.
4. Bound every queue, scan, batch, cache, retry, provider call, statement, worker cycle, and retained
   payload. A larger heap, longer timeout, or hidden alert is not a durable capacity fix.
5. Add a new numbered migration for schema changes; never rewrite an applied migration. Rehearse
   populated PostgreSQL 16 upgrades and measure locks, WAL, temporary disk, query plans, and rollback.
6. Validate fixtures, malformed and partial payloads, duplicates, out-of-order delivery, reconnect
   and gap repair, cursor non-advancement, provider failure, resource ceilings, and retention
   equilibrium. Run targeted tests before the repository gate.
7. Update code, tests, schema/config documentation, operations guidance, and build context together.

Production mutation, provider purchase, credential changes, heavy maintenance, or payload retirement
requires the separate production-operations workflow and current backup/headroom proof.
