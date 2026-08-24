ARG BASE_IMAGE=walletscaner-worker:discovery-gap-repair-r16-20260824
FROM ${BASE_IMAGE}

ARG RELEASE
ARG SOURCE_SHA256

LABEL walletscaner.release=${RELEASE} \
      walletscaner.source.sha256=${SOURCE_SHA256} \
      walletscaner.release.kind="verified-safety-hotfix-overlay"

# R17 is a narrow fail-closed hotfix over the already-loaded R16 image. Keep
# the exact truncation cursor as the only admissible repair boundary and ship
# the populated-upgrade containment migration plus its tests.
COPY apps/worker/src/discovery-supervisor.ts ./apps/worker/src/discovery-supervisor.ts
COPY apps/worker/src/discovery-supervisor.test.ts ./apps/worker/src/discovery-supervisor.test.ts
COPY packages/providers/src/solana-event-source.ts ./packages/providers/src/solana-event-source.ts
COPY packages/providers/src/solana-event-source.test.ts ./packages/providers/src/solana-event-source.test.ts
COPY packages/db/src/repository.ts ./packages/db/src/repository.ts
COPY packages/db/src/memory-repository.ts ./packages/db/src/memory-repository.ts
COPY packages/db/src/postgres-repository.ts ./packages/db/src/postgres-repository.ts
COPY packages/db/src/ingestion-coverage.integration.test.ts ./packages/db/src/ingestion-coverage.integration.test.ts
COPY packages/db/src/safe-discovery-repair-boundary-migration.test.ts ./packages/db/src/safe-discovery-repair-boundary-migration.test.ts
COPY scripts/migrations/045_safe_discovery_repair_boundary.sql ./scripts/migrations/045_safe_discovery_repair_boundary.sql

RUN chmod 0644 \
      apps/worker/src/discovery-supervisor.ts \
      apps/worker/src/discovery-supervisor.test.ts \
      packages/providers/src/solana-event-source.ts \
      packages/providers/src/solana-event-source.test.ts \
      packages/db/src/repository.ts \
      packages/db/src/memory-repository.ts \
      packages/db/src/postgres-repository.ts \
      packages/db/src/ingestion-coverage.integration.test.ts \
      packages/db/src/safe-discovery-repair-boundary-migration.test.ts \
      scripts/migrations/045_safe_discovery_repair_boundary.sql
