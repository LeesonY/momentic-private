# AUTH-7A repair verification (not Root acceptance)

## Current verified boundary

- `AuthStateService.authority`: shared lease/run/scope/frozen profile/version/session worker/fencing/context/epoch/purpose checks before private material access; initializer only, none rejected.
- `verifyGate`: current session snapshot identity and canonical snapshot hash plus complete settled intent-set fingerprint. A new pending action, a new completed action, or a newer observation invalidates the gate at issue/begin/capture.
- `live`: lease/session/capture deadline checked after blocking profile/grant/snapshot/state/profile-lock acquisition; capture rechecks after database writes as well.
- Capture replay: consumed original grant, current granted scope/state pointer, historical full state tuple and authenticated encrypted binding envelope required. Revoked or rebound state rejected. Historical `hmac_key_version` verified using `verifyKeyedHmac`, rather than active-key equality.
- Exclusive capture: requires held initializing lock owned by this run/session/epoch before atomic promotion; shared policy needs no exclusive lock.
- Generic auth finish rejects with `POLICY_DENIED`, including historical retry path. No undefined-column SQL fallback and no generic granted-scope bypass.
- Vault derived HMAC keys are erased after use; verification rejects malformed hashes and uses timing-safe comparison with the stored key version.

The current workspace also contains a later dedicated finish implementation and Root tests for it. Those are not a claim that 7A was authorized to add finish, and are not acceptance of a Worker production path. No Claude Worker or Root test edits in this continuation.

## Actual final runs

Storage/orchestrator/API build and typecheck passed. Targeted ESLint and Prettier checks passed.

- Own PG capture suite: **10/10**, including newly meaningful none/zero-decrypt/zero-authority case and settled-action/new-observation gate invalidation.
  - `T10-AUTH-STATE-CAPTURE-9bffe76b-a43a-4148-8c62-cd42b9b6d597.json`
- Unmodified current Root suite: **36/37**, not all green. The original first 27 cases all pass in this full run. Root has expanded the file since the 27-case request.
  - `T10-AUTH7-STATE-ROOT-ba8a60ca-9880-42e9-841d-4336df815de5.json`
  - Remaining failure: `Root real RuntimeClient and auth-services reach encrypted PG capture through the actual flow; missing finish stays blocked`, line 1611 expects `SERVICE_UNAVAILABLE`, actual `POLICY_DENIED`. Retained as failed evidence; do not restore a 503 or edit Root's expectation. Generic finish's separate Root policy-denial counterexample passes.
- AUTH-6 controller **18/18**, own actions **18/18**.
  - `T10-AUTH6-ACTIONS-ROOT-40fe72bb-6f27-4b7d-89ef-d64c8898be15.json`
  - `T10-AUTH-ACTIONS-e1e10577-ab63-4a32-a2af-79382e9e92b2.json`
- Existing ledger/runtime/FakeBrowser regression set **55/55** (27 PG injected-transport + 11 auth runtime + 17 FakeBrowser). No real browser or supplier model acceptance.
  - `T10-auth-runtime-5bf662be.json`
- Additional preceding run: AUTH-5 **11/11**, internal action result **15/15**.

Full final run log: `T10-AUTH7A-repair-44724AAC-8C15-4626-99D6-E10CDEAD662A.log`. All prior failures/reports preserved, including the new 37-case failures; no commit/reset or production migration.

## Cleanup and limitations

Independent exact-ID cleanup recheck: `T10-AUTH7A-cleanup-recheck-a9a8a953-47c4-441c-91ba-3b2c64ca1b85.json`, passed. Capture/action/runtime report-owned containers and volumes absent, recorded PG/API ports closed, capture credentials/rotation keys absent. Exact logged g3d container and PG port absent/closed. FakeBrowser teardown passed but its fixture does not emit exact volume/temp resource IDs; do not claim independent exact-resource reinspection of that fixture.

Storage criterion remains fail-closed without a frozen server criterion. No real Chromium, OTP/import/handoff/production Worker routing acceptance. Ego paused, provider calls zero, P0=false. Root suite remains nonzero pending Root resolution of the obsolete SERVICE_UNAVAILABLE assertion; this delivery is not acceptance.
