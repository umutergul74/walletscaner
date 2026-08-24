ARG BASE_IMAGE=walletscaner-worker:discovery-gap-repair-r18-20260824
FROM ${BASE_IMAGE}

ARG RELEASE
ARG SOURCE_SHA256

LABEL walletscaner.release=${RELEASE} \
      walletscaner.source.sha256=${SOURCE_SHA256} \
      walletscaner.release.kind="verified-discovery-websocket-route-overlay"

# Split the four independent program subscriptions across two reviewed
# standard-RPC providers. This preserves the durable HTTP/cursor/repair path
# while avoiding a provider's silent per-host socket delivery ceiling.
COPY apps/worker/src/watch-solana.ts ./apps/worker/src/watch-solana.ts
COPY apps/worker/src/solana-discovery-transport.ts ./apps/worker/src/solana-discovery-transport.ts
COPY apps/worker/src/solana-discovery-transport.test.ts ./apps/worker/src/solana-discovery-transport.test.ts

RUN chmod 0644 \
      apps/worker/src/watch-solana.ts \
      apps/worker/src/solana-discovery-transport.ts \
      apps/worker/src/solana-discovery-transport.test.ts
