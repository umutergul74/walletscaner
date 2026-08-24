# Wallet-alpha Priority R13 — Production Rollout Evidence

Generated: 2026-08-24 03:21 UTC

Status: **Operational on the shared production host.** Live execution remains disabled. This
release changes scheduling and wake-up behavior only; it does not validate profitable alpha or
authorize live capital.

## Release identity

- Release: `walletscaner-worker:wallet-alpha-priority-r13-20260824`.
- Production image ID: `sha256:528c9d8a92fbdc6e56c8e6c2d377c030fd1c369605812690e20deb683ce89f0f`.
- Source archive SHA-256:
  `f08a6994698dbc00b7ecb20a82c32cbd137ae193b3fcde6965e5205f28c9cb43`.
- Normalized runtime-tree SHA-256:
  `399b9449952176b23a2e8115dbc2da9f5a9bd29830a39e19e92350c3c671cba3`.
- The release reuses the exact R15 base image
  `sha256:8e26314aa8e8287b64cc19210df7b1da8d5d7fdf282540492827bc234eb96956`.
  All package manifests matched that base. Only complete runtime source trees were overlaid; file
  modes were normalized to make Windows/Linux builders deterministic.

The initially attempted 462,732,117-byte full-image transfer was stopped because the observed SCP
rate would have created a multi-hour deployment. Its exact partial server artifact was removed.
The 653,745-byte source archive, release Dockerfile, Compose file and scoped updater were transferred
and SHA-verified. No server dependency install or networked build step ran; the server build reused
the verified local base and performed only bounded `COPY`/`chmod` layers.

## Preflight and verification

- Backup `memecoin_alpha_20260823T150923Z.dump` remained present at 1,505,940,747 bytes. Its SHA-256
  `2f8831a3a9bde0e6e19c89099444b2404bc950f30ae9c7f20865e38c0f43fdba`, sidecar, off-site
  acknowledgement and PostgreSQL 16 `pg_restore --list` all passed.
- Pre-rollout host reserve was about 22.44 GB; PostgreSQL had no lock waiter or invalid index.
- Exact normalized image queue/wake tests passed 18/18 locally. The same production image runtime
  tree passed 18/18 on the server. Disposable PostgreSQL 16 evidence integration passed 27/27.
  The scoped image updater passed 3/3 on its supported host runtime.
- Migration `043_wallet_alpha_priority_queue.sql` applied with checksum
  `a4a033792c104f1dc7a5c5e97c0dd7a39b2887b2ee96040ec686d24a42112d55`. Its three columns,
  partial priority index, enqueue function, normalization/notification triggers and constraints
  were present; no invalid index or lock waiter remained.
- The only semantic Compose difference was replacement of the five-minute shell wrapper with the
  direct long-lived wallet-alpha worker command. Image keys were changed by exact-prestate,
  atomic-file replacement. `ENABLE_LIVE_EXECUTION=false` was verified inside every recreated
  target container.

## Rollout and failure handling

Two early canaries started alpha/sampler before recreating ingestion. LaunchLab then acknowledged
its subscription but missed independently confirmed program activity. The hard coverage gate
correctly failed; each attempt atomically restored the previous Compose/env values and exact R15,
R9 and R12 service images. Migration 043 remained because it is additive and old releases are
compatible. No evidence row or volume was removed.

The accepted rollout followed the documented one-CPU shared-host order:

1. stop alpha and sampler while leaving durable queues intact;
2. activate ingestion alone and require two clean program samples;
3. add sampler and re-check ingestion under sampler load;
4. add alpha last and re-check ingestion under scoring load.

That sequence passed. The final containers started at 03:09, 03:12 and 03:14 UTC respectively.
Startup backfill saturation remained fail-closed append-only evidence; every transient incident
closed after healthy samples and no missing interval was relabelled complete.

## Final production canary

- All three targets run the new image with restart count zero and OOM false.
- Ingestion: 421,851 raw notifications at the final sample; four of four programs reported
  `current_transport_healthy`; minimum consecutive healthy samples was 20. Queue/active/in-flight,
  dropped, rejected, unresolved, open incidents, breach samples, canonical failures and finality
  errors were all zero. Storage admission was open and decode ratio was 1.0.
- Sampler: latest cycle sampled two tokens/two markets, saved two observations, evaluated 114
  outcomes and reported zero provider error or exact-pool miss. An earlier activation cycle saved
  six observations and 290 outcome transitions with zero provider error.
- Alpha: PostgreSQL `LISTEN wallet_alpha_work` had one live session. The first bounded cycle ran in
  243.117 seconds, processed 49 admitted wallets, skipped 33 low-evidence wallets and immediately
  refreshed one signal-relevant wallet with zero refresh failure. It emitted no alpha signal and
  had no failed worker cycle. Cycle RSS was 121.04 MiB under the unchanged 160 MiB limit.
- Queue classification was observed before alpha activation as P2/P1/P0 = 31/224/3,079. After the
  first cycle, 30 of 31 P2 rows had drained. The sole remaining P2 row is the known over-10,000-
  trade wallet, fail-closed for about 24 hours; it is deferred rather than ready work. At the final
  sample, ready P2/P1/P0 counts were 0/279/3,043.
- Sampled CPU/memory after activation: ingestion 14.90% / 68.33 MiB, sampler 0.05% / 53.12 MiB,
  alpha 3.29% / 73.73 MiB, PostgreSQL 11.08% / 171.5 MiB and Redis 0.65% / 7.04 MiB. Host load was
  0.73/0.90/1.16 with about 1.07 GB available RAM.
- PostgreSQL inbox working set was four rows with zero dead letter. No invalid index or lock waiter
  existed. Final host free space was about 22.30 GB (70% used).
- The protected Compose label had zero running containers before and after. No protected path,
  global Docker prune, daemon/network/firewall/package setting, B2 object or Docker volume was
  changed.

## Residual gates

- The operations monitor remains `degraded` for pre-existing capacity reasons: database about
  13.80 GB exceeds the 12 GiB warning threshold, chain-payload compaction lag was about 9,326
  seconds, and the conservative recent-window storage runway was 2.52 days above reserve. Pipeline
  backlog/dead letters and unresolved finality were zero. This release does not claim storage
  equilibrium.
- The one oversized P2 wallet has attempt count 21 and is safely deferred for roughly 24 hours.
  Lane telemetry currently counts deferred P2 work as `signalPending`; ready/deferred separation
  should be improved before treating that field alone as an incident.
- The old P1/P0 backlog is still catching up. A production future-event p95/p99 wake-latency sample
  is not mature yet; local commit-to-refresh was 181 ms. Do not infer the required p95 below three
  seconds or p99 below ten seconds from one canary.
- No wallet-alpha signal was found. Strategy quality, future-only holdout, exact executable fills,
  rug/tail loss and live-capital gates remain open.

## Rollback

Exact rollback points remain available: ingestion R15
`sha256:8e26314aa8e8...`, evidence sampler R9 `sha256:dc6d9b903a3f...`, wallet-alpha R12
`sha256:23f5fea40751...`, the pre-R13 Compose copy and the verified current dump. Rollback restores
the two exact image keys and old Compose command, then recreates only the three named services.
Migration 043 stays in place because it is additive and its normalization trigger preserves
old-release queue writes.
