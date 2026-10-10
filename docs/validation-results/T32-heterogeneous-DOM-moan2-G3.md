# T32 · Heterogeneous DOM layouts, repeated real MiniMax-M3 G3 and acceptance-gate fixes

Date: 2026-10-09. Local Windows workspace: `E:\\AI\\momentic`.
Real upstream: previously authorized `moan2 / MiniMax-M3`.
All model-backed samples use disposable PostgreSQL 18, a real
Playwright Chromium browser, Worker, local-only business fixture, frozen
`text_equals` oracle and independent fresh-context reproduction of
seeded faults. No third-party website was changed. The existing dirty
worktree was preserved. No commit/push/deploy, billing or credentials edit.

## New structural coverage

The project contains **eight** deterministic independent business rules.
T26–T31 had repeated the same simple HTML form construction despite
varied business calculations. T32 retains the original first four
fixtures for historical comparability, and adds four **different DOM
families** to the remaining business rules, without changing their
expected business values or authorized two-button sequence:

| Business rule | Actual new DOM construction |
| --- | --- |
| Enterprise VAT invoice | Nested fieldset and separated sidebar |
| Incident priority routing | Navigation list and grouped article/actions |
| Hotel room upgrade | Accessible data table with nested input/button |
| Shopping cart subtotal | Product list with independent summary aside |

`pnpm test:t26-oracles` passed: **8 rule calculations,
16 healthy/faulty page variants**, actual Chromium clicks and exact
business result comparison. The faulty UI still exposes the same
result test-id; presence alone cannot satisfy the frozen oracle.
These are structurally distinct *scripted local pages*, not arbitrary
production websites or a comprehensive iframe/shadow-DOM benchmark.

## Real model experiment

The append-only `T32-g3-moan2-business.ndjson` contains **18** actual
MiniMax-M3 end-to-end attempts: two full passes across the four
new-page rules (8 each), plus two room-upgrade healthy repetitions
after the test-gate correction. All three incomplete outcomes remain.

| Workflow | Correct healthy / total | Confirmed seeded faults / total |
| --- | ---: | ---: |
| Invoice VAT | 2/2 | 2/2 |
| Support priority | 2/2 | 1/2 |
| Room upgrade | 3/4 | 1/2 |
| Cart subtotal | 2/2 | 2/2 |
| **Total** | **9/10** | **6/8** |

Overall **15/18 complete**, **2 execution failures**, **1 inconclusive**:

1. Initial room-upgrade healthy case had one frozen `passed` verdict,
   five settled model provider requests, and ten browser actions.
   The *old test runner* assumed a maximum of four provider requests
   and exactly nine browser actions. Those gates were not correct
   under the approved four-decision plus single-format-repair protocol.
   The original **inconclusive** ledger row was **not** relabeled,
   because its disposable session's complete action-kind histogram
   was not captured before cleanup.
2. Support priority seeded fault had `CRITERION_NOT_PASSED` and no
   completed, independently confirmed finding. Recorded as
   `execution_failure`, **not** as a verified business Bug or clean
   negative verdict.
3. Room upgrade seeded fault had `MODEL_INVALID_JSON` after bounded
   format repair. Recorded as `execution_failure`, not an accepted
   false-negative decision.

In this small 18-attempt T32 batch there were **zero MODEL_TIMEOUT**
reasons. This does not invalidate T31's observed upstream timeout or
establish that model latency is reliable.

## Test acceptance defect and exact fix

The original batch runner only allowed `providerCalls<=count*2`
(healthy at most four, seeded fault at most eight) and required an
exact action count of 9/18. Those expectations accidentally conflated
**model decisions** with **provider requests including schema repair**
and refused the already-approved extra read-only `observe`.

T32 now validates:

- **At most four model decisions per approved `ai_action`**, each
  involving at most one additional paid format repair: healthy
  provider requests **2..8**, independently reproduced seeded fault
  **4..16**. Provider-request, database model-request and settled
  counts must all match exactly.
- Actual G2 Chrome baseline: per independent case
  `capture=1, click=2, navigate=1, observe=4, type_text=1` (nine
  total). For each attempt, only **zero to two extra read-only
  `observe` actions** are permitted, with all four other action-kind
  counts unchanged and a complete DB action histogram required.
  Any extra click, input, navigation, screenshot capture, missing
  action log, non-integer count or excess decision rejects the gate.
- This is *not* permission for Worker to invent a target or exceed
  the frozen user-approved tools. All G3 source/version, exact-value
  verdict, model-identity, fresh-context, disjoint-evidence and
  confirmed-finding gates are unchanged.

The first two full T32 batches did **not** record a complete
action-kind histogram; their historical outcomes remain immutable.
Two later **real MiniMax-M3 room-upgrade healthy repetitions both
passed** under the corrected strict histogram gate. Both recorded
the exact nine approved baseline actions; they used two and three
settled provider requests, respectively. No unauthorized mutation
or blanket relaxation was introduced.

## Independent denominator and provider use

`pnpm report:t32` reads the original 18-row NDJSON and regenerates
`T32-g3-independent-audit.json` without model calls or altering rows:

- Four distinct new page structures, **18 samples / 15 passed**
- **10 healthy / 9 correct**; **8 seeded faults / 6 confirmed**
- **2 execution failures** and **1 inconclusive**, no false G3 signoff
- All **18 rows** report observed model requests and settlements:
  **69 provider requests observed, 69 settlement records observed**
- Only **16 rows** retain complete vendor-reported token aggregates:
  **146,890 input tokens and 5,137 output tokens**. Missing token
  aggregates on the two failed attempts must **not** be replaced by
  zero. Observed settled requests do not prove an exact vendor invoice;
  commercial cost remains unknown/null.

These provider request totals are **not** the same as the summary's
`providerCalls=61`, which comes from only rows with a complete
fixture summary and excludes 8 requests recorded by the failed
samples. T32 explicitly exposes the larger safe observational lower
bound to avoid misleading usage/cost reporting.

## Verification completed

- `pnpm test:t26-oracles`: **1/1 Playwright suite** validating 16
  real Chromium page variants with all exact outputs
- `pnpm test:t32-bounds`: **5/5 deterministic approval and request
  settlement/allowed action histogram tests**
- `pnpm test:t18-wire`: **2/2** real PG18/Chromium G2 transport tests,
  normal and independently reproduced wrong-value
- `node scripts/t26-wire-flow.mjs cart-quantity faulty`: **1/1**
  synthetic-provider, real-browser independent wrong subtotal
- `pnpm test:auth-pure`: **48/48** security/privacy tests
- `pnpm contracts:check`: generator/schema consistency passed

Synthetic-provider G2 results must never be counted as live-model G3.
Original MiniMax and DeepSeek records remain separately attributed.
The full G3 quota (100 healthy and 30 fault checks with independent
human review) and all P0 release gates remain **NOT APPROVED**.

## Repeat commands

```powershell
pnpm test:t26-oracles
pnpm test:t32-bounds
pnpm report:t32
pnpm test:t32-layout-moan2
pnpm test:t32-repeat-moan2
```

The final two commands send **additional real upstream model calls**
and append historical rows. Do not use them as free, deterministic
unit tests or as a release-certification shortcut.
