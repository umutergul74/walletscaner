ARG BASE_IMAGE=walletscaner-worker:discovery-gap-repair-r17-20260824
FROM ${BASE_IMAGE}

ARG RELEASE
ARG SOURCE_SHA256

LABEL walletscaner.release=${RELEASE} \
      walletscaner.source.sha256=${SOURCE_SHA256} \
      walletscaner.release.kind="verified-quiet-transport-hotfix-overlay"

# A quiet program can prove current transport with subscription ACK, a fresh
# heartbeat and an independent no-activity probe. Close that transport-only
# incident as unreconciled; never manufacture a repair boundary.
COPY apps/worker/src/discovery-supervisor.ts ./apps/worker/src/discovery-supervisor.ts
COPY apps/worker/src/discovery-supervisor.test.ts ./apps/worker/src/discovery-supervisor.test.ts

RUN chmod 0644 \
      apps/worker/src/discovery-supervisor.ts \
      apps/worker/src/discovery-supervisor.test.ts
