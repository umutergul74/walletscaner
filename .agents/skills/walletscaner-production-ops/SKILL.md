---
name: walletscaner-production-ops
description: "Inspect, start, stop, deploy, migrate, back up, restore, or troubleshoot Walletscaner on its shared production host. Use for server operations and incidents; require explicit authority before mutations."
---

# Walletscaner Production Ops

Operate through exact targets, durable checkpoints, and pre/post evidence.

1. Read the root `AGENTS.md`, `skills.md` route **Operations and incident response**,
   `docs/agent/current-state.md`, `docs/operations.md`, and the exact Compose/scripts involved.
2. Classify the request as read-only diagnosis, reversible service operation, deployment/migration,
   or destructive data/host action. User approval for one class does not authorize another.
3. Begin with host/time/disk/memory/swap/load, Compose project/service/container/mount inventory,
   live-execution state, backup/restore evidence, database size/growth, and bounded health/log checks.
4. Before a mutation, record exact pre-state and rollback point; verify a current off-host backup,
   required disk/WAL/temp headroom, immutable artifact identity, and affected services. Persist the
   same facts plus the next exact action in `docs/agent/work-in-progress.md` before changing state.
5. Target only `docker compose -p walletscaner -f docker-compose.server.yml` and named services.
   Never use dependency-following `docker compose create` for a stopped worker. Avoid `down` when
   `stop` suffices. Never run global Docker/BuildKit/volume prune or touch a co-tenant.
6. Use explicit `docker compose run -e` overrides for one-shot safety settings; do not rely on shell
   prefixes that lose to `env_file` precedence.
7. Apply migrations only after populated PostgreSQL 16 rehearsal. Keep live execution false and use
   serial restore for current dumps.
8. Verify service identity, restart/OOM counts, mounts, queues, freshness, resource use, migrations,
   backup state, disk, and co-tenant state after the action. Stop or roll back on a hard gate.

After every mutation, immediately update the durable checkpoint with the observed result and the
next action. On resume, compare hashes, migrations and container state before rerunning anything;
never assume an interrupted command did or did not finish. Mark the checkpoint complete only after
post-state verification and a coherent source/tests/docs commit.

Never read or print `.env`, `.env.server`, credentials, tokens, private keys, or full container
environments. Do not infer mutation authority from a previous session or rollout.
