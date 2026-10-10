// T17 synthetic provider protocol: the browser, database and policy engine
// are real, but the decisions come from a deterministic test transport.
// NEVER count this as real moan2 model acceptance.
process.env.LOCALQA_T17_SIM_INTERACTIVE = '1';
if (process.argv[2] === 'broken') process.env.LOCALQA_T17_BROKEN = '1';
await import('../apps/worker/test/t14-provider-wire-pg-chromium.integration.mjs');
