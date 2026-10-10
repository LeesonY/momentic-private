// Live React Workbench, HTTP API, private Worker + Chromium, isolated PG18.
process.env.LOCALQA_T22_OTP = 'success';
process.env.LOCALQA_T23_WEB_OTP = '1';
await import('../apps/worker/test/auth-pg-chromium.integration.mjs');
