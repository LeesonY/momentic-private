FROM node:24-bookworm-slim AS build
WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm_config_registry=${NPM_REGISTRY}
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN npx --yes pnpm@10.34.0 fetch --frozen-lockfile
COPY . .
RUN npx --yes pnpm@10.34.0 install --offline --frozen-lockfile
RUN npx --yes pnpm@10.34.0 --filter '@localqa/worker...' build

# Official browser image supplies Noble's Chromium/libs; runtime Node must be Node 24.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
ENV NODE_ENV=production HOME=/var/localqa/scratch TMPDIR=/tmp \
    DATA_DIR=/var/localqa/data PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=build --chown=1001:1001 /app /app
RUN mkdir -p /var/localqa/data /var/localqa/scratch && chown -R 1001:1001 /var/localqa
USER 1001:1001
ENTRYPOINT ["node", "/app/deploy/images/worker-entry.mjs"]
