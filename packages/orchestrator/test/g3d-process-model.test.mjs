import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGateway } from '@localqa/model-gateway';
import { StorageError } from '@localqa/storage';
import {
  createWorkerModelOptions,
  frozenModelSelection,
} from '../dist/index.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const profileId = 'd3d8d3d8-d3d8-43d8-83d8-d3d8d3d8d3d8';

test('frozenModelSelection follows the lease role and purpose', () => {
  assert.deepEqual(frozenModelSelection('explorer', 'decide'), {
    role: 'explorer',
    binding: 'explorer',
  });
  assert.deepEqual(frozenModelSelection('executor', 'decide'), {
    role: 'executor',
    binding: 'executor',
  });
  assert.deepEqual(frozenModelSelection('executor', 'assert'), {
    role: 'assertion',
    binding: 'assertion',
  });
  assert.deepEqual(frozenModelSelection('reproducer', 'assert'), {
    role: 'assertion',
    binding: 'assertion',
  });
  assert.deepEqual(frozenModelSelection('coordinator', 'decide'), {
    role: 'coordinator',
    binding: 'coordinator',
  });
  assert.deepEqual(frozenModelSelection('coordinator', 'plan'), {
    role: 'planner',
    binding: 'coordinator',
  });
  assert.deepEqual(frozenModelSelection('finalizer', 'summarize'), {
    role: 'finalizer',
    binding: 'coordinator',
  });
  assert.throws(
    () => frozenModelSelection('finalizer', 'decide'),
    (error) => error instanceof StorageError && error.code === 'FORBIDDEN',
  );
  assert.throws(
    () => frozenModelSelection('coordinator', 'assert'),
    (error) => error instanceof StorageError && error.code === 'FORBIDDEN',
  );
  assert.throws(
    () => frozenModelSelection('explorer', 'plan'),
    (error) => error instanceof StorageError && error.code === 'FORBIDDEN',
  );
  assert.throws(
    () => frozenModelSelection('coordinator', 'probe'),
    (error) =>
      error instanceof StorageError && error.code === 'VALIDATION_ERROR',
  );
});

test('createWorkerModelOptions uses the frozen version and not the test stub', async () => {
  const key = `g3d-worker-${randomUUID()}`;
  const seen = [];
  const options = createWorkerModelOptions({
    transport: async (url, init) => {
      seen.push({
        url: String(url),
        body: JSON.parse(init.body),
        authorization: init.headers.authorization,
      });
      return new Response(
        JSON.stringify({
          model: 'explore-model',
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({ ok: true }),
              },
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        }),
        { status: 200 },
      );
    },
    load: async (id, version) => {
      assert.equal(id, profileId);
      assert.equal(version, 5);
      return {
        document: {
          id,
          name: 'worker-frozen',
          endpoint: 'https://example.test/v1',
          configuredModelId: 'explore-model',
          adapter: 'openai_compatible',
          dataBoundary: 'external',
          capabilities: {
            structuredOutput: true,
            nativeTools: false,
            imageInput: false,
          },
          status: 'degraded',
          version,
          responseFormat: 'json_object',
        },
        apiKey: key,
      };
    },
  });
  const profile = await options.profile(profileId, 5);
  assert.equal(profile.kind, 'openai_compatible');
  assert.equal(profile.version, 5);
  assert.equal(profile.configuredModelId, 'explore-model');
  assert.equal(profile.responseFormat, 'json_object');
  assert.equal(profile.status, 'degraded');
  assert.equal(profile.capabilities.nativeTools, false);
  assert.equal(profile.capabilities.imageInput, false);
  assert.equal(profile.encryptedApiKey, `${profileId}:5`);
  assert.equal(profile.encryptedApiKey === key, false);
  const built = options.adapter.build({
    endpoint: profile.endpoint,
    model: profile.configuredModelId,
    purpose: 'decide',
    messages: [
      { role: 'user', content: [{ type: 'text', text: '冻结版本。' }] },
    ],
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['ok'],
      properties: { ok: { type: 'boolean' } },
    },
    tools: [],
    maxOutputTokens: 40,
    responseFormat: profile.responseFormat,
  });
  assert.equal(built.body.model, 'explore-model');
  assert.equal(built.body.response_format.type, 'json_object');
  assert.equal(JSON.stringify(built.body).includes(key), false);
  await options.adapter.send(
    {
      model: profile.configuredModelId,
      endpoint: built.endpoint,
      body: built.body,
      apiKey: options.decryptKey(profile.id, profile.encryptedApiKey),
    },
    new AbortController().signal,
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'https://example.test/v1/chat/completions');
  assert.equal(seen[0].body.model, 'explore-model');
  assert.equal(seen[0].body.response_format.type, 'json_object');
  assert.equal(seen[0].authorization === `Bearer ${key}`, true);
  assert.equal(JSON.stringify(seen[0].body).includes(key), false);

  const workerEntry = readFileSync(
    `${root}deploy/images/worker-entry.mjs`,
    'utf8',
  );
  assert.equal(workerEntry.includes('createWorkerModelOptions('), true);
  assert.equal(workerEntry.includes('transport: globalThis.fetch'), true);
  assert.equal(
    workerEntry.includes('return modelRepo.readVersion(actor, id, version);'),
    true,
  );
});

test('allowTestStub never decrypts and rejects a non-stub profile', async () => {
  const key = `g3d-stub-${randomUUID()}`;
  let fetches = 0;
  const options = createWorkerModelOptions({
    allowTestStub: true,
    transport: async () => {
      fetches += 1;
      throw new Error('stub transport must not be called by profile load');
    },
    load: async () => ({
      document: {
        id: profileId,
        name: 'stub-profile',
        endpoint: 'https://example.test/v1',
        configuredModelId: 'stub-local',
        adapter: 'openai_compatible',
        dataBoundary: 'internal',
        capabilities: {
          structuredOutput: false,
          nativeTools: false,
          imageInput: false,
        },
        status: 'untested',
        version: 1,
      },
      apiKey: key,
    }),
  });
  const profile = await options.profile(profileId, 1);
  assert.equal(profile.kind, 'stub');
  assert.equal(profile.encryptedApiKey, null);
  assert.equal(profile.capabilities.structuredOutput, true);
  assert.equal(fetches, 0);
  assert.throws(
    () => options.decryptKey(profileId, 'ciphertext'),
    /Test stub must not decrypt API credentials/,
  );

  const rejected = createWorkerModelOptions({
    allowTestStub: true,
    transport: async () => {
      throw new Error('unused');
    },
    load: async () => ({
      document: {
        id: profileId,
        name: 'real',
        endpoint: 'https://example.test/v1',
        configuredModelId: 'explore-model',
        adapter: 'openai_compatible',
        dataBoundary: 'external',
        capabilities: {
          structuredOutput: false,
          nativeTools: false,
          imageInput: false,
        },
        status: 'untested',
        version: 1,
      },
      apiKey: key,
    }),
  });
  await assert.rejects(
    () => rejected.profile(profileId, 1),
    /Test stub profile not configured/,
  );
});

test('concurrent frozen versions keep separate credentials', async () => {
  const keyV1 = `g3d-v1-${randomUUID()}`;
  const keyV2 = `g3d-v2-${randomUUID()}`;
  let waiting = 0;
  let releaseBoth;
  const bothWaiting = new Promise((resolve) => {
    releaseBoth = resolve;
  });
  const calls = [];
  const options = createWorkerModelOptions({
    transport: async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push({
        model: body.model,
        format: body.response_format.type,
        authorization: init.headers.authorization,
      });
      return new Response(
        JSON.stringify({
          model: body.model,
          choices: [
            {
              message: {
                content: JSON.stringify({
                  structuredOutput: false,
                  nativeTools: true,
                  imageInput: true,
                }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200 },
      );
    },
    load: async (id, version) => {
      waiting += 1;
      if (waiting === 2) releaseBoth();
      await bothWaiting;
      return {
        document: {
          id,
          name: 'same-profile',
          endpoint: 'https://example.test/v1',
          configuredModelId: version === 1 ? 'model-v1' : 'model-v2',
          adapter: 'openai_compatible',
          dataBoundary: 'external',
          capabilities: {
            structuredOutput: true,
            nativeTools: false,
            imageInput: false,
          },
          status: 'ready',
          version,
          responseFormat: version === 1 ? 'json_schema' : 'json_object',
        },
        apiKey: version === 1 ? keyV1 : keyV2,
      };
    },
  });
  const [older, newer] = await Promise.all([
    options.profile(profileId, 1),
    options.profile(profileId, 2),
  ]);
  assert.equal(waiting, 2);
  assert.equal(older.version, 1);
  assert.equal(newer.version, 2);
  assert.equal(older.encryptedApiKey, `${profileId}:1`);
  assert.equal(newer.encryptedApiKey, `${profileId}:2`);
  assert.notEqual(older.encryptedApiKey, newer.encryptedApiKey);
  assert.equal(JSON.stringify(older).includes(keyV1), false);
  assert.equal(JSON.stringify(newer).includes(keyV2), false);
  assert.equal(
    options.decryptKey(older.id, older.encryptedApiKey) === keyV1,
    true,
  );
  assert.equal(
    options.decryptKey(newer.id, newer.encryptedApiKey) === keyV2,
    true,
  );
  assert.equal(
    options.decryptKey(older.id, newer.encryptedApiKey) === keyV1,
    false,
  );
  assert.equal(options.decryptKey(older.id, 'set') === '', true);

  const gatewayFor = (profile) =>
    createGateway({
      profiles: [profile],
      decryptKey: options.decryptKey,
      adapter: options.adapter,
    });
  await Promise.all([
    gatewayFor(older).capabilityProbe(profileId, 1000),
    gatewayFor(newer).capabilityProbe(profileId, 1000),
  ]);
  const first = calls.find((call) => call.model === 'model-v1');
  const second = calls.find((call) => call.model === 'model-v2');
  assert.equal(calls.length, 2);
  assert.equal(first.format, 'json_schema');
  assert.equal(second.format, 'json_object');
  assert.equal(first.authorization === `Bearer ${keyV1}`, true);
  assert.equal(second.authorization === `Bearer ${keyV2}`, true);
  assert.equal(first.authorization === second.authorization, false);
  assert.equal(
    JSON.stringify(
      calls.map((call) => ({ model: call.model, format: call.format })),
    ).includes(keyV1),
    false,
  );
  assert.equal(
    JSON.stringify(
      calls.map((call) => ({ model: call.model, format: call.format })),
    ).includes(keyV2),
    false,
  );
});
