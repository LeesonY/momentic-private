// Real PostgreSQL 18 + Chromium, fixed fixture and no model calls.
const scenario = process.argv[2];
if (
  !['login_redirect', 'login_spa', 'auth_lease_crash', 'otp_required'].includes(
    scenario,
  )
)
  throw new Error('EXPECTED_T21_AUTH_FAILURE_SCENARIO');
process.env.LOCALQA_T21_AUTH_FAILURE = scenario;
await import('../apps/worker/test/auth-pg-chromium.integration.mjs');
