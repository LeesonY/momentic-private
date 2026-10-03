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
ARG LOCALQA_UID=1001
ARG LOCALQA_GID=1001
ENV NODE_ENV=production HOME=/home/localqa
RUN groupadd --gid "${LOCALQA_GID}" localqa && \
    useradd --uid "${LOCALQA_UID}" --gid "${LOCALQA_GID}" --create-home --home-dir /home/localqa --shell /usr/sbin/nologin localqa
WORKDIR /app
COPY --from=build --chown=${LOCALQA_UID}:${LOCALQA_GID} /app/apps/web/dist /app/apps/web/dist
COPY --from=build --chown=${LOCALQA_UID}:${LOCALQA_GID} /app/deploy/images/web-entry.mjs /app/web-entry.mjs
USER ${LOCALQA_UID}:${LOCALQA_GID}
EXPOSE 8080
ENTRYPOINT ["node", "/app/web-entry.mjs"]
