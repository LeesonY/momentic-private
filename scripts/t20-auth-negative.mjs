// Isolated PostgreSQL/Chromium negative tests using the normal Worker.once.
// No external model API call is permitted in these failure scenarios.
const scenario = process.argv[2];
if (!['expired', 'forbidden', 'revoked', 'revoked_mid'].includes(scenario))
  throw new Error('EXPECTED_AUTH_FAILURE_SCENARIO');
process.env.LOCALQA_T20_AUTH_FAILURE = scenario;
await import('../apps/worker/test/auth-pg-chromium.integration.mjs');
