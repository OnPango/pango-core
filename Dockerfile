# syntax=docker/dockerfile:1

ARG NODE_VERSION=24

# pnpm pinned to the version that writes pnpm-lock.yaml.
FROM node:${NODE_VERSION}-slim AS base
ENV CI=true
RUN npm install --global pnpm@12.18.0
WORKDIR /app

# Build: all dependencies, Prisma clients and the compiled API.
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Production dependencies only.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod

FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# Read when an organization signs up: its schema is created from these.
COPY --chown=node:node prisma/tenant/migrations ./prisma/tenant/migrations
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + process.env.PORT + '/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "dist/main.js"]
