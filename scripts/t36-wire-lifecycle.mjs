// Deterministic synthetic G2 decisions with actual PG18, Worker and Chromium.
// Deliberately separate from paid MiniMax-M3 G3 accounting.
const stage = process.argv[2];
const variant = process.argv[3];
if (
  !['reload', 'remount'].includes(stage) ||
  !['healthy', 'faulty'].includes(variant)
)
  throw new Error('T36_INVALID_LOCAL_LIFECYCLE_FIXTURE');
process.env.LOCALQA_T26_FLOW =
  stage === 'reload' ? 'support-priority' : 'room-upgrade';
process.env.LOCALQA_T26_FAULT = variant === 'faulty' ? '1' : '0';
process.env.LOCALQA_T17_SIM_INTERACTIVE = '1';
process.env.LOCALQA_T33_SEQUENCE = '1';
process.env.LOCALQA_T32_ACTION_COUNTS = '1';
process.env.LOCALQA_T36_DOM_VARIANT = stage;
await import('../apps/worker/test/t14-provider-wire-pg-chromium.integration.mjs');
