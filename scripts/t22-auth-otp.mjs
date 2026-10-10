const scenario = process.argv[2];
if (!['success', 'reject', 'expire', 'wrong'].includes(scenario))
  throw new Error('INVALID_T22_SCENARIO');
process.env.LOCALQA_T22_OTP = scenario;
await import('../apps/worker/test/auth-pg-chromium.integration.mjs');
