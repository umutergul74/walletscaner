FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci

COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig.json vitest.config.ts eslint.config.mjs .prettierrc ./

CMD ["npm", "run", "worker:solana"]
