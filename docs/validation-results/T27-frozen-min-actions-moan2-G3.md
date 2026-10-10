# T27 · Human-approved minimum AI actions and moan2/MiniMax-M3 G3 stability

Date: 2026-10-09. Local Windows `E:\\AI\\momentic`, isolated PostgreSQL18
and Playwright Chromium, real `moan2 / MiniMax-M3` upstream. No Pi credentials
read into the repository or emitted to the report.

## Product defect and resolution

T26 exposed a strict semantic gap: the approved `ai_action.maxToolCalls=2`
only limits *maximum* actions. A real LLM can return `done=true` after the
first click. Previously the Worker accepted it and proceeded to the frozen
business criterion despite not completing the human-approved second click.
The criterion failed safely (`blocked`), but the promised multi-step action
was never executed. Better prompting alone did not solve this consistently.

T27 adds **optional, approval-frozen `minToolCalls` (1..4)** to the
`ReplayStep` contract. It is validated, hashed as part of the approved
RegressionDocument, compiled into the immutable plan and delivered to the
same guarded Worker replay port. A minimum above the maximum is rejected.

For a step with `minToolCalls=2,maxToolCalls=2`, a model's premature
`done=true` before two successfully dispatched actions **does not end the
step**. Worker reobserves the actual page and requests another decision
within the *existing four-decision bound*. No automatic browser click,
unapproved locator, extra action allowance, secret disclosure, oracle
rewriting or model self-verdict has been introduced. Repeated premature
completion fails closed with machine error `AI_ACTION_INCOMPLETE`. Steps
without an explicit minimum preserve their earlier behavior.

This minimum is for successful *tool actions*, not a universal guarantee
that the selected tools were both clicks. The separate strict G3 oracle
still requires **two distinct authorized button clicks per case attempt**,
technical exact-value comparison, and fresh-context confirmation. A
non-click tool cannot manufacture a passing business test.

## Actual validation

1. `pnpm test:t27-actions`: 6/6 including premature done retry to two
   clicks, repeated premature done exhaustion without a pass, no-progress
   handling, invalid min/max combination, legacy no-min compatibility,
   frozen schema range.
2. Existing replay security test fixture was corrected to specify the
   previously required `maxToolCalls`. The existing replay test suite and
   the new end-to-end frozen-parameter propagation test pass **16/16**.
3. `pnpm contracts:check`: generator consistency passed across generated
   schemas, OpenAPI and TypeScript; Worker/Orchestrator/Contracts builds
   passed. Post-change Prettier/ESLint/Git diff checks passed.
4. Real `MiniMax-M3` inventory healthy: passed, 2 provider decisions,
   2 authorized browser clicks, fixed exact-value oracle.
5. Real inventory wrong-value independent reproduction: **confirmed**, 6
   provider decisions instead of the nominal 4, 4 authorized clicks,
   distinct browser contexts, disjoint evidence, two technical
   `issue_found` verdicts. The extra two decisions were genuinely
   provider-reported, not synthesized.
6. Real seed faults for coupon discount and shipping delivery fee were
   independently rerun as direct new tests and both passed confirmed
   reproduction. They are not retroactively counted in the batch ledger.
7. Post-change `pnpm test:t18-wire`: **2/2** independent PG18/Chromium
   healthy/fault, plus T26 exact-value fault G2: **1/1**. The synthetic
   transport regressions are *not* included in any real G3 denominator.
   Final audited format/lint/Git whitespace checks passed.

### Batch G3 stability measurement, historical failures retained

`pnpm test:t27-moan2` executes 4 distinct business-rule pairs with a
**new append-only T27 provider-specific ledger**, keeping T26's failed
attempts intact:

| Case type | Correct complete | Execution failure |
| --- | ---: | ---: |
| Healthy | 4/4 | 0 |
| Seeded fault + independent reproduction | 1/4 | 3 |

- 14 settled model decision calls for 5 complete accepted cases;
  provider-reported 31,686 input + 1,188 output tokens in those samples.
- Fault failures do **not** count as false-negative technical oracles:
  they never produced a complete successful technical verdict.
- A separate direct meeting-slot fault encountered 0 executed clicks
  and fail-closed `blocked`; another limitation of live model planning.
- The final disposal audit found **0 owned disposable PostgreSQL
  containers** and **0 T27 test subprocesses** remaining.
- Historical matrix attempts remain on disk as returned, including
  failed status; a later rerun success does not overwrite failed rows.

The T27 code improves adherence to explicitly frozen multistep intent but
does not make the external model deterministic. **Model stability is still
below release acceptance. G3 full 100+30 and P0 remain not approved.**

## Artifacts and controls

- `apps/worker/src/regression-ai.ts`
- `apps/worker/src/regression-replay.ts`
- `docs/build_contracts.py` and generated contract files
- `apps/worker/test/t27-approved-action-min.test.mjs`
- `apps/worker/test/regression-replay.test.mjs`
- `T27-g3-moan2-business.ndjson` and `T27-g3-moan2-summary.json`

All external model calls were made solely against the previously
authorized `moan2` provider and disposable local test pages. No commit,
push or deployment; pre-existing dirty worktree preserved. Test samples
are not arbitrary-site autonomous Bug discovery.
