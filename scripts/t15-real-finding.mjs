// Explicit opt-in: existing authorized Pi moan2 key and an isolated
// PostgreSQL 18/Chromium environment are used for this real model test.
process.env.LOCALQA_T15_REAL_FINDING = '1';
await import('../apps/worker/test/t14-provider-wire-pg-chromium.integration.mjs');
