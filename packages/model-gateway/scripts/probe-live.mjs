// Live capability probe. Exits before any network call unless the operator
// sets the endpoint, model id, key, and LOCALQA_MODEL_PROBE=allow.
const required = [
  'LOCALQA_MODEL_BASE_URL',
  'LOCALQA_MODEL_API_KEY',
  'LOCALQA_MODEL_ID',
];
const missing = required.filter((name) => !process.env[name]);
const allow = process.env.LOCALQA_MODEL_PROBE === 'allow';
if (!allow || missing.length > 0) {
  process.stdout.write(
    `${JSON.stringify({
      status: 'blocked',
      networkCallMade: false,
      allow,
      missing,
      reason: '待用户提供 HTTPS endpoint、model id 与密钥，并明确允许调用。',
    })}\n`,
  );
  process.exit(0);
}

const base = process.env.LOCALQA_MODEL_BASE_URL.replace(/\/$/, '');
const endpoint = base.endsWith('/chat/completions')
  ? base
  : `${base}/chat/completions`;
if (!endpoint.startsWith('https://')) {
  process.stdout.write(
    `${JSON.stringify({
      status: 'blocked',
      networkCallMade: false,
      reason: '外部 endpoint 必须是 HTTPS。',
    })}\n`,
  );
  process.exit(0);
}

const response = await fetch(endpoint, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${process.env.LOCALQA_MODEL_API_KEY}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    model: process.env.LOCALQA_MODEL_ID,
    messages: [{ role: 'user', content: '只回复 JSON {"ok":true}' }],
    max_completion_tokens: 16,
    response_format: { type: 'json_object' },
  }),
});
const raw = (await response.text()).slice(0, 2000);
process.stdout.write(
  `${JSON.stringify({
    status: response.ok ? 'called' : 'provider_error',
    networkCallMade: true,
    httpStatus: response.status,
    raw,
  })}\n`,
);
process.exit(response.ok ? 0 : 1);
