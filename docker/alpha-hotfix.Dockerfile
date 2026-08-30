# Copy-only wallet-alpha patch: the caller must verify the exact loaded base image ID.
# No RUN, dependency installation, network access or unrelated application source changes.
ARG ALPHA_BASE_IMAGE
FROM ${ALPHA_BASE_IMAGE}
ARG ALPHA_PATCH_REVISION
ARG ALPHA_BASE_ID
LABEL org.walletscaner.alpha.patch-revision=${ALPHA_PATCH_REVISION}
LABEL org.walletscaner.alpha.base-id=${ALPHA_BASE_ID}
COPY packages/db/src/repository.ts packages/db/src/memory-repository.ts packages/db/src/postgres-repository.ts packages/db/src/postgres-evidence.integration.test.ts ./packages/db/src/
COPY scripts/research/wallet-alpha-report-builder.ts scripts/research/wallet-alpha-report-builder.test.ts ./scripts/research/
