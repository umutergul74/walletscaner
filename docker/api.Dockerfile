FROM node:24-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY tsconfig.json vitest.config.ts eslint.config.mjs .prettierrc ./
RUN npm ci --ignore-scripts
EXPOSE 4010
CMD ["npm", "run", "start", "-w", "apps/api"]
