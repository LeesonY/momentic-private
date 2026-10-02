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
ARG LOCALQA_UID=1001
ARG LOCALQA_GID=1001
ENV NODE_ENV=production HOME=/var/localqa/scratch TMPDIR=/tmp \
    DATA_DIR=/var/localqa/data PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Noble already has pwuser (1001:1001). Rename it rather than creating a duplicate UID;
# custom build IDs get a new localqa account. In both cases passwd resolves HOME.
RUN set -eux; \
    mkdir -p /var/localqa; \
    if getent group "${LOCALQA_GID}" >/dev/null; then \
      groupmod --new-name localqa "$(getent group "${LOCALQA_GID}" | cut -d: -f1)"; \
    else groupadd --gid "${LOCALQA_GID}" localqa; fi; \
    if getent passwd "${LOCALQA_UID}" >/dev/null; then \
      usermod --login localqa --gid "${LOCALQA_GID}" --home /var/localqa/scratch --move-home \
        "$(getent passwd "${LOCALQA_UID}" | cut -d: -f1)"; \
    else useradd --uid "${LOCALQA_UID}" --gid "${LOCALQA_GID}" --create-home \
      --home-dir /var/localqa/scratch --shell /usr/sbin/nologin localqa; fi; \
    mkdir -p /var/localqa/data /var/localqa/scratch && \
    chown -R "${LOCALQA_UID}:${LOCALQA_GID}" /var/localqa
WORKDIR /app
COPY --from=build --chown=${LOCALQA_UID}:${LOCALQA_GID} /app /app
USER ${LOCALQA_UID}:${LOCALQA_GID}
ENTRYPOINT ["node", "/app/deploy/images/worker-entry.mjs"]
