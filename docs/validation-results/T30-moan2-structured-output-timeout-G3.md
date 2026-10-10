# T30 · moan2 MiniMax-M3 structured-output and timeout boundaries

Date: 2026-10-09. Windows workspace: `E:\\AI\\momentic`. This is a
real-model G3 engineering pilot, **not** a passing G3 release gate.
Original dirty/untracked worktree preserved; no commit/push/deployment or
provider credential/billing modification.

## Root-cause analysis and actual changes

T29 identified two distinct upstream causes concealed by earlier generic
`MODEL_FAILURE`: invalid structured model output after the gateway's
single repair attempt and a provider request timeout. T30 reproduced
these causes in disposable real PG18/Chromium/Worker samples.

### 1. Anthropic-compatible `max_tokens` was misclassified

Before T30, the Anthropic Messages adapter returned the same
`VALIDATION_ERROR` for `stop_reason=max_tokens`, malformed envelopes and
unapproved `tool_use` content. It also discarded provider-reported token
usage even when the provider returned a completed, billable HTTP 200
response. This was a production observability/accounting defect.

The adapter now maps a completed `max_tokens` reply to the explicit
`MODEL_OUTPUT_TRUNCATED` reason, preserves the reported model ID and
input/output token usage, **does not retain or run partial output**, and
does **not** automatically retry the paid request. Malformed envelopes
still fail closed, and any valid usage already received is retained.
Gateway/Worker and the documented internal error registry support the
new cause. A timeout remains `MODEL_TIMEOUT` with unknown settlement;
there is no automatic retry.

### 2. Failure-stage classification after the single format repair

The gateway now emits a controlled, allowlisted failure stage after
canonical output validation:

| Frozen reason | Meaning |
| --- | --- |
| `MODEL_INVALID_JSON` | No valid JSON document after at most one repair |
| `MODEL_SCHEMA_MISMATCH` | A valid JSON document does not match the approved JSON Schema |
| `MODEL_TOOL_CONTRACT_INVALID` | JSON/Schema passes, but the canonical ToolCall contract fails |
| `MODEL_OUTPUT_TRUNCATED` | The upstream Messages response exhausted its output-token limit |
| `MODEL_TIMEOUT` | The upstream request was aborted at the finite time limit |

Only these classification names reach the Worker failure reason, not
provider bodies, malformed JSON fragments or sensitive page content.
The frozen technical oracle and authorized browser-action limits remain
unchanged.

### 3. Strict single JSON code-fence compatibility

A response consisting **entirely of one** ```json fenced document may be
parsed locally. It still must pass the exact existing AJV Schema and
canonical ToolCall validation. A response with prose, other action
instructions, multiple code blocks, invalid JSON or unapproved
permissions is rejected; the system never scans arbitrary prose for
an executable JSON substring.

This saves a repair round-trip for that **specific** format only. It does
not authorize new tools or automatically retry timeouts/charges.

## Deterministic evidence

- `pnpm test:t30-diagnostics`: **11/11**; correct max-token cause and
  reported usage, bad JSON/schema/tool-call subtypes, successful one-time
  repair, strict fenced JSON compatibility, rejection of prose and
  multiple fences, and one finite timeout with exactly one provider
  request and no hidden retry.
- `pnpm --filter @localqa/model-gateway test`: **31/31** previous
  gateway security and transport regressions.
- `pnpm test:t29-causes`: **24/24** Worker action, policy, model cause
  and no-mutation-on-error tests.
- Model-gateway and Worker TypeScript builds passed.
- Real browser G2 and private authentication tests are kept separate
  from G3 model quality evidence.

## Real moan2/MiniMax-M3 G3 outcome (historical ledger preserved)

An initial eight-sample baseline executed **before** enabling the fenced
JSON parser. Four more independent samples ran **after** the parser
change, all appended to `T30-g3-moan2-business.ndjson`. The data must
not be silently filtered to successful outcomes.

| Phase | Healthy complete | Seeded fault independently confirmed | Failed execution |
| --- | ---: | ---: | ---: |
| Baseline, 8 samples | 2/4 | 1/4 | 5 |
| After strict parser, 4 samples | 0/2 | 2/2 | 2 |
| **Total, 12 samples** | **2/6** | **3/6** | **7** |

The seven failures comprise **four `MODEL_INVALID_JSON`**, **two
`MODEL_TIMEOUT`**, and **one `CRITERION_NOT_PASSED`**. No invalid
model response was treated as an authorized browser action or false
confirmed Finding. Model responses may have incurred provider usage
even in failed samples. The summary lists **20 model decision requests,
44,905 reported input and 1,709 reported output tokens across the five
fully accepted samples only**; this is **not the full batch billing
total**.

Important limitation: the strict fence parser passed local test fixtures,
but the two healthy post-change model runs still failed, including one
`MODEL_INVALID_JSON`. There is **no evidence** that this narrow
compatibility fix improves MiniMax-M3's overall success rate. A
`MODEL_INVALID_JSON` reason alone does not establish exactly what text
the provider returned, and raw provider replies have deliberately
not been exported. The SDK cannot currently disambiguate all vendor
semantic causes without more privacy-safe upstream metadata.

## Reproduction

```powershell
pnpm test:t30-diagnostics
pnpm test:t29-causes
pnpm test:t30-moan2
node scripts/t26-g3-diverse-matrix.mjs 0 2 1 both moan2 MiniMax-M3 T30
```

The latter two scripts make **real paid provider calls** against the
previously configured moan2 provider. Repeating them will append more
rows to the audit ledger. Test data are isolated local fixtures. Formal
G3 distinct-flow/repeat quotas and P0 release gates remain **NOT
APPROVED**.
