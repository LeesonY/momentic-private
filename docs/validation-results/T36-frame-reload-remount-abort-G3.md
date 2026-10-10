# T36 · Snapshot lifetime, iframe reload, Shadow DOM remount and interrupt safety

Date: 2026-10-09. Windows LocalQA workspace `E:\\AI\\momentic`.
Existing dirty/untracked files and T17–T35 failure ledgers retained.
No reset, clean, stash, commit, push, deployment or credential/billing edit.

## Real browser defects reproduced BEFORE the fix

T36 added Chromium regression tests that independently **failed** against
the previous browser resolver:

1. After a same-origin iframe document reload, an *old*
   `snapshotId/frameId/nodeId` could still resolve to a button in the
   new document, provided the frame name and test ID matched.
2. A button removed and re-mounted with identical visible text,
   name, role and `data-testid` could likewise be resolved using
   a pre-remount snapshot.

These are **LocalQA browser framework bugs**, not confirmed
faults in external business software. The accepted action must bind
to the actual element and document observed, not merely a reusable
selector string.

## Production fixes

- `packages/browser/src/snapshot.ts` now registers a **process-local,
  non-serialized DOM witness** per owned frame and snapshot. Its
  `MutationObserver` detects DOM replacement or attribute/text
  mutations; the Playwright JSHandle becomes invalid when its frame
  reloads. A snapshot with an absent, invalid, changed or evicted witness
  is **not** valid authorization for new actions. Witnesses never
  enter model messages, evidence, page globals, raw logs, or a database.
- Witnesses are bounded to the most recent **12 snapshots per page**;
  old observers/handles are explicitly disposed. This is a fail-closed
  resource cap, not a retry budget.
- `packages/browser/src/resolver.ts` validates the witness both before
  and **after** selecting the unique element. Its result includes a
  concrete pinned `ElementHandle`. A replacement with the same test ID
  cannot silently inherit the previously approved target.
- `packages/browser/src/executor.ts` performs approved `click`,
  `fill`, `selectOption` and target `press` through the pinned
  handle and disposes it afterward. No Playwright locator auto-rebind
  to newly mounted elements is permitted. It refuses dispatch if the
  signal has already been cancelled.
- The `wait_for element_visible` path previously had a test-ID
  fallback after resolver failure; it could wait for an *unobserved*
  replacement. This bypass is removed. An absent/stale node must be
  explicitly reobserved and selected under the unchanged human
  approval rules.

The Worker still owns the frozen `click -> click` decision sequence,
two-click maximum, original 4-decision observation budget, and
same-origin policy. Provider timeouts remain terminal without a
hidden paid retry.

### Cancellation boundary

Two new deterministic Worker tests verify that cancellation **after
the first completed click** prevents the second decision/action, and
that cancellation **while a model decision is pending** prevents any
model-proposed click. An action already in progress inside Chromium
cannot be guaranteed to have had no external side effect. Such an
ambiguous in-flight interruption should be recorded as unconfirmed,
not automatically retried or called a confirmed product bug.

## New actual business/browser lifecycle fixtures

Two additional test-only DOM variants preserve T26's frozen exact
`text_equals` criteria and injected *wrong but visible* result:

1. **support-priority**: first click replaces the iframe `srcdoc`,
   triggering a real same-origin document lifecycle transition.
   The approved second button is created asynchronously inside the
   newly loaded iframe. Both the healthy urgent support queue and the
   wrong queue have the result element, so presence-only checks fail.
2. **room-upgrade**: first click builds a temporary open Shadow DOM
   subtree; its nested component is then removed and replaced with a
   newly mounted nested open Shadow Root containing the async second
   button. The exact M2 room inventory calculation stays fixed.

The Chromium fixture test initially had one **test-only mistake**:
checking the `body`'s text after the new button intentionally replaced
that text. The test was changed to check a persistent document-stage
attribute. Another check mistakenly used Playwright's
shadow-piercing CSS to count light-DOM children; it now evaluates
`host.children.length`. Neither failure was counted as a model or
product defect.

## Deterministic and G2 acceptance

| Coverage | Completed result |
| --- | --- |
| T36 Browser Chromium origin/iframe/shadow/stale/remount/pinned-handle suite | **8/8** |
| Business Chromium eight original rules + modal + async DOM + lifecycle variants | **4/4 suites** |
| Worker safe actions (including 2 cancellation tests) | **30/30** |
| T36 real PostgreSQL 18 + Chromium G2 lifecycle healthy and seeded faults | **4/4** |
| Prior T34 real PG18/Chromium G2 iframe and shadow | **4/4** |
| Prior T18/T33 G2 backwards compatibility | **4/4** |
| T36 independent G3-audit contract cases | **2/2** |
| Model gateway regression | **31/31** |
| Authentication/privacy regression | **48/48** |
| Seven relevant TypeScript builds and frozen contract validation | **Passed** |

G2 is deterministic synthetic-provider control only; it is never
added to the live-model G3 numerator.

## Actual T36 real moan2/MiniMax-M3 G3

Each individual attempt is in the **append-only**
`T36-g3-moan2-business.ndjson`. It exercises real model decisions,
fresh PostgreSQL 18, real Chromium, the frozen two approved clicks
and technical exact-value oracle. Seeded faults need two independent
contexts, disjoint evidence and `issue_found` twice.

| Distinct underlying business rule / lifecycle DOM | Healthy | Seeded wrong value |
| --- | --- | --- |
| Support priority with iframe document reload | **TN** | **TP** |
| Room upgrade with nested Shadow DOM remount | **TN** | **TP** |

**4/4 samples accepted**: 2/2 healthy and 2/2 seeded faults independently
reproduced. There were **25 reported/settled provider calls**
and **64,403 reported input / 2,077 output tokens**. These usage
figures are not a currency charge or a full provider invoice.

The read-only `T36-g3-independent-audit.json` reconstructs the exact
denominator, accepted verdicts, provider identity and bounded request
accounting directly from the original rows, without changing them.

These are **two business rules**, not four different applications.
Four successful model samples do not prove latency/timeout reliability
or satisfy the project's 100 healthy / 30 fault G3 target and human
P0 reviews. **Formal G3 and P0 remain NOT APPROVED.**

## Reproduction

```powershell
pnpm test:t36-browser
pnpm test:t26-oracles
pnpm test:t27-actions
pnpm test:t36-wire
pnpm test:t36-audit
pnpm report:t36
pnpm test:t36-moan2
```

Only the final command is a real paid-model test and appends new G3
samples. The other commands remain local/deterministic controls.
