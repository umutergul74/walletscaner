---
status: complete
updated_at_utc: 2026-09-03T02:30:00Z
owner: codex
task: Temporarily stop every running Walletscaner Compose service without deleting data
last_safe_checkpoint: zero Walletscaner containers running; twelve retained exited containers; PostgreSQL and Redis volumes plus verified backup intact
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

## Stop checkpoint — 2026-09-03 02:29 UTC

The ten named application/scheduler services were stopped through bounded 60-second Compose
timeouts. Redis then stopped, followed by PostgreSQL last. `docker compose stop` was used; no
container, network, volume, image, file, database row, backup or B2 object was removed. Next exact
action is read-only post-state verification; do not rerun the stop command unless a named
Walletscaner container is independently found running.

## Verified post-state — 2026-09-03 02:28 UTC

- Zero Walletscaner containers are running. Twelve retained service containers are `exited`; the
  pre-existing disabled `paper-alert` container remains `created` and was not changed.
- PostgreSQL, Redis, ingestion, wallet-alpha and Telegram notifier exited with code zero. The
  scheduler processes received normal stop signals; evidence sampler and the sleeping PostgreSQL
  backup scheduler required Compose's bounded timeout and show exit 137. No dump/restore was active,
  and PostgreSQL was deliberately stopped only after every writer had exited, then completed a clean
  exit with code zero.
- `walletscaner_postgres-data` and `walletscaner_redis-data` still exist. The verified 02-Sep dump,
  SHA sidecar and off-site acknowledgement retain their original names, sizes and timestamps.
- Root filesystem is 85% used with 10,943,631,360 bytes available. No cleanup was performed; stopping
  prevents Walletscaner ingestion, database, archive, backup and log growth but is not itself a
  meaningful disk-space reclamation.
- `docker compose ls -a` reports only `walletscaner` as `created(1), exited(12)`. No other Compose
  project or container was touched. This shutdown task is complete.

Before a future restart, perform a new read-only disk/backup inventory and explicitly decide the
cleanup. Then start PostgreSQL and Redis first, verify recovery, and restore only the twelve
previously running named services in stages. Keep API, web, paper-alert, alpha-decision-tape and
legacy research stopped unless separately authorized.
