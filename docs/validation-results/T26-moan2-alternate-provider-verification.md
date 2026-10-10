# T26 · Previously authorized moan2 model restored, without mixing G3 scores

Date: 2026-10-09, `E:\\AI\\momentic`.

## Provider attribution and authorization

The user's previously supplied provider is **moan2**, configured in the
existing read-only local Pi `auth.json` / `models.json` as
`anthropic-messages`. The code already supported this provider in T14/T17,
but the newer T26 runner had forced the DeepSeek provider. This was a test
runner selection mistake, not evidence that the user lacked an alternative.

The selected configured model must be present in the provider's existing
model allowlist. No new API key was requested, exposed or persisted in a
repository, and no Pi configuration was changed.

## Actual model probe and completed browser outcomes

| Selected route | Result |
| --- | --- |
| `moan2 / mofree-m1` | Live preflight HTTP 503 |
| `moan2 / glm-5.3-flash` | Live preflight HTTP 503 |
| `moan2 / MiniMax-M3` | Real T14 PG18/Chromium smoke **passed**. 12 provider requests, 12 settled, 5 browser actions, 1 technical `passed` case |
| `moan2 / MiniMax-M3` T26 inventory healthy | Multiple real model-backed **passed** executions. Two model-selected DOM clicks, frozen `text_equals`, approved-origin binding |
| `moan2 / MiniMax-M3` T26 inventory wrong value | A separately run live **passed** reproduction: 4 provider calls, 18 browser actions, 4 authorized clicks, 2 distinct contexts with disjoint evidence, `issue_found` x2, Finding `confirmed` |

**Do not overstate stability:** other MiniMax-M3 attempts sometimes returned
`done=true` after one of two required clicks and the technical run
remained `blocked`. No false confirmed business Bug was accepted for
those attempts. T26 strengthened the human-approved two-step goal to
require two distinct model-selected button clicks while retaining the
frozen criterion, policy, and action limit.

## Model-specific, append-only matrix

The rerunnable provider-explicit T26 scripts now support:

```powershell
node scripts/t26-real-flow.mjs inventory-reservation healthy moan2 MiniMax-M3
node scripts/t26-real-flow.mjs inventory-reservation faulty moan2 MiniMax-M3
node scripts/t26-g3-diverse-matrix.mjs 1 4 1 both moan2 MiniMax-M3
```

Moan2 results are appended to `T26-g3-moan2-business.ndjson` and summarized
in `T26-g3-moan2-summary.json`. Earlier DeepSeek runs and failures remain
in separate files. Configured and provider-reported model IDs are checked
and recorded separately.

This initial moan2 matrix across four distinct workflows has **10 historical
attempts**: 5 healthy (3 correct), 5 seeded faults (1 independently confirmed)
and 6 execution failures. A **separate** direct inventory-fault execution
passed the full independent reproduction gate but is not inserted into
the matrix ledger retrospectively. Do not report 100% moan2 model
reliability, merge it into DeepSeek's G3 baseline, or count failed runs
as model false negatives. The original G3/P0 release gates remain open.

Historical T14/T17 records showed `moan2 / mofree-m1` with an actual
`MiniMax-M3` provider response, but this does not imply the originally
configured `mofree-m1` route is currently available.

## Validation and next engineering work

The alternate model has been shown to work on the actual private isolated
stack; the blocker is now **model selection plus observed MiniMax action
variability**, not a missing user credential. G2 `t26-wire-flow` still
correctly reproduces the exact business fault after prompt tightening.
Future G3 samples should use the explicit provider/model in the immutable
test configuration and preserve the full denominator and failure reasons.

No commit, push, deploy, account billing edit or provider key replacement.
