# T38 · Long-session resource caps, cross-session isolation and durable action audit

Date: 2026-10-09. Windows workspace `E:\\AI\\momentic`.
All existing dirty/untracked code and T17–T37 ledger rows were retained,
without a commit, push, deployment, reset, cleanup or credential edit.
Tests used disposable browser contexts and, for G2/G3, PostgreSQL 18.

## Reproduced memory/resource concerns and corrections

The T37 snapshot witness cap already limited each page to 12 registered
DOM-witness sets. T38 exercised **120 sequential fresh snapshots**,
explicitly checked eviction of the first grant, and confirmed that the
latest grant remained usable. The test covers **functional resource
bounds**, not a multi-hour heap profile or all possible browser leaks.

`SessionRecorder` also maintained a **never-drained, unused network
request Map**, and its `pageerror` event bypassed the existing 500-entry
console buffer cap. T38 removed the unused request retention and
bounded sanitized `pageerror` entries identically to console events.
The real Playwright Page test emitted **700 page errors** and verified
the resulting recorder buffer remained at or below its configured
limit, with degradation indicated. This addresses confirmed LocalQA
framework resource defects rather than any business application bug.

## Multi-session concurrency, privacy and approval

Three actual isolated Chromium sessions were run concurrently with
identical `data-testid` buttons. Cross-session use of an
approval-bearing snapshot was rejected. Each correct session
performed exactly **one** independent click; the three page-side
mutation counters were **[1, 1, 1]**.

Each session's audit output had a separate path and distinct
identifiers. No authorized target or context was shared. The T37
session-scoped action queue, same-origin restrictions and frozen
human-approved tool bounds remain enforced.

## New durable, redacted write-intent and settlement journal

For a BrowserSession with **an explicitly configured `artifactsDir`**,
`SessionRecorder` now durably appends:

1. A random per-attempt **intent** before dispatch of a potentially
   mutating browser operation: `navigate`, `click`, `type_text`,
   `select_option`, `press`, or `scroll`.
2. A matching **settlement** after the browser executor returns a
   validated status, reason code and optional action ID.

Each line is JSON serialized, append-only under that session's
artifact directory, written and **fsync-ed** synchronously.
Records contain only a schema number, attempt ID, project/run/task
IDs, tool name, phase, allowlisted status/reason, action ID, and UTC
timestamp. **No selectors, text input, passwords, cookies, URLs,
DOM contents, model messages, raw provider responses or screenshots**
enter this journal.

If an intent cannot be durably written, the action is **not dispatched**.
If the action happened but the settlement cannot be persisted, the
caller sees a storage failure and the recovered journal contains an
unmatched intent, classified **`outcome_unknown`**. It is never
automatically retried. Cancellation during an already-dispatched
click records `cancelled` with a non-null action ID and
`requiresReview=true`; a persisted cancellation is **not proof of
rollback**.

The new read-only `inspectActionAudit` utility rejects corrupt
rows, duplicate attempts, fabricated settlements, mixed
project/run/task scope and oversized files. Its recovery results
explicitly flag incomplete or potentially side-effectful attempts
as needing manual reconciliation. It does **not** call Chromium or
replay mutations.

The writer also enforces the approved mutation-tool vocabulary
and rejects malformed operation metadata. Untrusted reason text
that is not an uppercase machine code is replaced by
`UNRECOGNIZED_REASON`, so raw exception content never enters
the durable journal.

**Scope limitation:** When `artifactsDir` is absent, the browser
session has no on-disk action journal; this is not claimed as a
globally durable audit for every possible caller. The journal
is a local fsync-backed file, **not** a cryptographically signed,
remote replicated transaction log, and process/storage
failures after a browser side effect cannot be fully undone.
Verification of an external product's ultimate state remains
necessary. This is not an exactly-once guarantee across crashes.

## Real Chromium T38 tests

`packages/browser/test/t38-session-stress-journal-chromium.test.mjs`
has five checks, all **passed**:

- 120 sequential snapshots plus 700 page errors: bounded
  recorder logs and fail-closed evicted approval.
- Three concurrent real Chromium contexts: distinct grants,
  state, clicks and scrubbed durable journal files.
- Actual click then abort: `cancelled` receipt with evidence of one
  browser effect, persisted matching journal entry; simulated
  process death after fsynced intent is recovered as unknown.
- Forced durable-intent write failure: **zero browser mutations**;
  forced settlement write failure after a real click:
  **one mutation**, missing settlement, `requiresReview=true`.
- Malformed tool metadata is rejected and injected secret-shaped
  error text is scrubbed before append.

The first test iteration mistakenly used an incorrect test-ID
delimiter and produced `TARGET_NOT_FOUND`. It was a fixture
mistake, not a product bug. After fixing the test target, all
five passed.

## G2 and actual real-model G3

G2 preserved the original user-specified exact-value oracle, two
approved model-selected clicks, and independent browser context
reproduction for injected wrong values.

| Underlying test-only business | G2 normal | G2 seeded fault | Real G3 normal | Real G3 fault |
| --- | --- | --- | --- | --- |
| Support-priority / reloaded same-origin iframe | passed | confirmed | **TN** | **TP** |
| Room-upgrade / remounted nested open Shadow Root | passed | confirmed | **TN** | **TP** |

- **G2: 4/4** deterministic-provider *real PostgreSQL 18 +
  Chromium* cases; never included in real-model accuracy.
- **G3: 4/4** actually completed, 2 healthy and 2 confirmed seeded
  faults with independently reproduced evidence, using previously
  authorized `moan2 / MiniMax-M3`.
- Independent T38 evidence:
  `T38-g3-moan2-business.ndjson` and
  `T38-g3-independent-audit.json`.
- **18 observed settled provider calls**, 45,180 input tokens and
  1,555 output tokens, as reported by the model. These are
  observations, **not** a monetary charge or full provider invoice.
- There are **only two underlying business rules**. T38 stress,
  journal failure and concurrent clicks were tested with
  deterministic real Chromium, not paid-model concurrent G3. A
  4/4 pilot does not establish release-grade reliability.

## Safety and release

T38 adds no action permissions or origins, does not auto-retry
provider failures or uncertain mutations, does not reclassify
historical failed rows, and does not infer missing billing as zero.
The release gates have **NOT** passed: the complete independent
flow/repetition G3 sample quota and formal P0 human/security review
remain outstanding.

## Run locally

```powershell
pnpm test:t38-browser
pnpm test:t37-browser
node --test packages/browser/test/browser.test.mjs
pnpm test:t36-wire
pnpm test:t38-audit
pnpm report:t38
pnpm test:t38-moan2
```

The **last** command makes real paid-model requests and appends
new T38 G3 rows. Other listed commands remain local or G2
synthetic-model validations.
