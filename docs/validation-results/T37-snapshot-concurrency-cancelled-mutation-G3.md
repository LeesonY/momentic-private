# T37 · Snapshot witness pressure, same-grant concurrency, and in-flight cancellation

Date: 2026-10-09. LocalQA Windows workspace `E:\\AI\\momentic`.
Prior dirty/untracked worktree, T17–T36 code and append-only failure
ledgers preserved. No commit, push, deployment, cleanup/reset or
provider credential/billing changes.

## Scope and reproduced browser framework bugs

The underlying T36 framework already rejects stale snapshots after
iframe document reloads and DOM remounts. T37 examined browser-session
concurrency and ambiguous cancellation, not new external product features.

Two new **real Chromium** tests failed against the T36 baseline:

1. Two simultaneous approved `click` requests with the **same**
   `snapshotId/pageId/nodeId` both dispatched to a static
   unchanged button, producing **two actual browser click side
   effects** despite only one approved observed target.
2. A model-requested click caused an actual page side effect, and
   the caller cancelled while the browser command was executing.
   The previous executor nevertheless returned `status=succeeded`,
   losing critical cancellation ambiguity.

Both were independently reproduced before the production changes.
They are **LocalQA browser execution framework defects**, not bugs
confirmed in a separate business product.

## Code changes and safety properties

`packages/browser/src/session.ts`:

- All `executeTool` and `getSnapshot(forceFresh)` operations on the
  same browser session run through one FIFO, finally-released,
  per-session async operation gate.
- An already consumed snapshot cannot authorize an additional
  simultaneous click. The first click commits a fresh snapshot,
  the queued old-grant request fails with `VERSION_CONFLICT`.
- The waiting request's own abort signal is rechecked when it
  obtains the operation gate. Event listeners for both session-wide
  and caller cancellation are removed in `finally`, avoiding
  unbounded listener accumulation.
- The gate is **session-scoped**: it does not allow cross-task or
  cross-origin access. It introduces no new browser permissions.

`packages/browser/src/executor.ts`:

- After a click has reached Chromium, a subsequently observed
  cancellation is returned as `status=cancelled`,
  `reasonCode=USER_CANCELLED`, with its non-null `actionId`.
- This representation is **not proof of rollback or no side effect**.
  It makes the action attempt traceable, preserves the fresh
  post-click snapshot where one can be captured, and prevents the
  interrupted action from being reported as normal success.
- If execution throws after an abort signal, the catch path also
  conservatively classifies it as cancellation rather than claiming
  an unrelated successful action.
- The caller must inspect effects before any *newly authorized*
  attempt. The framework does not automatically retry ambiguous
  writes, bypass the frozen two-click protocol, or expand model
  decision/provider budgets.

## Deterministic actual Chromium stress tests

`packages/browser/test/t37-lifecycle-concurrency-chromium.test.mjs`
contains six independent real-browser assertions:

1. 32 sequential snapshot captures: prior DOM witnesses are
   bounded to 12 per page, evicted snapshot grants fail closed, and
   the latest captured target resolves.
2. Two overlapping same-grant clicks: browser side-effect counter
   is **exactly one**, with one success and one version conflict.
3. Cancellation *during* click: one browser side effect observed,
   `cancelled/USER_CANCELLED` returned with non-null `actionId`;
   no subsequent action may use the aborted caller signal.
4. Twenty-four overlapping snapshots across three owned frames:
   stale grants fail, latest grants bind correctly, and a subsequent
   iframe document replacement invalidates its previous grant.
5. An overlapping click queued behind an in-flight interrupted
   click with the same caller signal never dispatches the second
   browser mutation. The in-flight action retains a non-null
   action ID while the unstarted queued action's ID is null.
6. An **already observed but hidden** element may be awaited using
   its exact original `snapshotId/nodeId` and pinned handle until
   it becomes visible. A normal click while hidden remains blocked,
   and `wait_for` refuses an **unobserved** guessed test ID.

**6/6 Chromium T37 safety tests passed** after correction.
This verifies functional bounds and fail-closed behavior, **not**
heap-memory profiling or an hours-long soak test. A future
long-run check is still warranted.

### Additional compatibility regression found and fixed

As a final check, the original complete T03 Browser test suite was
rerun. It initially passed **16/17**, with one legitimate
`wait_for element_visible` case failing: the delayed element
**already existed** in the snapshot but was initially hidden. T36
had removed the insecure fallback that guessed an unobserved test
ID, yet the resolver also denied legitimate waiting on an already
observed hidden node. T37 adds a narrowly scoped
`allowHiddenForWait` option used **only** by `wait_for`:
the exact snapshot and original ElementHandle must still match,
so it cannot auto-rebind after a remount. `click` continues to
reject hidden elements, and a nonexistent test ID is never accepted.
The T03 legacy Chromium suite then passed **17/17**, including
the original SSE/delayed-rendering test, and the separate T37
security test above passed. Neither a guessed click nor the
removed unsafe wait fallback was restored.

## G2 regression and real model G3

- `pnpm test:t36-wire`: **4/4** actual fresh PostgreSQL18 +
  Chromium G2 controls for iframe reload and Shadow DOM remount,
  including independently reproduced wrong values.
- Prior T36 frozen business criteria and tests are unchanged.
- `pnpm test:t37-audit`: **2/2**, and legacy
  `pnpm test:t36-audit`: **2/2**; audit logic is parameterized to
  keep campaign-specific data isolated, not pooled.
- Legacy T03 full Browser execution integration: **17/17**, after
  the safe existing-hidden-element wait correction.

The separate T37 append-only real-provider source is:
`docs/validation-results/T37-g3-moan2-business.ndjson`.
All samples used previously authorized `moan2 / MiniMax-M3`,
actual PostgreSQL 18/Chromium, the same frozen `click -> click`
approval, exact user-specified business values and independently
reproduced seeded faults.

| Underlying business / DOM | Healthy | Seeded fault |
| --- | --- | --- |
| Support-priority / reloaded owned iframe | **TN** | **TP** |
| Room-upgrade / remounted nested open Shadow Root | **TN** | **TP** |

**T37 real G3: 4/4 completed; healthy 2/2, fault 2/2.**
The independently reconstructed audit confirmed **23 observed and
settled provider requests** and **58,791 input / 1,965 output
tokens** reported by the provider. Missing/unsettled usage must
never be treated as zero. These counts are not a currency charge.

**Important limitations:** This G3 subset repeats the *same two
underlying business rules* from T36 to verify nonregression. It does
not validate concurrent real model invocations; those specific
race and abort behaviors are covered by deterministic real-Chromium
tests instead. Nor does this small sample prove reliability over
extended operating periods. The final backward-compatible
`wait_for` correction was implemented after the four G3 samples;
the full T03 and new T37 Chromium tests, not extra paid model
requests, verify that narrowly scoped non-mutation behavior.

## Release conclusion

No external product business bug was confirmed in T37. Its two
reproduced browser framework bugs are fixed and guarded by
red-to-green Chromium tests. The full G3 distinct-flow/repeat and
healthy/fault coverage quotas remain unmet; formal G3 and P0
human/security sign-off are **NOT APPROVED**.

## Reproduction

```powershell
pnpm test:t37-browser
pnpm test:t34-dom
pnpm test:t27-actions
pnpm test:t36-wire
pnpm test:t37-audit
pnpm report:t37
pnpm test:t37-moan2
```

Only `test:t37-moan2` makes real paid provider requests and appends
new G3 rows. All G2 and unit runs are local deterministic controls.
