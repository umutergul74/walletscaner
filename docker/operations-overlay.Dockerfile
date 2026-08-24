ARG WALLETSCANER_BASE_IMAGE=walletscaner-worker:local
FROM ${WALLETSCANER_BASE_IMAGE}

# Small operations-only releases can reuse a fully tested worker base without
# transferring or rebuilding every dependency layer on the fixed shared host.
COPY scripts/maintenance/prune-operational-data.ts /app/scripts/maintenance/prune-operational-data.ts
COPY scripts/migrations /app/scripts/migrations
