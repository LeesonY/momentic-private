# LocalQA CI CLI (T11)

Requires Node.js 24+ and a running LocalQA API. The CLI uses project-scoped
API keys; it never asks for a password on the command line and never prints a
token. API keys can only access the explicitly allowlisted endpoints.

## Create a project-scoped key

With an authorized operator/owner browser session, call:

`POST /api/v1/projects/<projectId>/api-keys`

```json
{
  "name": "pipeline-read-run",
  "scope": ["runs:create", "runs:read", "reports:read", "runs:cancel"],
  "expiresAt": null
}
```

The response contains `token` **only once**. Put it in your CI secret manager
and configure the runner with `LOCALQA_API_TOKEN`, or with
`LOCALQA_API_TOKEN_FILE` pointing to an absolute, regular, non-symlink secret
file readable only by the runner UID (0400/0600 on Linux). Configure
`LOCALQA_API_BASE_URL` as an HTTPS endpoint (HTTP is allowed for localhost
only). Do not paste a token into CLI flags, build logs or a repository.

## Usage

```sh
node apps/cli/localqa.mjs smoke --project "$PROJECT_ID" --url "https://test.example.com" --wait --json
node apps/cli/localqa.mjs run --project "$PROJECT_ID" --cases "$APPROVED_VERSION_ID" --environment "$ENV_ID" --wait
node apps/cli/localqa.mjs status --run "$RUN_ID"
node apps/cli/localqa.mjs status --run "$RUN_ID" --gate
node apps/cli/localqa.mjs stop --run "$RUN_ID"
node apps/cli/localqa.mjs report --run "$RUN_ID" --output result.json --gate
```

`smoke` starts a new smoke run; `run` starts a regression from immutable
approved saved-case version IDs. `--wait` polls and applies the strict gate,
with a 10-minute default or `--timeout 900` (seconds). `--json` emits the
full returned payload; otherwise the wait/report output is a compact summary.
Report files are new files created with restricted permissions; overwriting
an existing report is refused.

Exit codes for a gated report: `0` = all selected cases passed with complete
evidence and no coverage or warning gaps; `1` = a verified case-level issue;
`2` = configuration/transport failure, missing coverage/evidence, timeout,
inconclusive or incomplete run; `130` = interrupted by the user. Plain
`status` only queries status; use `--gate` for a CI decision. The CI
runner should preserve the CLI process exit code.

Keys may be revoked through
`POST /api/v1/api-keys/<keyId>/revoke` using an authorized browser session.
Key use rechecks project membership and the creator's current permissions.

## Limitations

The T11 scheduler (cron, timezone, catch-up, overlap and occurrences) is a
separate workstream and is **not yet available**. CI API keys do not grant
SSE, artifact-download or ordinary management access. This CLI returns report
JSON and can persist it but does not currently download artifact binaries.
