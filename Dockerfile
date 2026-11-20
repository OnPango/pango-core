FROM node:24-slim AS builder

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable pnpm
RUN pnpm install
COPY . .
RUN pnpm build

FROM node:24-slim AS runtime

WORKDIR /app
COPY --from=builder /app/dist ./dist
# Tenant migrations are applied at runtime when an organization signs up
COPY --from=builder /app/prisma/tenant/migrations ./prisma/tenant/migrations
COPY --from=builder /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
RUN corepack enable pnpm
RUN pnpm install --prod

EXPOSE 3000
CMD ["node", "dist/main"]