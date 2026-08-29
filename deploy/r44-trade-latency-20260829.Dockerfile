ARG WALLETSCANER_BASE_IMAGE=walletscaner-worker:pipeline-reliability-r43-20260829
FROM ${WALLETSCANER_BASE_IMAGE}

ARG WALLETSCANER_SOURCE_REVISION=1252b2b93e98911377ad101d3ef5fa41cd8b6c5d
LABEL walletscaner.release="trade-latency-r44-20260829" \
      walletscaner.source-revision="${WALLETSCANER_SOURCE_REVISION}"

# R44 changes only the standard-source queue-age circuit breaker and its
# trade-worker wiring. R43 remains the complete, independently verified base.
COPY apps/worker/src/watch-solana.ts /app/apps/worker/src/watch-solana.ts
COPY packages/providers/src/solana-event-source.ts /app/packages/providers/src/solana-event-source.ts
COPY packages/providers/src/solana-event-source.test.ts /app/packages/providers/src/solana-event-source.test.ts
