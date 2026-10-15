/**
 * Outbound redaction: what the provider actually receives.
 *
 * These tests assert on the captured provider request body rather than on the
 * redaction helper in isolation, because the defect they cover was exactly a
 * gap between "looks redacted" and "what left the process".
 *
 * Every secret below is synthetic and generated in-process. No real credential,
 * API key or vault value is used as a leak sample.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { createGateway, createOpenAIAdapter } from '../dist/index.js';
import { redactText, redactMessages, hideSecret, REDACTED } from '../dist/redact.js';

/** A value that must never appear in a provider request. */
const synthetic = (label) => `SYNTH-${label}-${randomBytes(9).toString('hex')}`;

const profile = {
  id: 'c3111111-1111-4111-8111-111111111111',
  version: 1,
  name: 'Redaction wire',
  endpoint: 'https://redaction.fixture.test/v1',
  configuredModelId: 'redaction-wire',
  kind: 'openai_compatible',
  dataBoundary: 'internal',
  status: 'ready',
  responseFormat: 'json_schema',
  capabilities: {
    structuredOutput: true,
    nativeTools: false,
    imageInput: false,
  },
  encryptedApiKey: 'owned-key-marker',
  approvedFallbackIds: [],
};
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['done'],
  properties: { done: { type: 'boolean' } },
};
const text = (role, content) => ({
  role,
  content: [{ type: 'text', text: content }],
});
const input = (messages, extra = {}) => ({
  taskId: 'c3222222-2222-4222-8222-222222222222',
  profileId: profile.id,
  contextVersion: 1,
  role: 'executor',
  promptVersion: 'redaction-test',
  purpose: 'decide',
  messages,
  approvedImageIds: [],
  toolSchemas: [],
  outputSchema: schema,
  timeoutMs: 5000,
  ...extra,
});

/** Runs a real gateway call and returns the parsed provider body. */
async function capturedBody(messages, extra = {}) {
  let body = null;
  const gateway = createGateway({
    profiles: [profile],
    decryptKey: () => 'owned-wire-key',
    adapter: createOpenAIAdapter(async (_url, init) => {
      body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          model: profile.configuredModelId,
          choices: [
            { finish_reason: 'stop', message: { content: '{"done":true}' } },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        }),
        { status: 200 },
      );
    }),
  });
  const record = await gateway.generateDecision(input(messages, extra));
  return { body, record };
}

const wireText = (body) => JSON.stringify(body);

test('a JSON field carrying a secret does not reach the provider', async () => {
  // The regression: the old pattern required an unquoted value, so the quoted
  // JSON form passed through untouched.
  const secret = synthetic('PASSWORD');
  const { body } = await capturedBody([
    text('user', `Page payload: {"username":"qa","password":"${secret}"}`),
  ]);
  const sent = wireText(body);
  assert.ok(!sent.includes(secret), 'quoted JSON password leaked to provider');
  // The message text is itself embedded in a JSON string, so the field name
  // appears escaped in the wire body.
  assert.ok(sent.includes('password'), 'the field name should stay visible');
  assert.ok(sent.includes('qa'), 'benign neighbouring context must survive');
});

test('nested objects, arrays and escaped JSON are all covered', async () => {
  const deep = synthetic('DEEP');
  const inArray = synthetic('ARRAY');
  const escaped = synthetic('ESCAPED');
  const formValue = synthetic('FORM');
  const { body } = await capturedBody([
    text(
      'user',
      [
        `{"auth":{"nested":[{"token":"${inArray}"}],"deep":{"apiKey":"${deep}"}}}`,
        `tool_output: "{\\"password\\":\\"${escaped}\\"}"`,
        `request body was login=qa&password=${formValue}&submit=1`,
      ].join('\n'),
    ),
  ]);
  const sent = wireText(body);
  for (const [label, value] of [
    ['nested api key', deep],
    ['token in array', inArray],
    ['escaped JSON password', escaped],
    ['form password', formValue],
  ])
    assert.ok(!sent.includes(value), `${label} leaked to provider`);
  assert.ok(sent.includes('submit'), 'non-secret form fields must survive');
});

test('headers, cookies, bearer credentials and JWTs do not reach the provider', async () => {
  const bearer = synthetic('BEARER');
  const cookieValue = synthetic('COOKIE');
  const jwt = `eyJ${randomBytes(8).toString('base64url')}.${randomBytes(12).toString('base64url')}.${randomBytes(12).toString('base64url')}`;
  const apiKey = synthetic('HEADERKEY');
  const { body } = await capturedBody([
    text(
      'user',
      [
        `Authorization: Bearer ${bearer}`,
        `Cookie: sid=${cookieValue}; theme=dark`,
        `Set-Cookie: session=${cookieValue}; HttpOnly`,
        `x-api-key: ${apiKey}`,
        `token=${jwt}`,
        'Accept-Language: zh-CN',
      ].join('\n'),
    ),
  ]);
  const sent = wireText(body);
  for (const [label, value] of [
    ['bearer token', bearer],
    ['cookie value', cookieValue],
    ['jwt', jwt],
    ['api key header', apiKey],
  ])
    assert.ok(!sent.includes(value), `${label} leaked to provider`);
  // The cookie header value is bounded: the secret-bearing pair is removed
  // while a non-credential pair on the same line survives. Redacting to end of
  // line would consume the rest of a single-line serialized request.
  assert.ok(!sent.includes('sid='), 'cookie name/value pair was not removed');
  assert.ok(
    sent.includes('theme=dark'),
    'a non-credential cookie pair must survive',
  );
  // Non-credential headers must still reach the model.
  assert.ok(
    sent.includes('zh-CN'),
    'a benign header was over-redacted',
  );
});

test('secrets embedded in URLs are removed including the query string', async () => {
  const query = synthetic('QUERY');
  const fragment = synthetic('FRAGMENT');
  const { body } = await capturedBody([
    text(
      'user',
      `navigated to https://app.fixture.test/callback?access_token=${query}&page=2#access_token=${fragment}`,
    ),
  ]);
  const sent = wireText(body);
  assert.ok(!sent.includes(query), 'query access_token leaked');
  assert.ok(!sent.includes(fragment), 'fragment access_token leaked');
  assert.ok(sent.includes('page=2'), 'benign query parameter survives');
});

test('a registered secret is removed even with no key and odd encodings', async () => {
  const secret = synthetic('REGISTERED');
  const encoded = encodeURIComponent(secret);
  const messages = [
    text('user', `the value is ${secret} and also ${encoded} verbatim`),
  ];
  const { body } = await capturedBody(messages, {
    sensitiveValues: [secret],
  });
  const sent = wireText(body);
  assert.ok(!sent.includes(secret), 'plain registered secret leaked');
  assert.ok(!sent.includes(encoded), 'URI-encoded registered secret leaked');
});

test('redaction happens before serialisation, not only in the stored diagnostic', async () => {
  const secret = synthetic('ORDERING');
  const { body, record } = await capturedBody([
    text('user', `{"secret":"${secret}"}`),
  ]);
  assert.ok(!wireText(body).includes(secret), 'provider body leaked');
  assert.ok(
    !JSON.stringify(record.outboundRedacted ?? '').includes(secret),
    'stored outbound diagnostic leaked',
  );
  assert.ok(
    !JSON.stringify(record.rawOutput ?? '').includes(secret),
    'stored raw output leaked',
  );
});

test('truncated and malformed content is still redacted', async () => {
  const secret = synthetic('TRUNCATED');
  // A cut-off JSON document is not parseable, so only the syntax layer can act.
  const { body } = await capturedBody([
    text('user', `{"password":"${secret}`),
  ]);
  const sent = wireText(body);
  assert.ok(!sent.includes(secret), 'truncated JSON leaked the secret');
});

test('benign context is preserved so the model stays useful', async () => {
  const { body } = await capturedBody([
    text(
      'user',
      [
        'PAGE_OBSERVATION: {"title":"订单列表","rows":3}',
        'button "保存" role=button',
        'tokenCount=42 sessionTimeoutMs=1800',
      ].join('\n'),
    ),
  ]);
  const sent = wireText(body);
  assert.ok(sent.includes('订单列表'), 'page text was over-redacted');
  assert.ok(sent.includes('保存'), 'button label was over-redacted');
  // Words that merely start with a sensitive key must not be truncated.
  assert.ok(sent.includes('tokenCount=42'), 'tokenCount was over-redacted');
  assert.ok(
    sent.includes('sessionTimeoutMs=1800'),
    'sessionTimeoutMs was over-redacted',
  );
});

test('redactText covers each documented shape directly', () => {
  const value = 'v-1234567890';
  const shapes = [
    `password=${value}`,
    `password: ${value}`,
    `"password":"${value}"`,
    `'password': '${value}'`,
    `{"a":{"b":[{"secret":"${value}"}]}}`,
    `Authorization: Bearer ${value}`,
    `Cookie: x=${value}`,
    `?api_key=${value}`,
    `&token=${value}#`,
    `secret=${encodeURIComponent(value)}`,
  ];
  for (const shape of shapes) {
    const redacted = redactText(shape);
    assert.ok(
      !redacted.includes(value),
      `not redacted: ${shape} -> ${redacted}`,
    );
  }
});

test('hideSecret removes a value that has no key at all', () => {
  const secret = 'super-secret-value-9f8e7d';
  assert.ok(!hideSecret(`prefix ${secret} suffix`, secret).includes(secret));
  assert.ok(
    !hideSecret(`prefix ${encodeURIComponent(secret)} suffix`, secret).includes(
      secret,
    ),
  );
  // Too short to be a meaningful secret: never treat ordinary words as secrets.
  assert.equal(hideSecret('the cat sat', 'cat'), 'the cat sat');
});

test('redactMessages keeps image gating and reports its work', () => {
  const secret = synthetic('MSG');
  const result = redactMessages(
    [
      text('user', `{"password":"${secret}"}`),
      {
        role: 'user',
        content: [{ type: 'image', artifactId: 'not-approved' }],
      },
    ],
    [],
    [],
  );
  assert.equal(result.droppedImageIds.length, 1);
  assert.ok(!wireText(result.messages).includes(secret));
  assert.ok(result.redactionCount >= 1);
  assert.equal(REDACTED, '[redacted]');
});
