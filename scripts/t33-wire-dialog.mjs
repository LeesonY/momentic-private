// Explicitly labeled G2 synthetic control. No paid provider request.
// Execute the same immutable click sequence and modal DOM used in T33 G3.
process.env.LOCALQA_T26_FLOW = 'support-priority';
process.env.LOCALQA_T26_FAULT = process.argv[2] === 'faulty' ? '1' : '0';
process.env.LOCALQA_T17_SIM_INTERACTIVE = '1';
process.env.LOCALQA_T33_DOM_VARIANT = '1';
process.env.LOCALQA_T33_SEQUENCE = '1';
process.env.LOCALQA_T32_ACTION_COUNTS = '1';
await import('../apps/worker/test/t14-provider-wire-pg-chromium.integration.mjs');
