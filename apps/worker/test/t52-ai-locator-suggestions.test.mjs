import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { suggestSemanticLocatorRepairs } from '../dist/ai-locator-suggestions.js';

const source = { documentId: 'frozen-checkout', stepIndex: 1, modulePath: [] };
const locator = { by: 'role', value: 'button', name: 'Review details' };
const button = (id, name) => ({
  nodeId: id,
  frameId: 'main',
  role: 'button',
  name,
  text: '',
  visible: true,
  enabled: true,
  sensitive: false,
  bounds: { x: 0, y: 0, width: 80, height: 24 },
});
const snapshot = {
  snapshotId: randomUUID(),
  pageId: randomUUID(),
  displayUrl: 'https://fixture.test/path?access_token=PRIVATE#secret',
  redacted: true,
  truncated: false,
  nodes: [
    button('private-token-in-raw-node-id', 'Inspect details'),
    button('button_two', 'View details'),
    button('ambiguous1', 'Help panel'),
    button('ambiguous2', 'Help panel'),
  ],
};
const run = ({
  output = { abstain: false, candidateIds: ['candidate_1'] },
  ...opts
} = {}) => {
  let invoked = 0,
    prompt = '';
  const result = suggestSemanticLocatorRepairs({
    locator,
    source,
    snapshot,
    reasonCode: 'LOCATOR_NOT_FOUND',
    signal: new AbortController().signal,
    verifyCandidate: async () => true,
    ...opts,
    async decide(messages, schema) {
      invoked++;
      prompt = JSON.stringify(messages);
      assert.deepEqual(schema.properties.candidateIds.items.enum, [
        'candidate_1',
        'candidate_2',
        'candidate_3',
      ]);
      return { requestResult: 'ok', data: output };
    },
  });
  return result.then((suggestions) => ({ suggestions, invoked, prompt }));
};
test('T52 real DOM evidence with model selecting one semantic candidate never makes an executable repair', async () => {
  const { suggestions, invoked, prompt } = await run();
  assert.equal(invoked, 1);
  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].kind, 'locator_semantic_candidate');
  assert.deepEqual(suggestions[0].proposed, {
    by: 'role',
    value: 'button',
    name: 'Inspect details',
  });
  assert.equal(suggestions[0].verification, 'not_run');
  assert.equal(suggestions[0].reviewRequired, true);
  assert.equal(suggestions[0].observedOrigin, 'https://fixture.test');
  assert.ok(!prompt.includes('private-token-in-raw-node-id'));
  assert.ok(!JSON.stringify(suggestions).includes('PRIVATE'));
});
test('T52 two distinct candidates preserved for independent human review', async () => {
  const { suggestions } = await run({
    output: { abstain: false, candidateIds: ['candidate_1', 'candidate_2'] },
  });
  assert.equal(suggestions.length, 2);
  assert.notEqual(suggestions[0].proposed.name, suggestions[1].proposed.name);
  assert.equal(suggestions[1].verification, 'not_run');
});
test('T52 ambiguity, unknown model ID, duplication and abstention always fail closed', async () => {
  for (const output of [
    { abstain: false, candidateIds: ['candidate_3'] },
    { abstain: false, candidateIds: ['candidate_42'] },
    { abstain: false, candidateIds: ['candidate_1', 'candidate_1'] },
    { abstain: true, candidateIds: ['candidate_1'] },
    {
      abstain: false,
      candidateIds: [
        'candidate_1',
        'candidate_2',
        'candidate_3',
        'candidate_4',
      ],
    },
  ]) {
    const { suggestions } = await run({ output });
    assert.equal(suggestions.length, 0, JSON.stringify(output));
  }
});
test('T52 no model request for untrusted or unsafe observations', async () => {
  for (const changes of [
    { snapshot: { ...snapshot, redacted: false } },
    { snapshot: { ...snapshot, truncated: true } },
    {
      snapshot: {
        ...snapshot,
        nodes: snapshot.nodes.map((node) => ({ ...node, sensitive: true })),
      },
    },
    { snapshot: { ...snapshot, nodes: [] } },
    { locator: { ...locator, name: 'Submit payment' } },
    { reasonCode: 'MODEL_TIMEOUT' },
    { signal: AbortSignal.abort() },
    { source: { ...source, modulePath: ['foreign-module'] } },
  ]) {
    const { suggestions, invoked } = await run(changes);
    assert.deepEqual(suggestions, []);
    assert.equal(invoked, 0);
  }
});
test('T52 model exception, missing data and malformed output never change business verdict', async () => {
  const errors = [
    {
      requestResult: 'rate_limited',
      data: { abstain: false, candidateIds: ['candidate_1'] },
    },
    { requestResult: 'ok', data: null },
    { requestResult: 'ok', data: 'candidate_1' },
  ];
  for (const record of errors) {
    const result = await suggestSemanticLocatorRepairs({
      locator,
      source,
      snapshot,
      reasonCode: 'LOCATOR_NOT_FOUND',
      signal: new AbortController().signal,
      verifyCandidate: async () => true,
      async decide() {
        return record;
      },
    });
    assert.deepEqual(result, []);
  }
  const failure = await suggestSemanticLocatorRepairs({
    locator,
    source,
    snapshot,
    reasonCode: 'LOCATOR_NOT_FOUND',
    signal: new AbortController().signal,
    verifyCandidate: async () => true,
    async decide() {
      throw new Error('MODEL_TIMEOUT');
    },
  });
  assert.deepEqual(failure, []);
});
