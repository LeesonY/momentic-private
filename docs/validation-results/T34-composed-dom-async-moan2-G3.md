# T34 · iframe, open Shadow DOM, async controls and safe bounded recovery

Date: 2026-10-09. LocalQA `E:\\AI\\momentic`, branch main.
All existing dirty/untracked files, T17–T33 source and failure ledgers
were preserved. No commit, push, deployment, credential or billing edit.

## Verified BrowserManager defects and remediations

1. **Open Shadow DOM observation gap**. The browser snapshot extractor
   previously only scanned `document.querySelectorAll()`, excluding
   controls nested inside open Shadow Roots. T34 recursively enumerates
   *open* roots with shared finite traversal/node limits. Closed Shadow
   Roots remain opaque. Node content retains the same redaction, visibility,
   name and JSON schema validation as ordinary DOM.
2. **Iframe target binding ambiguity**. The resolver allowed target
   `frameId` to be omitted, potentially resolving an iframe node ID
   against the wrong frame. Now it requires the node to match the exact
   `frameId` (default only for `main`) and resolves the exact owned
   frame ID. Same test ID in main and child frames cannot authorize a
   cross-frame click; stale `snapshotId` is denied.
3. **Cross-origin frame disclosure boundary**. Although Playwright
   may evaluate cross-origin frames, a normal page cannot. BrowserManager
   now records only an opaque disabled frame placeholder for any cross-origin
   frame, never its controls or text. The resolver checks the live frame
   and denies even a *forged* cross-origin snapshot target. Owned same-origin
   frames and direct inherited `about:blank`/`about:srcdoc` descendants
   remain supported. Arbitrary cross-origin automation requires separate
   future authorization work; T34 does not add it.
4. **Silent complex-page truncation**. Recursive scanning uses a finite
   work/node cap. Exhausting it now explicitly sets
   `BrowserSnapshot.truncated=true` instead of claiming that the limited
   snapshot contains all controls.
5. **Repeated first-click proposals before async second control**.
   In a frozen `requiredToolSequence=['click','click']`, an already
   completed first click proposed again is rejected *before dispatch*.
   The model can re-observe and choose the second click only while
   the original four decision rounds remain. Exhaustion is a
   `AI_REPEATED_ACTION` failure with no second mutation. This never
   retries a provider timeout or increases any paid-call budget.

## Distinct new real Chromium fixtures

- Support-priority: main-page text input and first button, dynamically
  inserted second approval button inside a same-origin child iframe.
- Room-upgrade: main-page text input and first button, dynamically
  inserted second approval button inside a **nested open Shadow Root**.
- Both use an actual asynchronous timer, not an immediately present
  second button. Both retain the original exact-value frozen oracle.
  Wrong-value variants still render the normal `complete-marker`; an
  element-exists assertion cannot masquerade as a detected defect.
- No production website was visited; all actions stayed inside local
  disposable fixtures with approved origin and two frozen clicks.

## Deterministic and G2 real-browser evidence

| Verification | Actual result |
| --- | --- |
| T34 actual Chromium iframe, nested open/closed shadow, async freshness, cross-origin forbidden, truncation | **5/5** |
| Original 8-rule/16-variant + T33 dialog + T34 iframe/shadow browser oracle suites | **3/3 suites** |
| T34 G2 actual PostgreSQL 18/Chromium healthy and seeded faults for both new pages | **4/4** |
| T27–T34 approved Worker decision and no-repeat safety tests | **26/26** |
| Original regression locator / cached Chromium safety checks | **4/4** |
| Authentication and private-state security | **48/48** |
| Browser/Worker TypeScript builds | **Passed** |

G2 uses a deterministic *synthetic* model decision protocol but all
database, Worker, browser intents and page interactions are real.
The G2 runner initially incorrectly expected the second control
to appear immediately and failed on the asynchronous iframe case.
T34 fixed **only this simulated decision assumption**: when the
second element is absent, the stub returns zero proposed tools and
allows the guarded Worker to re-observe; it never invents a target.
All four new G2 runs then passed, with 10/20 browser actions per
healthy/fault case (the only extra action kind was `observe`).
Do **not** count G2 as real-model G3.

## Actual G3 moan2 / MiniMax-M3 evidence

Historical append-only source:
`T34-g3-moan2-business.ndjson`, independent aggregation
`T34-g3-moan2-summary.json`.

| Execution phase | Healthy | Seeded fault | Interpretation |
| --- | --- | --- | --- |
| Initial iframe flow | failure: `MODEL_TIMEOUT` | failure: missing required evidence | Not confirmed product bugs |
| Initial nested shadow flow | failure: `AI_REPEATED_ACTION` | failure: `AI_REPEATED_ACTION` | First click repeated; correctly blocked |
| After bounded non-mutating anti-repeat recovery | **TN** room-upgrade | **TP** room-upgrade | Exact business oracle and independent reproduction completed |

**Total: 2/6 fully accepted, 4/6 execution failures.**
This is **not** a passing G3 stability demonstration. No
healthy false finding or confirmed false business bug was observed;
uncompleted samples cannot be quietly treated as correct rejections.

The successful two post-change samples used **11 fully observed and
settled MiniMax-M3 provider requests**, 26,197 vendor-reported input
tokens and 929 output tokens. Some unsuccessful samples also incurred
requests (e.g. one timed-out attempt recorded 3 provider calls with
2 settlements). Missing cost/settlement evidence is unknown, **not
zero**; no invoice or currency amount is inferred.

The T34 remote model still timed out in an iframe sample and was
unreliable selecting the dynamic second control. The code change
addresses one recoverable class of repeated proposal but does **not**
fix vendor timeouts, guarantee robust iframe G3 performance or allow
any unapproved extra clicks.

## Reproduction commands

```powershell
pnpm test:t34-dom
pnpm test:t26-oracles
pnpm test:t34-wire
pnpm test:t27-actions
pnpm test:t34-moan2
```

`test:t34-moan2` sends **real paid model requests** and appends more
independent G3 samples; it is not a free local deterministic test.
The full required G3 distinct-flow/repeated-sample acceptance and
overall P0 release sign-off remain **NOT APPROVED**.
