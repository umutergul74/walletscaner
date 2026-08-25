---
status: complete
updated_at_utc: 2026-08-25T18:55:00Z
owner: codex
task: finish R30/R29 pipeline hardening and make future work interruption-safe
last_safe_checkpoint: source commits, migration 049 and final production verification are complete
---

# Walletscaner Work In Progress

This is the durable resume point for an interrupted multi-step task. It contains no credentials and
does not grant production authority. On resume, verify every recorded fact before continuing; never
blindly repeat the last mutation.

## Current scope and boundaries

- Finish the evidence-v1 retry/backlog correction without deleting canonical evidence.
- Persist an interruption-safe workflow for future engineering and production work.
- Keep `ENABLE_LIVE_EXECUTION=false`.
- Do not inspect or change the protected co-tenant, global Docker state, volumes, B2 lifecycle or
  credentials.

## Completed and verified

- R30 ingestion and R29 sampler/alpha/maintenance/operations are running; restart/OOM were zero at
  the last observation.
- Migration `049_wallet_alpha_transient_retry_backoff.sql` was rehearsed on disposable PostgreSQL
  16, whose evidence integration passed 32/32.
- Migration 049 is deployed in production with checksum
  `0250d3f480a2283deba2e435ed0ca3f931d6974fd1e43dd4a38d3d25185ff085`.
- A production transaction canary proved revision increment, unchanged retry `not_before`, retained
  error provenance and zero residual canary rows after rollback.
- Latest short sample: evidence-v1 P0/P1/P2 pending `1,871 / 6,548 / 0`; one evidence-limit wallet
  remains intentionally quarantined. This is not yet the one-hour equilibrium gate.
- Typecheck, ESLint and workspace production build pass. Migration contract tests pass 3/3.
- The exact post-049 Node 24/Linux image passed 89/89 files and 428/428 tests with disposable
  PostgreSQL 16, zstd, test-only Python and the reviewed Compose file. The two schema-heavy suites
  passed sequentially (32/32 and 4/4) after their all-parallel setup exceeded only the test hook.
- The interruption-safe contract is now present in `AGENTS.md`, `skills.md` and the production-ops
  skill; this file is the first active checkpoint under that contract.
- Server dump `memecoin_alpha_20260825T150924Z.dump` remains locally verified at 2,053,352,363
  bytes; its newest generation still awaits off-site acknowledgement. About 17.2 GB host disk was
  free at the last observation.
- Final production observation at 18:52 UTC: database 16,142,654,487 bytes; inbox had nine normal
  pending rows and no terminal/dead-letter state; pool freshness was seven seconds. Evidence-v1
  P0/P1/P2 was `1,911 / 5,649 / 0`, with 30 transient-retry rows and one evidence-limit quarantine.
  The only open coverage incident was CPMM, whose 15,941-signature exact replay had reached 2,800.
- All inspected Walletscaner containers were running with restart `0`, OOM `false`, reviewed
  CPU/RAM limits and `ENABLE_LIVE_EXECUTION=false`. The Compose hash remained
  `ae54b1e10b92246405f0026e56eb1a463b22dac35056839342658d5c970d1bcd`.

## Current source state

- Base commit before this task: `954aaa4` (`ops: finalize R30 pipeline rollout`).
- Migration 049, tests and synchronized runtime documents are committed as `bca83d5`
  (`fix: preserve wallet alpha retry backoff`).
- The interruption-safe agent/skill contract is committed as `9c33624`
  (`docs: add interruption-safe work checkpoints`).
- The untracked `deploy/.tmp-pipeline-storage-r28-2dc66ab.tar817264887` is a stale local transfer
  artifact. It is not production data and must not be committed or confused with an R30 rollback
  image.

## Recovery and rollback

- Migration 049 changes only `enqueue_wallet_alpha_work` and `normalize_wallet_alpha_work` plus its
  trigger definition; it deletes no row. Forward repair is a new numbered migration, never editing
  049 after deployment.
- R30/R29/R23 immutable images remain available. No service restart was required for migration 049.
- Current verified server dump and the prior verified off-host generation are recovery points.

## Completion state

- There is no pending production mutation, service recreation, migration, upload or data cleanup.
- The source handoff is complete. The only remaining working-tree artifact is the pre-existing stale
  local R28 transfer tar named above; it is intentionally uncommitted and unrelated to production.
- A future substantive task must replace this completed checkpoint with a fresh `active` objective
  before its first mutation.

## Remaining gates, not failures

- Observe a clean one-hour negative evidence-v1 backlog slope after migration 049.
- Let the one open CPMM historical repair converge or remain explicitly alpha-excluded.
- Reach zero chain-payload compaction lag, then measure a clean 24-hour storage slope above the
  8 GiB reserve.
- Obtain byte-identical off-site acknowledgement for the newest dump.
- Alpha remains unvalidated: zero signals and no profitable chronological paper cohort.
