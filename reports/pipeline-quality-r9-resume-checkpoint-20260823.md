# Pipeline quality R9 resume checkpoint — 2026-08-23

> Superseded: this interruption checkpoint was completed through R12. See
> `reports/pipeline-quality-r12-completion-20260823.md` and `docs/agent/current-state.md` for the
> current boundary. The historical steps below are retained only as recovery archaeology.

This checkpoint exists so an interrupted Codex run can resume without guessing or repeating a
production mutation.

## Production boundary

- Production services are still on their pre-R9 images. No application or PostgreSQL migration
  from this release has been deployed yet.
- `ENABLE_LIVE_EXECUTION=false`; paper V3 remains paused and qualified-pool delivery remains shadow.
- The protected co-tenant was not inspected, started, stopped or changed.
- No production row, volume, image or cache was deleted during R9 preparation.

## Completed recovery work

- Local off-host backup task was repaired so remote reconciliation is invoked through readable
  `sh` input instead of relying on a POSIX executable bit copied through Windows.
- Current dump: `memecoin_alpha_20260823T150923Z.dump`, 1,505,940,747 bytes.
- SHA-256: `2f8831a3a9bde0e6e19c89099444b2404bc950f30ae9c7f20865e38c0f43fdba`.
- Local/off-host SHA, PostgreSQL 16 archive-list and server acknowledgement passed. The Windows task
  completed with result zero. The newest server generation remains present.

## R9 code state

- Migration 040: `pg_stat_statements` extension; Compose preload, query IDs, I/O timing and bounded
  slow/temp/lock logging.
- Migration 041: durable Solana signature queue.
- Migration 042: future-only finalized-chain gate.
- Standard RPC discovery writes matching live signatures durably before RAM queueing and replays
  pending rows after restart. RAM saturation defers work instead of dropping it.
- Ingestion includes a bounded finalized-signature reconciliation cycle; failed or safely absent
  transactions roll back before canonical parsing.
- Pump creator decoding, Token-2022 extension fail-closed rules, exact-pair missing/rug evidence,
  short-horizon storage runway, reviewed Meteora/Orca discovery manifests and read-only Jupiter
  direct-route quote evidence are implemented.
- Validation passed: 67 test files/322 tests (30 integration tests skipped without PostgreSQL),
  TypeScript, ESLint and all workspace production builds. The two archive-artifact tests need zstd
  and are intentionally rerun inside the Linux release image.

## In-progress populated restore gate

- Isolated container: `walletscaner-restore-probe-20260823`.
- Isolated volume: `walletscaner_restore_probe_20260823`.
- Source dump is mounted read-only from `/opt/walletscaner/backups`.
- Restore is serial (`pg_restore --no-owner --exit-on-error`), currently bounded to 0.20 CPU and
  320 MiB RAM. It is not attached to the production PostgreSQL volume or Compose dependency graph.
- Release transport staged only at `/tmp/walletscaner-quality-r9-20260823b.tar.gz`, 2,269,292 bytes,
  SHA-256 `7cbd0697e8e9dc25ecb69a1756f6505d5e14cf2a1e9dcbbc4b4a96a0c7df166b`.

## Exact resume order

1. Poll the existing restore process/session or inspect the probe container. Do not start a second
   restore.
2. After serial restore succeeds, apply migrations 040-042 to the clone and verify zero invalid
   indexes, finality gate/rollback behavior, signature-queue idempotency, counts and database size.
3. Run the full suite inside the Linux image so PostgreSQL 16 and zstd tests execute.
4. Remove only the named restore-probe container and its exactly labelled temporary volume after
   recording proof. Never run a global prune.
5. Extract the staged release into a versioned server staging directory, build an immutable R9
   worker image and recheck `ENABLE_LIVE_EXECUTION=false` plus disk headroom.
6. Apply migrations once. Recreate only `solana-ingestion`; do not use dependency-following
   `docker compose create`. Restart PostgreSQL for observability only in a separately checked,
   bounded step because preload settings require it.
7. Keep `SOLANA_ENABLE_EXTENDED_VENUES=false` for the base canary. Verify finality latency, durable
   queue drain, creator/Token-2022 evidence, decoder coverage, resource ceilings, archive state and
   canonical freshness before explicitly enabling the extra venue sockets.
