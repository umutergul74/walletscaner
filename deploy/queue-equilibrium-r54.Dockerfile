FROM walletscaner-worker:queue-recovery-r53-1-20260901

ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.revision="${SOURCE_REVISION}"
LABEL org.opencontainers.image.version="queue-equilibrium-r54-20260902"
LABEL walletscaner.base-image="walletscaner-worker:queue-recovery-r53-1-20260901"

# Keep this release as a small, auditable overlay on the exact deployed R53.1 runtime. Dependency
# manifests are unchanged; only the repository query paths and their additive migrations move.
COPY packages/db/src/postgres-repository.ts /app/packages/db/src/postgres-repository.ts
COPY scripts/migrations/058_wallet_trade_fifo_order_index.sql /app/scripts/migrations/058_wallet_trade_fifo_order_index.sql
COPY scripts/migrations/059_canonical_partition_key_contract.sql /app/scripts/migrations/059_canonical_partition_key_contract.sql
COPY scripts/migrations/060_canonical_partition_head_index.sql /app/scripts/migrations/060_canonical_partition_head_index.sql
