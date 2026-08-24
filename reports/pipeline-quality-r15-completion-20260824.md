# Pipeline quality R15 completion — 2026-08-24

## Outcome

R15 fixes the recurring LaunchLab discovery incident/recovery loop caused by an undersized
reconnect backfill. It does not weaken coverage: an interval whose cursor boundary cannot be proved
inside the bounded window still fails closed and remains outside alpha. Live execution remains
disabled and no alpha, paper or risk threshold changed.

## Root cause

- R14 passed `initialBackfillLimit=5`, `backfillPageLimit=5` and `maxBackfillPages=1` to every
  discovery source.
- LaunchLab's websocket reconnected repeatedly. Its live counters reached seven reconnects and
  eight truncations before rollout, while discovery queue/workers/dropped/unresolved were all zero.
  The bottleneck was therefore the repair window, not CPU, RAM or queue capacity.
- A read-only PublicNode query found 288 signatures newer than the last durable LaunchLab cursor.
  The old five-signature window could never prove the boundary; a 500-signature window could.

## Implementation

- `discoveryBackfillProfile()` defines a default `100 x 5 = 500` paged signature window.
- All values must be strict positive integers and the calculated window may never exceed the
  product hard cap of 2,000 signatures. Invalid or unbounded configuration fails startup.
- The profile changes reconnect/initial repair only. Live transaction concurrency, per-program
  concurrency, queue limits, retries, memory limits and CPU limits are unchanged.
- The active profile is emitted in `solana-ingestion-health` as `discoveryBackfill`.
- Provider regression coverage proves multi-page boundary discovery, oldest-first admission and
  cursor advancement. A saturated window still admits no backfill and reports truncation.

## Release evidence

- Source archive: `walletscaner-pipeline-quality-r15-20260824.tar.gz`, 648,769 bytes.
- Source SHA-256:
  `e08ce6d179e93a1dc04158a1b21771df1cf0fab38f01135db6c0954a0e2d89aa`.
- Image: `walletscaner-worker:pipeline-quality-r15-20260824`.
- Exact Linux/amd64 image ID:
  `sha256:8e26314aa8e8287b64cc19210df7b1da8d5d7fdf282540492827bc234eb96956`.
- Release/source labels matched locally and on the production host.

## Verification

- Targeted profile/provider/supervisor tests: 64/64.
- TypeScript and ESLint: passed.
- Workspace production build: passed.
- Complete Windows suite with verified zstd 1.5.7 on the test-process PATH: 335 passed, 34 skipped.
- Disposable PostgreSQL 16 evidence/coverage integration: 30/30.
- Disposable PostgreSQL 16 archive-pipeline integration: 4/4.
- Exact R15 Linux image discovery/supervisor/reconnect/archive tests: 67/67.
- Source archive contained 350 entries and zero `.env`, `.env.server`, dependency, build-output or
  prior deployment-archive entries.

## Production rollout and canary

- The verified current dump remained available before rollout:
  `memecoin_alpha_20260823T150923Z.dump`, 1,505,940,747 bytes, SHA-256
  `2f8831a3a9bde0e6e19c89099444b2404bc950f30ae9c7f20865e38c0f43fdba`; sidecar,
  off-host acknowledgement and PostgreSQL 16 archive-list checks passed.
- The transition was made with discovery/trade queue and workers at zero, no active trade
  subscription, storage admission open, parser failures zero and finality errors zero.
- The exact-value updater changed only `WALLETSCANER_INGEST_IMAGE`; Compose recreated only
  `solana-ingestion --no-deps`. All other Walletscaner container IDs remained unchanged.
- The new container is running with restart count zero, OOM false and
  `ENABLE_LIVE_EXECUTION=false`.
- LaunchLab startup: `0 reconnects / 0 truncations`, status `ok`, one subscription, no open
  incident and current coverage.
- Natural LaunchLab reconnect canary: `1 reconnect / 0 truncations`; queue/workers/dropped/
  unresolved, parser failures and finality errors all remained zero.
- At 21:44 UTC the process had decoded 210/210 discovery candidates, completed 367 canonical
  events with zero parser failure, and used about 69.9 MiB of its 160 MiB limit at 10.3% sampled
  CPU. Host load was `0.49/0.80/0.82`, available RAM about 1.15 GB and swap use about 113 MB.
- New-pool persistence continued after activation: 181 Pump.fun, three LaunchLab, two PumpSwap and
  one CPMM pool were materialized by the 21:43 UTC read-only sample.
- Pump.fun, PumpSwap and CPMM each produced one startup truncation because their historical raw
  program activity exceeded 500 signatures. The three incidents closed after two healthy samples;
  the six corresponding Telegram transition messages were delivered once. No LaunchLab incident
  was opened after R15 activation.
- The temporary 462,616,491-byte transfer artifact was removed after verification. Both R14 and
  R15 images remain available; final host free space was 22,162,567,168 bytes (70% used).

## Residual boundaries

- R15 repairs only gaps whose cursor boundary is proved inside 500 signatures. Saturated program
  windows remain fail-closed by design; they require a separately reviewed provider/replay path,
  not a silent threshold increase.
- Historical coverage incidents are append-only evidence and remain alpha-excluded even after the
  transport recovers. R15 does not retroactively reconstruct or relabel them.
- A natural reconnect canary proves the observed LaunchLab failure path, but it is not the
  independent 99% supported-program denominator or deliberate long-outage/fork recovery gate.
- This release improves evidence continuity only. It does not establish profitable alpha or grant
  live-capital authority.

## Rollback

Use the exact-value release updater to change only `WALLETSCANER_INGEST_IMAGE` from R15 back to
`walletscaner-worker:pipeline-quality-r14-20260823`, then recreate only `solana-ingestion` with
`--no-deps`. R15 introduced no migration.
