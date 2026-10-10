// Explicit opt-in to two negative Finding transitions using the real Pi
// moan2 model and an isolated PostgreSQL18/Chromium test environment.
const mode = process.argv[2];
if (!['unconfirmed', 'blocked', 'interrupted'].includes(mode))
  throw new Error('Expected unconfirmed, blocked or interrupted scenario');
process.env.LOCALQA_T16_SCENARIO = mode;
await import('../apps/worker/test/t14-provider-wire-pg-chromium.integration.mjs');
