import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createAnthropicAdapter,
  createGateway,
  createOpenAIAdapter,
} from '../dist/index.js';
import { probeProviderCapability } from '../dist/capability-probe.js';
import { createProbeImage } from '../dist/probe-image.js';

const profile = {
  id: 'd3111111-1111-4111-8111-111111111111',
  version: 1,
  name: 'Full capability probe',
  endpoint: 'https://motoken.moresec.cn:3443/v1',
  configuredModelId: 'fixture-model',
  kind: 'anthropic_messages',
  dataBoundary: 'external',
  capabilities: {
    structuredOutput: false,
    nativeTools: false,
    imageInput: false,
  },
  responseFormat: 'json_object',
  status: 'untested',
  encryptedApiKey: 'fixture-ciphertext',
  approvedFallbackIds: [],
};
const key = 'test-secret-must-not-be-logged';

function envelope(kind, text, tool, stop) {
  return new Response(
    JSON.stringify(
      kind === 'anthropic_messages'
        ? {
            type: 'message',
            model: profile.configuredModelId,
            stop_reason: stop ?? (tool ? 'tool_use' : 'end_turn'),
            content: tool
              ? [
                  {
                    type: 'tool_use',
                    id: 'fixture-call',
                    name: 'localqa_probe_echo',
                    input: tool,
                  },
                ]
              : [{ type: 'text', text }],
            usage: { input_tokens: 10, output_tokens: 5 },
          }
        : {
            model: profile.configuredModelId,
            choices: [
              {
                finish_reason: stop ?? (tool ? 'tool_calls' : 'stop'),
                message: tool
                  ? {
                      tool_calls: [
                        {
                          type: 'function',
                          id: 'fixture-call',
                          function: {
                            name: 'localqa_probe_echo',
                            arguments: JSON.stringify(tool),
                          },
                        },
                      ],
                    }
                  : { content: text },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          },
    ),
    { status: 200 },
  );
}

function fixture(kind, options = {}) {
  const requests = [];
  let expectedImage;
  const transport = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    assert.equal(
      init.headers[
        kind === 'anthropic_messages' ? 'x-api-key' : 'authorization'
      ],
      kind === 'anthropic_messages' ? key : `Bearer ${key}`,
    );
    if (body.tools) {
      if (options.toolError)
        return new Response('{"error":{"message":"refused"}}', {
          status: options.toolError,
        });
      if (options.timeout)
        return new Promise((_resolve, reject) =>
          init.signal.addEventListener(
            'abort',
            () =>
              reject(
                Object.assign(new Error('aborted'), { name: 'AbortError' }),
              ),
            { once: true },
          ),
        );
      const token = /参数 token 必须是 "([a-f0-9]+)"/.exec(
        body.messages[0].content[0].text,
      )[1];
      assert.ok(
        body.tools[0][
          kind === 'anthropic_messages' ? 'input_schema' : 'function'
        ],
      );
      if (options.truncate)
        return envelope(
          kind,
          '',
          null,
          kind === 'anthropic_messages' ? 'max_tokens' : 'length',
        );
      if (options.fakeTool)
        return envelope(kind, JSON.stringify({ nativeTools: true, token }));
      const response = envelope(kind, null, { token });
      if (options.changedModel) {
        const body = await response.json();
        body.model = 'another-model';
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return response;
    }
    const parts = body.messages[0].content;
    const image = parts.find(
      (part) => part.type === 'image' || part.type === 'image_url',
    );
    if (image) {
      assert.ok(expectedImage);
      const data =
        kind === 'anthropic_messages'
          ? `data:image/png;base64,${image.source.data}`
          : image.image_url.url;
      assert.equal(data, expectedImage.dataUrl);
      assert.ok(
        !parts[0].text.includes(expectedImage.code),
        'challenge answer must not leak into text',
      );
      return envelope(
        kind,
        JSON.stringify({
          code: options.wrongImage ? null : expectedImage.code,
        }),
      );
    }
    return envelope(
      kind,
      options.badJson
        ? '{"anything":true}'
        : JSON.stringify({
            structuredOutput: true,
            nativeTools: true,
            imageInput: true,
          }),
    );
  };
  const adapter =
    kind === 'anthropic_messages'
      ? createAnthropicAdapter(transport)
      : createOpenAIAdapter(transport);
  // Capture the generated fixture answer in the provider test double, not
  // in request text. Production adapters always use the random factory.
  adapter.probeCapability = (input, signal) =>
    probeProviderCapability(transport, kind, input, signal, () => {
      expectedImage = createProbeImage();
      return expectedImage;
    });
  return {
    requests,
    gateway: createGateway({
      adapter,
      profiles: [{ ...profile, kind }],
      decryptKey: () => key,
    }),
  };
}

for (const kind of ['anthropic_messages', 'openai_compatible']) {
  test(`${kind}: native wire call plus hidden image challenge promote to ready`, async () => {
    const h = fixture(kind);
    const result = await h.gateway.capabilityProbe(profile.id, 1000);
    assert.equal(result.requestResult, 'ok');
    assert.equal(result.errorCode, null);
    assert.equal(result.data.status, 'ready');
    assert.deepEqual(result.data.capabilities, {
      structuredOutput: true,
      nativeTools: true,
      imageInput: true,
    });
    assert.equal(h.requests.length, 3);
    assert.equal(result.providerCalls, 3);
    assert.equal(result.requests, 3);
    assert.equal(result.inputTokens, 30);
    assert.equal(result.outputTokens, 15);
    assert.equal(result.usageSource, 'reported');
    assert.ok(!JSON.stringify(result).includes(key));
  });

  test(`${kind}: self-reported tools and wrong image answers do not pass`, async () => {
    const h = fixture(kind, { fakeTool: true, wrongImage: true });
    const result = await h.gateway.capabilityProbe(profile.id, 1000);
    assert.equal(result.data.status, 'degraded');
    assert.deepEqual(result.data.capabilities, {
      structuredOutput: true,
      nativeTools: false,
      imageInput: false,
    });
    assert.match(result.data.notes.join(''), /未匹配/);
    assert.equal(h.requests.length, 3);
  });

  test(`${kind}: failed native capability request still tests image`, async () => {
    const h = fixture(kind, { toolError: 400 });
    const result = await h.gateway.capabilityProbe(profile.id, 1000);
    assert.equal(result.errorCode, null);
    assert.equal(result.data.status, 'degraded');
    assert.equal(result.data.capabilities.nativeTools, false);
    assert.equal(result.data.capabilities.imageInput, true);
    assert.match(result.data.notes.join(''), /HTTP 400/);
    assert.equal(h.requests.length, 3);
    assert.equal(
      result.outputTokens,
      null,
      'unreported failed-request usage remains unknown',
    );
  });

  test(`${kind}: truncated native reply fails once and does not save partial caps`, async () => {
    const h = fixture(kind, { truncate: true });
    const result = await h.gateway.capabilityProbe(profile.id, 1000);
    assert.equal(result.errorCode, 'MODEL_OUTPUT_TRUNCATED');
    assert.equal(result.data, null);
    assert.equal(h.requests.length, 2);
    assert.equal(result.repairCount, 0);
    assert.equal(result.outputTokens, 10);
  });
}

for (const [status, code] of [
  [401, 'MODEL_NOT_CONFIGURED'],
  [402, 'MODEL_BILLING_REQUIRED'],
  [429, 'RATE_LIMITED'],
  [503, 'SERVICE_UNAVAILABLE'],
]) {
  test(`operational HTTP ${status} leaves probe unsaved without retry`, async () => {
    const h = fixture('anthropic_messages', { toolError: status });
    const result = await h.gateway.capabilityProbe(profile.id, 1000);
    assert.equal(result.errorCode, code);
    assert.equal(result.data, null);
    assert.equal(h.requests.length, 2);
  });
}

test('all capability stages share the caller deadline and stop on timeout', async () => {
  const h = fixture('anthropic_messages', { timeout: true });
  const result = await h.gateway.capabilityProbe(profile.id, 50);
  assert.equal(result.errorCode, 'MODEL_TIMEOUT');
  assert.equal(result.data, null);
  assert.equal(h.requests.length, 2);
  assert.equal(result.outputTokens, null);
});

test('a random JSON object is not a structured capability result', async () => {
  const h = fixture('anthropic_messages', { badJson: true });
  const result = await h.gateway.capabilityProbe(profile.id, 1000);
  assert.equal(result.errorCode, 'VALIDATION_ERROR');
  assert.equal(result.data, null);
  assert.equal(h.requests.length, 1);
});

test('capabilities from another reported model do not promote this profile to ready', async () => {
  const h = fixture('anthropic_messages', { changedModel: true });
  const result = await h.gateway.capabilityProbe(profile.id, 1000);
  assert.equal(result.data.status, 'degraded');
  assert.equal(result.data.capabilities.nativeTools, false);
  assert.equal(result.data.capabilities.imageInput, true);
  assert.match(result.data.notes.join(''), /模型标识.*不一致/);
});
