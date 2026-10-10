// One isolated, explicitly selected real provider + PostgreSQL18 + Chromium.
// Only predefined local business fixture IDs and fault flags are accepted.
import { T26_FIXTURES } from '../apps/worker/test/t26-business-fixtures.mjs';
const [id, mode, provider = 'deepseek', configuredModel, campaign] =
  process.argv.slice(2);
if (!T26_FIXTURES.some((fixture) => fixture.id === id))
  throw new Error('T26_UNKNOWN_OR_MISSING_FLOW');
if (!['healthy', 'faulty'].includes(mode))
  throw new Error('T26_EXPECTED_HEALTHY_OR_FAULTY');
if (!['deepseek', 'moan2'].includes(provider))
  throw new Error('T26_UNKNOWN_REAL_PROVIDER');
if (provider === 'moan2' && (!configuredModel || configuredModel.length > 64))
  throw new Error('T26_MOAN2_EXPLICIT_MODEL_REQUIRED');
process.env.LOCALQA_T26_FLOW = id;
process.env.LOCALQA_T26_FAULT = mode === 'faulty' ? '1' : '0';
if (campaign === 'T31') process.env.LOCALQA_T31_OUTPUT_SHAPES = '1';
if (campaign === 'T32') process.env.LOCALQA_T32_ACTION_COUNTS = '1';
if (campaign === 'T33') {
  process.env.LOCALQA_T32_ACTION_COUNTS = '1';
  process.env.LOCALQA_T31_OUTPUT_SHAPES = '1';
  process.env.LOCALQA_T33_SEQUENCE = '1';
  if (id === 'support-priority') process.env.LOCALQA_T33_DOM_VARIANT = '1';
}
if (
  campaign === 'T34' ||
  campaign === 'T35' ||
  campaign === 'T36' ||
  campaign === 'T37' ||
  campaign === 'T38'
) {
  process.env.LOCALQA_T32_ACTION_COUNTS = '1';
  process.env.LOCALQA_T33_SEQUENCE = '1';
  process.env.LOCALQA_T31_OUTPUT_SHAPES = '1';
  if (id === 'support-priority') process.env.LOCALQA_T34_DOM_VARIANT = 'iframe';
  if (id === 'room-upgrade') process.env.LOCALQA_T34_DOM_VARIANT = 'shadow';
  if (['T36', 'T37', 'T38'].includes(campaign)) {
    if (id === 'support-priority')
      process.env.LOCALQA_T36_DOM_VARIANT = 'reload';
    if (id === 'room-upgrade') process.env.LOCALQA_T36_DOM_VARIANT = 'remount';
  }
}
if (provider === 'deepseek') {
  process.env.LOCALQA_T17_PI_DEEPSEEK = '1';
  delete process.env.LOCALQA_T17_PI_MOAN2_MODEL;
} else {
  delete process.env.LOCALQA_T17_PI_DEEPSEEK;
  process.env.LOCALQA_T17_PI_MOAN2_MODEL = configuredModel;
}
await import('../apps/worker/test/t14-provider-wire-pg-chromium.integration.mjs');
