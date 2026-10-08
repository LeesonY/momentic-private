# AUTH-9A importer service delivery — local verification, not Root acceptance

## Files and preserved boundaries

New:
- `packages/orchestrator/src/auth-import-service.ts`
- `packages/storage/migrations/014_auth_state_import.sql`
- `apps/api/test/t10-auth-import.test.mjs`

Minimal integration: `auth-execution.ts`, `core.ts`, `runtime.ts`, `index.ts`.
`auth-state-service.ts` adds one internal `importState` reader. It verifies authoritative historical session/task/capture-grant columns, then reuses the existing complete encrypted-envelope decoder and historical keyed-HMAC validation. It does not require a historical normally/recovery-ended initializer to retain an active lease. No old capture/finish implementation was restored or weakened.

Migration 013 remains byte-identical to Root AUTH-8 acceptance: SHA256 `97cc3095d5559c6630442e054d648540a3f9a68bd4feb0b9e9d77d177cec785b`. `auth-actions.ts` remains byte-identical as well. No Claude Worker/privatePort/locator/adapter or Root controller test edits.

## Exact private interfaces for Root/Claude wiring

Coordinator signatures below prepend `scope: WorkerScope`. RuntimeClient uses the same remaining arguments and its internally frozen scope. All are in-process internal service interfaces, **not public HTTP endpoints**.

```ts
allocateAuthImporterSession(proof: LeaseProof, authStateId: string): Promise<AuthSessionBinding>
issueAuthActivationTicket(proof: LeaseProof, sessionId: string): Promise<{ activationTicket: string }>
activateAuthSession(proof: LeaseProof, sessionId: string, ticket: string): Promise<AuthSessionBinding>
authSession(proof: LeaseProof, sessionId: string): Promise<AuthSessionBinding>

grantAuthImport(proof: LeaseProof, sessionId: string): Promise<AuthImportGrant>
prepareAuthImport(proof: LeaseProof, sessionId: string, grantId: string): Promise<{ grant: AuthImportGrant; state: ApprovedAuthState }>
beginAuthImport(proof: LeaseProof, sessionId: string, grantId: string): Promise<AuthImportReceipt>
recordAuthImport(proof: LeaseProof, sessionId: string, grantId: string, receipt: AuthImportReceipt, outcome: AuthImportOutcome): Promise<void>
endAuthSession(proof: LeaseProof, sessionId: string, reason?: string): Promise<AuthSessionBinding>
```

```ts
interface AuthImportGrant extends AuthSessionBinding {
  grantId: string;
  authStateId: string;
  kind: 'import_auth_state';
  deadline: string;
}
interface AuthImportReceipt {
  grantId: string;
  executionId: string; // high-entropy 32-byte hex capability; private memory only
  startedAt: string;
}
interface AuthImportOutcome {
  status: 'succeeded' | 'failed' | 'unknown' | 'cancelled';
}
```

`AuthSessionBinding` has `sessionId, projectId, runId, taskId, workerId, fencingToken, contextVersion, contextId, profileId, profileVersion, authEpoch, purpose, status, expiresAt`; an importer has `purpose='importer'`. The grant's `status` is the session status, not the private ledger phase. `ApprovedAuthState` is the existing browser approved-state validator's return type, not a caller-defined loose cookie DTO.

Required order: allocate → activation ticket/activation CAS → grant → **prepare once** → **begin once immediately before the private prepare_state effect** → record with that begin receipt. Preparation returns decrypted state only in private memory. Repeated prepare/begin rejects `VERSION_CONFLICT`; neither replays a lost reply. Grant retries are inert only while issued. Record retries need the same complete receipt, current proof/authority, unchanged pinned state, and the identical status; changed outcome conflicts and never charges twice.

No automatic session/attempt retry: the existing task+fencing uniqueness remains. A new attempt needs an explicitly scheduled/claimed task/fencing transition; an ended importer does not reactivate. No credentials, capture authority, or dedicated initializer finish is granted to importers.

## Authority, state and ledger

- Server task summary/role must be `explore/explorer`, `execute/executor`, or `reproduce/reproducer`; smoke run only. None or absent/ungranted/revoked state is fail-closed with no material and no new authority rows.
- Current run/scope/session/frozen profile/version/context/epoch/worker/fencing/state pointer are checked on allocation, activation and every import operation. No proof values are rebuilt from database state.
- Current state must be granted and retain the complete historical capturing context/session/task/worker/fencing/grant tuple, a consumed capture grant, allowed-origin fingerprint, approved-state validation and authenticated encrypted envelope/HMAC with the **stored** key version.
- A grant additionally pins a protected-row fingerprint. Ciphertext, HMAC or historical binding changes after preparation cannot authorize begin; no second decrypt is needed.
- Exclusive policy requires an existing held/granted lock for the current run/profile/epoch, not the importer's identity. It does not acquire a new initializer lock. Shared policy has no exclusive-lock requirement.
- One `auth_import_grants` row per session, forced RLS/admin-only. The raw begin receipt is never persisted; only its canonical digest is stored in the protected table.
- Reserve `actions:1` once through the existing Coordinator reservation path, create a private `action_intents` row and safe Step, then settle/charge once. Private state/receipt never enters ToolCall args, Step, events or ordinary result channels.
- All authority clock checks follow potentially blocking locks; additional checks after writes catch budget/index/Step waits and roll the transaction back.
- Explicit session end charges an unfinished/lost-reply import conservatively as unknown. Generic successful task finish requires the importer to have recorded success, ends only that task's session/import row, and rechecks the deadline after terminal writes. The migration's narrow session-end trigger mirrors existing service-admin interruption/recovery into the import ledger; run state/epoch/granted lock and siblings are preserved.

## Actual verification and evidence

Final static checks: storage/orchestrator/API build + typecheck, targeted ESLint and Prettier passed.

- Own importer PG: **20/20**.
  - `T10-AUTH-IMPORT-4b02e577-6932-47af-b266-55400f353936.json`
  - Normal capture+dedicated finish → two same-run tasks with different workers and real fencing 1/2; exclusive/shared, independent ending; current-authority zero-decrypt negatives; complete historical binding/ciphertext/HMAC tamper; retained-key rotation; one-shot/concurrent prepare/begin; lost replies; private channel/RLS/real viewer; budget and DB-write rollback; profile-lock and budget-lock deadline expiration; truthfully failed/unknown/cancelled settlement; real recovery of initializer and one importer; RuntimeClient facade; none zero authority/decryption.
- Unmodified Root capture/finish suite is now **38/38** (original 37 plus Root/Claude's fresh-adapter case).
  - `T10-AUTH7-STATE-ROOT-008a982e-f8f4-4d38-8ce4-67148b574fb7.json`
- Existing ledger/Worker/Auth regression: **91/91**.
  - `T10-AUTH6-ACTIONS-ROOT-f3b6bf7c-a8e2-4b0d-8989-f8fe5a386175.json`
  - `T10-AUTH-ACTIONS-b911415f-006d-4ea3-bd8d-e902ba17e46f.json`
  - `T10-auth-runtime-e3ca8623.json`

Full final log: `T10-AUTH9A-verification-C051E355-90C4-4F5C-8018-6111329FCF42.log` (static/import/Root/regression exits all 0).

Reproduction:
```sh
node --test apps/api/test/t10-auth-import.test.mjs
node --test apps/api/test/t10-auth-state-capture-controller.test.mjs
node --test apps/api/test/t10-auth-actions-controller.test.mjs apps/api/test/t10-auth-actions.test.mjs apps/api/test/g3d2-lease-ledger.test.mjs apps/api/test/t10-auth-runtime.test.mjs apps/worker/test/t10-b5-fakebrowser.test.mjs
```

Independent exact-owned resource recheck: `T10-AUTH9A-resource-recheck-68b4bdd1-145a-4fc6-9360-832e16dd3b83.json`, **16 recorded resource sets checked, passed**, including every importer run's failed/successful history. Recorded container/volume IDs absent, PG/API ports closed, importer credential/rotation files absent; g3d logged container/PG port/temp directory absent. FakeBrowser/g3d fixtures do not emit exact pre-deletion volume IDs, so no independent exact-volume reinspection is claimed for those fixtures. No unrelated resources removed. All previous failure reports and logs remain.

## Concrete residual gap for Root

`apps/api/src/errors.ts` `STATUS_MAP` has no `POLICY_DENIED` entry. A real ordinary HTTP action-result attempt on an importer intent returns **HTTP 500 + code POLICY_DENIED**, with zero write/charge and no material, while the private/ordinary service boundary correctly rejects it. Suggested separate API-owned correction is `POLICY_DENIED: 403`. This file is outside this tranche; it was not changed. The own test records the existing 500 explicitly and proves the refusal/zero-write behavior; it is **not** a claim that the desired HTTP status has been accepted.

## Not accepted / not exercised

No real browser state injection, Worker.once auth/import routing, tick admission release, worker-entry, OTP, handoff, latest supplier model or production migrations. The importer suite uses real PG/HTTP and synthetic captured browser state; the existing 91 uses FakeBrowser/injected transports. Dedicated importer modelTransportCalls=0, real provider calls=0, Ego paused, P0=false. Own evidence does not replace Root independent AUTH-9A acceptance. Parameter permutations and actual case-level Worker import wiring are not exhaustively tested.
