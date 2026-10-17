import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compileRegression,
  regressionDocumentSha256,
} from '@localqa/orchestrator';
import { replayRegression } from '../dist/regression-replay.js';

const criterion = {
  id: 'visible',
  kind: 'element_visible',
  description: 'Visible body',
  sourceKind: 'generic_smoke',
  sourceRef: 'fixture',
  locator: { by: 'css', value: 'body' },
};
const navigate = { kind: 'navigate', url: 'https://fixture.test/' };
const click = { kind: 'click', locator: { by: 'label', value: 'Submit' } };
const check = { kind: 'assert', criterionId: 'visible' };
const ai = {
  kind: 'ai_action',
  goal: 'Controlled action',
  criteriaIds: ['visible'],
  maxToolCalls: 4,
};
function doc(steps) {
  return {
    schemaVersion: 1,
    kind: 'localqa/test',
    id: 'root',
    name: 'Root',
    criteria: [criterion],
    steps,
  };
}
function compile(steps, resolveModule = () => undefined) {
  return compileRegression(doc(steps), {
    projectId: 'p',
    env: {},
    allowedOrigins: ['https://fixture.test'],
    maxExpandedSteps: 100,
    resolveModule,
  });
}
function fake(patch = {}) {
  const events = [];
  let sequence = 0;
  const ports = {
    async resolveTarget(locator, source, signal) {
      events.push({ type: 'resolve', locator, source, signal });
      sequence++;
      return {
        snapshotId: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
        pageId: '00000000-0000-4000-8000-000000000100',
        nodeId: `node-${sequence}`,
      };
    },
    async executeTool(call, source, signal) {
      events.push({ type: 'tool', call, source, signal });
      return { status: 'succeeded' };
    },
    async evaluateCriterion(value, source, signal) {
      events.push({ type: 'assert', criterion: value, source, signal });
      return {
        criterionId: value.id,
        result: 'passed',
        reason: 'Fake observation',
        evidenceRefs: [],
      };
    },
    ...patch,
  };
  return { ports, events };
}

test('ordered fixed replay evaluates assert in place and resolves current click/type targets', async () => {
  const root = doc([
    navigate,
    check,
    {
      kind: 'type_text',
      locator: { by: 'label', value: 'Input' },
      text: 'value',
    },
    click,
  ]);
  const before = JSON.stringify(root);
  const plan = compile(root.steps);
  const planBefore = JSON.stringify(plan);
  const { ports, events } = fake();
  const signal = new AbortController().signal;
  const result = await replayRegression(plan, ports, signal);
  assert.equal(result.status, 'completed');
  assert.deepEqual(
    events.map((e) => e.type),
    ['tool', 'assert', 'resolve', 'tool', 'resolve', 'tool'],
  );
  assert.deepEqual(
    events.filter((e) => e.type === 'tool').map((e) => e.call.name),
    ['navigate', 'type_text', 'click'],
  );
  assert.equal(events[3].call.args.target.nodeId, 'node-1');
  assert.equal(events[5].call.args.target.nodeId, 'node-2');
  assert.equal(events[3].call.args.text, 'value');
  assert.ok(events.every((e) => e.signal === signal));
  assert.deepEqual(result.steps[1].criterionResults[0].criterionId, 'visible');
  assert.equal(JSON.stringify(root), before);
  assert.equal(JSON.stringify(plan), planBefore);
  assert.ok(Object.isFrozen(result.steps[1].compiled.criteria[0]));
});

test('full module source is delivered to tool/evaluator ports and retained in records', async () => {
  const child = { ...doc([navigate, check]), id: 'child', name: 'Child' };
  const sha256 = regressionDocumentSha256(child);
  const plan = compile([{ kind: 'module', ref: 'child@1' }], () => ({
    projectId: 'p',
    name: 'child',
    version: 1,
    reviewStatus: 'approved',
    sha256,
    document: child,
  }));
  const { ports, events } = fake();
  const result = await replayRegression(
    plan,
    ports,
    new AbortController().signal,
  );
  assert.equal(result.status, 'completed');
  assert.deepEqual(events[0].source, plan[0].source);
  assert.deepEqual(events[1].source, plan[1].source);
  assert.equal(result.steps[0].compiled.source.modulePath[0].sha256, sha256);
  assert.equal(result.steps[1].compiled.source.stepIndex, 1);
});

test('AI uses the shared guarded tool port and is followed by frozen criteria evaluation', async () => {
  const { ports, events } = fake();
  ports.aiAction = async ({ executeTool, signal, criteria, source }) => {
    assert.equal(criteria[0].id, 'visible');
    assert.ok(Object.isFrozen(criteria[0]));
    assert.equal(source.documentId, 'root');
    assert.equal(signal.aborted, false);
    await executeTool({
      name: 'navigate',
      args: { url: 'https://fixture.test/controlled' },
    });
  };
  const result = await replayRegression(
    compile([ai, click]),
    ports,
    new AbortController().signal,
  );
  assert.equal(result.status, 'completed');
  assert.deepEqual(
    events.map((e) => e.type),
    ['tool', 'assert', 'resolve', 'tool'],
  );
  assert.equal(result.steps[0].tools.length, 1);
  assert.equal(result.steps[0].criterionResults[0].result, 'passed');
});

test('T27 frozen minimum and maximum travel through compiler to the guarded replay port', async () => {
  const frozen = { ...ai, maxToolCalls: 2, minToolCalls: 2 };
  const compiled = compile([frozen]);
  assert.equal(compiled[0].step.maxToolCalls, 2);
  assert.equal(compiled[0].step.minToolCalls, 2);
  const { ports } = fake();
  let forwarded = 0;
  ports.aiAction = async ({ minToolCalls, maxToolCalls, source }) => {
    forwarded++;
    assert.equal(minToolCalls, 2);
    assert.equal(maxToolCalls, 2);
    assert.equal(source.stepIndex, 0);
  };
  const result = await replayRegression(
    compiled,
    ports,
    new AbortController().signal,
  );
  assert.equal(result.status, 'completed');
  assert.equal(forwarded, 1);
  assert.equal(result.steps[0].criterionResults[0].result, 'passed');
});

test('T33 frozen two-click tool order is conveyed unchanged through the guarded replay compiler', async () => {
  const frozen = {
    ...ai,
    maxToolCalls: 2,
    minToolCalls: 2,
    requiredToolSequence: ['click', 'click'],
  };
  const { ports } = fake();
  ports.aiAction = async ({
    requiredToolSequence,
    minToolCalls,
    maxToolCalls,
  }) => {
    assert.deepEqual(requiredToolSequence, ['click', 'click']);
    assert.equal(minToolCalls, 2);
    assert.equal(maxToolCalls, 2);
  };
  const result = await replayRegression(
    compile([frozen]),
    ports,
    new AbortController().signal,
  );
  assert.equal(result.status, 'completed');
});

test('missing AI adapter fails closed with no exploration or subsequent action', async () => {
  const { ports, events } = fake();
  const result = await replayRegression(
    compile([ai, navigate]),
    ports,
    new AbortController().signal,
  );
  assert.equal(result.status, 'unsupported');
  assert.equal(result.reasonCode, 'AI_ADAPTER_REQUIRED');
  assert.equal(events.length, 0);
  assert.equal(result.steps.length, 1);
});

test('failed, unknown and not-evaluated criteria stop later actions and retain results', async () => {
  for (const evaluation of ['failed', 'unknown', 'not_evaluated']) {
    const { ports, events } = fake();
    ports.evaluateCriterion = async (value) => ({
      criterionId: value.id,
      result: evaluation,
      reason: 'Controlled negative',
      evidenceRefs: [],
    });
    const result = await replayRegression(
      compile([navigate, check, click]),
      ports,
      new AbortController().signal,
    );
    assert.equal(
      result.status,
      evaluation === 'failed' ? 'failed' : 'inconclusive',
    );
    assert.equal(result.steps.length, 2);
    assert.equal(result.steps[1].criterionResults[0].result, evaluation);
    assert.equal(events.filter((e) => e.type === 'tool').length, 1);
    assert.ok(!events.some((e) => e.type === 'resolve'));
  }
});

test('tool failure/unknown and evaluator exception stop; exception text is not leaked', async () => {
  for (const status of ['failed', 'unknown']) {
    let calls = 0;
    const { ports } = fake({
      executeTool: async () => {
        calls++;
        return { status };
      },
    });
    const result = await replayRegression(
      compile([navigate, navigate]),
      ports,
      new AbortController().signal,
    );
    assert.equal(
      result.status,
      status === 'failed' ? 'failed' : 'inconclusive',
    );
    assert.equal(calls, 1);
    assert.equal(result.steps[0].tools[0].receipt.status, status);
  }
  const { ports } = fake({
    evaluateCriterion: async () => {
      throw new Error('private secret');
    },
  });
  const result = await replayRegression(
    compile([check, navigate]),
    ports,
    new AbortController().signal,
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.reasonCode, 'REPLAY_PORT_ERROR');
  assert.ok(!JSON.stringify(result).includes('private secret'));
});

test('pre-step cancellation and cancellation during a port stop subsequent actions', async () => {
  const before = new AbortController();
  before.abort();
  const first = fake();
  const stopped = await replayRegression(
    compile([navigate]),
    first.ports,
    before.signal,
  );
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.steps.length, 0);
  assert.equal(first.events.length, 0);
  const during = new AbortController();
  let calls = 0;
  const second = fake({
    executeTool: async (_call, _source, signal) => {
      assert.equal(signal, during.signal);
      calls++;
      during.abort();
      return { status: 'succeeded' };
    },
  });
  const interrupted = await replayRegression(
    compile([navigate, click]),
    second.ports,
    during.signal,
  );
  assert.equal(interrupted.status, 'cancelled');
  assert.equal(calls, 1);
  assert.equal(interrupted.steps[0].tools[0].receipt.status, 'succeeded');
});

test('shared fake budget exhaustion affects AI and fixed actions; swallowed rejection stays sticky', async () => {
  let attempts = 0;
  const { ports } = fake({
    executeTool: async () => {
      attempts++;
      if (attempts > 1)
        throw Object.assign(new Error('budget'), { code: 'BUDGET_EXCEEDED' });
      return { status: 'succeeded' };
    },
  });
  ports.aiAction = async ({ executeTool }) => {
    try {
      await executeTool({
        name: 'navigate',
        args: { url: 'https://fixture.test/ai' },
      });
    } catch {
      /* adversarial adapter */
    }
    try {
      await executeTool({
        name: 'navigate',
        args: { url: 'https://fixture.test/bypass' },
      });
    } catch {
      /* must not reach port */
    }
  };
  const result = await replayRegression(
    compile([navigate, ai, click]),
    ports,
    new AbortController().signal,
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.reasonCode, 'BUDGET_EXCEEDED');
  assert.equal(attempts, 2);
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[1].criterionResults.length, 0);
});

test('AI post-action failed criterion stops next step; wrong criterion id is rejected', async () => {
  const { ports, events } = fake();
  ports.aiAction = async ({ executeTool }) => {
    await executeTool({
      name: 'navigate',
      args: { url: 'https://fixture.test/ai' },
    });
  };
  ports.evaluateCriterion = async () => ({
    criterionId: 'visible',
    result: 'failed',
    reason: 'not met',
    evidenceRefs: [],
  });
  const result = await replayRegression(
    compile([ai, click]),
    ports,
    new AbortController().signal,
  );
  assert.equal(result.status, 'failed');
  assert.equal(events.length, 1);
  assert.equal(result.steps[0].criterionResults.length, 1);
  ports.evaluateCriterion = async () => ({
    criterionId: 'other',
    result: 'passed',
    reason: 'wrong',
    evidenceRefs: [],
  });
  const mismatch = await replayRegression(
    compile([check, navigate]),
    ports,
    new AbortController().signal,
  );
  assert.equal(mismatch.reasonCode, 'CRITERION_ID_MISMATCH');
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('unawaited in-flight AI tool fails closed and drains before returning evidence', async () => {
  const entered = deferred();
  const release = deferred();
  let attempts = 0;
  const { ports } = fake({
    executeTool: async () => {
      attempts++;
      entered.resolve();
      await release.promise;
      return { status: 'succeeded' };
    },
  });
  ports.aiAction = async ({ executeTool }) => {
    void executeTool({ name: 'navigate', args: { url: navigate.url } });
  };
  const running = replayRegression(
    compile([ai, navigate]),
    ports,
    new AbortController().signal,
  );
  await entered.promise;
  // Let the adapter finish while its tool is still pending.
  await Promise.resolve();
  await Promise.resolve();
  release.resolve();
  const result = await running;
  assert.equal(result.reasonCode, 'AI_TOOL_NOT_AWAITED');
  assert.equal(attempts, 1);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].criterionResults.length, 0);
  assert.equal(result.steps[0].tools[0].receipt.status, 'succeeded');
});

test('concurrent AI calls and swallowed exceptions stay sticky; only first tool reaches port', async () => {
  const entered = deferred();
  const release = deferred();
  let attempts = 0;
  const { ports } = fake({
    executeTool: async () => {
      attempts++;
      entered.resolve();
      await release.promise;
      return { status: 'succeeded' };
    },
  });
  ports.aiAction = async ({ executeTool }) => {
    const first = executeTool({
      name: 'navigate',
      args: { url: navigate.url },
    });
    const second = executeTool({
      name: 'navigate',
      args: { url: navigate.url },
    });
    await Promise.allSettled([first, second]);
    await executeTool({ name: 'navigate', args: { url: navigate.url } }).catch(
      () => {},
    );
  };
  const running = replayRegression(
    compile([ai, navigate]),
    ports,
    new AbortController().signal,
  );
  await entered.promise;
  release.resolve();
  const result = await running;
  assert.equal(result.reasonCode, 'CONCURRENT_AI_TOOL');
  assert.equal(attempts, 1);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].tools.length, 1);
});

test('escaped AI callback is revoked during criterion evaluation and after replay returns', async () => {
  let escaped;
  const entered = deferred();
  const release = deferred();
  let attempts = 0;
  const { ports } = fake({
    executeTool: async () => {
      attempts++;
      return { status: 'succeeded' };
    },
    evaluateCriterion: async (value) => {
      entered.resolve();
      await release.promise;
      return {
        criterionId: value.id,
        result: 'passed',
        reason: 'Fake',
        evidenceRefs: [],
      };
    },
  });
  ports.aiAction = async ({ executeTool }) => {
    escaped = executeTool;
  };
  const running = replayRegression(
    compile([ai, navigate]),
    ports,
    new AbortController().signal,
  );
  await entered.promise;
  await assert.rejects(
    escaped({ name: 'navigate', args: { url: navigate.url } }),
    (e) => e.code === 'AI_STEP_CLOSED',
  );
  release.resolve();
  const result = await running;
  assert.equal(result.reasonCode, 'AI_STEP_CLOSED');
  assert.equal(attempts, 0);
  const before = JSON.stringify(result);
  await assert.rejects(
    escaped({ name: 'navigate', args: { url: navigate.url } }),
  );
  assert.equal(attempts, 0);
  assert.equal(JSON.stringify(result), before);
});

test('completed AI capability cannot escape into a later step or execute after cancellation', async () => {
  let escaped;
  const controller = new AbortController();
  const { ports, events } = fake();
  ports.aiAction = async ({ executeTool }) => {
    escaped = executeTool;
  };
  const result = await replayRegression(
    compile([ai]),
    ports,
    controller.signal,
  );
  assert.equal(result.status, 'completed');
  await assert.rejects(
    escaped({ name: 'navigate', args: { url: navigate.url } }),
    (e) => e.code === 'AI_STEP_CLOSED',
  );
  controller.abort();
  await assert.rejects(
    escaped({ name: 'navigate', args: { url: navigate.url } }),
    (e) => e.code === 'CANCELLED',
  );
  assert.equal(events.filter((event) => event.type === 'tool').length, 0);
  assert.equal(result.status, 'completed');
});

test('escaped AI tool cannot enter the port while a later fixed DSL action is running', async () => {
  let escaped;
  const entered = deferred();
  const release = deferred();
  let attempts = 0;
  const { ports } = fake({
    executeTool: async () => {
      attempts++;
      entered.resolve();
      await release.promise;
      return { status: 'succeeded' };
    },
  });
  ports.aiAction = async ({ executeTool }) => {
    escaped = executeTool;
  };
  const running = replayRegression(
    compile([ai, navigate, click]),
    ports,
    new AbortController().signal,
  );
  await entered.promise;
  await assert.rejects(
    escaped({ name: 'navigate', args: { url: navigate.url } }),
    (e) => e.code === 'AI_STEP_CLOSED',
  );
  release.resolve();
  const result = await running;
  assert.equal(result.reasonCode, 'AI_STEP_CLOSED');
  assert.equal(attempts, 1);
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].status, 'completed');
  assert.equal(result.steps[1].status, 'failed');
});

test('invalid canonical target and cancellation during resolution never enter tool port', async () => {
  let attempts = 0;
  const { ports } = fake({
    resolveTarget: async () => ({
      snapshotId: 'invalid',
      pageId: 'invalid',
      nodeId: 'node',
    }),
    executeTool: async () => {
      attempts++;
      return { status: 'succeeded' };
    },
  });
  const invalid = await replayRegression(
    compile([click, navigate]),
    ports,
    new AbortController().signal,
  );
  assert.equal(invalid.status, 'failed');
  assert.equal(attempts, 0);
  const controller = new AbortController();
  ports.resolveTarget = async () => {
    controller.abort();
    return {
      snapshotId: '00000000-0000-4000-8000-000000000001',
      pageId: '00000000-0000-4000-8000-000000000100',
      nodeId: 'node',
    };
  };
  const cancelled = await replayRegression(
    compile([click, navigate]),
    ports,
    controller.signal,
  );
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(attempts, 0);
});

test('grant denials keep their own code and still classify the step as failed', async () => {
  for (const code of [
    'VERSION_CONFLICT',
    'TARGET_NOT_FOUND',
    'TARGET_HIDDEN',
    'TARGET_DISABLED',
    'HIDDEN_INPUT_FORBIDDEN',
    'SENSITIVE_INPUT_FORBIDDEN',
    'SAVED_CREDENTIAL_INPUT',
    'OUT_OF_SCOPE_MUTATION',
  ]) {
    const { ports } = fake({
      executeTool: async () => {
        throw Object.assign(new Error('denied'), { code });
      },
    });
    const result = await replayRegression(
      compile([navigate, navigate]),
      ports,
      new AbortController().signal,
    );
    assert.equal(result.status, 'failed', code);
    assert.equal(result.reasonCode, code);
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0].status, 'failed');
    assert.equal(result.steps[0].reasonCode, code);
  }
});

test('an AI action denied by the ledger keeps its own code', async () => {
  const { ports } = fake({
    executeTool: async () => {
      throw Object.assign(new Error('denied'), { code: 'VERSION_CONFLICT' });
    },
  });
  ports.aiAction = async ({ executeTool }) => {
    await executeTool({
      name: 'navigate',
      args: { url: 'https://fixture.test/ai' },
    });
  };
  const result = await replayRegression(
    compile([ai, click]),
    ports,
    new AbortController().signal,
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.reasonCode, 'VERSION_CONFLICT');
  assert.equal(result.steps.length, 1);
});
