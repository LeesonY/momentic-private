# T28 · Safe bounded DOM-decision recovery and explicit upstream failure causes

Date: 2026-10-09. Workspace: `E:\\AI\\momentic` (existing dirty working
tree preserved). Real model route: previously authorized `moan2/MiniMax-M3`.
Disposable local PostgreSQL 18, Chromium, Worker and localhost business fixtures.
No credential changes, no commit/push/deploy.

## Defect scope

T27 fixed the possibility of accepting `done=true` before the two approved
actions had completed, but a model could still return `done=false` with
`toolCalls=[]` or a stale/unowned/non-interactable DOM target. Formerly the
first case failed immediately as `AI_NO_PROGRESS`; the second could reach
the guarded execution port unnecessarily. Neither should authorize an
inferred or guessed click.

T28 changes only regression `ai_action` steps that have **an explicit,
previously frozen positive `minToolCalls`**:

- An empty proposed action list or `done=true` before the approved minimum
  triggers a fresh browser observation and a new model decision.
- The **complete proposed action batch** is checked against the *current*
  `snapshotId`, `pageId`, frame/node IDs, visibility and enabled state
  **before executing any part of it**. Stale, unknown, hidden and disabled
  targets are rejected without sending a browser action. A model, not the
  Worker, must select a valid target on the next observation.
- The existing four-decision limit is unchanged. Exhaustion fails closed
  with `AI_NO_PROGRESS`, `AI_TARGET_INVALID` or `AI_ACTION_INCOMPLETE`;
  it never fabricates a passed criterion or extends the approved action
  count. Steps without `minToolCalls` retain fail-fast no-progress behavior.
- Policy or origin denial, cancellation, lease/budget failures and upstream
  billing/rate-limit/unavailability do **not** enter DOM-target recovery.
  Provider errors are propagated as stable machine codes, without response
  bodies or API keys; invalid model output is `MODEL_VALIDATION_FAILED`.

The existing frozen exact-value business oracle, independent reproduction,
fresh browser context and disjoint evidence checks remain authoritative.
This is a real Worker behavior change, not a prompt-only alteration or a
relaxation of test expected results.

## Verified tests

- `pnpm test:t27-actions`: **16/16** deterministic unit scenarios passed,
  including reobserve after an empty model answer, stale snapshot,
  fabricated node, invalid multi-call atomic rejection, hidden/disabled
  controls, policy denial not retried, bounded no-progress failures,
  provider billing/rate-limit/service/validation cause propagation, and
  previous T27 behavior.
- Worker TypeScript build passed. Existing compiler/replay tests and
  synthetic browser controls should be kept separate from real-model G3
  quality, not counted as live inference.

### Actual G3 evidence: T28 model-specific append-only ledger

`T28-g3-moan2-business.ndjson` records an initial four healthy + four
seeded faults, followed by **four additional independent fault attempts**.
All samples are preserved, including those where model execution failed:

| Type | Complete correctly classified | Execution failure | Total |
| --- | ---: | ---: | ---: |
| Healthy exact-value business cases | 4 | 0 | 4 |
| Seeded wrong-value independent reproductions | 4 | 4 | 8 |
| **Total** | **8** | **4** | **12** |

The failed fault runs never generated confirmed false findings, nor may
they be counted as valid technical false negatives. The T28 provider
summary reports **29 live provider decision requests across eight fully
accepted cases**, with vendor-reported 62,894 input + 2,478 output tokens
on those complete samples only. The unsuccessful attempts are retained
as execution failures, so these are not a total spending estimate.

**Important:** a failed model call in the first matrix batch was reported
with the generic `MODEL_FAILURE` machine reason, but the original T26
runner gave it the inaccurate label
`model_ended_before_second_approved_click`. T28 fixed classification
precedence; subsequent such failures are now labeled
`model_request_failed_unclassified`. Earlier raw ledger rows are not
overwritten. Upstream provider and model output failures are separate
from DOM target recovery and are not automatically retried.

These data do **not** establish that live MiniMax-M3 reliably triggered
the new DOM-invalid-target retry path. That recovery mechanism has
deterministic unit tests; the real model batch still has material
execution failures and is not a passing release-grade stability result.
Comparing T27 and T28 rates on such small, non-randomized samples would
not support a causal improvement claim.

## Run / audit

```powershell
pnpm --filter @localqa/worker build
pnpm test:t27-actions
pnpm test:t28-moan2
node scripts/t26-g3-diverse-matrix.mjs 0 4 1 faulty moan2 MiniMax-M3 T28
```

The G2 synthetic protocol is never added to the G3 denominator. Do not
declare G3 100+30 or G0-G4 P0 signoff passed. Retain historical T26/T27
and T28 failed samples for subsequent flake/transport diagnosis.
