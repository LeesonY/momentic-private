const scenario = process.argv[2];
if (
  ![
    'kill',
    'kill_submitted',
    'submit_race',
    'consume_race',
    'revoke_consume',
    'stale_lease',
  ].includes(scenario)
)
  throw new Error('INVALID_T24_SCENARIO');
process.env.LOCALQA_T22_OTP = 'success';
process.env.LOCALQA_T24_AUTH = scenario;
await import('../apps/worker/test/auth-pg-chromium.integration.mjs');
