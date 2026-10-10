# LocalQA Windows Docker Development Stack

The isolated development environment is managed by
`deploy/docker-compose.dev.yml`, not the production Compose file.
The UI is at http://localhost:5173, with the API at
http://localhost:3000. Services only publish on the host loopback.

## First-time installation

Open PowerShell at the repository root, E:/AI/momentic.
Start Docker Desktop in Linux-container mode, then run:

```powershell
docker volume create localqa-dev-secrets
$scripts = (Resolve-Path 'deploy/scripts').Path
docker run --rm -v 'localqa-dev-secrets:/secrets' -v "$($scripts):/scripts:ro" node:24-bookworm-slim node /scripts/init-dev-secrets.mjs

docker compose -f deploy/docker-compose.dev.yml build --parallel
docker compose -f deploy/docker-compose.dev.yml up -d --wait postgres
docker compose -f deploy/docker-compose.dev.yml run --rm --no-deps --entrypoint node api /app/deploy/scripts/migrate.mjs
$env:ADMIN_INITIAL_EMAIL='admin@localqa.internal'
docker compose -f deploy/docker-compose.dev.yml run --rm --no-deps -e ADMIN_INITIAL_EMAIL --entrypoint node api /app/deploy/scripts/bootstrap-admin.mjs
./deploy/dev-start.ps1
```

The bootstrap step is ONLY for a new empty database. Do not repeat it on
an existing installation. Credential initialization is safe to rerun only
when the dev secrets volume contains all original secret files.

## Daily start / stop

```powershell
cd E:/AI/momentic
./deploy/dev-start.ps1
# Rebuild images manually after dependencies or Dockerfiles change:
./deploy/dev-start.ps1 -Build
# Stop services and file watcher, WITHOUT deleting any volumes:
./deploy/dev-stop.ps1
```

## Developer login

Admin email: `admin@localqa.internal`.
Its unique random password is stored ONLY in the dedicated Docker
secrets volume. To display it **in your own private terminal**:

```powershell
docker run --rm -v 'localqa-dev-secrets:/secrets:ro' node:24-bookworm-slim cat /secrets/admin_initial_password
```

Do not paste this password into source code, tickets or chat.
The login screen's prefilled mock-fixture credentials are not valid
for this real API database.

## Hot reload / restart

- Web: Vite development server binds `apps/web/src`,
  `apps/web/index.html` and the Vite config as read-only Docker bind
  mounts. File polling is enabled for Windows Docker Desktop HMR.
- Backend: the start script runs `docker compose watch --no-up` in the
  background. API, Worker and shared package source changes trigger
  **automatic image rebuild and service restart** (not in-process HMR).
  The database volume persists across rebuilds.
- Vite dependencies, lockfiles and Dockerfiles require `-Build` to
  update the image.
- Watcher diagnostics are saved outside the Git checkout:
  `$env:LOCALAPPDATA/LocalQA/compose-dev-watch.log` and
  `compose-dev-watch.err.log`. Windows restarts require running
  the start script again.

To inspect the stack:

```powershell
docker compose -f deploy/docker-compose.dev.yml ps
docker compose -f deploy/docker-compose.dev.yml logs --tail=100
curl.exe --noproxy '*' http://localhost:3000/readyz
curl.exe --noproxy '*' http://localhost:5173/
```

Never use `docker compose down --volumes` for this environment:
it deletes the development database. This stack is HTTP and
localhost-only. It is not a validated secure production deployment;
real remote-model Worker functionality still requires further
end-to-end acceptance.
