ARG BASE_IMAGE=walletscaner-worker:pipeline-quality-r15-20260824
FROM ${BASE_IMAGE}

ARG RELEASE
ARG SOURCE_SHA256

LABEL walletscaner.release=${RELEASE} \
      walletscaner.source.sha256=${SOURCE_SHA256} \
      walletscaner.release.kind="verified-source-overlay"

# Reuse the previously verified R15 dependency/base layers. This release adds
# only the migration-044 durable discovery repair, standard-socket heartbeat,
# strict coverage proof and their bounded operational cleanup.
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig.json vitest.config.ts eslint.config.mjs .prettierrc ./

RUN find apps packages scripts -type f -exec chmod 0644 {} + \
    && find scripts -type f -name '*.sh' -exec chmod 0755 {} + \
    && chmod 0644 tsconfig.json vitest.config.ts eslint.config.mjs .prettierrc
