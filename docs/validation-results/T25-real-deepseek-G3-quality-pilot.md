# T25 · Real DeepSeek G3 decision stability and independent Bug oracle

Date: 2026-10-09. Runner: Windows, Node 24, PostgreSQL 18 Docker,
real Chromium Worker. **This is a real G3 pilot, not a G3/P0 release gate.**

## Exact quality baseline

`docs/04-validation.md` requires 10 **distinct** healthy flows, each run
10 independent times (**100 first outcomes**), plus 10 **distinct**
specified faults checked at least 3 times (**30 fault runs**).
Acceptance targets are healthy first-pass >=95%, no false successful
verdicts for executed checks, >=90% valid failures for specified in-scope
faults, and independently confirmed evidence for a confirmed issue.

Earlier T17/T18 two-case passes do not meet this. A repeated instance of a
single fixture must not be counted as a distinct business flow.

## T25 changes

- `scripts/t25-g3-pilot.mjs`: versioned per-sample NDJSON ledger, one fresh
  disposable PostgreSQL18 DB / Chromium / Worker / real model invocation
  per sample. It records **all** results including execution failures and
  incomplete evidence, not just successful tests.
- `T25-g3-deepseek-pilot-samples.ndjson`: append-only allowlisted evidence
  (classification, model ID, observed click/intent count, independent
  verdicts, provider-reported token counts, duration). No raw prompt,
  page snapshots, model response, API key or unredacted errors persisted.
- `T25-g3-deepseek-pilot-summary.json`: aggregate of the above.
- T18 real integration fixture now asserts that the two `Verdict`
  documents' nested `criterionResults[].evidenceRefs` are nonempty and
  pairwise disjoint, in addition to fresh browser contexts, confirmed
  Finding and two `issue_found` verdicts.
- Real-model telemetry sums `model_requests.redacted_diagnostic` reported
  input/output tokens **only if every call is provider-reported**.
  Missing usage stays null. No fabricated USD price.

## G3 two-step repeated pilot, 16 independent samples

| Metric | Recorded |
| --- | ---: |
| Repeated distinct approved workflows | 1 |
| Healthy initial results (TN) | 8 / 8 |
| Seeded stable fault results (TP) | 8 / 8 |
| Potential false positive / negative flags | 0 / 0 |
| Execution failures or inconclusive | 0 |
| DeepSeek provider calls | 48 |
| Vendor-reported input tokens | 109,623 |
| Vendor-reported output tokens | 10,803 |
| Average healthy execution | 9.4 sec |
| Average faulty+reproduction execution | 12.9 sec |

Each healthy sample requires completed `passed` technical oracle,
2 settled live model decisions, 9 audited browser actions, and exactly
2 approved clicks; no confirmed Finding. Each fault sample requires
4 settled live model decisions, 18 actions/4 approved clicks, two fresh
browser contexts, **disjoint evidence IDs**, both technical verdicts
`issue_found`, and one confirmed Finding. A provider or assertion failure
is recorded as `execution_failure`/`inconclusive`, not silently
converted to a model false negative.

### Interpretive limits

Observed 100% classification on sixteen **repetitions of one known local
fixture** provides no high-confidence global error-rate estimate.
The expected decision is authored and approved before running.
This does not demonstrate autonomous arbitrary-site Bug discovery.
No attempt was made to create production orders/payments, access third-party
business systems or let the model change the technical oracle.
The pilot count does **not** satisfy 100+30 or the 10+10 distinct-fixture
coverage rule. Do not mark the overall G3 or P0 release Gate passed.

## Reproduction

```powershell
pnpm test:t18-real           # One fresh healthy and faulty baseline each
node scripts/t25-g3-pilot.mjs 4  # Four more independent pairs (real DeepSeek)
```

This runs real external model requests; each new sample incurs usage. The
existing Pi DeepSeek credential is read-only and not copied into reports.
The test runner should preserve dirty git worktree and remove its own
disposable DB containers.

## Distinct-function G3 breadth (separate denominator)

The standalone `scripts/t25-g3-breadth.mjs` executes seven independently
seeded real-model acceptance checks and appends **all** results to
`T25-g3-deepseek-breadth.ndjson` even when one check fails. It exits with
code 2 if any safe degraded run remains, rather than silently turning a
partial outcome into success.

| Case | Pre-fix initial result | What was actually verified |
| --- | --- | --- |
| Single-step Chinese healthy form | expected | Browser click and fixed technical pass |
| Single-step seeded form fault | expected | Confirmed Finding with independent reproduction |
| Checkout success marker absent | expected | Confirmed Finding from user-sourced oracle |
| Transient failure repaired before reproduction | expected | Independent `passed`, Finding downgraded to `unconfirmed` |
| Reproducer sees HTTP 503 | **safe_degraded_incomplete_reproduction** | Run partial, job interrupted, Finding `blocked`, but no complete independent `reproductions` record |
| Intentional reproducer interruption | expected | No fabricated confirmation; Finding `blocked` |
| Real form-authenticated exploration | expected | Imported private auth state, protected page visited |

The initial breadth batch therefore recorded **6 expected, 1 degraded,
0 incorrectly confirmed**. The 503 scenario is not accepted as a
successful independent reproduction. It is also not a false confirmed Bug.
These seven categories are not counted as seven additional repetitions of
the two-step pilot and no overall model accuracy rate is calculated from
them.

## T25 issue 001 · Interrupted HTTP 503 reproduction

The real DeepSeek 503 case reproduced twice before repair. Both failures
ended with `reproducer=interrupted`, `recover=succeeded`,
`reproductions=0`, `Run.completion=partial` and `Finding=blocked`.
Fail-closed behavior prevented false confirmation, but a requested
independent reproduction record was missing.

In `apps/worker/src/index.ts`, the Worker previously continued model
decisions and model-based assertion requests against a browser-observed
HTTP 503 error page. In a reproduction phase, the technical oracle
already establishes that the feature DOM could not be evaluated. T25
now skips unnecessary LLM actions/assertion for an unavailable target
response (HTTP 5xx, 401, 403 in execute/reproduce), captures the real
page evidence, and completes the frozen technical criterion with
`not_evaluated`. Explicit user-sourced `http_status` checks retain
their direct technical verdict rather than being rewritten as a DOM
failure.

**Post-fix observed G3 test:** `node scripts/t16-real-nonconfirm.mjs blocked`
with the existing Pi DeepSeek profile completed normally: 8/8 model
requests settled, 2 distinct Chromium contexts and disjoint evidence,
`reproductionOutcome=blocked`, `Finding=blocked`,
`Run=completed/complete`. The reproducer does not invoke the model
on the 503 page. This is an actual code fix, not an assertion relaxation.

Two additional **independent** post-fix 503 runs via
`node scripts/t25-g3-breadth.mjs 4 5` also passed (8 and 7 actual model
calls, respectively). The append-only breadth ledger now contains **9
historical executions across 7 distinct scenarios**: one original
safe-degraded failure retained and both post-fix passes retained.
`pnpm report:t25-g3` reads the first and most recent outcome for each
scenario, reporting **7/7 latest expected, 0 currently unresolved**, while
preserving the original failure as evidence. Repeating just the fixed
503 case is not a substitute for the larger G3 sample requirement.

Other blocked/timeouts, non-local or upstream-provider outages, and
independent full G3/G4/P0 gates remain open.

## Post-fix compatibility verification

All the following were executed on the changed local Worker:

- `node scripts/t25-g3-breadth.mjs 4 5` twice: **2/2** fresh HTTP 503
  DeepSeek reproductions now have a complete `blocked` reproduction
  record and no false confirmation. Earlier degraded history retained.
- `pnpm test:t18-real`: **2/2** actual DeepSeek healthy/confirmed fault
  cases with two approved model-selected DOM actions per attempt.
- `node scripts/t16-real-nonconfirm.mjs unconfirmed` with the authorized
  DeepSeek profile: **1/1**, original failure corrected on independent
  replay, Finding `unconfirmed`.
- `pnpm test:t22-otp`: **4/4** real PostgreSQL18/Chromium OTP success,
  reject, expiry and incorrect code behavior.
- `pnpm test:t20-auth-negative` and `pnpm test:t21-auth-negative`:
  **8/8** existing session expiry, revocation and fail-closed checks.
- `pnpm test:auth-pure`: **48/48** private-auth and browser-facing
  security unit tests.
- `pnpm test:t18-wire`: **2/2** synthetic transport G2 regression cases,
  recorded separately from all G3 scores.
- Worker TypeScript build, ESLint, Prettier and tracked git whitespace
  validation passed. No commit/push/deployment.

The independent current state is generated with
`pnpm report:t25-g3` into
`T25-g3-real-deepseek-current-summary.json`. Its schema intentionally
retains the historical failure, distinguishes latest outcome, and sets
`normativeGate.coverageSatisfied=false` and `p0Approved=false`.
