// Deterministic G2 protocol control; never counts as real-model G3 quality.
import { T26_FIXTURES } from '../apps/worker/test/t26-business-fixtures.mjs';
const [id, mode] = process.argv.slice(2);
if (
  !T26_FIXTURES.some((flow) => flow.id === id) ||
  !['healthy', 'faulty'].includes(mode)
)
  throw new Error('INVALID_T26_WIRE_SCENARIO');
process.env.LOCALQA_T26_FLOW = id;
process.env.LOCALQA_T26_FAULT = mode === 'faulty' ? '1' : '0';
process.env.LOCALQA_T17_SIM_INTERACTIVE = '1';
await import('../apps/worker/test/t14-provider-wire-pg-chromium.integration.mjs');
