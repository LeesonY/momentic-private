# T35 · Bounded async iframe guidance, frame-aware replay, and real MiniMax-M3

Date: 2026-10-09. Windows LocalQA workspace: `E:\\AI\\momentic`.
All existing worktree changes and earlier real-model sample ledgers were
preserved. No commit, push, deployment, API key or billing-setting edits.

## Scope and motivating evidence

T34 introduced owned same-origin iframe and nested open Shadow DOM support.
It passed four real PostgreSQL 18/Chromium G2 end-to-end controls but only
**2/6** initial real moan2 / MiniMax-M3 G3 samples. Its iframe healthy
sample timed out upstream; the iframe fault sample ended without enough
required evidence. Two initial nested-shadow samples proposed repeated
clicks and failed closed. Bounded nonmutating recovery later enabled two
successful shadow replays. **T34's four failures remain unchanged.**

T35 reproduced a **healthy same-origin iframe baseline before modifying
the model guidance**: `TN`, 3 settled provider requests, frozen
two-click order and exact output. This proves T34's iframe failures
were intermittent in these samples; it does not establish that timeout
or unreliable target selection had vanished.

## Verified interaction mismatch and changes

The earlier Worker asked the model to return **one tool call for the next
control** even when a dynamically created second button did not yet
exist in the observed DOM. This conflicted with T28's legitimate,
bounded empty-action/reobservation mechanism and made an invented
target or repeated first click more likely. The model also received no
concise frozen-next-click candidate list, though the approved current
redacted snapshot already contained these nodes.

T35 updates `apps/worker/src/regression-ai.ts` without modifying the
business fixture's exact results or the human-approved actions:

1. Next-step click hints are derived **only from the current
   `BrowserSnapshot.nodes`**, and include the node's frame ID, node ID
   and existing **redacted** accessible name. At most 12 candidates
   are provided, with an explicit truncation flag. Hidden, disabled
   and previously executed targets are excluded.
2. Instructions now explicitly permit **`done=false` with
   `toolCalls=[]`** if the next approved button is absent, including
   a still-loading iframe. The Worker re-observes only within the
   original at-most-four model decision rounds; no inferred click,
   additional permission, automatic paid transport retry or budget
   extension is introduced.
3. The anti-repeat key now includes `frameId`; two legitimately
   different buttons with the same accessible name in **different
   owned frames** can be individually approved. Same-frame repeated
   proposals are still rejected before dispatch.
4. Every proposed tool call still requires the exact current
   `snapshotId`, `pageId`, `nodeId` and `frameId`, an actual unique
   live locator, and the unchanged browser origin/policy/permission
   checks. Candidate hints themselves grant **no authorization**.
5. A provider timeout remains terminal and never triggers an
   unapproved second billed model request. Cross-origin frame content
   remains opaque; closed Shadow DOM remains inaccessible.

The T35 deterministic unit suite reproduces the relevant edge cases:
an async second button initially absent and later visible in another
frame with **the same accessible name** as the first; and a case
where it never appears and the Worker must fail after exactly four
decisions with **only one executed click**.

## T35 real-model G3 evidence

All seven individual results are append-only in
`docs/validation-results/T35-g3-moan2-business.ndjson`. Each sample
used the previously authorized `moan2 / MiniMax-M3` provider,
fresh disposable PostgreSQL 18, real Playwright Chromium, frozen
`click -> click` approval and exact technical oracle. Every seeded
fault had to be independently reproduced with disjoint evidence in
another browser context before becoming a confirmed Finding.

| Timing | iframe healthy | iframe seeded fault | shadow healthy | shadow seeded fault |
| --- | --- | --- | --- | --- |
| Before guidance change | **TN** | Not executed | Not executed | Not executed |
| First after-change pair | **TN** | **TP** | Not executed | Not executed |
| Follow-up after-change breadth | **TN** | **TP** | **TN** | **TP** |

**T35 total: 7/7 completed, 4/4 healthy correctly passed and 3/3
seeded faults independently confirmed.** Within T35:

- Three sequential T35 execution batches preserve the initial
  baseline vs later runs; no prior row was reclassified.
- **37** observed, settled provider calls; **93,490 vendor-reported
  input tokens and 3,088 output tokens** for these seven accepted
  samples. This is not a monetary price or a complete provider
  account invoice.
- No T35 `MODEL_TIMEOUT`, `MODEL_INVALID_JSON` or wrong confirmed
  product bug was recorded in this small set. This does **not**
  negate T34's documented timeout, nor prove that upstream reliability
  is fixed.
- The independent read-only audit
  `T35-g3-independent-audit.json` validates provider/model isolation,
  unique row IDs, classifications, exact denominators, and reported
  request/settlement evidence. It cannot turn missing external
  billing evidence into a zero cost.

These are **two underlying business flows**, with repetitions and
different DOM structures; there are not seven independently designed
business scenarios. This observational before/after pilot is too small
and uncontrolled to establish causal improvement or a statistically
reliable production success rate.

## Deterministic regression and security boundaries

- `pnpm test:t27-actions`: **28/28** bounded AI action tests,
  including two new T35 missing-control/frame-specific safety cases.
- `pnpm test:t35-audit`: **2/2** read-only G3 ledger integrity and
  failed-request accounting tests.
- `pnpm test:t34-wire`: **4/4** real PostgreSQL18/Chromium G2
  synthetic-provider healthy/faulty iframe and Shadow DOM tests. G2 is
  **not** included in the real-model G3 result.
- T34 origin-isolation, closed-root opacity, stale snapshot and DOM
  truncation behavior remain enforced.
- No user-visible website navigation outside the disposable,
  approved loopback fixtures; no credential, raw provider reply,
  raw prompt or screenshot content exported to metrics.

Formal G3 requires the project-defined distinct-flow repeated healthy
and seeded fault quota and wider iframe/shadow/auth/permission coverage.
**Neither formal G3 nor overall P0 is approved.**

## Safe reproduction

```powershell
pnpm test:t27-actions
pnpm test:t35-audit
pnpm report:t35
pnpm test:t34-wire
pnpm test:t35-moan2
```

`test:t35-moan2` sends **paid upstream MiniMax-M3 requests** and appends
new rows. The local unit/G2 tests do not. Do not rerun real-provider
commands merely to inflate the success numerator.
