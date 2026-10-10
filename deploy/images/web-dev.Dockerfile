FROM node:24-bookworm-slim
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 NODE_ENV=development
RUN npm install --global pnpm@10.34.0 && \
    groupadd --gid 1001 localqa && \
    useradd --uid 1001 --gid 1001 --create-home localqa
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --offline --frozen-lockfile && \
    pnpm --filter @localqa/contracts build && \
    chown -R 1001:1001 /app
USER 1001:1001
EXPOSE 5173
CMD ["pnpm", "--filter", "@localqa/web", "dev", "--host", "0.0.0.0"]
