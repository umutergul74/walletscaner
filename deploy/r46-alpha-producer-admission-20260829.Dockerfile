ARG WALLETSCANER_BASE_IMAGE=walletscaner-worker:trade-watchdog-r45-20260829
FROM ${WALLETSCANER_BASE_IMAGE}

ARG WALLETSCANER_SOURCE_REVISION
LABEL walletscaner.release="alpha-producer-admission-r46-20260829" \
      walletscaner.source-revision="${WALLETSCANER_SOURCE_REVISION}"

# R46 preserves every wallet trade and price update, but suppresses redundant
# price-enrichment score revisions until the configured wallet-alpha admission
# floor is met. R45 remains the complete, independently verified runtime base.
COPY apps/worker/src/watch-solana.ts /app/apps/worker/src/watch-solana.ts
COPY packages/db/src/repository.ts /app/packages/db/src/repository.ts
COPY packages/db/src/postgres-repository.ts /app/packages/db/src/postgres-repository.ts
COPY packages/db/src/memory-repository.ts /app/packages/db/src/memory-repository.ts
COPY packages/db/src/memory-repository.test.ts /app/packages/db/src/memory-repository.test.ts
COPY packages/db/src/postgres-evidence.integration.test.ts /app/packages/db/src/postgres-evidence.integration.test.ts
