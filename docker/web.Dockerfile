FROM node:24-alpine
WORKDIR /app
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:4010
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL}
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.json vitest.config.ts eslint.config.mjs .prettierrc ./
RUN npm ci --include=dev --ignore-scripts
RUN npm run build -w apps/web
RUN npm prune --omit=dev --ignore-scripts
ENV NODE_ENV=production
EXPOSE 3010
CMD ["npm", "run", "start", "-w", "apps/web"]
