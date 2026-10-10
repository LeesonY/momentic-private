import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFrozenGateway } from '../dist/frozen-model.js';

test('Model Management probe uses frozen Anthropic Messages protocol', async () => {
  const id = 'b3b3b3b3-3333-4333-8333-b3b3b3b3b3b3';
  let providerCalls = 0;
  const frozen = {
    document: {
      id,
      name: 'T14 local Anthropic wire',
      endpoint: 'https://anthropic-probe.test/v1',
      configuredModelId: 'mofree-m1',
      adapter: 'anthropic_messages',
      responseFormat: 'json_object',
      status: 'untested',
      dataBoundary: 'external',
      version: 1,
      capabilities: {
        structuredOutput: false,
        nativeTools: false,
        imageInput: false,
      },
    },
    apiKey: 'local-test-credential',
  };
  const transport = async (url, init) => {
    providerCalls++;
    assert.equal(url, 'https://anthropic-probe.test/v1/messages');
    assert.equal(init.headers['x-api-key'], frozen.apiKey);
    const body = JSON.parse(init.body);
    assert.equal(body.model, 'mofree-m1');
    if (body.tools) {
      const token = /参数 token 必须是 "([a-f0-9]+)"/.exec(
        body.messages[0].content[0].text,
      )[1];
      return new Response(
        JSON.stringify({
          type: 'message',
          model: 'MiniMax-M3',
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'probe-tool-call',
              name: 'localqa_probe_echo',
              input: { token },
            },
          ],
          usage: { input_tokens: 30, output_tokens: 14 },
        }),
        { status: 200 },
      );
    }
    if (body.messages[0].content.some((part) => part.type === 'image')) {
      assert.equal(body.messages[0].content[1].source.media_type, 'image/png');
      return new Response(
        JSON.stringify({
          type: 'message',
          model: 'MiniMax-M3',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '{"code":null}' }],
          usage: { input_tokens: 30, output_tokens: 14 },
        }),
        { status: 200 },
      );
    }
    assert.ok(body.messages[0].content[0].text.includes('能力探测'));
    return new Response(
      JSON.stringify({
        type: 'message',
        model: 'MiniMax-M3',
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              structuredOutput: true,
              nativeTools: false,
              imageInput: false,
            }),
          },
        ],
        usage: { input_tokens: 30, output_tokens: 14 },
      }),
      { status: 200 },
    );
  };
  const result = await createFrozenGateway(frozen, transport).capabilityProbe(
    id,
    8000,
  );
  assert.equal(providerCalls, 3);
  assert.equal(result.requestResult, 'ok');
  assert.equal(result.errorCode, null);
  assert.equal(result.reportedModelId, 'MiniMax-M3');
  assert.equal(result.data.capabilities.structuredOutput, true);
  assert.equal(result.data.capabilities.nativeTools, true);
  assert.equal(result.data.capabilities.imageInput, false);
  assert.equal(result.data.status, 'degraded');
});
