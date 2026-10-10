// Real >45 second human-wait exercise, never a virtual/modified clock.
process.env.LOCALQA_T22_OTP = 'success';
process.env.LOCALQA_T23_LONG_OTP = '1';
await import('../apps/worker/test/auth-pg-chromium.integration.mjs');
