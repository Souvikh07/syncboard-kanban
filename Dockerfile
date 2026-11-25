# Build stage
FROM node:22-slim AS builder

# Native build tools for better-sqlite3 fallback if needed
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/tsconfig.json ./shared/
COPY server/package.json server/tsconfig.json ./server/
COPY client/package.json client/tsconfig.json client/vite.config.ts client/index.html ./client/

RUN npm ci

COPY shared/src ./shared/src
COPY server/src ./server/src
COPY client/src ./client/src

RUN npm run build

# Production stage
FROM node:22-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001
ENV DB_PATH=/data/kanban.db
ENV FAIL_RATE=0

COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/

RUN npm ci --omit=dev --workspace=shared --workspace=server --include-workspace-root=false

COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/client/dist ./client/dist

RUN mkdir -p /data

EXPOSE 3001
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server/dist/index.js"]
