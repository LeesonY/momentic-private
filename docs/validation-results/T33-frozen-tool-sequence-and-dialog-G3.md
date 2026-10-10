# T33 · Frozen tool sequence, native dialog and moan2/MiniMax-M3 real regression

Date: 2026-10-09. LocalQA Windows workspace: `E:\\AI\\momentic`.
Existing dirty/untracked worktree retained without commit, push or
deployment. Real G3 calls used the previously authorized
`moan2 / MiniMax-M3` route and disposable PostgreSQL 18 + Chromium +
Worker. No raw provider output, credentials or user DOM data were
exported to the audit.

## T32 failure investigation

T32 had two `execution_failure` rows in its append-only ledger:
`support-priority/faulty` failed with `CRITERION_NOT_PASSED`; one
`room-upgrade/faulty` failed with `MODEL_INVALID_JSON` after the
gateway's existing single repair attempt. Neither may be labeled a
confirmed product Bug without complete independent evidence.

Before T33 production changes, direct fresh real
`support-priority/faulty` reproduction **passed** with
`issue_found, issue_found`, 4 approved clicks, two independent
contexts and disjoint evidence, model `MiniMax-M3`.
This means T32's criterion failure was **not reliably reproduced** in
this follow-up. Its exact historical cause is not provable from the
retained sanitized T32 row alone. Do not relabel it as resolved product
Bug or model false negative. T33 makes a targeted structural defense
against a separate latent multi-step protocol gap.

## Found protocol weakness and implementation

T27 added `minToolCalls` and T28 safe model reobservation. It could
still regard two successful *non-click* tools as meeting a minimum
in a human-approved goal that required **two clicks**. The fixed
`text_equals` oracle would normally fail, but the Worker was not
strictly enforcing the human-reviewed action *type order* at dispatch.

T33 introduces optional `ReplayStep.ai_action.requiredToolSequence`:

- The sequence is restricted to approved browser tool primitives in
  the generated domain JSON Schema, parsed into the RegressionDocument
  and included in its approved version/hash; module expansion retains
  it and the guarded replay port passes it unchanged.
- For a T33 human-approved two-stage business step, the immutable
  requirement is `["click","click"]`, alongside `minToolCalls=2`
  and `maxToolCalls=2`.
- Mismatched tool names or a batch proposing multiple future actions
  are rejected **before any browser mutation**; the model may select
  the single correct next action only from a fresh observed snapshot,
  within the original four-decision bound. No guessed clicks,
  selector substitutions, new permissions or fallback provider calls
  are introduced.
- The sequence must have the same length as the approved maximum and
  implied/effective minimum. Any conflict is rejected before a model
  decision. Exhaustion fails with the allowlisted machine error
  `AI_ACTION_SEQUENCE_MISMATCH`.
- Existing `ai_action` steps without a sequence retain their earlier
  approved behavior; no new action privileges are available.

These restrictions do **not** repair the upstream model's malformed
JSON; malformed output still fails closed, without a speculative
second paid retry. The capability controls and frozen technical oracle
remain independent of model self-reported success.

## New fifth page structure

T32 had four different DOM families but no native browser modal.
T33 adds a **test-only** support-priority variant using native
`<details open>`, an actual `<dialog>` and
`dialog.showModal()` after the first button click. The modal contains
the *dynamically created* second confirmation button. The result
appears **only after the second actual click**.

The eight historical business computation fixtures and expected/wrong
values remain unchanged. The alternate DOM is enabled only by the
explicit T33 testing mode. The Chromium test verifies that the
dialog is initially closed, that it opens after the first click, that
the completion element does not exist before the second click, and
that both healthy and wrong-value exact results remain correct.

## G3 real MiniMax-M3 samples

New append-only source:
`docs/validation-results/T33-g3-moan2-business.ndjson`.
Four completed real-model samples were executed with the new frozen
sequence, before the additional final hardening of one click per
observation:

| Flow | Healthy | Seeded wrong-value independent reproduction |
| --- | --- | --- |
| Support priority native disclosure/modal | TN (3 provider requests) | TP (6 provider requests) |
| Hotel room upgrade accessible table | TN (2 provider requests) | TP (5 provider requests) |

The initial batch yielded **4/4 fully accepted** technical outcomes,
**16** actually reported settled provider requests and reported
usage of **42,113 input / 1,346 output tokens**.

Every TP still required a wrong exact business value observed and
independently reproduced in a fresh browser context; it was not
approved merely because an HTML marker existed or the model claimed
a finding. No wrong positive or false product Bug was confirmed.

The final sequence hardening also denies a batch proposing two
future clicks against a single snapshot; a dedicated deterministic
test requires four bounded decisions with **zero browser clicks**
when the model keeps proposing that invalid batch. Follow-up G2
tests verify the identical actual Chromium DOM without paid
upstream calls. **After** the hardening, one additional independent
real `support-priority/healthy` MiniMax-M3 case passed. Thus T33's
complete append-only ledger has **5/5 accepted** outcomes (healthy
3/3, seeded fault confirmed 2/2), **19 observed settled provider
requests**, and **50,323 input / 1,603 output tokens** with reported
provenance for all five successful samples. This is **not** an
estimated cash charge. The first four cases are not falsely claimed
as evidence for the later one-click-per-snapshot hardening; the
single additional real sample and G2/security tests cover it.

## Validation and release boundary

- `pnpm test:t27-actions`: includes the prior T27–T30 protection
  suite and new T33 frozen tool order, wrong-type rejection, no
  early-done sequence bypass, no batched future actions and no
  unauthorized mutation (**24/24**)
- `node --test apps/worker/test/regression-replay.test.mjs`:
  compiler-to-guarded-port forwarding (**17/17**)
- `pnpm test:t26-oracles`: 8 original rules, 16 healthy/faulty
  Chromium variants, plus native details/dialog both variants (**2/2
  test suites**)
- `pnpm test:t33-wire`: **G2 synthetic provider** with the real
  PostgreSQL18/Chromium production replay pipeline and approved
  two-click modal workflow, both healthy and seeded wrong value
  (**2/2**)
- `pnpm contracts:check`: approved schema/generator check

G2 is kept **out of** the G3 numerator. T32 historical failures
are unchanged. The small 4/4 batch is only an engineering
pilot; the full G3 distinct-flow/repetition quotas and P0
human/security release review are **NOT APPROVED**.

## Reproduce

```powershell
pnpm test:t27-actions
node --test apps/worker/test/regression-replay.test.mjs
pnpm test:t26-oracles
pnpm test:t33-wire
pnpm test:t33-moan2
```

The last command **makes paid-model API calls** and appends new samples,
so it is not a free local unit test. No automatic background work is
scheduled.
