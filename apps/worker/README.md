# @localqa/worker — T05

Worker polls RuntimeClient, claims T02 leases, heartbeats, binds runtime identity/config/approvals (never model IDs), dispatches schema/role/policy-checked tools through T04 dispatcher into T03 BrowserPort and commits durable intents/outcomes/evidence/results. Each case/reproduction uses a fresh browser context. Technical verdicts use deterministic sourced observations; T04 fixed assertion stub's static evidence IDs are rejected, never rebound to fake a successful assertion.

## Verify

From project root (Docker images `postgres:18-alpine` and `mcr.microsoft.com/playwright:v1.63.0-noble` required):

```sh
npx --yes pnpm@10.34.0 install
npx --yes pnpm@10.34.0 --filter @localqa/domain build
npx --yes pnpm@10.34.0 --filter @localqa/orchestrator build
npx --yes pnpm@10.34.0 --filter @localqa/worker test
```

Verifier runs scoped build/typecheck/lint/format and domain tests, creates an isolated PostgreSQL 18 + Linux Chromium network, mounts source read-only and only T05 artifact/evidence directories writable. Uses non-root host UID, `chromiumSandbox:true`, **no `--no-sandbox`**; this T00 host needs SYS_ADMIN. Fixture is a new in-memory process, so existing fixture state/source is untouched. PostgreSQL migrations come from read-only T02. Verification logs/facts/material bytes stay in T05 directories; containers/anonymous volumes/network/temporary passwords/KEK are deleted and absence checked in finally. Evidence: `docs/validation-results/T05-domain.json`.

The runtime API is an injectable Worker class, not a fake standalone HTTP deployment. `run(signal)` polls continuously; `once(signal)` provides deterministic integration-driving. Fault hook `onActionIntent` is optional test instrumentation before a browser action; not exposed as a tool.

Cancellation/model transport signals are combined; each action/result rechecks fencing/context/cancel status. BrowserPort close currently swallows errors, therefore finalizer cleanup status is unknown rather than falsely complete. Wider tools, authentication, real models, transport security, full reports and complete G2/P0 remain unverified/blocked as detailed in evidence and orchestrator README.
