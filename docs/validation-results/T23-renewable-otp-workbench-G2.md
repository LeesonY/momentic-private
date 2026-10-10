# T23 · Renewable, bounded private AUTH session and real Workbench OTP UI

Date: 2026-10-09. Project: `E:\\AI\\momentic`. Isolated local fixtures only.

## Root causes resolved

1. T22 OTP allowed only a 30-second window: the server session expired with
   the *initial* 45-second task lease even though the Worker renewed its
   actual lease continuously. Its private BrowserPort also pinned the original
   `expiresAt`. Updating only one layer would still fail closed.
2. API SSE sends frames with `event: input.requested` and other named
   events; `SseClient` listened only via `onmessage`, which never receives
   such named events. Consequently, the real Workbench never displayed OTP.
3. A cancelled, failed or interrupted authentication could invalidate the
   private OTP challenge without marking the associated public input request
   expired, leaving a stale control in the UI.

## Implemented behavior

- AuthExecutionManager renews an active initializer/importer session during
  the trusted Coordinator heartbeat transaction, after verifying the live
  Worker lease, its Worker ID, task, fencing token, context version, active
  auth epoch/scope and non-revoked profile. **Expired sessions cannot be
  resurrected**, and the absolute session deadline is at most **5 minutes
  from activation**. Cancelling/stopping sessions are not renewed.
- Private BrowserPort supports an optional parameterless trusted authority
  refresh; it can only obtain a new binding from the server-owned
  `RuntimeClient.authSession`. Every immutable identity field must match,
  the expiry must be monotonic, currently valid, and within a hard upper
  bound. Refresh happens before browser actions and after the server grants
  them, closing the heartbeat/permit time-of-check race. Existing legacy ports
  without this callback preserve their exact original deadline behavior.
- OTP request max wait is now **180 seconds**, provided there is sufficient
  *remaining absolute session lifetime* for the OTP and its final browser
  actions. Worker still holds its same browser context and live lease.
  OTP never travels through the model or ordinary clarification channel.
- Workbench SSE consumes both default messages and all 13 authoritative
  `RunEvent` named event types, with the existing sequence deduplication.
  Its OTP projection retains the true `running` Run status.
- `reconcileExpiredOtpInputs` is used by initializer session ending,
  Coordinator interruption, and expired-lease recovery. It updates the
  public InputRequest status/version and emits `input.resolved` **inside the
  same privileged transaction** that clears private OTP ciphertext.

## Verified execution (local)

| Command | Scope | Observed |
| --- | --- | --- |
| `pnpm test:t23-long-otp` | True 49-second pause after OTP challenge, PostgreSQL18 + Worker heartbeat + Chromium + HTTP API | Passed; auth session extended beyond the original 45-second deadline yet never beyond 5 minutes; correct OTP still authenticated and protected exploration succeeded |
| `pnpm test:t23-web-otp` | Real React build, same-origin HTTP/SSE proxy, Playwright Chromium, API login and OTP submit, independent authenticated Worker Chromium | Passed; OTP field displayed/masked, disabled button until input, real click posted `oneTimeCode` only, component removed on resolution, authorized state captured |
| `pnpm test:t23-cancel-otp` | User cancels while real Worker awaits private OTP | Passed; both private challenge and public InputRequest expired, ciphertext cleared, `input.resolved` emitted, no auth-state capture |
| `node packages/browser/test/private-auth.test.mjs` | Private port redaction, grant fencing, frozen tuple, retry/abort plus two T23 renewal-specific safety tests | Passed **23/23** |

### Still not accepted

- No OS-level kill/restart test of a Worker while awaiting OTP; the
  Coordinator lease-recovery path now cleans its public input, but a hard
  process interruption after the challenge requires its own load/restart
  matrix.
- No third-party SSO / IdP MFA, resend, multiple challenges, parallel input
  actors at scale, or multi-minute actual wall-clock test out to 180 seconds.
  The configured 180-second limit is enforced by request expiry and the
  5-minute session upper bound; the actual long-wait smoke covers 49 seconds.
- These G2 tests use a fixed model decision after authenticated exploration,
  not a live external DeepSeek G3 acceptance campaign.
- Existing dirty worktree preserved. No commit, push or deployment.
  **Overall P0 approval remains false** pending the broader G3/P0 matrix.
