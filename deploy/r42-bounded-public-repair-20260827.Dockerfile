ARG WALLETSCANER_BASE_IMAGE=walletscaner-worker:storage-r41-20260827
FROM ${WALLETSCANER_BASE_IMAGE}

ARG WALLETSCANER_SOURCE_REVISION=423559147ea6b4f8c4c08a6bde8ccc5db528b565
LABEL walletscaner.release="storage-r42-20260827" \
      walletscaner.source-revision="${WALLETSCANER_SOURCE_REVISION}"

# R41 already contains the fully tested ingestion scheduler and compact
# materializer. R42 changes only public-RPC repair resumption/cap policy, so
# keep the production delta explicit and independently hashable.
COPY packages/providers/src/solana-event-source.ts /app/packages/providers/src/solana-event-source.ts
COPY packages/providers/src/solana-event-source.test.ts /app/packages/providers/src/solana-event-source.test.ts
COPY apps/worker/src/watch-solana.ts /app/apps/worker/src/watch-solana.ts
