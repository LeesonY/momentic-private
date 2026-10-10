# LocalQA Docker Development Stack

The isolated development environment is managed by
`deploy/docker-compose.dev.yml`, not the production Compose file.
The UI is at http://localhost:5173, with the API at
http://localhost:3000. Services only publish on the host loopback.

Scripts exist for both platforms; run them from the repository root:

| Task | macOS / Linux | Windows (PowerShell) |
| --- | --- | --- |
| First-time install | `deploy/dev-init.sh` | steps below |
| Start | `deploy/dev-start.sh` | `./deploy/dev-start.ps1` |
| Start after dependency/Dockerfile changes | `deploy/dev-start.sh --build` | `./deploy/dev-start.ps1 -Build` |
| Stop (keeps volumes) | `deploy/dev-stop.sh` | `./deploy/dev-stop.ps1` |

## First-time installation

### macOS / Linux

Start Docker (Docker Desktop, or Colima with enough memory for image builds
and Chromium, for example `colima start --cpu 4 --memory 6`), then run:

```sh
deploy/dev-init.sh
```

It creates the `localqa-dev-secrets` volume and its random credentials,
builds the images, applies all migrations, bootstraps
`admin@localqa.internal` (override with `ADMIN_INITIAL_EMAIL`) and starts
the stack. Rerunning it keeps existing credentials, skips applied
migrations and leaves an existing admin unchanged.

### Windows

Open PowerShell at the repository root. Start Docker Desktop in
Linux-container mode, then run:

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

## Developer login

Admin email: `admin@localqa.internal`.
Its unique random password is stored ONLY in the dedicated Docker
secrets volume. To display it **in your own private terminal**:

```sh
docker run --rm -v 'localqa-dev-secrets:/secrets:ro' node:24-bookworm-slim cat /secrets/admin_initial_password
```

Do not paste this password into source code, tickets or chat.
The login screen's prefilled mock-fixture credentials are not valid
for this real API database.

## Hot reload / restart

- Web: Vite development server binds `apps/web/src`,
  `apps/web/index.html` and the Vite config as read-only Docker bind
  mounts. File polling is enabled for Docker Desktop HMR.
- Backend: the start script runs `docker compose watch --no-up` in the
  background. API, Worker and shared package source changes trigger
  **automatic image rebuild and service restart** (not in-process HMR).
  The database volume persists across rebuilds.
- Vite dependencies, lockfiles and Dockerfiles require a rebuild
  (`--build` / `-Build`) to update the image.
- Watcher diagnostics are saved outside the Git checkout as
  `compose-dev-watch.log` and `compose-dev-watch.err.log`: in
  `$env:LOCALAPPDATA/LocalQA` on Windows, and in
  `${XDG_STATE_HOME:-~/.local/state}/localqa` on macOS/Linux
  (override with `LOCALQA_STATE_DIR`). After a reboot, run the start
  script again.

To inspect the stack:

```sh
docker compose -f deploy/docker-compose.dev.yml ps
docker compose -f deploy/docker-compose.dev.yml logs --tail=100
curl --noproxy '*' http://localhost:3000/readyz
curl --noproxy '*' http://localhost:5173/
```

On Windows use `curl.exe`; PowerShell `Invoke-WebRequest` may inherit a
proxy and time out even when services are ready.

Never use `docker compose down --volumes` for this environment:
it deletes the development database. This stack is HTTP and
localhost-only. It is not a validated secure production deployment;
real remote-model Worker functionality still requires further
end-to-end acceptance.
