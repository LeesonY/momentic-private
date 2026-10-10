process.env.LOCALQA_T22_OTP = 'success';
process.env.LOCALQA_T23_CANCEL_OTP = '1';
await import('../apps/worker/test/auth-pg-chromium.integration.mjs');
