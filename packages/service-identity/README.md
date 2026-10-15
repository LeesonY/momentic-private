# @localqa/service-identity

Request-level HMAC authentication for the internal `/internal/v1/*` boundary.

## Why

The internal API listens on the shared compose network. Network membership alone
cannot be an identity: a self-declared header such as `X-Worker-Id` proves
nothing. Peer identity therefore comes from an HMAC over the request, computed
with a key that only the calling service and the API can read.

## Key ring file

`SERVICE_IDENTITY_FILE` (default `/run/secrets/service_identity.json`, mode
`0400`/`0600` owned by the application UID):

```json
{
  "services": {
    "worker":       { "activeVersion": 2, "keys": { "1": "<32+ byte base64>", "2": "<32+ byte base64>" } },
    "orchestrator": { "activeVersion": 1, "keys": { "1": "<32+ byte base64>" } }
  }
}
```

Keys may be base64 or 64-character hex. Every key must decode to at least 32
bytes.

## What is signed

```
localqa-internal-v1
<serviceId>
<keyVersion>
<timestampMs>
<nonce>
<METHOD>
<pathname?query>
<sha256(rawBody)>
```

sent as `x-localqa-service`, `x-localqa-key-version`, `x-localqa-timestamp`,
`x-localqa-nonce`, `x-localqa-signature`. The signing key is never transmitted,
so it cannot leak through request logs.

## Operations

- **Rotate**: add the new version under `keys`, raise `activeVersion`, restart
  clients first and the API last. Keeping the old version in `keys` keeps both
  accepted during the overlap.
- **Revoke**: remove the version from `keys` and restart the API. Any holder of
  the removed key is rejected immediately, including requests that would
  otherwise be perfectly signed.
- **Reject stale/replayed**: the API accepts only credentials within
  `SERVICE_IDENTITY_MAX_SKEW_MS` (120s) and refuses a nonce it has already seen
  within `SERVICE_IDENTITY_NONCE_TTL_MS` (300s).

## Fail-closed behaviour

`InternalServiceVerifier` is required by the API. Without it, `/internal/v1/*`
returns `503` rather than serving unauthenticated callers; there is no
development bypass.
