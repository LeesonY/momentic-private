import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseContract } from '@localqa/contracts';
import { selectRunModelBinding } from '../dist/runModelSelection.js';

const projectId = 'aaaa0000-0000-4000-8000-000000000001';
const approved = 'aaaa0000-0000-4000-8000-000000000002';
const defaultId = 'aaaa0000-0000-4000-8000-000000000003';
const foreign = 'aaaa0000-0000-4000-8000-000000000004';

function clientFixture({
  defaultModel = defaultId,
  grants = [approved, defaultId],
  status = 'ready',
  projectExists = true,
} = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, args) {
      calls.push({ sql, args });
      if (sql.includes('FROM projects'))
        return {
          rows: projectExists
            ? [{ default_model_profile_id: defaultModel }]
            : [],
          rowCount: projectExists ? 1 : 0,
        };
      if (sql.includes('SELECT 1 FROM model_profile_grants'))
        return { rows: [], rowCount: grants.includes(args[1]) ? 1 : 0 };
      if (sql.includes('SELECT profile_id FROM model_profile_grants'))
        return {
          rows: grants.length ? [{ profile_id: [...grants].sort()[0] }] : [],
          rowCount: grants.length ? 1 : 0,
        };
      if (sql.includes('FROM model_profiles'))
        return { rows: [{ version: 5, status }], rowCount: 1 };
      throw new Error('Unexpected test query');
    },
  };
}

test('T39 client contract accepts explicit model profile and only enumerated scoped action policies', () => {
  const input = parseContract('RunCreate', {
    projectId,
    targetUrl: 'https://fixture.example.test/path?x=1',
    modelProfileId: approved,
  });
  assert.equal(input.modelProfileId, approved);
  // Approved business workflows were added after T39. Authorization is
  // checked at run creation and by the frozen execution policy, not rejected
  // by the OpenAPI shape itself.
  assert.equal(
    parseContract('RunCreate', {
      ...input,
      actionPolicy: 'approved_workflows',
    }).actionPolicy,
    'approved_workflows',
  );
  assert.throws(() =>
    parseContract('RunCreate', {
      ...input,
      actionPolicy: 'unrestricted_actions',
    }),
  );
});

test('T39 authorized explicit model override wins over project default and freezes actual version', async () => {
  const client = clientFixture();
  const selected = await selectRunModelBinding(client, projectId, approved);
  assert.deepEqual(selected, { profileId: approved, version: 5 });
  assert.ok(
    client.calls.some((call) =>
      call.sql.includes('SELECT 1 FROM model_profile_grants'),
    ),
  );
});

test('T39 ungranted model selection fails before reading model version without falling back', async () => {
  const client = clientFixture();
  await assert.rejects(
    selectRunModelBinding(client, projectId, foreign),
    (err) => err?.code === 'MODEL_NOT_CONFIGURED',
  );
  assert.equal(
    client.calls.some((call) => call.sql.includes('FROM model_profiles')),
    false,
  );
});

test('T39 default profile and deterministic fallback use only the project default or grants', async () => {
  assert.deepEqual(await selectRunModelBinding(clientFixture(), projectId), {
    profileId: defaultId,
    version: 5,
  });
  const fallback = clientFixture({
    defaultModel: null,
    grants: [defaultId, approved],
  });
  assert.deepEqual(await selectRunModelBinding(fallback, projectId), {
    profileId: approved,
    version: 5,
  });
  assert.ok(
    fallback.calls.some((call) => call.sql.includes('ORDER BY profile_id')),
  );
});

test('T39 nonexistent project, absent grant and disabled model fail closed', async () => {
  for (const [client, expectedCode] of [
    [clientFixture({ projectExists: false }), 'NOT_FOUND'],
    [clientFixture({ defaultModel: null, grants: [] }), 'MODEL_NOT_CONFIGURED'],
    [clientFixture({ status: 'disabled' }), 'MODEL_NOT_CONFIGURED'],
  ])
    await assert.rejects(
      selectRunModelBinding(client, projectId),
      (err) => err?.code === expectedCode,
    );
});
