FROM node:24-bookworm-slim AS build
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm_config_registry=${NPM_REGISTRY}
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN npx --yes pnpm@10.34.0 fetch --frozen-lockfile
COPY . .
RUN npx --yes pnpm@10.34.0 install --offline --frozen-lockfile
RUN npx --yes pnpm@10.34.0 --filter '@localqa/orchestrator...' build

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOME=/tmp DATA_DIR=/var/localqa/data MASTER_KEY_FILE=/run/secrets/kek.json
WORKDIR /app
COPY --from=build --chown=1001:1001 /app /app
RUN mkdir -p /var/localqa/data && chown 1001:1001 /var/localqa/data
USER 1001:1001
ENTRYPOINT ["node", "/app/deploy/images/orchestrator-entry.mjs"]
