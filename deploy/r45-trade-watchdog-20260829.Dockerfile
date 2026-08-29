ARG WALLETSCANER_BASE_IMAGE=walletscaner-worker:trade-latency-r44-20260829
FROM ${WALLETSCANER_BASE_IMAGE}

ARG WALLETSCANER_SOURCE_REVISION
LABEL walletscaner.release="trade-watchdog-r45-20260829" \
      walletscaner.source-revision="${WALLETSCANER_SOURCE_REVISION}"

# R45 keeps R44's trade-only queue-age contract but moves enforcement to a
# bounded per-address watchdog, so a blocked admitted head cannot postpone the
# fail-closed release. R44 remains the complete, independently verified base.
COPY apps/worker/src/watch-solana.ts /app/apps/worker/src/watch-solana.ts
COPY packages/providers/src/solana-event-source.ts /app/packages/providers/src/solana-event-source.ts
COPY packages/providers/src/solana-event-source.test.ts /app/packages/providers/src/solana-event-source.test.ts
