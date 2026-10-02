import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Coordinator, RuntimeClient, ArtifactStore } from '../dist/index.js';
import { criteriaHash as storageHash } from '@localqa/storage';
import { smokeCase, criteriaHash } from '@localqa/domain';
test('RuntimeClient has no enumerable/reflection-readable DB, actor, KEK, scope or adapter state', () => {
  const runtime = new RuntimeClient(
    {},
    Object.freeze({ projectId: randomUUID(), workerId: 'test-only' }),
    new ArtifactStore('packages/orchestrator/.artifacts'),
    {},
  );
  assert.deepEqual(Object.keys(runtime), []);
  assert.equal(runtime.coordinator, undefined);
  assert.equal(runtime.scope, undefined);
  assert.equal(JSON.stringify(runtime), '{}');
});
test('criteria hash matches accepted storage canonical algorithm', () => {
  const c = smokeCase(
    { id: randomUUID(), projectId: randomUUID() },
    'http://localhost:8080/',
  );
  assert.equal(criteriaHash(c), storageHash(c));
});
test('invalid platform/project slot policy is rejected', () => {
  for (const n of [0, -1, 1.5, NaN])
    assert.throws(
      () =>
        new Coordinator({
          db: {},
          serviceActor: { userId: randomUUID() },
          vault: {},
          platformSlots: n,
        }),
    );
});
