# T24 · OTP hard-process crash, concurrent submit/consume and replay fencing

Date: 2026-10-09. Workspace: `E:\\AI\\momentic`.

## Scope and actual execution

Focused negative tests exercise the same real PostgreSQL 18, Chromium,
Coordinator/Worker and versioned HTTP API as T22/T23. No external IdP,
production users, network AI requests or synthetic in-memory DB substitute.

Run `pnpm test:t24-auth-negative` to execute:

| Scenario | Evidence / expected invariant |
| --- | --- |
| `kill` | OS child executes real `Worker.once()` until the OTP request is pending. Parent forcibly terminates the child process **and its Chromium process tree** on Windows using `taskkill /T /F`. After the actual 3-second lease expires, a separate parent Coordinator recovers it. Auth job is interrupted, session ended, initialized exclusive lock released, OTP/input expired and private ciphertext null, run `setup_failure`, no new authentication job. The original lease cannot heartbeat, issue a second OTP or consume the first. |
| `kill_submitted` | Child OTP consumer intentionally remains suspended, but the real HTTP endpoint accepts a correct OTP and the database is checked to contain a non-null encrypted payload. Only then is the OS process killed. Recovery nulls the **previously present ciphertext**, ends the session and rejects stale-leased retry. The public input remains `resolved` because the human submission succeeded; the overall Run fails. |
| `submit_race` | **12 concurrent real HTTP calls** with the same input version: exactly one 200, eleven 409 `VERSION_CONFLICT`. Only the winner gets a private encrypted submission; Worker consumes it and authenticates normally, with fresh protected Chromium exploration. |
| `consume_race` | After one authenticated HTTP submission, the real Worker consumer is deliberately held at its private boundary. Eight other concurrent server-side calls with the exact live lease proof race to consume the same challenge: precisely one returns `ready`, seven reject as `AUTH_FAILED`. Ciphertext, nonce, tag and key version are all nulled. Releasing the Worker consumer causes a safe failed auth; no protected page access or anonymous fallback. |
| `stale_lease` | While an actual Worker is waiting for an OTP, intentionally altered fencing token, context version, lease token and task ID each fail both OTP consumption and heartbeat. The genuine Worker is still able to consume the correct OTP and complete protected exploration. |
| `revoke_consume` | After the HTTP OTP submission, a versioned profile revocation denies consumption, clears ciphertext and prevents login-state capture. |

Observed: **6/6 T24 scenarios passed** using `pnpm test:t24-auth-negative`.
The same final execution also passed **4/4 T22 OTP scenarios**
and **1/1 normal non-OTP auth smoke**. Related pure auth regression:
`pnpm test:auth-pure`, **48/48 passed**.

Test-specific IPC passes disposable KEK and DB coordinates only to the
throwaway child process, never via process command-line arguments, HTTP,
artifact, event, stdout or the external model. The child is killed rather
than performing graceful task completion. Parent cleanup removes its owned
PostgreSQL container. The child helper must not be used as a production
Worker launcher.

## Change list

- Added `scripts/t24-auth-worker-child.mjs`: isolated executable Worker
  child for OS termination checks, with temporary 3-second leased heartbeat.
- Added `scripts/t24-auth-negative.mjs`, and
  `package.json:test:t24-auth-negative`.
- Extended `apps/worker/test/auth-pg-chromium.integration.mjs` with
  all six focused T24 cases and database-backed assertions.
- Hardened `packages/orchestrator/src/auth-otp.ts` with a PostgreSQL
  shared row lock on the auth profile during OTP issuance and consumption.
  This serializes checks with versioned profile revocations.

## Limits / release decision

- 12 concurrent submits and 8 concurrent consumes validate a targeted race;
  they are not a throughput or long-term soak benchmark.
- Cross-host loss, network partitions, distributed worker orchestration,
  process crash during a partially executed browser action, multi-factor
  resend/fallback and external IdP are not yet covered.
- No real model is involved in these negative OTP scenarios. T17/T18/T19
  real-model evidence and scaled G3 acceptance remain separate.
- Existing dirty worktree preserved; no commit, push or deployment.
  **Overall P0 release approval remains false.**
