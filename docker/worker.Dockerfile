FROM node:24-alpine

WORKDIR /app

RUN apk add --no-cache zstd postgresql16-client

COPY package.json package-lock.json ./

# npm workspaces resolves each package's production dependencies while running
# npm ci. Copy the manifests before the install layer so the container contains
# the same dependency graph as local/CI builds without invalidating the cache
# for source-only changes.
COPY apps/api/package.json ./apps/api/package.json
COPY apps/bot/package.json ./apps/bot/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/backtesting/package.json ./packages/backtesting/package.json
COPY packages/config/package.json ./packages/config/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/paper-trading/package.json ./packages/paper-trading/package.json
COPY packages/providers/package.json ./packages/providers/package.json
COPY packages/scoring/package.json ./packages/scoring/package.json
COPY packages/shared/package.json ./packages/shared/package.json

RUN npm ci

COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig.json vitest.config.ts eslint.config.mjs .prettierrc ./

CMD ["npm", "run", "worker:solana"]
