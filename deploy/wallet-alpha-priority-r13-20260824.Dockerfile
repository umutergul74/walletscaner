ARG BASE_IMAGE=walletscaner-worker:pipeline-quality-r15-20260824
FROM ${BASE_IMAGE}

ARG RELEASE
ARG SOURCE_SHA256

LABEL walletscaner.release=${RELEASE} \
      walletscaner.source.sha256=${SOURCE_SHA256} \
      walletscaner.release.kind="verified-source-overlay"

# This release deliberately reuses the exact R15 dependency/base layers. The
# package manifests and lockfile are verified unchanged before build. Copy the
# complete runtime source trees so the resulting filesystem can be compared
# byte-for-byte with the independently built full candidate.
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig.json vitest.config.ts eslint.config.mjs .prettierrc ./

# Windows and Linux archive extractors expose different source mode bits.
# Normalize them inside the image so the production runtime is deterministic
# across builders; only shell entrypoints remain executable.
RUN find apps packages scripts -type f -exec chmod 0644 {} + \
    && find scripts -type f -name '*.sh' -exec chmod 0755 {} + \
    && chmod 0644 tsconfig.json vitest.config.ts eslint.config.mjs .prettierrc
