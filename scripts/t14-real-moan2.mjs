// Explicitly opt in to a genuine upstream model call. No API key is printed,
// exported, or persisted beyond the isolated disposable database container.
// The Pi configuration is only read from the host's authorized home folder.
process.env.LOCALQA_T14_REAL_MOAN2 = '1';
await import('../apps/worker/test/t14-provider-wire-pg-chromium.integration.mjs');
