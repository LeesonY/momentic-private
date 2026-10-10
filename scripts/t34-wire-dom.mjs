// Explicit G2 synthetic-model control using real PostgreSQL18 + Chromium.
// No upstream paid calls. The same frozen two-click local business scenarios
// are later exercised with moan2/MiniMax-M3 as separately labeled G3.
const kind = process.argv[2];
const faulty = process.argv[3] === 'faulty';
if (
  !['iframe', 'shadow'].includes(kind) ||
  !['healthy', 'faulty'].includes(process.argv[3])
)
  throw new Error('T34_INVALID_LOCAL_FIXTURE_VARIANT');
process.env.LOCALQA_T26_FLOW =
  kind === 'iframe' ? 'support-priority' : 'room-upgrade';
process.env.LOCALQA_T26_FAULT = faulty ? '1' : '0';
process.env.LOCALQA_T17_SIM_INTERACTIVE = '1';
process.env.LOCALQA_T33_SEQUENCE = '1';
process.env.LOCALQA_T32_ACTION_COUNTS = '1';
process.env.LOCALQA_T34_DOM_VARIANT = kind;
await import('../apps/worker/test/t14-provider-wire-pg-chromium.integration.mjs');
