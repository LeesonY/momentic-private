import assert from 'node:assert/strict';
import { createPrivateAuthPort } from '../dist/index.js';

const secret = 'vault-password-value-5a';
const otp = 'otp-material-5a';
const user = 'vault-username-5a';
const ticket = 'capture-ticket-value-5a';
const deadline = '2026-10-07T00:30:00.000Z';
const baseNow = '2026-10-07T00:00:00.000Z';
const binding = {
  sessionId: 'sess-1',
  projectId: 'proj-1',
  runId: 'run-1',
  taskId: 'task-1',
  workerId: 'worker-1',
  fencingToken: 4,
  contextVersion: 2,
  contextId: 'ctx-1',
  profileId: 'profile-1',
  profileVersion: 3,
  authEpoch: 1,
  purpose: 'initializer',
  status: 'active',
  expiresAt: '2026-10-08T00:00:00.000Z',
};
const target = {
  snapshotId: '11111111-1111-4111-8111-111111111111',
  pageId: '22222222-2222-4222-8222-222222222222',
  frameId: 'main',
  nodeId: 'user-node',
};
const origins = ['http://fixture.local.test:8080'];

function snapshot(text, name = 'Email') {
  return {
    snapshotId: target.snapshotId,
    pageId: target.pageId,
    frameIds: ['main'],
    displayUrl: 'http://fixture.local.test:8080/login',
    title: 'Login',
    responseStatus: 200,
    capturedAt: '2026-10-07T00:00:00.000Z',
    stateVersion: 1,
    viewport: { width: 800, height: 600 },
    nodes: [
      {
        nodeId: target.nodeId,
        frameId: 'main',
        role: 'textbox',
        name,
        text,
        visible: true,
        enabled: true,
        bounds: { left: 0, top: 0, width: 10, height: 10 },
      },
    ],
    screenshotRef: 'shot-1',
    networkSummary: [
      {
        url: 'http://fixture.local.test:8080/login',
        method: 'POST',
        status: 200,
        resourceType: 'document',
        summary: text,
      },
    ],
    consoleSummary: [text],
    truncated: false,
    redacted: false,
  };
}

function primitivesStub(calls) {
  return {
    async navigate(url) {
      calls.push(['navigate', url]);
      return snapshot('landed');
    },
    async fill(node, value) {
      calls.push(['fill', node.nodeId]);
      return snapshot(value, value);
    },
    async submit(node) {
      calls.push(['submit', node.nodeId]);
      return snapshot('sent');
    },
    async prepareState() {
      calls.push(['prepare']);
    },
    async exportState() {
      calls.push(['export']);
      return {
        cookies: [
          {
            name: 'sid',
            value: secret,
            domain: 'fixture.local.test',
            path: '/',
          },
        ],
      };
    },
  };
}

// Fake Runtime gate: stands in for the trusted service boundary for these
// pure-Node tests only. The real capture-ticket CAS/Coordinator wiring is a
// later batch, so nothing here claims the service already verifies tickets.
function harness(now = baseNow) {
  const calls = [];
  const gateCalls = { authorize: 0, authorizeExport: 0, grants: [] };
  const gate = {
    async authorize() {
      gateCalls.authorize += 1;
    },
    async authorizeExport(input) {
      gateCalls.authorizeExport += 1;
      gateCalls.grants.push(input.grant);
    },
  };
  const primitives = primitivesStub(calls);
  const port = createPrivateAuthPort({
    binding,
    gate,
    primitives,
    allowedOrigins: origins,
    now: () => Date.parse(now),
  });
  return { port, calls, gateCalls, primitives, gate };
}

function grant(overrides = {}) {
  return {
    grantId: 'capture-1',
    ...binding,
    deadline,
    kind: 'capture_auth_state',
    captureTicket: ticket,
    ...overrides,
  };
}

function permit(overrides = {}) {
  return {
    grantId: 'grant-1',
    ...binding,
    deadline,
    action: 'navigate_auth',
    slot: 'login_url',
    url: 'http://fixture.local.test:8080/login',
    ...overrides,
  };
}

function signal() {
  return new AbortController().signal;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function exportedCalls(calls) {
  return calls.filter((item) => item[0] === 'export').length;
}

const cases = [];
async function check(name, action) {
  try {
    await action();
    cases.push({ name, passed: true });
  } catch (error) {
    cases.push({ name, passed: false, message: error.message });
  }
}

await check(
  'four actions call only injected primitives and fill redacts every slot',
  async () => {
    const { port, calls } = harness();
    const nav = await port.executeAuth(
      permit(),
      { kind: 'navigate' },
      signal(),
    );
    assert.deepEqual(calls, [
      ['navigate', 'http://fixture.local.test:8080/login'],
    ]);
    assert.equal(nav.snapshot.screenshotRef, null);
    assert.equal(JSON.stringify(calls).includes('ToolCall'), false);

    for (const [slot, material, nodeId] of [
      ['username', user, 'user-node'],
      ['password', secret, 'pass-node'],
      ['otp', otp, 'otp-node'],
    ]) {
      const box = harness();
      const node = { ...target, nodeId };
      const result = await box.port.executeAuth(
        permit({
          grantId: `fill-${slot}`,
          action: 'fill_credential',
          slot,
          target: node,
          url: undefined,
        }),
        { kind: 'fill', secret: material },
        signal(),
      );
      assert.deepEqual(box.calls, [['fill', nodeId]]);
      assert.equal(result.snapshot.nodes[0].text, '•');
      assert.equal(result.snapshot.nodes[0].name, '•');
      assert.equal(result.snapshot.screenshotRef, null);
      assert.deepEqual(result.snapshot.networkSummary, []);
      assert.deepEqual(result.snapshot.consoleSummary, []);
      assert.equal(JSON.stringify(result.snapshot).includes(material), false);
    }

    const submitPort = harness();
    await submitPort.port.executeAuth(
      permit({
        grantId: 'submit-1',
        action: 'submit_auth',
        slot: 'submit',
        target,
        url: undefined,
      }),
      { kind: 'submit' },
      signal(),
    );
    assert.deepEqual(submitPort.calls, [['submit', target.nodeId]]);
  },
);

await check(
  'auth navigate rejects foreign scheme, host, port and credentials before gate',
  async () => {
    const badUrls = [
      'https://fixture.local.test:8080/login',
      'http://fixture.local.test:9090/login',
      'http://evil.local.test:8080/login',
      'http://fixture.local.test.evil.test:8080/login',
      'http://user:pass@fixture.local.test:8080/login',
      'javascript:alert(1)',
      'not-a-url',
    ];
    for (const url of badUrls) {
      const { port, calls, gateCalls } = harness();
      await assert.rejects(
        port.executeAuth(permit({ url }), { kind: 'navigate' }, signal()),
        (error) =>
          error.code === 'TARGET_NOT_ALLOWED' &&
          error.message === 'TARGET_NOT_ALLOWED' &&
          !String(error).includes(url),
      );
      assert.equal(gateCalls.authorize, 0, url);
      assert.deepEqual(calls, [], url);
    }
    const { port, calls, gateCalls } = harness();
    await port.executeAuth(
      permit({ url: 'http://fixture.local.test:8080/welcome' }),
      { kind: 'navigate' },
      signal(),
    );
    assert.equal(gateCalls.authorize, 1);
    assert.deepEqual(calls, [
      ['navigate', 'http://fixture.local.test:8080/welcome'],
    ]);
  },
);

await check('prepare_state validates and does not navigate', async () => {
  const { port, calls } = harness();
  const result = await port.executeAuth(
    permit({
      grantId: 'import-1',
      action: 'import_storage_state',
      slot: 'storage_state',
      url: undefined,
    }),
    {
      kind: 'prepare_state',
      state: {
        cookies: [
          {
            name: 'sid',
            value: secret,
            domain: 'fixture.local.test',
            path: '/',
          },
        ],
      },
    },
    signal(),
  );
  assert.equal(result.snapshot, null);
  assert.deepEqual(calls, [['prepare']]);
  assert.equal(
    calls.some((item) => item[0] === 'navigate'),
    false,
  );
});

await check(
  'repeat and overlap of one grant do not execute twice',
  async () => {
    const released = deferred();
    let authorizations = 0;
    const calls = [];
    const port = createPrivateAuthPort({
      binding,
      allowedOrigins: origins,
      now: () => Date.parse(baseNow),
      gate: {
        authorize: () => {
          authorizations += 1;
          return released.promise;
        },
        authorizeExport: async () => {},
      },
      primitives: {
        ...primitivesStub(calls),
        async navigate() {
          calls.push('navigate');
          return snapshot('landed');
        },
      },
    });
    const first = port.executeAuth(permit(), { kind: 'navigate' }, signal());
    await Promise.resolve();
    await assert.rejects(
      port.executeAuth(permit(), { kind: 'navigate' }, signal()),
      (error) =>
        error.code === 'VALIDATION_ERROR' &&
        error.message === 'VALIDATION_ERROR',
    );
    released.resolve();
    await first;
    await assert.rejects(
      port.executeAuth(permit(), { kind: 'navigate' }, signal()),
    );
    assert.equal(calls.length, 1);
    assert.equal(authorizations, 1);
  },
);

await check(
  'gate failure, abort, deadline, and tampering cause zero side effects',
  async () => {
    const rejected = async (mutate, code) => {
      const calls = [];
      let authorizations = 0;
      const port = createPrivateAuthPort({
        binding,
        allowedOrigins: origins,
        now: () => Date.parse(baseNow),
        gate: {
          authorize: async () => {
            authorizations += 1;
            if (mutate === 'gate') throw new Error(secret);
          },
          authorizeExport: async () => {},
        },
        primitives: {
          ...primitivesStub(calls),
          async fill() {
            calls.push('fill');
            throw new Error(secret);
          },
        },
      });
      const controller = new AbortController();
      if (mutate === 'abort') controller.abort();
      const input = permit();
      const effect = { kind: 'navigate' };
      if (mutate === 'fence') input.fencingToken = 99;
      if (mutate === 'epoch') input.authEpoch = 2;
      if (mutate === 'slot') input.slot = 'otp';
      if (mutate === 'effect') effect.kind = 'fill';
      if (mutate === 'deadline') input.deadline = '2026-10-06T00:00:00.000Z';
      await assert.rejects(
        port.executeAuth(input, effect, controller.signal),
        (error) => {
          assert.equal(error.code, code);
          assert.equal(error.message, code);
          assert.equal(String(error).includes(secret), false);
          return true;
        },
      );
      assert.deepEqual(calls, []);
      if (mutate !== 'gate') assert.equal(authorizations, 0);
    };
    await rejected('gate', 'VALIDATION_ERROR');
    await rejected('abort', 'CANCELLED');
    await rejected('deadline', 'LEASE_EXPIRED');
    await rejected('fence', 'LEASE_EXPIRED');
    await rejected('epoch', 'LEASE_EXPIRED');
    await rejected('slot', 'VALIDATION_ERROR');
    await rejected('effect', 'VALIDATION_ERROR');
  },
);

await check('invalid approved state does not prepare or navigate', async () => {
  const { port, calls } = harness();
  await assert.rejects(
    port.executeAuth(
      permit({
        grantId: 'bad-state',
        action: 'import_storage_state',
        slot: 'storage_state',
        url: undefined,
      }),
      {
        kind: 'prepare_state',
        state: {
          cookies: [
            { name: 'sid', value: secret, domain: 'evil.test', path: '/' },
          ],
        },
      },
      signal(),
    ),
    (error) =>
      error.message === 'TARGET_NOT_ALLOWED' && !String(error).includes(secret),
  );
  assert.deepEqual(calls, []);
});

await check(
  'async gate sees a frozen permit and later snapshots keep prior secrets out',
  async () => {
    const released = deferred();
    let authorizations = 0;
    const navigations = [];
    const material = 'SyntheticAuthMaterialOnly';
    const custom = createPrivateAuthPort({
      binding,
      allowedOrigins: origins,
      now: () => Date.parse(baseNow),
      gate: {
        authorize: () => {
          authorizations += 1;
          if (authorizations > 1) return Promise.resolve();
          return released.promise;
        },
        authorizeExport: async () => {},
      },
      primitives: {
        async navigate(url) {
          navigations.push(url);
          return snapshot(material);
        },
        async fill() {
          return snapshot('ordinary');
        },
        async submit() {
          return snapshot(material);
        },
        async prepareState() {},
        async exportState() {
          return { cookies: [] };
        },
      },
    });
    const approved = permit({ grantId: 'mutate-url-2' });
    const execution = custom.executeAuth(
      approved,
      { kind: 'navigate' },
      signal(),
    );
    approved.url = 'https://unapproved-auth.test/';
    released.resolve();
    await execution;
    assert.equal(navigations.includes('https://unapproved-auth.test/'), false);
    assert.equal(navigations[0], 'http://fixture.local.test:8080/login');
    await custom.executeAuth(
      permit({
        grantId: 'fill-later',
        action: 'fill_credential',
        slot: 'password',
        target,
        url: undefined,
      }),
      { kind: 'fill', secret: material },
      signal(),
    );
    const submitted = await custom.executeAuth(
      permit({
        grantId: 'submit-later',
        action: 'submit_auth',
        slot: 'submit',
        target,
        url: undefined,
      }),
      { kind: 'submit' },
      signal(),
    );
    assert.equal(JSON.stringify(submitted.snapshot).includes(material), false);
    await custom.close();
  },
);

await check(
  'missing gate, missing export gate, and non-active binding are refused at construction',
  async () => {
    const fullGate = {
      authorize: async () => {},
      authorizeExport: async () => {},
    };
    const refused = (build, leak) => {
      assert.throws(build, (error) => {
        assert.equal(error.code, 'VALIDATION_ERROR');
        assert.equal(error.message, 'VALIDATION_ERROR');
        if (leak) assert.equal(String(error).includes(leak), false);
        return true;
      });
    };
    refused(() =>
      createPrivateAuthPort({
        binding,
        primitives: primitivesStub([]),
        allowedOrigins: origins,
      }),
    );
    refused(() =>
      createPrivateAuthPort({
        binding,
        gate: {},
        primitives: primitivesStub([]),
        allowedOrigins: origins,
      }),
    );
    refused(() =>
      createPrivateAuthPort({
        binding,
        gate: { authorize: async () => {} },
        primitives: primitivesStub([]),
        allowedOrigins: origins,
      }),
    );
    refused(() =>
      createPrivateAuthPort({
        binding,
        gate: { authorizeExport: async () => {} },
        primitives: primitivesStub([]),
        allowedOrigins: origins,
      }),
    );
    const { status: _status, ...withoutStatus } = binding;
    for (const candidate of [
      withoutStatus,
      { ...binding, status: 'allocated' },
      { ...binding, status: 'ended' },
      { ...binding, status: 'revoked' },
      { ...binding, authEpoch: 0 },
      { ...binding, sessionId: '' },
    ]) {
      refused(() =>
        createPrivateAuthPort({
          binding: candidate,
          gate: fullGate,
          primitives: primitivesStub([]),
          allowedOrigins: origins,
        }),
      );
    }
    refused(() =>
      createPrivateAuthPort({
        binding,
        gate: fullGate,
        primitives: { ...primitivesStub([]), exportState: undefined },
        allowedOrigins: origins,
      }),
    );
    refused(
      () =>
        createPrivateAuthPort({
          binding,
          gate: Object.defineProperty(
            { authorize: async () => {} },
            'authorizeExport',
            {
              enumerable: true,
              get() {
                throw new Error(ticket);
              },
            },
          ),
          primitives: primitivesStub([]),
          allowedOrigins: origins,
        }),
      ticket,
    );

    // The fake runtime gate and the adapter keep their original receivers.
    const calls = [];
    const adapter = primitivesStub(calls);
    adapter.navigate = async function (url) {
      assert.equal(this, adapter);
      calls.push(['navigate', url]);
      return snapshot('landed');
    };
    const gate = {
      authorize: async function () {
        assert.equal(this, gate);
      },
      authorizeExport: async function () {
        assert.equal(this, gate);
      },
    };
    const port = createPrivateAuthPort({
      binding,
      gate,
      primitives: adapter,
      allowedOrigins: origins,
      now: () => Date.parse(baseNow),
    });
    await port.executeAuth(permit(), { kind: 'navigate' }, signal());
    await port.exportAuthState(grant());
    assert.deepEqual(calls, [
      ['navigate', 'http://fixture.local.test:8080/login'],
      ['export'],
    ]);
  },
);

await check(
  'export needs a well-formed grant, the exact tuple, a live deadline and no abort',
  async () => {
    const rejected = async (mutate, code, build = grant) => {
      const { port, calls, gateCalls } = harness();
      const input = build();
      if (typeof mutate === 'function') mutate(input);
      const controller = new AbortController();
      const args = [input];
      if (mutate === 'aborted-signal') controller.abort();
      if (mutate === 'aborted-signal') args.push(controller.signal);
      await assert.rejects(port.exportAuthState(...args), (error) => {
        assert.equal(error.code, code);
        assert.equal(error.message, code);
        assert.equal(String(error).includes(ticket), false);
        assert.equal(String(error).includes(secret), false);
        return true;
      });
      assert.deepEqual(calls, []);
      assert.equal(gateCalls.authorizeExport, 0);
      assert.equal(gateCalls.authorize, 0);
    };
    await rejected(null, 'VALIDATION_ERROR', () => undefined);
    await rejected(null, 'VALIDATION_ERROR', () => ({}));
    await rejected((input) => delete input.captureTicket, 'VALIDATION_ERROR');
    await rejected((input) => (input.captureTicket = ''), 'VALIDATION_ERROR');
    await rejected((input) => (input.captureTicket = 42), 'VALIDATION_ERROR');
    await rejected(
      (input) => (input.kind = 'import_storage_state'),
      'VALIDATION_ERROR',
    );
    await rejected((input) => delete input.kind, 'VALIDATION_ERROR');
    await rejected((input) => delete input.grantId, 'VALIDATION_ERROR');
    await rejected((input) => (input.grantId = ''), 'VALIDATION_ERROR');
    await rejected((input) => (input.status = 'ended'), 'VALIDATION_ERROR');
    await rejected((input) => delete input.status, 'VALIDATION_ERROR');
    await rejected(
      (input) => (input.sessionId = 'sess-other'),
      'LEASE_EXPIRED',
    );
    await rejected((input) => (input.taskId = 'task-other'), 'LEASE_EXPIRED');
    await rejected((input) => (input.authEpoch = 2), 'LEASE_EXPIRED');
    await rejected((input) => (input.fencingToken = 9), 'LEASE_EXPIRED');
    await rejected((input) => (input.contextId = 'ctx-other'), 'LEASE_EXPIRED');
    await rejected((input) => (input.contextVersion = 7), 'LEASE_EXPIRED');
    await rejected(
      (input) => (input.profileId = 'profile-other'),
      'LEASE_EXPIRED',
    );
    await rejected((input) => (input.profileVersion = 8), 'LEASE_EXPIRED');
    await rejected(
      (input) => (input.workerId = 'worker-other'),
      'LEASE_EXPIRED',
    );
    await rejected(
      (input) => (input.expiresAt = '2026-10-09T00:00:00.000Z'),
      'LEASE_EXPIRED',
    );
    await rejected(
      (input) => (input.deadline = '2026-10-06T00:00:00.000Z'),
      'LEASE_EXPIRED',
    );
    await rejected(
      (input) => (input.deadline = '2026-10-09T00:00:00.000Z'),
      'VALIDATION_ERROR',
    );
    await rejected(
      (input) => (input.deadline = 'not-a-date'),
      'VALIDATION_ERROR',
    );
    await rejected('aborted-signal', 'CANCELLED');
  },
);

await check(
  'a capture grant exports once, only through the fake runtime gate',
  async () => {
    const { port, calls, gateCalls } = harness();
    const approved = grant();
    const exported = await port.exportAuthState(approved);
    assert.equal(exported.cookies[0].name, 'sid');
    assert.equal(exported.cookies[0].value, secret);
    assert.equal(gateCalls.authorizeExport, 1);
    assert.equal(gateCalls.authorize, 0);
    assert.deepEqual(calls, [['export']]);
    // The private ticket only crosses the gate boundary, frozen and unaltered.
    const seen = gateCalls.grants[0];
    assert.equal(seen.captureTicket, ticket);
    assert.equal(seen.grantId, 'capture-1');
    assert.equal(Object.isFrozen(seen), true);
    assert.equal(exported.cookies[0].value === ticket, false);
    assert.equal(JSON.stringify(exported).includes(ticket), false);

    await port.close();
    await assert.rejects(
      port.exportAuthState(grant({ grantId: 'capture-after-close' })),
      (error) => error.code === 'VALIDATION_ERROR',
    );
    assert.equal(gateCalls.authorizeExport, 1);
    assert.deepEqual(calls, [['export']]);
  },
);

await check(
  'duplicate and overlapping exports of one grant never run twice',
  async () => {
    const blocked = deferred();
    const calls = [];
    let authorizations = 0;
    const port = createPrivateAuthPort({
      binding,
      allowedOrigins: origins,
      now: () => Date.parse(baseNow),
      gate: {
        authorize: async () => {
          authorizations += 1;
        },
        authorizeExport: () => {
          authorizations += 1;
          return blocked.promise;
        },
      },
      primitives: primitivesStub(calls),
    });
    const approved = grant({ grantId: 'capture-once' });
    const first = port.exportAuthState(approved);
    await Promise.resolve();
    await assert.rejects(port.exportAuthState(approved), (error) => {
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.message, 'VALIDATION_ERROR');
      return true;
    });
    blocked.resolve();
    await first;
    await assert.rejects(
      port.exportAuthState(grant({ grantId: 'capture-once' })),
      (error) => {
        assert.equal(error.code, 'VALIDATION_ERROR');
        return true;
      },
    );
    assert.equal(authorizations, 1);
    assert.deepEqual(calls, [['export']]);

    const second = await port.exportAuthState(
      grant({ grantId: 'capture-two' }),
    );
    assert.equal(second.cookies[0].name, 'sid');
    assert.deepEqual(calls, [['export'], ['export']]);
  },
);

await check(
  'a grant mutated during a blocked gate cannot change what is approved or exported',
  async () => {
    const blocked = deferred();
    const calls = [];
    const seenGrants = [];
    const approved = grant({ grantId: 'capture-mutated' });
    const custom = createPrivateAuthPort({
      binding,
      allowedOrigins: origins,
      now: () => Date.parse(baseNow),
      gate: {
        authorize: async () => {},
        authorizeExport: (input) => {
          seenGrants.push(input.grant);
          return blocked.promise;
        },
      },
      primitives: primitivesStub(calls),
    });
    const pending = custom.exportAuthState(approved);
    approved.sessionId = 'sess-injected';
    approved.authEpoch = 99;
    approved.deadline = '2026-10-07T00:29:00.000Z';
    approved.captureTicket = 'ticket-injected';
    approved.kind = 'import_storage_state';
    blocked.resolve();
    const exported = await pending;
    const seen = seenGrants[0];
    assert.equal(seen.sessionId, binding.sessionId);
    assert.equal(seen.authEpoch, binding.authEpoch);
    assert.equal(seen.deadline, deadline);
    assert.equal(seen.captureTicket, ticket);
    assert.equal(seen.kind, 'capture_auth_state');
    assert.equal(JSON.stringify(seen).includes('injected'), false);
    assert.equal(JSON.stringify(exported).includes('injected'), false);
    assert.deepEqual(calls, [['export']]);

    // The same frozen grant cannot be replayed with a tampered copy either.
    await assert.rejects(
      custom.exportAuthState(
        grant({ grantId: 'capture-mutated', sessionId: 'sess-injected' }),
      ),
      (error) => error.code === 'LEASE_EXPIRED',
    );
    assert.deepEqual(calls, [['export']]);
    await custom.close();
  },
);

await check(
  'gate rejection, abort, expiry and close during a capture return no material',
  async () => {
    const run = async (scenario, expected) => {
      const calls = [];
      let releases = null;
      const clock = { value: Date.parse(baseNow) };
      const controller = new AbortController();
      const exportPrimitive = () => {
        calls.push(['export']);
        return { cookies: [] };
      };
      const port = createPrivateAuthPort({
        binding,
        allowedOrigins: origins,
        now: () => clock.value,
        gate: {
          authorize: async () => {},
          authorizeExport: async () => {
            calls.push(['gate-export']);
            if (scenario === 'rejected') throw new Error(`${ticket}:${secret}`);
            if (scenario === 'blocked') await releases.promise;
            if (scenario === 'aborted') controller.abort();
            if (scenario === 'expired')
              clock.value = Date.parse('2026-10-09T00:00:00.000Z');
            if (scenario === 'closed') await port.close();
          },
        },
        primitives: {
          ...primitivesStub(calls),
          exportState: async () => exportPrimitive(),
        },
      });
      if (scenario === 'blocked') {
        releases = deferred();
        const pending = port.exportAuthState(
          grant({ grantId: `capture-${scenario}` }),
          controller.signal,
        );
        await port.close();
        releases.resolve();
        await assert.rejects(pending, (error) => {
          assert.equal(error.code, 'VALIDATION_ERROR');
          return true;
        });
      } else {
        await assert.rejects(
          port.exportAuthState(
            grant({ grantId: `capture-${scenario}` }),
            controller.signal,
          ),
          (error) => {
            assert.equal(error.code, expected);
            assert.equal(error.message, expected);
            assert.equal(String(error).includes(ticket), false);
            assert.equal(String(error).includes(secret), false);
            return true;
          },
        );
      }
      assert.equal(exportedCalls(calls), 0);
    };
    await run('rejected', 'VALIDATION_ERROR');
    await run('aborted', 'CANCELLED');
    await run('expired', 'LEASE_EXPIRED');
    await run('closed', 'VALIDATION_ERROR');
    await run('blocked', 'VALIDATION_ERROR');
  },
);

await check(
  'the private ticket never appears in a returned snapshot or error',
  async () => {
    const blocked = deferred();
    const calls = [];
    const port = createPrivateAuthPort({
      binding,
      allowedOrigins: origins,
      now: () => Date.parse(baseNow),
      gate: {
        authorize: async () => {},
        authorizeExport: () => blocked.promise,
      },
      primitives: {
        ...primitivesStub(calls),
        async navigate() {
          calls.push(['navigate']);
          return snapshot(ticket);
        },
      },
    });
    const pending = port.exportAuthState(grant({ grantId: 'capture-ticket' }));
    await Promise.resolve();
    blocked.resolve();
    await pending;
    const echoed = await port.executeAuth(
      permit({ grantId: 'after-capture' }),
      { kind: 'navigate' },
      signal(),
    );
    assert.equal(JSON.stringify(echoed.snapshot).includes(ticket), false);
    await port.close();
  },
);

await check(
  'export in flight rejects after close, abort, or expiry',
  async () => {
    // The gate passes, then the capture itself hangs: the post-export re-check
    // must discard the material instead of returning it.
    const build = (calls) =>
      createPrivateAuthPort({
        binding,
        allowedOrigins: origins,
        now: () => clock.value,
        gate: { authorize: async () => {}, authorizeExport: async () => {} },
        primitives: {
          ...primitivesStub(calls),
          exportState: () => {
            calls.push(['export']);
            return inFlight.promise;
          },
        },
      });
    const clock = { value: Date.parse(baseNow) };
    let inFlight;

    const closeCalls = [];
    inFlight = deferred();
    const port = build(closeCalls);
    const controller = new AbortController();
    const pending = port.exportAuthState(
      grant({ grantId: 'capture-close' }),
      controller.signal,
    );
    await Promise.resolve();
    await port.close();
    inFlight.resolve({ cookies: [] });
    await assert.rejects(pending, (error) => error.code === 'VALIDATION_ERROR');
    assert.equal(exportedCalls(closeCalls), 1);

    const abortCalls = [];
    inFlight = deferred();
    const aborted = new AbortController();
    const abortPort = build(abortCalls);
    const aborting = abortPort.exportAuthState(
      grant({ grantId: 'capture-abort' }),
      aborted.signal,
    );
    await Promise.resolve();
    aborted.abort();
    inFlight.resolve({ cookies: [] });
    await assert.rejects(aborting, (error) => error.code === 'CANCELLED');
    assert.equal(exportedCalls(abortCalls), 1);

    const expiryCalls = [];
    inFlight = deferred();
    const expiryPort = build(expiryCalls);
    const expiring = expiryPort.exportAuthState(
      grant({ grantId: 'capture-expiry' }),
      signal(),
    );
    await Promise.resolve();
    clock.value = Date.parse('2026-10-09T00:00:00.000Z');
    inFlight.resolve({ cookies: [] });
    await assert.rejects(expiring, (error) => error.code === 'LEASE_EXPIRED');
    assert.equal(exportedCalls(expiryCalls), 1);
  },
);

await check(
  'grant accessors, cycles, and non-plain grants are rejected without running getters',
  async () => {
    const rejected = async (input, expected = 'VALIDATION_ERROR') => {
      const calls = [];
      let gateExports = 0;
      const port = createPrivateAuthPort({
        binding,
        allowedOrigins: origins,
        now: () => Date.parse(baseNow),
        gate: {
          authorize: async () => {},
          authorizeExport: async () => {
            gateExports += 1;
          },
        },
        primitives: primitivesStub(calls),
      });
      await assert.rejects(port.exportAuthState(input), (error) => {
        assert.equal(error.code, expected);
        assert.equal(error.message, expected);
        assert.equal(String(error).includes(ticket), false);
        return true;
      });
      assert.deepEqual(calls, []);
      assert.equal(gateExports, 0);
    };
    let accessed = 0;
    const accessor = grant();
    Object.defineProperty(accessor, 'captureTicket', {
      enumerable: true,
      get() {
        accessed += 1;
        return ticket;
      },
    });
    await rejected(accessor);
    assert.equal(accessed, 0);

    const cyclic = grant();
    cyclic.self = cyclic;
    await rejected(cyclic);

    class Grant {
      constructor() {
        Object.assign(this, grant());
      }
    }
    await rejected(new Grant());

    const nested = grant();
    nested.extra = { deep: { deeper: [1, 2, 3] } };
    const { port } = harness();
    await assert.rejects(port.exportAuthState(nested), (error) => {
      assert.equal(error.code, 'VALIDATION_ERROR');
      return true;
    });
  },
);

await check(
  'the first navigation cannot expose material the port was not told about',
  async () => {
    const material = 'SyntheticAuthMaterialOnly';
    const other = 'SyntheticPasswordOnly';
    const build = () => {
      const navigations = [];
      const port = createPrivateAuthPort({
        binding,
        allowedOrigins: origins,
        now: () => Date.parse(baseNow),
        gate: {
          authorize: async () => {},
          authorizeExport: async () => {},
        },
        primitives: {
          ...primitivesStub([]),
          async navigate(url) {
            navigations.push(url);
            // An auto-filled login page echoes both credentials back.
            const echoed = snapshot(material, material);
            echoed.title = `Welcome ${material}`;
            echoed.displayUrl = `${origins[0]}/login?u=${encodeURIComponent(other)}`;
            return echoed;
          },
        },
      });
      return { port, navigations };
    };

    // Documented gap: without priming, the port cannot know the values yet, so
    // the first snapshot after navigation would expose them.
    const unprimed = build();
    const leaked = await unprimed.port.executeAuth(
      permit(),
      { kind: 'navigate' },
      signal(),
    );
    assert.equal(JSON.stringify(leaked.snapshot).includes(material), true);
    await unprimed.port.close();

    // Primed before any effect: the very first snapshot is already scrubbed.
    const primed = build();
    primed.port.primeSensitiveValues([material, other]);
    const clean = await primed.port.executeAuth(
      permit(),
      { kind: 'navigate' },
      signal(),
    );
    const exposed = JSON.stringify(clean.snapshot);
    assert.equal(exposed.includes(material), false);
    assert.equal(exposed.includes(other), false);
    assert.equal(exposed.includes(encodeURIComponent(other)), false);
    assert.equal(exposed.includes('•'), true);
    await primed.port.close();
  },
);

await check(
  'priming refuses malformed input without echoing it or running getters',
  async () => {
    const { port } = harness();
    const refused = (value, leak) => {
      assert.throws(
        () => port.primeSensitiveValues(value),
        (error) => {
          assert.equal(error.code, 'VALIDATION_ERROR');
          assert.equal(error.message, 'VALIDATION_ERROR');
          if (leak) assert.equal(String(error).includes(leak), false);
          return true;
        },
      );
    };
    refused(undefined);
    refused(null);
    refused('a string');
    refused(42);
    refused({});
    refused(['']);
    refused([42]);
    refused([user, '']);
    refused(['x'.repeat(4097)], 'x'.repeat(64));
    refused(Array(33).fill('value'));
    const sparse = [];
    sparse[1] = user;
    refused(sparse);
    class Values extends Array {}
    refused(new Values(user));

    // Accessors are rejected without being invoked.
    let accessed = 0;
    const accessor = [user];
    Object.defineProperty(accessor, '0', {
      enumerable: true,
      get() {
        accessed += 1;
        return user;
      },
    });
    refused(accessor, user);
    assert.equal(accessed, 0);

    // A valid prime still works after the refusals, and close refuses new ones.
    port.primeSensitiveValues([user, secret]);
    await port.close();
    refused([user], user);
  },
);

await check(
  'redactObservation scrubs a fresh observation with the registered material',
  async () => {
    const material = 'SyntheticAuthMaterialOnly';
    const { port } = harness();
    port.primeSensitiveValues([material]);
    const fresh = snapshot(material, material);
    fresh.title = `Welcome ${material}`;
    fresh.displayUrl = `http://fixture.local.test:8080/login?u=${material}`;
    const redacted = port.redactObservation(fresh);
    const exposed = JSON.stringify(redacted);
    assert.equal(exposed.includes(material), false);
    assert.equal(redacted.redacted, true);
    assert.equal(redacted.screenshotRef, null);
    assert.equal(redacted.snapshotId, fresh.snapshotId);
    assert.equal(redacted.pageId, fresh.pageId);
    // A detached, frozen copy: the raw observation is untouched.
    assert.notEqual(redacted, fresh);
    assert.equal(JSON.stringify(fresh).includes(material), true);
    assert.equal(Object.isFrozen(redacted), true);

    assert.throws(
      () => port.redactObservation(null),
      (error) => error.code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () => port.redactObservation({ nodes: undefined }),
      (error) => error.code === 'VALIDATION_ERROR',
    );
    await port.close();
    assert.throws(
      () => port.redactObservation(fresh),
      (error) => error.code === 'VALIDATION_ERROR',
    );
  },
);

await check(
  'redactObservation refuses accessors, cycles, and exotic prototypes without running getters',
  async () => {
    const { port } = harness();
    port.primeSensitiveValues([secret]);
    let reads = 0;
    const refused = (value) =>
      assert.throws(
        () => port.redactObservation(value),
        (error) =>
          error.code === 'VALIDATION_ERROR' &&
          error.message === 'VALIDATION_ERROR',
      );

    const titleAccessor = snapshot('ordinary');
    Object.defineProperty(titleAccessor, 'title', {
      enumerable: true,
      get() {
        reads += 1;
        return secret;
      },
    });
    refused(titleAccessor);

    const nodesAccessor = snapshot('ordinary');
    Object.defineProperty(nodesAccessor, 'nodes', {
      enumerable: true,
      get() {
        reads += 1;
        return [];
      },
    });
    refused(nodesAccessor);
    assert.equal(reads, 0);

    const cyclic = snapshot('ordinary');
    cyclic.self = cyclic;
    refused(cyclic);

    class Holder {}
    const exotic = new Holder();
    Object.assign(exotic, snapshot('ordinary'));
    refused(exotic);

    const hidden = snapshot('ordinary');
    Object.defineProperty(hidden, 'trace', { enumerable: false, value: 'x' });
    refused(hidden);
    await port.close();
  },
);

await check(
  'redactObservation never freezes or aliases the caller-owned objects',
  async () => {
    const { port } = harness();
    port.primeSensitiveValues([secret]);
    const raw = snapshot(secret, secret);
    raw.title = `Welcome ${secret}`;
    const copy = port.redactObservation(raw);
    assert.notEqual(copy.viewport, raw.viewport);
    assert.notEqual(copy.nodes[0].bounds, raw.nodes[0].bounds);
    assert.equal(Object.isFrozen(raw.viewport), false);
    assert.equal(Object.isFrozen(raw.nodes[0].bounds), false);
    assert.equal(Object.isFrozen(copy.viewport), true);
    assert.equal(Object.isFrozen(copy.nodes[0].bounds), true);
    assert.equal(JSON.stringify(copy).includes(secret), false);
    // The caller's own object keeps its data: we copy, redact, and never mutate.
    assert.equal(JSON.stringify(raw).includes(secret), true);
    assert.equal(raw.redacted, false);
    await port.close();
  },
);

await check(
  'T23 trusted renewal after old lease expires preserves identity and redaction',
  async () => {
    const prior = {
      ...binding,
      expiresAt: '2026-10-07T00:00:30.000Z',
    };
    let now = Date.parse('2026-10-07T00:00:35.000Z');
    const calls = [];
    let renewals = 0;
    const port = createPrivateAuthPort({
      binding: prior,
      allowedOrigins: origins,
      now: () => now,
      trustedRenewal: async () => {
        renewals++;
        return { ...prior, expiresAt: '2026-10-07T00:02:00.000Z' };
      },
      gate: {
        authorize: async () => {},
        authorizeExport: async () => {},
      },
      primitives: primitivesStub(calls),
    });
    port.primeSensitiveValues([secret]);
    const result = await port.executeAuth(
      permit({
        grantId: 't23-renewed',
        deadline: '2026-10-07T00:01:00.000Z',
      }),
      { kind: 'navigate' },
      signal(),
    );
    assert.equal(result.snapshot.redacted, true);
    assert.equal(JSON.stringify(result.snapshot).includes(secret), false);
    assert.deepEqual(calls, [
      ['navigate', 'http://fixture.local.test:8080/login'],
    ]);
    assert.ok(renewals > 0);
    now = Date.parse('2026-10-07T00:02:01.000Z');
    await assert.rejects(
      port.renewAuthority(),
      (error) => error.code === 'LEASE_EXPIRED',
    );
    await port.close();
  },
);

await check(
  'T23 identity swap, revoked session and unbounded expiry cannot renew a private port',
  async () => {
    const prior = { ...binding, expiresAt: '2026-10-07T00:00:30.000Z' };
    let authority = { ...prior, expiresAt: '2026-10-07T00:02:00.000Z' };
    const calls = [];
    const port = createPrivateAuthPort({
      binding: prior,
      allowedOrigins: origins,
      now: () => Date.parse('2026-10-07T00:00:36.000Z'),
      trustedRenewal: async () => authority,
      gate: { authorize: async () => {}, authorizeExport: async () => {} },
      primitives: primitivesStub(calls),
    });
    for (const changed of [
      { ...authority, workerId: 'other-worker' },
      { ...authority, authEpoch: 2 },
      { ...authority, fencingToken: 5 },
      { ...authority, status: 'revoked' },
      { ...authority, expiresAt: '2026-10-07T00:20:00.000Z' },
    ]) {
      authority = changed;
      await assert.rejects(
        port.renewAuthority(),
        (error) => error.code === 'LEASE_EXPIRED',
      );
    }
    assert.deepEqual(calls, []);
    await port.close();
    await assert.rejects(
      port.renewAuthority(),
      (error) => error.code === 'VALIDATION_ERROR',
    );
  },
);

const failed = cases.filter((item) => !item.passed);
console.log(JSON.stringify({ cases, P0Passed: false }, null, 2));
if (failed.length) process.exitCode = 1;
