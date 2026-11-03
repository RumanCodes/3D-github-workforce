# One image, two roles: run with ROLE=api or ROLE=worker.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile --filter @workforce/server... --filter @workforce/contracts
COPY packages/contracts packages/contracts
COPY apps/server apps/server
RUN pnpm --filter @workforce/contracts build && pnpm --filter @workforce/server build
RUN pnpm deploy --filter @workforce/server --prod --legacy /out \
  && cp -r apps/server/dist apps/server/drizzle /out/

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 4000
# Migrations are applied by the separate "migrate" service (see docker-compose.yml) before api/worker start.
CMD ["node", "dist/main.js"]
