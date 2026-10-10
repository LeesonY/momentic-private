import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseContract } from '@localqa/contracts';
import { createRegressionAiAction } from '../dist/regression-ai.js';

const pageId = '22222222-2222-4222-8222-222222222222';
const snapId = '11111111-1111-4111-8111-111111111111';
const makeSnapshot = (stage) => ({
  snapshotId: snapId,
  pageId,
  frameIds: ['main'],
  displayUrl: 'http://fixture.local.test:8080/',
  title: 'Approved local fixture',
  responseStatus: 200,
  capturedAt: '2026-10-09T06:00:00.000Z',
  stateVersion: stage + 1,
  viewport: { width: 800, height: 600 },
  nodes: [
    {
      nodeId: stage ? 'second' : 'first',
      frameId: 'main',
      role: 'button',
      name: stage ? 'Confirm' : 'Preview',
      text: stage ? 'Confirm' : 'Preview',
      visible: true,
      enabled: true,
      bounds: { left: 0, top: 0, width: 40, height: 25 },
    },
  ],
  screenshotRef: null,
  networkSummary: [],
  consoleSummary: [],
  truncated: false,
  redacted: true,
});
function setup(decisions, expectedMinimum = 2) {
  let stage = 0;
  let decisionsUsed = 0;
  let observations = 0;
  const clicks = [];
  const ai = createRegressionAiAction({
    role: 'executor',
    observation: () => makeSnapshot(stage),
    evidence: () => [],
    decide: async (messages) => {
      const progress = JSON.parse(messages[0].content[0].text);
      assert.equal(progress.executedActions.length, clicks.length);
      assert.equal(progress.minToolCalls, expectedMinimum);
      const choice = decisions[decisionsUsed++] ?? 'done';
      if (choice === 'done')
        return {
          requestResult: 'ok',
          data: { done: true, toolCalls: [] },
        };
      if (choice === 'empty')
        return {
          requestResult: 'ok',
          data: { done: false, toolCalls: [] },
        };
      if (choice === 'observe')
        return {
          requestResult: 'ok',
          data: { done: false, toolCalls: [{ name: 'observe', args: {} }] },
        };
      const nodeId = stage ? 'second' : 'first';
      return {
        requestResult: 'ok',
        data: {
          done: false,
          toolCalls: [
            {
              name: 'click',
              args: {
                target: {
                  snapshotId:
                    choice === 'stale'
                      ? '33333333-3333-4333-8333-333333333333'
                      : snapId,
                  pageId,
                  nodeId: choice === 'unknown' ? 'unobserved' : nodeId,
                },
              },
            },
          ],
        },
      };
    },
  });
  const input = {
    goal: 'Approved preview then confirmation',
    maxToolCalls: 2,
    minToolCalls: 2,
    criteria: [],
    source: {},
    signal: new AbortController().signal,
    executeTool: async (call) => {
      if (call.name === 'observe') observations++;
      else if (call.name === 'click') {
        clicks.push(call.args.target.nodeId);
        stage++;
      } else assert.fail('unapproved tool reached the port');
      return {
        status: 'succeeded',
        data: parseContract('BrowserSnapshot', makeSnapshot(stage)),
      };
    },
  };
  return {
    ai,
    input,
    clicks,
    get decisionsUsed() {
      return decisionsUsed;
    },
    get observations() {
      return observations;
    },
  };
}

test('T27 reobserve after early done and finish exactly the frozen two approved tools', async () => {
  const fixture = setup(['click', 'done', 'click']);
  await fixture.ai(fixture.input);
  assert.deepEqual(fixture.clicks, ['first', 'second']);
  assert.equal(fixture.decisionsUsed, 3);
  assert.equal(fixture.observations, 3);
});

test('T27 repeated premature done exhausts bounded four decisions without silently accepting it', async () => {
  const fixture = setup(['click', 'done', 'done', 'done']);
  await assert.rejects(
    fixture.ai(fixture.input),
    (err) => err?.code === 'AI_ACTION_INCOMPLETE',
  );
  assert.deepEqual(fixture.clicks, ['first']);
  assert.equal(fixture.decisionsUsed, 4);
});

test('T27 no executed action and repeated done cannot advance an approved two-step flow', async () => {
  const fixture = setup(['done', 'done', 'done', 'done']);
  await assert.rejects(
    fixture.ai(fixture.input),
    (err) => err?.code === 'AI_ACTION_INCOMPLETE',
  );
  assert.deepEqual(fixture.clicks, []);
});

test('T27 minimum greater than frozen maximum is denied before any observation/model call', async () => {
  const fixture = setup(['click']);
  await assert.rejects(
    fixture.ai({ ...fixture.input, maxToolCalls: 1, minToolCalls: 2 }),
    (err) => err?.code === 'VALIDATION_ERROR',
  );
  assert.equal(fixture.decisionsUsed, 0);
  assert.equal(fixture.observations, 0);
});

test('T27 steps without a minimum retain legacy early completion semantics', async () => {
  const fixture = setup(['done'], 0);
  await fixture.ai({ ...fixture.input, minToolCalls: undefined });
  assert.deepEqual(fixture.clicks, []);
  assert.equal(fixture.decisionsUsed, 1);
});

test('T27 frozen DSL validates range and does not accept changed minimum after approval', () => {
  const valid = {
    kind: 'ai_action',
    goal: 'Human reviewed',
    criteriaIds: ['verified'],
    maxToolCalls: 2,
    minToolCalls: 2,
  };
  assert.equal(parseContract('ReplayStep', valid).minToolCalls, 2);
  for (const invalid of [0, 5, 1.3, '2'])
    assert.throws(() =>
      parseContract('ReplayStep', { ...valid, minToolCalls: invalid }),
    );
});

test('T28 no-action proposal recovers by reobserving, with a model-selected first and second click', async () => {
  const fixture = setup(['empty', 'click', 'click']);
  await fixture.ai(fixture.input);
  assert.deepEqual(fixture.clicks, ['first', 'second']);
  assert.equal(fixture.decisionsUsed, 3);
  assert.equal(fixture.observations, 3);
});

test('T28 stale snapshot ID is rejected before a tool executes and the model must choose a fresh target', async () => {
  const fixture = setup(['stale', 'click', 'click']);
  await fixture.ai(fixture.input);
  assert.deepEqual(fixture.clicks, ['first', 'second']);
  assert.equal(fixture.decisionsUsed, 3);
  assert.equal(fixture.observations, 3);
});

test('T28 a fabricated node ID never enters the tool port, and bounded retry accepts the fresh observed node', async () => {
  const fixture = setup(['unknown', 'click', 'click']);
  await fixture.ai(fixture.input);
  assert.deepEqual(fixture.clicks, ['first', 'second']);
  assert.equal(fixture.decisionsUsed, 3);
});

test('T28 four no-action model replies fail closed with a precise code and zero DOM mutations', async () => {
  const fixture = setup(['empty', 'empty', 'empty', 'empty']);
  await assert.rejects(
    fixture.ai(fixture.input),
    (err) => err?.code === 'AI_NO_PROGRESS',
  );
  assert.deepEqual(fixture.clicks, []);
  assert.equal(fixture.decisionsUsed, 4);
});

test('T28 four obsolete targets fail closed without any browser click', async () => {
  const fixture = setup(['stale', 'stale', 'stale', 'stale']);
  await assert.rejects(
    fixture.ai(fixture.input),
    (err) => err?.code === 'AI_TARGET_INVALID',
  );
  assert.deepEqual(fixture.clicks, []);
  assert.equal(fixture.decisionsUsed, 4);
});

test('T28 no-action without an approved minimum still fails immediately with no hidden retry', async () => {
  const fixture = setup(['empty'], 0);
  await assert.rejects(
    fixture.ai({ ...fixture.input, minToolCalls: undefined }),
    (err) => err?.code === 'AI_NO_PROGRESS',
  );
  assert.deepEqual(fixture.clicks, []);
  assert.equal(fixture.decisionsUsed, 1);
});

test('T28 unsafe batch is atomically rejected before executing a legitimate first click', async () => {
  const fixture = setup(['stale']);
  const previous = fixture.ai;
  // Model-proposed multi-tool response may mix a valid first target and a
  // forged second target; no part of this batch should touch the browser.
  const real = createRegressionAiAction({
    role: 'executor',
    observation: () => makeSnapshot(0),
    evidence: () => [],
    decide: async () => ({
      requestResult: 'ok',
      data: {
        done: false,
        toolCalls: [
          {
            name: 'click',
            args: { target: { snapshotId: snapId, pageId, nodeId: 'first' } },
          },
          {
            name: 'click',
            args: {
              target: { snapshotId: snapId, pageId, nodeId: 'unobserved' },
            },
          },
        ],
      },
    }),
  });
  await assert.rejects(
    real({ ...fixture.input, minToolCalls: 2 }),
    (err) => err?.code === 'AI_TARGET_INVALID',
  );
  assert.deepEqual(fixture.clicks, []);
  assert.equal(typeof previous, 'function');
});

test('T28 policy refusal is terminal and cannot be retried to evade denial', async () => {
  let decisions = 0;
  let deniedTools = 0;
  const ai = createRegressionAiAction({
    role: 'executor',
    observation: () => makeSnapshot(0),
    evidence: () => [],
    decide: async () => {
      decisions++;
      return {
        requestResult: 'ok',
        data: {
          done: false,
          toolCalls: [
            {
              name: 'click',
              args: { target: { snapshotId: snapId, pageId, nodeId: 'first' } },
            },
          ],
        },
      };
    },
  });
  await assert.rejects(
    ai({
      goal: 'Approved goal but current policy denies the click',
      maxToolCalls: 2,
      minToolCalls: 2,
      criteria: [],
      source: {},
      signal: new AbortController().signal,
      executeTool: async (call) => {
        if (call.name === 'observe')
          return {
            status: 'succeeded',
            data: parseContract('BrowserSnapshot', makeSnapshot(0)),
          };
        deniedTools++;
        throw Object.assign(new Error('denied'), { code: 'POLICY_DENIED' });
      },
    }),
    (error) => error?.code === 'POLICY_DENIED',
  );
  assert.equal(decisions, 1);
  assert.equal(deniedTools, 1);
});

test('T28 an invisible or disabled DOM target never triggers a browser click', async () => {
  for (const field of ['visible', 'enabled']) {
    const snap = makeSnapshot(0);
    snap.nodes[0][field] = false;
    let decisions = 0;
    let clicked = 0;
    const ai = createRegressionAiAction({
      role: 'executor',
      observation: () => snap,
      evidence: () => [],
      decide: async () => {
        decisions++;
        return {
          requestResult: 'ok',
          data: {
            done: false,
            toolCalls: [
              {
                name: 'click',
                args: {
                  target: { snapshotId: snapId, pageId, nodeId: 'first' },
                },
              },
            ],
          },
        };
      },
    });
    await assert.rejects(
      ai({
        goal: 'Frozen approved flow',
        maxToolCalls: 2,
        minToolCalls: 2,
        criteria: [],
        source: {},
        signal: new AbortController().signal,
        executeTool: async (call) => {
          if (call.name === 'observe')
            return {
              status: 'succeeded',
              data: parseContract('BrowserSnapshot', snap),
            };
          clicked++;
          throw new Error('must not click');
        },
      }),
      (error) => error?.code === 'AI_TARGET_INVALID',
    );
    assert.equal(decisions, 4);
    assert.equal(clicked, 0);
  }
});

test('T28 provider billing/transport/validation errors are terminal with precise reason and no model retry', async () => {
  for (const sample of [
    {
      requestResult: 'not_configured',
      errorCode: 'MODEL_BILLING_REQUIRED',
      expected: 'MODEL_BILLING_REQUIRED',
    },
    {
      requestResult: 'unavailable',
      errorCode: 'SERVICE_UNAVAILABLE',
      expected: 'SERVICE_UNAVAILABLE',
    },
    {
      requestResult: 'rate_limited',
      errorCode: 'RATE_LIMITED',
      expected: 'RATE_LIMITED',
    },
    {
      requestResult: 'malformed',
      errorCode: 'VALIDATION_ERROR',
      expected: 'MODEL_VALIDATION_FAILED',
    },
    {
      requestResult: 'malformed',
      errorCode: 'MODEL_OUTPUT_TRUNCATED',
      expected: 'MODEL_OUTPUT_TRUNCATED',
    },
  ]) {
    let decisions = 0;
    let browserMutations = 0;
    const ai = createRegressionAiAction({
      role: 'executor',
      observation: () => makeSnapshot(0),
      evidence: () => [],
      decide: async () => {
        decisions++;
        return {
          requestResult: sample.requestResult,
          errorCode: sample.errorCode,
          data: null,
        };
      },
    });
    await assert.rejects(
      ai({
        goal: 'Two-step frozen local plan',
        maxToolCalls: 2,
        minToolCalls: 2,
        criteria: [],
        source: {},
        signal: new AbortController().signal,
        executeTool: async (call) => {
          if (call.name === 'observe')
            return {
              status: 'succeeded',
              data: parseContract('BrowserSnapshot', makeSnapshot(0)),
            };
          browserMutations++;
          throw new Error('model failure must not mutate DOM');
        },
      }),
      (error) => error?.code === sample.expected,
    );
    assert.equal(decisions, 1);
    assert.equal(browserMutations, 0);
  }
});

test('T30 failed model JSON, schema and tool format have separate machine codes, never DOM retry', async () => {
  for (const pair of [
    ['invalid_json', 'MODEL_INVALID_JSON'],
    ['schema_mismatch', 'MODEL_SCHEMA_MISMATCH'],
    ['tool_contract_mismatch', 'MODEL_TOOL_CONTRACT_INVALID'],
  ]) {
    let calls = 0;
    let toolInvocations = 0;
    const ai = createRegressionAiAction({
      role: 'executor',
      observation: () => makeSnapshot(0),
      evidence: () => [],
      decide: async () => {
        calls++;
        return {
          requestResult: 'malformed',
          errorCode: 'VALIDATION_ERROR',
          validationFailureKind: pair[0],
          data: null,
        };
      },
    });
    await assert.rejects(
      ai({
        goal: 'Frozen two-click local fixture',
        maxToolCalls: 2,
        minToolCalls: 2,
        criteria: [],
        source: {},
        signal: new AbortController().signal,
        executeTool: async (call) => {
          if (call.name === 'observe')
            return {
              status: 'succeeded',
              data: parseContract('BrowserSnapshot', makeSnapshot(0)),
            };
          toolInvocations++;
          throw new Error('must not mutate after malformed model data');
        },
      }),
      (err) => err?.code === pair[1],
    );
    assert.equal(calls, 1);
    assert.equal(toolInvocations, 0);
  }
});

test('T33 sequence safely rejects an unapproved observe then performs exactly both frozen clicks', async () => {
  const fixture = setup(['observe', 'click', 'click']);
  await fixture.ai({
    ...fixture.input,
    requiredToolSequence: ['click', 'click'],
  });
  assert.deepEqual(fixture.clicks, ['first', 'second']);
  assert.equal(fixture.decisionsUsed, 3);
  assert.equal(fixture.observations, 3);
});

test('T33 four unapproved tool names fail closed with no browser mutations', async () => {
  const fixture = setup(['observe', 'observe', 'observe', 'observe']);
  await assert.rejects(
    fixture.ai({ ...fixture.input, requiredToolSequence: ['click', 'click'] }),
    (error) => error?.code === 'AI_ACTION_SEQUENCE_MISMATCH',
  );
  assert.deepEqual(fixture.clicks, []);
  assert.equal(fixture.decisionsUsed, 4);
});

test('T33 sequence implicitly freezes minimum even when older caller omits it', async () => {
  const fixture = setup(['done', 'click', 'click'], 2);
  await fixture.ai({
    ...fixture.input,
    minToolCalls: undefined,
    requiredToolSequence: ['click', 'click'],
  });
  assert.deepEqual(fixture.clicks, ['first', 'second']);
});

test('T33 invalid tool-sequence length refuses inference before observing', async () => {
  const fixture = setup(['click']);
  await assert.rejects(
    fixture.ai({ ...fixture.input, requiredToolSequence: ['click'] }),
    (error) => error?.code === 'VALIDATION_ERROR',
  );
  assert.equal(fixture.decisionsUsed, 0);
  assert.equal(fixture.observations, 0);
});

test('T33 frozen schema accepts only bounded authorized tool sequences', () => {
  const valid = {
    kind: 'ai_action',
    goal: 'Two approved clicks',
    criteriaIds: ['visible'],
    maxToolCalls: 2,
    minToolCalls: 2,
    requiredToolSequence: ['click', 'click'],
  };
  assert.deepEqual(parseContract('ReplayStep', valid).requiredToolSequence, [
    'click',
    'click',
  ]);
  for (const invalid of [
    [],
    ['navigate'],
    ['click', 'capture'],
    ['click', 'click', 'click', 'click', 'click'],
  ])
    assert.throws(() =>
      parseContract('ReplayStep', { ...valid, requiredToolSequence: invalid }),
    );
});

test('T33 conflicting minimum and frozen tool sequence are denied before inference', async () => {
  const fixture = setup(['click']);
  await assert.rejects(
    fixture.ai({
      ...fixture.input,
      minToolCalls: 1,
      requiredToolSequence: ['click', 'click'],
    }),
    (error) => error?.code === 'VALIDATION_ERROR',
  );
  assert.equal(fixture.decisionsUsed, 0);
  assert.equal(fixture.observations, 0);
});

test('T33 cannot perform two frozen clicks against a single stale DOM observation', async () => {
  let decisions = 0;
  let browserClicks = 0;
  const ai = createRegressionAiAction({
    role: 'executor',
    observation: () => makeSnapshot(0),
    evidence: () => [],
    decide: async () => {
      decisions++;
      return {
        requestResult: 'ok',
        data: {
          done: false,
          toolCalls: [0, 1].map(() => ({
            name: 'click',
            args: { target: { snapshotId: snapId, pageId, nodeId: 'first' } },
          })),
        },
      };
    },
  });
  await assert.rejects(
    ai({
      goal: 'Human approved exactly two clicks in fresh snapshots',
      minToolCalls: 2,
      maxToolCalls: 2,
      requiredToolSequence: ['click', 'click'],
      criteria: [],
      source: {},
      signal: new AbortController().signal,
      executeTool: async (call) => {
        if (call.name === 'observe')
          return {
            status: 'succeeded',
            data: parseContract('BrowserSnapshot', makeSnapshot(0)),
          };
        browserClicks++;
        throw new Error('no batch click may reach the browser');
      },
    }),
    (error) => error?.code === 'AI_ACTION_SEQUENCE_MISMATCH',
  );
  assert.equal(decisions, 4);
  assert.equal(browserClicks, 0);
});

test('T34 repeated already-approved first click is rejected without mutation, then freshly observed second click completes', async () => {
  let stage = 0;
  let decisions = 0;
  const clicks = [];
  const snapshot = () => ({
    ...makeSnapshot(stage),
    nodes: stage
      ? [makeSnapshot(0).nodes[0], makeSnapshot(1).nodes[0]]
      : makeSnapshot(0).nodes,
  });
  const ai = createRegressionAiAction({
    role: 'executor',
    observation: snapshot,
    evidence: () => [],
    decide: async () => {
      const next = ['first', 'first', 'second'][decisions++];
      return {
        requestResult: 'ok',
        data: {
          done: false,
          toolCalls: [
            {
              name: 'click',
              args: { target: { snapshotId: snapId, pageId, nodeId: next } },
            },
          ],
        },
      };
    },
  });
  await ai({
    goal: 'Frozen two different buttons',
    maxToolCalls: 2,
    minToolCalls: 2,
    requiredToolSequence: ['click', 'click'],
    criteria: [],
    source: {},
    signal: new AbortController().signal,
    executeTool: async (call) => {
      if (call.name === 'click') {
        clicks.push(call.args.target.nodeId);
        stage++;
      } else assert.equal(call.name, 'observe');
      return {
        status: 'succeeded',
        data: parseContract('BrowserSnapshot', snapshot()),
      };
    },
  });
  assert.deepEqual(clicks, ['first', 'second']);
  assert.equal(decisions, 3);
});

test('T34 repeated first click exhaustion is fail closed, no second unapproved mutation', async () => {
  let stage = 0;
  let decisions = 0;
  const clicks = [];
  const snapshot = () => ({
    ...makeSnapshot(stage),
    nodes: stage
      ? [makeSnapshot(0).nodes[0], makeSnapshot(1).nodes[0]]
      : makeSnapshot(0).nodes,
  });
  const ai = createRegressionAiAction({
    role: 'executor',
    observation: snapshot,
    evidence: () => [],
    decide: async () => {
      decisions++;
      return {
        requestResult: 'ok',
        data: {
          done: false,
          toolCalls: [
            {
              name: 'click',
              args: { target: { snapshotId: snapId, pageId, nodeId: 'first' } },
            },
          ],
        },
      };
    },
  });
  await assert.rejects(
    ai({
      goal: 'Frozen next click',
      maxToolCalls: 2,
      minToolCalls: 2,
      requiredToolSequence: ['click', 'click'],
      criteria: [],
      source: {},
      signal: new AbortController().signal,
      executeTool: async (call) => {
        if (call.name === 'click') {
          clicks.push(call.args.target.nodeId);
          stage++;
        }
        return {
          status: 'succeeded',
          data: parseContract('BrowserSnapshot', snapshot()),
        };
      },
    }),
    (error) => error?.code === 'AI_REPEATED_ACTION',
  );
  assert.deepEqual(clicks, ['first']);
  assert.equal(decisions, 4);
});

test('T35 async owned iframe button stays absent from model hint until observed, then gets clicked exactly once', async () => {
  let observations = 0;
  let decisions = 0;
  const clicks = [];
  const frameId = 'frame-1-approval';
  const first = {
    ...makeSnapshot(0).nodes[0],
    name: 'Confirm',
    text: 'Confirm',
  };
  const second = { ...first, frameId, nodeId: 'frame-second' };
  const snapshot = () => ({
    ...makeSnapshot(0),
    frameIds: ['main', frameId],
    nodes: [first, ...(clicks.length > 0 && observations >= 3 ? [second] : [])],
  });
  const ai = createRegressionAiAction({
    role: 'executor',
    observation: snapshot,
    evidence: () => [],
    decide: async (messages) => {
      const progress = JSON.parse(messages[0].content[0].text);
      decisions++;
      assert.equal(progress.candidateListTruncated, false);
      assert.ok(progress.instruction.includes('done=false and toolCalls=[]'));
      assert.ok(progress.instruction.includes('same-origin frame'));
      assert.ok(
        progress.instruction.includes(
          'NEVER click the completed first control',
        ),
      );
      if (decisions === 1) {
        assert.deepEqual(progress.nextApprovedClickCandidates, [
          { nodeId: first.nodeId, frameId: 'main', name: 'Confirm' },
        ]);
      } else if (decisions === 2) {
        assert.deepEqual(progress.nextApprovedClickCandidates, []);
        assert.equal(progress.executedActions.length, 1);
        return { requestResult: 'ok', data: { done: false, toolCalls: [] } };
      } else {
        assert.deepEqual(progress.nextApprovedClickCandidates, [
          { nodeId: second.nodeId, frameId, name: 'Confirm' },
        ]);
      }
      const node = decisions === 1 ? first : second;
      return {
        requestResult: 'ok',
        data: {
          done: false,
          toolCalls: [
            {
              name: 'click',
              args: {
                target: {
                  snapshotId: snapId,
                  pageId,
                  nodeId: node.nodeId,
                  frameId: node.frameId,
                },
              },
            },
          ],
        },
      };
    },
  });
  await ai({
    goal: 'Approved second button in async same-origin iframe',
    requiredToolSequence: ['click', 'click'],
    minToolCalls: 2,
    maxToolCalls: 2,
    criteria: [],
    source: {},
    signal: new AbortController().signal,
    executeTool: async (call) => {
      if (call.name === 'observe') observations++;
      if (call.name === 'click') clicks.push(call.args.target);
      return {
        status: 'succeeded',
        data: parseContract('BrowserSnapshot', snapshot()),
      };
    },
  });
  assert.equal(decisions, 3);
  assert.deepEqual(
    clicks.map((call) => [call.nodeId, call.frameId]),
    [
      [first.nodeId, 'main'],
      [second.nodeId, frameId],
    ],
  );
  assert.equal(observations, 3);
});

test('T35 no visible owned next control never authorizes guessed or repeated click, and remains bounded', async () => {
  let observations = 0;
  let decisions = 0;
  const clicks = [];
  const ai = createRegressionAiAction({
    role: 'executor',
    observation: () => makeSnapshot(0),
    evidence: () => [],
    decide: async (messages) => {
      const progress = JSON.parse(messages[0].content[0].text);
      decisions++;
      if (decisions === 1) {
        assert.equal(progress.nextApprovedClickCandidates.length, 1);
        return {
          requestResult: 'ok',
          data: {
            done: false,
            toolCalls: [
              {
                name: 'click',
                args: {
                  target: {
                    snapshotId: snapId,
                    pageId,
                    nodeId: 'first',
                    frameId: 'main',
                  },
                },
              },
            ],
          },
        };
      }
      assert.deepEqual(progress.nextApprovedClickCandidates, []);
      return { requestResult: 'ok', data: { done: false, toolCalls: [] } };
    },
  });
  await assert.rejects(
    ai({
      goal: 'Second control must become visible',
      requiredToolSequence: ['click', 'click'],
      minToolCalls: 2,
      maxToolCalls: 2,
      criteria: [],
      source: {},
      signal: new AbortController().signal,
      executeTool: async (call) => {
        if (call.name === 'observe') observations++;
        if (call.name === 'click') clicks.push(call.args.target.nodeId);
        return {
          status: 'succeeded',
          data: parseContract('BrowserSnapshot', makeSnapshot(0)),
        };
      },
    }),
    (error) => error?.code === 'AI_NO_PROGRESS',
  );
  assert.deepEqual(clicks, ['first']);
  assert.equal(decisions, 4);
  assert.equal(observations, 4);
});

test('T36 interruption immediately after first approved click blocks all later decisions and second mutations', async () => {
  const fixture = setup(['click', 'click']);
  const controller = new AbortController();
  const original = fixture.input.executeTool;
  await assert.rejects(
    fixture.ai({
      ...fixture.input,
      requiredToolSequence: ['click', 'click'],
      signal: controller.signal,
      executeTool: async (call) => {
        const receipt = await original(call);
        if (call.name === 'click') controller.abort();
        return receipt;
      },
    }),
    (error) => error?.code === 'CANCELLED',
  );
  assert.deepEqual(fixture.clicks, ['first']);
  assert.equal(fixture.decisionsUsed, 1);
});

test('T36 cancellation during pending model decision never dispatches the proposed first click', async () => {
  const controller = new AbortController();
  let clicks = 0;
  let decisions = 0;
  const ai = createRegressionAiAction({
    role: 'executor',
    observation: () => makeSnapshot(0),
    evidence: () => [],
    decide: async () => {
      decisions++;
      controller.abort();
      return {
        requestResult: 'ok',
        data: {
          done: false,
          toolCalls: [
            {
              name: 'click',
              args: { target: { snapshotId: snapId, pageId, nodeId: 'first' } },
            },
          ],
        },
      };
    },
  });
  await assert.rejects(
    ai({
      goal: 'Approved first click',
      maxToolCalls: 2,
      minToolCalls: 2,
      requiredToolSequence: ['click', 'click'],
      criteria: [],
      source: {},
      signal: controller.signal,
      executeTool: async (call) => {
        if (call.name === 'click') clicks++;
        return {
          status: 'succeeded',
          data: parseContract('BrowserSnapshot', makeSnapshot(0)),
        };
      },
    }),
    (error) => error?.code === 'CANCELLED',
  );
  assert.equal(decisions, 1);
  assert.equal(clicks, 0);
});
