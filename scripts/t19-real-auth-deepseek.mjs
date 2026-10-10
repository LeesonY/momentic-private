// Explicit G3 mode. Only reads the existing, authorized Pi DeepSeek key.
// The regression fixture uses a disposable PostgreSQL container and localhost.
process.env.LOCALQA_T19_REAL_AUTH = '1';
await import('../apps/worker/test/auth-pg-chromium.integration.mjs');
