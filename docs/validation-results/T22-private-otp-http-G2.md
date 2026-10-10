# T22 · Private human OTP with live Worker / HTTP / Chromium

Date: 2026-10-09. Project: `E:\\AI\\momentic`.
Scope: implementation plus narrowly scoped acceptance using disposable
PostgreSQL 18, real API HTTP routes, Coordinator, Worker and Chromium.

## Delivered

- Added `023_auth_otp_challenges.sql`: private admin-RLS challenge ledger.
  The ordinary `InputRequest`/event carries only kind, ID, status, deadline
  and version. Submitted codes are AES-256-GCM encrypted through the project
  SecretVault with project/input/purpose-bound AAD. Neither code nor decrypted
  state is emitted in a response, browser action, normal event or model prompt.
- Added `AuthOtpService`: issue, versioned user submit/reject and one-use
  Worker consume. Rejects a missing OTP-enabled frozen form profile, stale
  challenge, changed run context, revoked profile, expired Worker lease or
  private auth session. Public actor RBAC is checked before the internal
  write, then locked/rechecked inside the trusted transaction. Viewers and
  cross-site/unauthenticated HTTP submissions are denied.
- Production Worker initialization now waits within its **same authenticated
  Chromium context and live Worker heartbeat** for a one-time human response,
  then fills/submits the challenge via private auth actions. It does not use
  ordinary clarification input, release the job for anonymous rescheduling
  or ask the model to provide credentials.
- API's existing `/api/v1/runs/{runId}/inputs/{inputId}/respond` accepts
  `oneTimeCode` only for a pending `one_time_code` request with
  `decision=provide`, or allows `reject` with no code. Extra credential
  or generic text fields are rejected.
- Workbench has an OTP-specific masked input and provide/reject controls.
  RunStore maps the value only into `InputResponse.oneTimeCode`, never the
  ordinary text/comment stream; input clears after submission/error.
- End-session, expired-lease recovery and interruption paths clear any
  unconsumed private OTP ciphertext. A successful consumption also nulls
  ciphertext, nonce, authentication tag and key version.

## Actual execution

Run: `pnpm test:t22-otp` (isolated local site, PostgreSQL 18, Chromium,
real API HTTP login/response, versioned Coordinator ledger, Worker.once).

| Scenario | Observed result |
| --- | --- |
| `success` | Correct code submitted by authenticated HTTP user, applied to actual OTP form, authenticated cookie captured, fresh Worker context explores protected dashboard; Run advances to plan |
| `reject` | Auth input explicitly rejected, no authenticated state, Run fails with `setup_failure` |
| `expire` | Disposable DB's OTP deadline moved into past; response denied as `VERSION_CONFLICT`, no state captured, Run fails safely |
| `wrong` | Wrong code accepted once by human-input API but denied by local target site; no auth-state capture, Run fails safely |

**4/4 passed.** Positive scenario additionally checked:

- unauthenticated HTTP request: 401;
- cross-site HTTP request: 403;
- authorized viewer actor: `FORBIDDEN`;
- retry of the same input version: HTTP 409 `VERSION_CONFLICT`;
- successful private ledger: status `consumed`, ciphertext/nonce/tag null;
- no code in input response, ordinary InputRequest document or input events.

Additional acceptance checks: API, Web, Worker, Orchestrator and Storage
builds passed during the T22 implementation. Existing T21 negative auth
flows **4/4** and the positive non-OTP auth smoke **1/1** passed after
introducing T22. The role-based AI decision in these tests is a fixed
testing stub; **this is not a live DeepSeek G3 benchmark**.

## Boundaries

- The frozen auth initializer session currently expires with its initial
  45-second task lease, even though Worker heartbeats renew the task lease.
  Therefore T22 deliberately caps the one-time OTP response at **30 seconds**
  and fails closed if insufficient session lifetime remains. This is not
  a supported multi-minute human OTP wait/resume design.
- The local test site is owned and deterministic, not a third-party IdP or
  production MFA/SSO provider. No second OTP challenge, fallback factor,
  resend flow, clock-skew acceptance or parallel user load benchmark was run.
- The UI compiles and routes its OTP payload correctly; independent
  Playwright browser clicking of the Workbench's OTP entry was not performed.
- Ordinary pending InputRequest event status during early session interruption
  may require an additional state reconciliation pass; consumption and
  authorization already fail closed, but this is not a UX SLA assertion.
- No deploy/commit/push. Preserve existing dirty worktree. **Overall P0
  acceptance remains false.**
