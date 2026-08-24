ARG BASE_IMAGE=walletscaner-worker:discovery-ws-split-r19-20260824
FROM ${BASE_IMAGE}

ARG RELEASE
ARG SOURCE_SHA256

LABEL walletscaner.release=${RELEASE} \
      walletscaner.source.sha256=${SOURCE_SHA256} \
      walletscaner.release.kind="verified-fail-closed-repair-cap-overlay"

# A bounded repair that cannot reach its historical boundary remains failed
# and excluded. Current transport may recover without retrying an unbounded
# signature history or manufacturing a coverage proof.
COPY packages/providers/src/solana-event-source.ts ./packages/providers/src/solana-event-source.ts
COPY packages/providers/src/solana-event-source.test.ts ./packages/providers/src/solana-event-source.test.ts
COPY apps/worker/src/discovery-supervisor.ts ./apps/worker/src/discovery-supervisor.ts
COPY apps/worker/src/discovery-supervisor.test.ts ./apps/worker/src/discovery-supervisor.test.ts

RUN chmod 0644 \
      packages/providers/src/solana-event-source.ts \
      packages/providers/src/solana-event-source.test.ts \
      apps/worker/src/discovery-supervisor.ts \
      apps/worker/src/discovery-supervisor.test.ts
