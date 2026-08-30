# Copy-only operational patch: the caller must verify the exact loaded base image ID.
# No RUN, dependency installation, network access or unrelated application source changes.
ARG MAINTENANCE_BASE_IMAGE
FROM ${MAINTENANCE_BASE_IMAGE}
ARG MAINTENANCE_PATCH_REVISION
ARG MAINTENANCE_BASE_ID
LABEL org.walletscaner.maintenance.patch-revision=${MAINTENANCE_PATCH_REVISION}
LABEL org.walletscaner.maintenance.base-id=${MAINTENANCE_BASE_ID}
COPY scripts/maintenance/prune-operational-data.ts scripts/maintenance/maintenance-inventory.ts scripts/maintenance/maintenance-health.ts scripts/maintenance/check-operational-health.ts scripts/maintenance/quote-price-prerequisite.ts scripts/maintenance/backup-health.ts scripts/maintenance/storage-runway.ts ./scripts/maintenance/
COPY scripts/maintenance/prune-operational-data.test.ts scripts/maintenance/maintenance-inventory.test.ts scripts/maintenance/maintenance-health.test.ts scripts/maintenance/quote-price-prerequisite.test.ts scripts/maintenance/backup-health.test.ts scripts/maintenance/storage-runway.test.ts ./scripts/maintenance/
