---
status: active
updated_at_utc: 2026-09-03T02:27:00Z
owner: codex
task: Temporarily stop every running Walletscaner Compose service without deleting data
last_safe_checkpoint: R54 operational pre-stop; twelve Walletscaner services running; verified 02-Sep off-host backup retained
---

# Temporary Walletscaner shutdown — 2026-09-03

## Objective and exclusions

The user explicitly authorized a temporary shutdown of all Walletscaner services because the root
filesystem reached 85% utilization. Stop only the exact `walletscaner` Compose project under
`/opt/walletscaner`. Do not use `down`, remove/recreate containers, delete files, prune Docker,
change configuration, clean the database, alter B2, or touch any other project or system service.

## Verified pre-state — 2026-09-03 02:24 UTC

- `docker compose ls` reports only `walletscaner`, with twelve running services: PostgreSQL, Redis,
  Solana ingestion, evidence sampler, wallet alpha, Telegram notifier, data maintenance, operations
  monitor, PostgreSQL backup scheduler, archive writer/verifier schedulers and wallet-evidence
  materializer scheduler. All have restart count zero and OOM false.
- R54 ingestion and wallet-alpha retain `ENABLE_LIVE_EXECUTION=false`. No live-capital execution is
  enabled.
- Root filesystem is 72,648,024,064 bytes total, 61,683,245,056 bytes used and 10,948,001,792 bytes
  available (85%). Available RAM is 1,047,076 kB; swap use is about 154 MiB.
- No `pg_dump` or `pg_restore` is active. The backup container is only sleeping between cycles. The
  retained server dump `memecoin_alpha_20260902T173517Z.dump` is 3,186,064,426 bytes and has both
  its SHA sidecar and off-site verification marker.
- Persistent volumes are exactly `walletscaner_postgres-data` and `walletscaner_redis-data`; both
  must remain untouched. No cleanup is authorized in this task.

## Exact action and recovery

1. Gracefully stop the ten application/scheduler services with a 60-second timeout.
2. Stop Redis, then PostgreSQL last, using named Compose services and the same timeout.
3. Verify zero running Walletscaner containers, all twelve containers remain in `exited` state,
   both named volumes still exist, filesystem state is unchanged except normal shutdown writes, and
   no other project/container changed.

Recovery is a separately authorized future start operation. Before restarting, refresh disk and
backup state, then start PostgreSQL/Redis first and add the previously authorized named services in
stages. Do not use a profile-wide `up` or start disabled API/web/paper/legacy services implicitly.
