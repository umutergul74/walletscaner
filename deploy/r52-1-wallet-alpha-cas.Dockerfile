# Copy-only R52.1 wallet-alpha concurrency patch. The rollout must verify ALPHA_BASE_ID
# against the locally loaded R52 image before building; this file performs no RUN or network I/O.
ARG ALPHA_BASE_IMAGE
FROM ${ALPHA_BASE_IMAGE}
ARG ALPHA_PATCH_REVISION
ARG ALPHA_BASE_ID
LABEL org.walletscaner.alpha.patch-revision=${ALPHA_PATCH_REVISION}
LABEL org.walletscaner.alpha.base-id=${ALPHA_BASE_ID}
COPY scripts/research/wallet-alpha-report-builder.ts ./scripts/research/
