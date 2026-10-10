# T26 · Distinct business oracles, real DeepSeek G3 pilot, billing blocker

Date: 2026-10-09, Windows `E:\\AI\\momentic`, real PostgreSQL 18,
Chromium, Worker, isolated localhost fixtures. No commit or deployment.

## Eight newly implemented, distinct frozen business rules

| Fixture | Correct technical oracle | Seeded in-scope regression fault |
| --- | --- | --- |
| inventory-reservation | Reserve 2 units, 5 stock -> 3 remaining | Wrongly reports 5 remaining |
| coupon-discount | 100 - 20% = 80 | Reports amount due 100 |
| shipping-service-zone | ZIP 410001 -> fee 8 | Fee incorrectly 18 |
| meeting-slot | 09:30 is free | Reports 09:30 already occupied |
| invoice-vat | 200 x 13% = 26 | Incorrect VAT 12 |
| support-priority | P1 routes to urgent support | Misroutes to normal queue |
| room-upgrade | M2 inventory 2 -> 1 after upgrade | Remains 2 |
| cart-quantity | Quantity 3 x 40 = 120 | Wrong subtotal 80 |

Every faulty page still renders `data-testid=complete-marker`: a
presence-only test would yield a **false pass**. T26 changes the frozen
approved `Criterion` to `text_equals` and uses true live DOM node
ownership and fresh snapshots for the business result. Model actions are
only accepted under the pre-existing signed/frozen source, action budget,
fencing and origin policies; the model cannot alter the business oracle.

The separate Chromium fixture test `pnpm test:t26-oracles` validated all
16 healthy/faulty DOM states and confirmed the shared marker remained
visible even in faulty states. The business rules are independent, but
the eight pages share a two-click UI skeleton; this is not a claim of
iframe/canvas/SPA/complex table coverage.

## Actual real-model runs, append-only ledger

`pnpm test:t26-matrix` used existing read-only Pi DeepSeek credentials
with *one independently reset disposable DB and browser per sample*.
First eight healthy and eight seeded faults all passed:

- **8/8 healthy** technical passes (TN);
- **8/8 faults** independently reproduced with separate Chromium contexts
  and non-overlapping evidence refs; database Finding confirmed (TP);
- 48 real model decision requests, all settled;
- provider-reported **114,887 input + 12,436 output tokens**;
- 0 observed false passes, false findings or inconclusive outputs in
  those initial **16 distinct business-rule samples**.

To approach the baseline requiring >=3 repeats per fault, T26 attempted
another 16 negative samples (two repetitions per new rule). Five more
real-provider samples completed successfully (TP) before upstream
capability preflight stopped working. **Eleven later samples failed
before any decision model call was accepted.** Their rows are preserved
as `execution_failure`, not silently rewritten as model misses or
passing results. The matrix intentionally returned nonzero.

### Verified external provider limitation

An independent fresh test reproduced the same preflight failure.
The gateway initially reported `requestResult=malformed` /
`errorCode=VALIDATION_ERROR`. A tightly scoped transport wrapper captured
**upstream HTTPS status 402** with no response body, key, headers or model
prompts logged. This is an upstream payment-required/account-billing
blocker, **not** an invalid JSON request. Calls cannot responsibly
continue until the account is externally reauthorized/funded by its
owner; no credential or billing change was attempted.

T26 repaired the adapter and gateway error classification:
`402 -> MODEL_BILLING_REQUIRED` (distinct from 429 rate limit,
400 invalid request, 401/403 credentials, 5xx availability).
New contract error mapping, §7 documentation and deterministic no-network
`pnpm test:t26-billing` cover the actual 402 response. No automatic
fallback, retry storm or anonymous downgrade is permitted.

## Independent G3 threshold report

Run `pnpm report:t26-g3` to regenerate
`T26-g3-coverage-current.json`. The report combines the accepted
T17 single-step, T18 dynamic preview and eight T26 business rules:

| Quality dimension | Real model-backed observations | Required |
| --- | ---: | ---: |
| Distinct scripted workflows | 10 | 10 |
| Healthy initial outcomes | 17/17 correct | 100 across 10 each |
| In-scope seeded faults | 22/22 correctly identified | >=30 and 3 per type |
| Additional healthy samples needed for per-flow quota | **83** | — |
| Additional fault samples needed for per-type quota | **13** | — |
| Provider billing preflight failures, not scored as fault misses | **11** | 0 blocker |

The 22/22 model-backed fault denominator **excludes 11 probe failures**.
The planned target of 30 is not enough by itself if some types already
have more samples than others: per-flow repetition requirements still
require 13 additional correctly executed seeded failures. The related
T17/T18 form interactions are not evidence of arbitrary website
generalization. Human review of all fixture oracles remains outstanding.

## G2 control and follow-up

T26 also supplies `pnpm test:t26-g2`: 16 fresh PG18/Chromium runs with
the deterministic *synthetic* provider protocol, which never count as G3
quality results. **Observed: 16/16 passed**, with eight successful
technical oracles and eight confirmed independently reproduced seeded
faults. The artifact ledger names G2 and G3 separately.

After the billing classifier change, **eight package/module builds**
(contracts, model-gateway, storage, browser, orchestrator, worker, api,
web) passed. `pnpm test:t26-oracles` passed 16 DOM variants,
`pnpm test:t26-billing` passed its strict HTTP 402/no-secret scenario,
and `pnpm test:auth-pure` remained **48/48**.

No original dirty worktree changes were removed. No secrets, unredacted
provider bodies or protected business data are exported. No commit,
push or deployment. **Overall G3 and P0 remain NOT APPROVED.**
