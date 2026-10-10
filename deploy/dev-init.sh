#!/usr/bin/env bash
# First-time setup of the isolated Docker development stack on macOS/Linux:
# secrets volume, image build, migrations, initial admin, then dev-start.sh.
# Safe to rerun: existing secrets are kept, applied migrations are skipped and
# the database refuses a second admin bootstrap (reported, not an error).
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
compose="$repo/deploy/docker-compose.dev.yml"
cd "$repo"

docker volume create localqa-dev-secrets >/dev/null
docker run --rm \
  -v localqa-dev-secrets:/secrets \
  -v "$repo/deploy/scripts:/scripts:ro" \
  node:24-bookworm-slim node /scripts/init-dev-secrets.mjs

docker compose -f "$compose" build
docker compose -f "$compose" up -d --wait postgres
docker compose -f "$compose" run --rm --no-deps --entrypoint node \
  api /app/deploy/scripts/migrate.mjs

export ADMIN_INITIAL_EMAIL="${ADMIN_INITIAL_EMAIL:-admin@localqa.internal}"
status=0
docker compose -f "$compose" run --rm --no-deps -e ADMIN_INITIAL_EMAIL \
  --entrypoint node api /app/deploy/scripts/bootstrap-admin.mjs || status=$?
if [ "$status" -eq 2 ]; then
  echo 'Admin already bootstrapped; keeping the existing account.'
elif [ "$status" -ne 0 ]; then
  exit "$status"
fi

"$repo/deploy/dev-start.sh"
