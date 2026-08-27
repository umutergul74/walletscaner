ARG WALLETSCANER_BASE_IMAGE=walletscaner-worker:storage-r40-20260826
FROM ${WALLETSCANER_BASE_IMAGE}

ARG WALLETSCANER_SOURCE_REVISION=5902ac0c3cdbca48b01a2b0d26fe3c757cfef0a0
LABEL walletscaner.release="storage-r41-20260827" \
      walletscaner.source-revision="${WALLETSCANER_SOURCE_REVISION}"

# R40 already contains the fully tested dependency graph and storage/materializer
# implementation. R41 changes only the directly tested trade-subscription bootstrap
# state machine, so keep the release delta explicit and independently hashable.
COPY apps/worker/src/trade-coverage.ts /app/apps/worker/src/trade-coverage.ts
COPY apps/worker/src/trade-coverage.test.ts /app/apps/worker/src/trade-coverage.test.ts
COPY apps/worker/src/watch-solana.ts /app/apps/worker/src/watch-solana.ts
