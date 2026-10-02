# @localqa/orchestrator — T05

Coordinator owns authority and SQL; RuntimeClient is the internal task-bound façade. `start(verifiedActor, RunCreate, frozenRunConfig, idempotencyKey)` commits Run/budget/config bindings/initial event/Job together; repeated keys return the same run, changed bodies reject. Project membership and frozen-model grants remain enforced. The optional sourced case list is **trusted server configuration**, not model or arbitrary HTTP input.

## Flow and concurrency

Durable job stages: coordinator preflight → explorer → coordinator planner → per-case executor → independent reproducer → deterministic finalizer. Planner uses T04's planner prompt/ModelPort but uses the sourced baseline when the fixed stub elects to keep it. Planner/finalizer map to the coordinator model binding because the accepted RoleModels DTO lacks those keys. All stage/task/case version/attempt keys are unique. Polling ≤1s is authoritative; no correctness dependency on NOTIFY.

Claims call T02 `claimTask` in a transaction. A global advisory lock serializes platform/project/run slot reservations (default 4/4/frozen run limit). Slots are separate zero-counter concurrency reservations, not invalid extra BudgetUsed fields. Model `ProviderAdapter.send` is wrapped: every physical send (including format repair) gets one call/input estimate/max output reservation under a locked budget row, then reported/estimated settlement; timeout/unknown usage retains the full reservation. Approved fallback is not silently enabled. Actions are reserved and intent+running Step committed before browser dispatch; outcome/hash/events commit atomically. Active time samples persist in append-only audit entries and use the union of running work, not sum of simultaneous workers; fully awaiting input does not advance active time.

Each result verifies lease token hash, worker/project/task, fencing, context and cancellation. Verdict, attempt state, case event, suspected finding/reproduction result, task result and released slots commit together. Evidence ownership is checked, metadata never publishes Worker file paths; ArtifactStore persists/fsyncs bytes before DB availability. On ambiguous metadata commit retain bytes for later orphan reconciliation.

## Recovery, input, cancellation

T02 recovery converts pending intents to unknown and charges unknown reservations. T05 preserves the original interrupted attempt and enqueues a **new, lease-authorized recovery-only attempt** with inconclusive verdict; no browser replay. Independent queued cases remain eligible after worker_failure. Cancellation persists `cancelling` immediately; every dispatch rechecks authoritative state, heartbeat ≤1s aborts active context. Input only switches the whole run to awaiting_input when no other queued/running work exists; retained Run.phase is previousPhase; input deadlines expire into partial/none results, not endless waiting.

## Security and integration limits

Coordinator needs a fixed trusted global-admin service Actor under T02's forced-RLS app role (not a superuser runtime login). Worker receives neither database nor KEK via RuntimeClient's ECMAScript private fields. T06 must transport this façade through authenticated `/internal/v1`; an in-process client is **not** evidence of an HTTP service-identity boundary.

Only observe/navigate/capture enabled. Configured authentication fails closed to InputRequest: form/state reuse and exclusive auth-account leases are not claimed. Request/redirect/popup interception, reliable screenshot masking, browser cleanup acknowledgement, richer link/content snapshot metadata need T03 signature changes before wider execution. No default anonymous fallback from revoked configured authentication, no fabricated semantic/visual oracles, no automatic arbitrary write tools.

Full HTTP/SSE/report/GC/backup/revocation/deployment/evidence orphan reconciliation remain T06/T07/T09 integrations. Do not infer P0/G2 from T05 tests.
