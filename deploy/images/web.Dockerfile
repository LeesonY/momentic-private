FROM node:24-bookworm-slim AS build
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm_config_registry=${NPM_REGISTRY}
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN npx --yes pnpm@10.34.0 fetch --frozen-lockfile
COPY . .
RUN npx --yes pnpm@10.34.0 install --offline --frozen-lockfile
RUN npx --yes pnpm@10.34.0 --filter @localqa/contracts build && \
    npx --yes pnpm@10.34.0 --filter @localqa/web build

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOME=/tmp
WORKDIR /app
COPY --from=build --chown=1001:1001 /app/apps/web/dist /app/dist
COPY --from=build --chown=1001:1001 /app/deploy/images/web-entry.mjs /app/web-entry.mjs
USER 1001:1001
EXPOSE 8080
ENTRYPOINT ["node", "/app/web-entry.mjs"]
