ARG WALLETSCANER_BASE_IMAGE=walletscaner-worker:storage-r40-20260826
FROM ${WALLETSCANER_BASE_IMAGE}

ARG WALLETSCANER_SOURCE_REVISION=13783e8915569ac348f059b44767b7b0890989bb
LABEL walletscaner.release="pipeline-reliability-r43-20260829" \
      walletscaner.source-revision="${WALLETSCANER_SOURCE_REVISION}"

# R40 is the newest complete off-host base retained locally. Reconstruct the
# reviewed R41/R42 deltas before adding R43 so this artifact is byte-independent
# of server-only image state and can be rebuilt after an interruption.
COPY apps/worker/src/trade-coverage.ts /app/apps/worker/src/trade-coverage.ts
COPY apps/worker/src/trade-coverage.test.ts /app/apps/worker/src/trade-coverage.test.ts
COPY apps/worker/src/watch-solana.ts /app/apps/worker/src/watch-solana.ts
COPY packages/providers/src/solana-event-source.ts /app/packages/providers/src/solana-event-source.ts
COPY packages/providers/src/solana-event-source.test.ts /app/packages/providers/src/solana-event-source.test.ts

# R43 also repairs incremental wallet-ledger replacement. Keep the directly
# exercised PostgreSQL integration fixture in the immutable artifact.
COPY packages/db/src/postgres-repository.ts /app/packages/db/src/postgres-repository.ts
COPY packages/db/src/postgres-evidence.integration.test.ts /app/packages/db/src/postgres-evidence.integration.test.ts
