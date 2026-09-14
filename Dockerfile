FROM node:24-bookworm-slim AS build

WORKDIR /app

RUN corepack enable && corepack install --global pnpm@10.26.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json .npmrc ./
COPY artifacts/api-server/package.json artifacts/api-server/package.json
COPY artifacts/api-server/.npmrc artifacts/api-server/.npmrc
COPY artifacts/api-server/build.mjs artifacts/api-server/build.mjs
COPY artifacts/api-server/tsconfig.json artifacts/api-server/tsconfig.json
COPY artifacts/api-server/src artifacts/api-server/src

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/api-server run build

FROM node:24-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY --from=build /app/artifacts/api-server/dist ./artifacts/api-server/dist

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]