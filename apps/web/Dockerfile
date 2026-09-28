FROM node:24-slim AS builder
RUN npm install -g pnpm@10.34.5
WORKDIR /app
ENV SKIP_ENV_VALIDATION=1
# the build evaluates the auth config; the real secret comes from compose at runtime
ENV BETTER_AUTH_SECRET=build-time-placeholder-secret-not-used-at-runtime

COPY . .
RUN --mount=type=cache,target=/pnpm-store pnpm install --frozen-lockfile --store-dir /pnpm-store

ENV NODE_ENV=production
RUN cd apps/web && pnpm run build
ENV SKIP_ENV_VALIDATION=
ENV BETTER_AUTH_SECRET=

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder --chown=node:node /app /app

ENV HOST=0.0.0.0
ENV PORT=3001
EXPOSE 3001

# SSR chunks require workspace dependencies at runtime
WORKDIR /app/apps/web
# /data (SQLite volume mountpoint) pre-created owned by node so a named
# volume inherits the right ownership on first use — see docker-compose.yml
RUN mkdir -p /data && chown node:node /data
# Run as the unprivileged node user; port 3001 needs no privileges
USER node
CMD ["node", ".output/server/index.mjs"]
