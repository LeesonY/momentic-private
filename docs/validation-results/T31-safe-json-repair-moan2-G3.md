# T31 · Bounded strict JSON repair, privacy-safe format diagnostics, moan2 G3

Date: 2026-10-09, Windows workspace `E:\\AI\\momentic`.
Previously authorized model: **moan2 / MiniMax-M3** using Anthropic
Messages compatibility; real PostgreSQL 18 + Chromium + Worker + a
different isolated localhost test fixture and disposable DB per sample.
No credentials, provider raw outputs or business data were exported.
No commit, push, deployment or billing modification.

## Findings from real T30/T31

T30 had **four invalid JSON failures**, two model timeouts and one
criterion failure in twelve real samples. Strictly parsing a single
Markdown JSON fence alone did not fix MiniMax-M3 quality.

T31 added a *test-gated* privacy-safe shape diagnostic for malformed
model responses, without logging the response text, DOM details,
prompts, snippets or provider credential. The T31 initial inventory
fault returned a `MODEL_INVALID_JSON` verdict despite the gateway's
one paid repair request. Both original and repaired outputs began with
an object-opening `{` but neither parsed as valid JSON.
This ruled out a pure Markdown-fence explanation for **that sample**.
The trace does **not** establish whether either particular output was
truncated, had invalid grammar or contained non-JSON trailing text.

Subsequent local logic safely subdivides the **syntax** classification
into an unclosed JSON object/string vs a structurally closed object
which nevertheless fails JSON.parse. It does not reconstruct any model
text or infer intended tool arguments. These are safe enum categories
only, exposed on failed `CallRecord` results, and can be observed by
the T31 test runner. No provider response body is included in T31
append-only metrics.

## Production changes

The previous generic format-repair prompt told the provider only to
return an object matching `outputSchema`. It did not differentiate
an invalid JSON string from a well-formed object with wrong fields.

In `packages/model-gateway/src/gateway.ts`, T31 now uses the
**existing single authorized repair attempt** and chooses an explicit,
bounded instruction:

- `invalid_json`: start a **new, complete** object, not a continuation
  of the malformed output; use exact JSON double-quote and closing
  delimiter grammar, without trailing commas or surrounding markup
- `schema_mismatch`: preserve all approved required fields and types,
  without modifying the frozen schema or oracle
- For a decision object, restate `done` and `toolCalls` structure;
  tool names/arguments remain restricted to the previously approved
  schemas and current observed DOM. No new tool entitlement
- Other outputs retain the existing frozen `outputSchema`; no
  arbitrary model text is executed or parsed for hidden commands

No additional model repair attempts, retries after an unknown provider
timeout, output token limits, billing overrides, policy waivers or
fallback models were added. Invalid final output remains a blocking
`MODEL_INVALID_JSON` / `MODEL_SCHEMA_MISMATCH` /
`MODEL_TOOL_CONTRACT_INVALID`.

During full-regression testing, the new repair message accidentally
included the legacy `格式修复` marker twice. The existing deterministic
stub treated that as a second repair request and correctly failed.
T31 fixed the marker duplication, then reran the **entire** legacy
gateway and Worker suites successfully. This is preserved as a real
regression found and resolved in this phase, not suppressed.

## Actual real G3 evidence

The immutable original individual rows are recorded in
`T31-g3-moan2-business.ndjson`, and the model-specific aggregation
in `T31-g3-moan2-summary.json`. The first five executions precede the
more specific one-time repair instruction; the next eight follow it.

| Version of repair instruction | Healthy fully correct | Faults independently confirmed | Execution failures |
| --- | ---: | ---: | ---: |
| Pre-change, five samples (two business rules) | 2/2 | 2/3 | 1 |
| Post-change, eight samples (four business rules) | **4/4** | **3/4** | 1 |
| **T31 total** | **6/6** | **5/7** | **2/13** |

One original failure was `MODEL_INVALID_JSON`; one later failure
was `MODEL_TIMEOUT` (independent meeting-room fault reproduction).
**No invalid JSON failure occurred among the eight post-change
samples**, although the limited sample count and non-randomized case
selection do **not** establish a statistically reliable improvement
or justify automatic timeout retries.

Among the **eleven fully accepted** T31 real-model samples, there were
**39 actual provider calls** with **89,019 reported input tokens and
3,367 reported output tokens**. These numbers explicitly **exclude
some possibly billable work done in the two failed samples**; they are
not a full vendor invoice or spending estimate.

Every confirmed fault maintained the result element, verified a frozen
exact business value, and was independently reproduced using a distinct
browser context with disjoint evidence. No partial execution was
recorded as a business pass, false finding or confirmed product bug.

## Deterministic validation and safety

- Model gateway `pnpm test:t30-diagnostics`: **13/13**; strict JSON
  syntax, stage-specific one-time repair, canonical Schema and ToolCall
  checks, truncated/timeout fail-closed, no arbitrary prose extraction
- Existing model gateway `pnpm --filter @localqa/model-gateway test`:
  **31/31** after fixing duplicate repair marker
- Worker policy/approval `pnpm test:t29-causes`: **24/24**
- Six relevant package build targets (contracts, model-gateway,
  orchestrator, worker, API, web) passed
- Existing G2 browser and authentication regressions are separate,
  **never added** to the live G3 numerator

Regressions must not drop historical failures, pool DeepSeek and
MiniMax-M3 model quality into one unlabeled pass rate, or claim that
T31's 8-post-change samples satisfy the required G3 100+30 quotas.
**Formal G3 and P0 remain NOT APPROVED.**

## Repeat commands

```powershell
pnpm test:t30-diagnostics
pnpm test:t29-causes
pnpm test:t31-moan2
```

The last command makes real provider calls and **appends more ledger
samples**; it is not a free local unit test. The remaining technical
risk is the upstream MiniMax-M3 timeout and long-term JSON format
adherence across more diverse real websites and quotas.
