# T29 · Unmask model failure causes in frozen regression AI actions

Date: 2026-10-09. LocalQA, `E:\\AI\\momentic` (dirty worktree
intentionally preserved). Real upstream: previously authorized
`moan2 / MiniMax-M3`; each G3 sample uses fresh disposable PostgreSQL 18,
Chromium and Worker. No user credentials, raw provider body, or API keys
are written to the ledger.

## Production defect found

The old Worker `decide()` method threw generic `MODEL_FAILURE` for any
`CallRecord.requestResult` other than `ok/repaired`, **before** the
T28 `createRegressionAiAction` classifier could inspect the redacted,
structured `requestResult` and `errorCode`. The T28/T27 error taxonomy
therefore worked in isolated unit tests but was not reachable via the
real Worker callback. T28's previous four error rows were genuinely
`MODEL_FAILURE` but could not distinguish malformed model output,
provider timeout, or upstream service faults. Treating these as
early-click failures was especially misleading.

### Applied resolution

- `apps/worker/src/index.ts`: the **regression executor/reproducer**
  callback now opts into receiving the structured model record even on a
  failed result. The existing guarded replay port remains responsible for
  converting known, safe codes into frozen technical failure reasons.
  Planner/explorer/other ordinary `decide` uses preserve strict
  fail-closed rejection. Any attempt to request a failed record from an
  unrelated role is itself rejected.
- Cancellation is rechecked immediately after awaited model completion;
  cancellation takes priority over exposing a stale model response.
- The outside-replay exception handler maps explicit model billing,
  timeout, unavailability, capability and rate-limit codes to the existing
  `model_failure` termination category instead of mislabeling all of
  them setup failures; budget exhaustion remains `budget_limit`.
- `scripts/t26-g3-diverse-matrix.mjs`: T29's independent append-only
  model ledger records precise replay reason codes and never confuses
  `MODEL_VALIDATION_FAILED`/`MODEL_TIMEOUT` with a skipped or repeated
  DOM click. New samples can preserve safely observed provider-request
  counts even when the full run fails; missing cost data remains null
  rather than invented zero.

**No automatic retries are added for provider errors.** An invalid model
response already receives the model gateway's bounded one-time structured
format repair. Reissuing a timeout may duplicate chargeable inference
while its previous settlement is unknown. No authorization, frozen oracle,
origin restriction, budget or action-limit policy is weakened.

## Actual G3 MiniMax-M3 validation

Source: `T29-g3-moan2-business.ndjson` with a *new*, isolated batch.
Eight independent test samples covered four business rules, each with
one healthy and one seeded wrong-value variant:

| Sample | Technical result |
| --- | --- |
| Inventory reservation healthy/fault | TN / TP |
| Coupon discount healthy/fault | TN / execution_failure: `MODEL_VALIDATION_FAILED` |
| Shipping zone healthy/fault | execution_failure: `MODEL_TIMEOUT` / TP |
| Meeting room healthy/fault | TN / TP |

Total: **3/4 correct healthy**, **3/4 independently confirmed seeded
faults**, **2/8 execution failures**. The two failures generated no false
confirmed Finding. The first five historical T26/T27/T28 sample files
are not rewritten and still retain their earlier generic diagnostics.
There were 24 provider decision requests across the six fully accepted
cases, with provider-reported 52,068 input and 2,041 output tokens on
those six accepted samples. **This is not a whole-batch billing total**:
failed samples may still have incurred model requests.

These observations prove the new error attribution now works in the real
PostgreSQL/Chromium/Worker run. They do **not** show that MiniMax-M3
reliability is fixed or that automatic retry is safe.

## Verification and release boundaries

- `pnpm test:t29-causes`: **23/23** deterministic tests, including Worker
  failed-record passthrough, legacy rejection, role guard, cancellation
  priority, Worker-to-regression error handling, no unauthorized DOM action,
  earlier T27/T28 bounded recovery behavior.
- `node --test apps/worker/test/regression-replay.test.mjs`:
  **16/16** guarded replay tests.
- Worker TypeScript build completed after the changes.
- `pnpm test:t18-wire`: **2/2** actual PG18/Chromium with G2 synthetic
  provider; `node scripts/t26-wire-flow.mjs coupon-discount faulty`:
  **1/1** independently reproduced business failure with synthetic
  model decisions. These are not model-backed G3 cases.
- `pnpm test:auth-pure`: **48/48** private auth and browser-facing
  security tests still pass.
- Prettier, production ESLint and Git tracked whitespace checks passed.
- Final audit: 0 disposable test DB containers and 0 owned T29 helper
  processes remain. All historical dirty/untracked files preserved.

The next technical investigation is **why MiniMax-M3 sometimes produces
malformed structured decisions despite the gateway's one-time repair**,
and why its model endpoint sometimes exceeds the configured finite timeout.
That investigation should use only allowlisted machine diagnostics, not
store or print complete provider responses.

**Formal G3 100+30 and P0 are not approved.** No commit, push, deploy,
credential modification or provider payment change was made.
