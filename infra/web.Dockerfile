FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @workforce/web... --filter @workforce/contracts
COPY packages/contracts packages/contracts
COPY apps/web apps/web
# API_URL is read at build time by the /api rewrite; NEXT_PUBLIC_RT_URL is baked into the browser bundle.
ARG API_URL=http://api:4000
ARG NEXT_PUBLIC_RT_URL=http://localhost:4000
ENV API_URL=$API_URL NEXT_PUBLIC_RT_URL=$NEXT_PUBLIC_RT_URL
RUN pnpm --filter @workforce/contracts build && pnpm --filter @workforce/web build

FROM node:22-alpine
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
