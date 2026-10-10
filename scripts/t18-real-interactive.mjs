// T18 adds a two-step, fresh-snapshot AI action to the approved T17 harness.
// It uses the same real-provider credential path and isolated resources.
process.env.LOCALQA_T18_MULTI = '1';
await import('./t17-real-interactive.mjs');
