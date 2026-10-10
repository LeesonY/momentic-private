import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenAIAdapter, createGateway } from '../dist/index.js';
import { ERROR_HTTP_STATUS, isErrorCode } from '../../contracts/dist/index.js';

test('T26 provider HTTP 402 is a billing blocker, never an invalid JSON request', async () => {
  const id = '9d4d4242-e672-4a6d-9620-7cf3891e37d5';
  const observed = [];
  const adapter = createOpenAIAdapter(async (_url, init) => {
    observed.push({ method: init.method });
    return new Response(
      JSON.stringify({ error: { message: 'fixture only' } }),
      {
        status: 402,
        headers: { 'content-type': 'application/json' },
      },
    );
  });
  const gateway = createGateway({
    profiles: [
      {
        id,
        version: 1,
        name: 'local fixture',
        endpoint: 'https://test-only.invalid',
        configuredModelId: 'fixture-model',
        kind: 'openai_compatible',
        dataBoundary: 'external',
        responseFormat: 'json_object',
        status: 'untested',
        encryptedApiKey: 'test-only-binding',
        approvedFallbackIds: [],
        capabilities: {
          structuredOutput: false,
          nativeTools: false,
          imageInput: false,
        },
      },
    ],
    decryptKey: () => 'fixture-credential',
    adapter,
  });
  const result = await gateway.capabilityProbe(id, 5000);
  assert.equal(result.providerCalls, 1);
  assert.equal(result.requestResult, 'not_configured');
  assert.equal(result.errorCode, 'MODEL_BILLING_REQUIRED');
  assert.deepEqual(observed, [{ method: 'POST' }]);
  assert.equal(isErrorCode('MODEL_BILLING_REQUIRED'), true);
  assert.equal(ERROR_HTTP_STATUS.MODEL_BILLING_REQUIRED, 402);
  assert.equal(JSON.stringify(result).includes('fixture-credential'), false);
});
