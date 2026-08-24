# Pipeline quality R13 completion — 2026-08-23

> Historical checkpoint: R14 supersedes the production image with a normal-payload zero-copy
> optimization. R13's safety behavior and canary evidence remain valid.

## Outcome

The interrupted pipeline-quality work is complete through R13. Finality late-arrival repair and
the two dominant wallet-alpha SQL defects remain operational. R13 additionally removed a newly
observed live trade-ingestion stall without increasing CPU, memory, queue or provider limits.
Live execution remains disabled; zero wallet-alpha signals exist and no alpha claim is made.

## R13 incident and root cause

- One live Solana transaction included `U+0000` inside provider-parsed JSON text.
- JavaScript serialized it as a valid JSON escape, but PostgreSQL JSONB cannot represent that code
  point and returned `unsupported Unicode escape sequence`.
- The ordered source correctly did not advance its durable pool cursor. Its handler retry was
  intentionally unbounded, however, so transaction requests stopped at 416 while one worker stayed
  blocked and queued notifications grew `574 -> 729`.
- Unsubscribing an exact pool removed the WebSocket subscription but formerly left already queued
  notifications in RAM, spending RPC and CPU on evidence already excluded from alpha.

## Implemented fix

- Canonical PostgreSQL admission now replaces only NUL code points in payload strings with the
  literal marker `\u0000`. It adds `_walletscanerPayloadEncoding` containing version, replacement,
  occurrence count and SHA-256 of the original unsanitized JSON serialization. Other payloads keep
  the unchanged fast path.
- Standard RPC unsubscribe now removes queued signatures for that exact address, releases dedupe
  keys, clears its pressure state and exposes `purgedSignatureCount`. An already admitted head may
  finish; work not yet admitted is not fetched after unsubscribe.
- No schema, retention horizon, provider budget, CPU/RAM limit or live-capital setting changed.

## Verification and production canary

- Provider source tests: 40/40.
- PostgreSQL 16 evidence integration: 24/24, including two nested NUL occurrences, literal-marker
  round trip and original-payload SHA-256 evidence.
- TypeScript and ESLint: passed.
- Exact Linux/amd64 image provider tests: 40/40.
- Broad Windows regression: 329 passed and 34 skipped; two archive tests could not spawn the absent
  local `zstd` binary, then passed 3/3 in the exact Linux R13 image.
- Source archive: `walletscaner-pipeline-quality-r13-20260823a.tar.gz`, 2,477,943 bytes, SHA-256
  `df4f7493b56c47f38180c6043c614baa1ba6ad89d041e024b61273b34b2f8f4f`.
- Image: `walletscaner-worker:pipeline-quality-r13-20260823`, exact ID
  `sha256:58f877e65e97972d6086df311fa91359efcc284ce9751e6bb53ac8fcda13abc7`.
- Only `WALLETSCANER_INGEST_IMAGE` changed under exact pre-state and whole-file SHA guards. Only
  `solana-ingestion` was stopped/recreated with `--no-deps`; restart is 0 and OOM is false.
- First active R13 pool: 122 backfill events, 45 live events, 170 transaction requests, queue 0,
  unresolved 0, dropped 0 and parser failures 0. Fresh live provider latency was 1.80 seconds.
  Bootstrap maximum queue delay was 15.75 seconds and therefore is not claimed as a passed p99 gate.
- Ingestion sampled 66.7 MiB / 160 MiB and 9.1% CPU. PostgreSQL/Redis volumes were unchanged.

## Current operational state

- The 20:35 UTC monitor had canonical backlog/dead letters `0/0`, finality unresolved `0`, fresh
  wallet trade age 17.4 seconds, price observations 36/hour and archive queues `0/0/0`.
- Status remains deliberately `degraded`: database 13.99 GB exceeds the warning threshold,
  payload-compaction lag is 7.80 hours, and the deployment-polluted recent runway is 6.65 days.
  Two latest maintenance runs compacted 4,000 and 3,000 payloads and advanced the oldest boundary.
- Wallet-alpha drained its pre-existing queue `475 -> 375 -> 275 -> 175 -> 75`; new R13 catch-up
  trades then created/coalesced fresh wallet revisions. The latest completed cycle reported 206
  pending, zero cycle failures and 87.1 MiB RSS; a later read-only producer-burst sample saw 644.
  Net drain over subsequent cycles is the next measurable gate.
- Verified backup remains `memecoin_alpha_20260823T150923Z.dump`, 1,505,940,747 bytes, SHA-256
  `2f8831a3a9bde0e6e19c89099444b2404bc950f30ae9c7f20865e38c0f43fdba`, off-host acknowledged.

## Remaining gates

- Continuous WAL/PITR is not operational; only the verified daily dump chain is operational.
- Compact 95-day wallet evidence still needs B2 export, deterministic dual-read parity, isolated
  restore and stopped-cutover proof before any canonical detail may be retired.
- Token-2022 fail-closed support is waiting for a representative live extension sample.
- Jupiter size-aware quotes need an approved API key. Optional Raydium/Meteora/Orca adapters remain
  disabled until independent coverage and resource gates pass.
- No signal-quality threshold should be weakened while signals are zero. Future-only market,
  exact-fill, rug/tail and independence gates remain mandatory.

## Rollback

Restore `WALLETSCANER_INGEST_IMAGE=walletscaner-worker:pipeline-quality-r10-20260823` with the same
hash-locked updater and recreate only `solana-ingestion --no-deps`. R13 added no migration and no
manual row, volume or B2 deletion.
