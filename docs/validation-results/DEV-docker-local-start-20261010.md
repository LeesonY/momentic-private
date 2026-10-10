# LocalQA Docker Desktop dev environment deployed (2026-10-10)

Location: `E:/AI/momentic`.

- Created isolated dev-only Compose deployment:
  `deploy/docker-compose.dev.yml` with PostgreSQL 18, API,
  Orchestrator, browser Worker and Vite React web.
- Generated unique secret files inside named
  `localqa-dev-secrets` Docker volume. No credential printed or
  copied into the Git worktree.
- Applied 23 SQL migrations and initialized the single development
  admin account `admin@localqa.internal`.
- Built four application images and launched all five services; Docker
  `up --wait` completed. PostgreSQL, API, and Web healthchecks passed;
  Orchestrator and Worker are running but have no dedicated healthchecks
  in the development Compose file.
- Verified HTTP 200:
  `http://localhost:5173/`,
  `http://localhost:3000/readyz`,
  `http://localhost:5173/api/v1/health/live`.
- Windows PowerShell Invoke-WebRequest may inherit a proxy and time out
  even when services are ready; tests use `curl.exe --noproxy '*'
  http://localhost:5173/`.
- Frontend Vite source folder is mounted read-only and file polling
  enabled. Changed the login page while Docker remained running and
  verified Vite served the updated content; Chromium loaded the real
  login screen and saw empty login credentials (no mock defaults).
- Compose Watch launched by an independent Windows WMI-created process
  to survive the short-lived task runner invocation. Cross-call
  inspection confirmed the watcher was still running. For backend
  changes Compose Watch rebuilds/restarts affected images; it is not
  in-process Node hot module reload.

The password remains in the local Docker secrets volume and can only be
read on the host by a user who has Docker access. See
`deploy/README.dev.md` for how to view it privately.
The user did not request a production TLS deployment; no production
volumes or credentials were changed, and this local HTTP environment
is explicitly restricted to 127.0.0.1.

Production G3/P0 acceptance and real AI Worker model-provider
end-to-end verification remain outstanding. No paid model runs,
stress tests, Git commit or deployment to external infrastructure.
