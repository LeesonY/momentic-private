import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createPolicyDispatcher } from '@localqa/agents';

const call = () => ({
  name: 'type_text',
  args: {
    target: {
      snapshotId: randomUUID(),
      pageId: randomUUID(),
      nodeId: 'main_node_0',
    },
    text: 'WrongPwd_123',
  },
});

const DENIAL_CODES = [
  'VERSION_CONFLICT',
  'TARGET_NOT_FOUND',
  'TARGET_HIDDEN',
  'TARGET_DISABLED',
  'HIDDEN_INPUT_FORBIDDEN',
  'SENSITIVE_INPUT_FORBIDDEN',
  'SAVED_CREDENTIAL_INPUT',
  'OUT_OF_SCOPE_MUTATION',
  'POLICY_DENIED',
  'TARGET_NOT_ALLOWED',
];

test('every grant denial becomes a denied ToolResult with its own code', async () => {
  for (const code of DENIAL_CODES) {
    const dispatcher = createPolicyDispatcher(async () => {
      throw Object.assign(new Error('denied'), {
        code,
        denial: { role: 'password', name: '密码' },
      });
    });
    const result = await dispatcher.dispatch({
      role: 'executor',
      call: call(),
      knownEvidenceIds: [],
    });
    assert.equal(result.status, 'denied', code);
    assert.equal(result.reasonCode, code);
    // The refusal is diagnostic only: no input value reaches the model.
    assert.equal(JSON.stringify(result).includes('WrongPwd_123'), false);
  }
});

test('a non-denial error still propagates instead of becoming a denial', async () => {
  const dispatcher = createPolicyDispatcher(async () => {
    throw Object.assign(new Error('lost'), { code: 'LEASE_EXPIRED' });
  });
  await assert.rejects(
    () =>
      dispatcher.dispatch({
        role: 'executor',
        call: call(),
        knownEvidenceIds: [],
      }),
    (error) => error.code === 'LEASE_EXPIRED',
  );
});
