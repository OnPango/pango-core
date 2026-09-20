FROM node:24-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN corepack enable pnpm
RUN pnpm install
COPY . .
RUN pnpm build

FROM node:24-slim AS runtime

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
RUN corepack enable pnpm
RUN pnpm install --prod

EXPOSE 3000
CMD ["node", "dist/main"]