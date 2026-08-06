FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY vitest.config.ts eslint.config.mjs .prettierrc ./

RUN npm ci --ignore-scripts

VOLUME ["/app/reports"]
VOLUME ["/app/logs"]

CMD ["npx", "tsx", "scripts/research/market-watch.ts"]
