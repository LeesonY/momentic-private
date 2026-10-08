import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateApprovedAuthState } from '../dist/index.js';

const APPROVED = 'http://fixture.local.test:8080';
const HOST = 'fixture.local.test';
const SECRET = 's3cret-cookie-value-4a-unique';

function cookie(overrides = {}) {
  return {
    name: 'sid',
    value: 'ok',
    domain: HOST,
    path: '/',
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    cookies: [cookie()],
    origins: [
      {
        origin: APPROVED,
        localStorage: [{ name: 'k', value: 'v' }],
      },
    ],
    ...overrides,
  };
}

function rejects(input, origins, code, leak = SECRET) {
  let thrown;
  try {
    validateApprovedAuthState(input, origins);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, 'expected validation to throw');
  assert.equal(thrown.code, code);
  assert.equal(thrown.message, code);
  const blob = `${thrown.message}\n${thrown.stack ?? ''}\n${String(thrown)}`;
  assert.equal(blob.includes(leak), false);
}

test('empty object is allowed and is not an authenticated proof', () => {
  const result = validateApprovedAuthState({}, [APPROVED]);
  assert.deepEqual(result, {});
  assert.equal(Object.hasOwn(result, 'cookies'), false);
  assert.equal(Object.hasOwn(result, 'origins'), false);
});

test('empty arrays are allowed', () => {
  const result = validateApprovedAuthState({ cookies: [], origins: [] }, [
    APPROVED,
  ]);
  assert.deepEqual(result, { cookies: [], origins: [] });
});

test('JSON string of a valid state returns a detached copy', () => {
  const result = validateApprovedAuthState(JSON.stringify(state()), [APPROVED]);
  assert.equal(result.cookies[0].value, 'ok');
  assert.equal(result.origins[0].origin, APPROVED);
});

test('plain object is accepted and not mutated', () => {
  const input = state();
  const result = validateApprovedAuthState(input, [APPROVED]);
  assert.notEqual(result, input);
  assert.notEqual(result.cookies, input.cookies);
  assert.notEqual(result.cookies[0], input.cookies[0]);
  assert.notEqual(result.origins, input.origins);
  assert.notEqual(result.origins[0], input.origins[0]);
  assert.notEqual(
    result.origins[0].localStorage,
    input.origins[0].localStorage,
  );
  result.cookies[0].value = 'mutated-result';
  result.origins[0].localStorage[0].value = 'mutated-ls';
  assert.equal(input.cookies[0].value, 'ok');
  assert.equal(input.origins[0].localStorage[0].value, 'v');
  input.cookies[0].value = 'mutated-input';
  input.cookies.push(cookie({ name: 'other' }));
  assert.equal(result.cookies[0].value, 'mutated-result');
  assert.equal(result.cookies.length, 1);
});

test('approvedOrigins may include a path; membership uses URL.origin', () => {
  const result = validateApprovedAuthState(state(), [`${APPROVED}/login`]);
  assert.equal(result.origins[0].origin, APPROVED);
});

test('shape: root must be a plain object', () => {
  for (const input of [null, undefined, 1, true, [], 'not-json']) {
    rejects(input, [APPROVED], 'VALIDATION_ERROR', 'not-json');
  }
});

test('shape: unknown fields are rejected', () => {
  rejects({ ...state(), extra: true }, [APPROVED], 'VALIDATION_ERROR');
  rejects({ cookies: [cookie({ extra: 1 })] }, [APPROVED], 'VALIDATION_ERROR');
  rejects(
    {
      origins: [{ origin: APPROVED, localStorage: [], indexedDB: [] }],
    },
    [APPROVED],
    'VALIDATION_ERROR',
  );
});

test('shape: dangerous keys, getters and non-plain objects', () => {
  rejects(
    JSON.parse(`{"__proto__":{"polluted":"${SECRET}"},"cookies":[]}`),
    [APPROVED],
    'VALIDATION_ERROR',
  );
  const withCtor = { cookies: [], constructor: { name: SECRET } };
  rejects(withCtor, [APPROVED], 'VALIDATION_ERROR');
  const getter = {
    cookies: [],
  };
  Object.defineProperty(getter, 'origins', {
    enumerable: true,
    get: () => [
      { origin: APPROVED, localStorage: [{ name: 'k', value: SECRET }] },
    ],
  });
  rejects(getter, [APPROVED], 'VALIDATION_ERROR');
  rejects({ cookies: new Date() }, [APPROVED], 'VALIDATION_ERROR');
  const proto = { cookies: [] };
  Object.setPrototypeOf(proto, { injected: SECRET });
  rejects(proto, [APPROVED], 'VALIDATION_ERROR');
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
});

test('shape: cookie flags, SameSite and non-finite expires', () => {
  rejects(
    { cookies: [cookie({ sameSite: 'lax' })] },
    [APPROVED],
    'VALIDATION_ERROR',
  );
  rejects(
    { cookies: [cookie({ sameSite: 'strict' })] },
    [APPROVED],
    'VALIDATION_ERROR',
  );
  rejects(
    { cookies: [cookie({ httpOnly: 1 })] },
    [APPROVED],
    'VALIDATION_ERROR',
  );
  rejects(
    { cookies: [cookie({ secure: 'true' })] },
    [APPROVED],
    'VALIDATION_ERROR',
  );
  rejects(
    { cookies: [cookie({ expires: Number.NaN })] },
    [APPROVED],
    'VALIDATION_ERROR',
  );
  rejects(
    { cookies: [cookie({ expires: Number.POSITIVE_INFINITY })] },
    [APPROVED],
    'VALIDATION_ERROR',
  );
  const ok = validateApprovedAuthState(
    {
      cookies: [
        cookie({
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax',
        }),
      ],
    },
    [APPROVED],
  );
  assert.equal(ok.cookies[0].sameSite, 'Lax');
  assert.equal(ok.cookies[0].expires, -1);
});

test('size: cookie, origin and localStorage counts', () => {
  const cookiesOk = Array.from({ length: 50 }, (_, i) =>
    cookie({ name: `n${i}` }),
  );
  assert.equal(
    validateApprovedAuthState({ cookies: cookiesOk }, [APPROVED]).cookies
      .length,
    50,
  );
  rejects(
    { cookies: [...cookiesOk, cookie({ name: 'n50' })] },
    [APPROVED],
    'VALIDATION_ERROR',
  );
  const originsOk = Array.from({ length: 30 }, (_, i) => ({
    origin: `http://o${i}.fixture.local.test:8080`,
    localStorage: [],
  }));
  const approvedMany = originsOk.map((entry) => entry.origin);
  assert.equal(
    validateApprovedAuthState({ origins: originsOk }, approvedMany).origins
      .length,
    30,
  );
  rejects(
    {
      origins: [
        ...originsOk,
        { origin: 'http://o30.fixture.local.test:8080', localStorage: [] },
      ],
    },
    [...approvedMany, 'http://o30.fixture.local.test:8080'],
    'VALIDATION_ERROR',
  );
  const keysOk = Array.from({ length: 32 }, (_, i) => ({
    name: `k${i}`,
    value: 'v',
  }));
  assert.equal(
    validateApprovedAuthState(
      { origins: [{ origin: APPROVED, localStorage: keysOk }] },
      [APPROVED],
    ).origins[0].localStorage.length,
    32,
  );
  rejects(
    {
      origins: [
        {
          origin: APPROVED,
          localStorage: [...keysOk, { name: 'k32', value: 'v' }],
        },
      ],
    },
    [APPROVED],
    'VALIDATION_ERROR',
  );
});

test('size: per-value UTF-8 bytes, no truncation', () => {
  const max = 'a'.repeat(4096);
  assert.equal(
    validateApprovedAuthState({ cookies: [cookie({ value: max })] }, [APPROVED])
      .cookies[0].value.length,
    4096,
  );
  rejects(
    { cookies: [cookie({ value: `${max}x` })] },
    [APPROVED],
    'VALIDATION_ERROR',
  );
  const emoji = '\u{1F600}'.repeat(1024);
  assert.equal(emoji.length, 2048);
  assert.equal(
    validateApprovedAuthState(
      {
        origins: [
          { origin: APPROVED, localStorage: [{ name: 'e', value: emoji }] },
        ],
      },
      [APPROVED],
    ).origins[0].localStorage[0].value,
    emoji,
  );
  rejects(
    {
      origins: [
        {
          origin: APPROVED,
          localStorage: [{ name: 'e', value: `${emoji}\u{1F600}` }],
        },
      ],
    },
    [APPROVED],
    'VALIDATION_ERROR',
  );
});

test('size: JSON string counted as UTF-8 before parse', () => {
  const json = '{"cookies":[]}';
  const padded = `${' '.repeat(65536 - json.length)}${json}`;
  assert.equal(Buffer.byteLength(padded, 'utf8'), 65536);
  assert.deepEqual(validateApprovedAuthState(padded, [APPROVED]), {
    cookies: [],
  });
  rejects(`${padded} `, [APPROVED], 'VALIDATION_ERROR');
  const cjk = '\u4f60'.repeat(21846);
  assert.ok(Buffer.byteLength(cjk, 'utf8') > 65536);
  rejects(cjk, [APPROVED], 'VALIDATION_ERROR', '\u4f60');
});

test('size: object is shaped first then serialized UTF-8 counted', () => {
  const items = Array.from({ length: 32 }, (_, i) => ({
    name: `k${i}`,
    value: 'b'.repeat(2500),
  }));
  const payload = { origins: [{ origin: APPROVED, localStorage: items }] };
  assert.equal(
    Buffer.byteLength(JSON.stringify(payload), 'utf8') > 65536,
    true,
  );
  rejects(payload, [APPROVED], 'VALIDATION_ERROR');
});

test('origin must be a canonical HTTP(S) origin in the approved URL.origin set', () => {
  rejects(
    { origins: [{ origin: `${APPROVED}/app`, localStorage: [] }] },
    [APPROVED],
    'VALIDATION_ERROR',
  );
  rejects(
    { origins: [{ origin: `${APPROVED}?q=1`, localStorage: [] }] },
    [APPROVED],
    'VALIDATION_ERROR',
  );
  rejects(
    { origins: [{ origin: `${APPROVED}#h`, localStorage: [] }] },
    [APPROVED],
    'VALIDATION_ERROR',
  );
  rejects(
    {
      origins: [
        {
          origin: 'http://user:pass@fixture.local.test:8080',
          localStorage: [],
        },
      ],
    },
    [APPROVED],
    'VALIDATION_ERROR',
    'pass',
  );
  rejects(
    { origins: [{ origin: `${APPROVED}/`, localStorage: [] }] },
    [APPROVED],
    'VALIDATION_ERROR',
  );
  rejects(
    {
      origins: [{ origin: 'ftp://fixture.local.test:8080', localStorage: [] }],
    },
    [APPROVED],
    'VALIDATION_ERROR',
  );
  rejects(
    {
      origins: [
        { origin: 'http://other.fixture.local.test:8080', localStorage: [] },
      ],
    },
    [APPROVED],
    'TARGET_NOT_ALLOWED',
  );
  rejects(
    {
      origins: [
        { origin: 'https://fixture.local.test:8080', localStorage: [] },
      ],
    },
    [APPROVED],
    'TARGET_NOT_ALLOWED',
  );
});

test('cookie.domain matches approved hostname after leading-dot and case fold', () => {
  assert.equal(
    validateApprovedAuthState(
      { cookies: [cookie({ domain: '.fixture.local.test' })] },
      [APPROVED],
    ).cookies[0].domain,
    '.fixture.local.test',
  );
  assert.equal(
    validateApprovedAuthState(
      { cookies: [cookie({ domain: 'Fixture.Local.Test' })] },
      [APPROVED],
    ).cookies[0].domain,
    'Fixture.Local.Test',
  );
  rejects(
    { cookies: [cookie({ domain: 'sub.fixture.local.test', value: SECRET })] },
    [APPROVED],
    'TARGET_NOT_ALLOWED',
  );
  rejects(
    { cookies: [cookie({ domain: 'other.test', value: SECRET })] },
    [APPROVED],
    'TARGET_NOT_ALLOWED',
  );
});

test('duplicate origin, localStorage key and cookie identity are rejected', () => {
  rejects(
    {
      origins: [
        { origin: APPROVED, localStorage: [] },
        { origin: APPROVED, localStorage: [{ name: 'k', value: '1' }] },
      ],
    },
    [APPROVED],
    'VALIDATION_ERROR',
  );
  rejects(
    {
      origins: [
        {
          origin: APPROVED,
          localStorage: [
            { name: 'k', value: '1' },
            { name: 'k', value: '2' },
          ],
        },
      ],
    },
    [APPROVED],
    'VALIDATION_ERROR',
  );
  rejects(
    {
      cookies: [
        cookie({ domain: '.fixture.local.test' }),
        cookie({ domain: 'Fixture.Local.Test' }),
      ],
    },
    [APPROVED],
    'VALIDATION_ERROR',
  );
  assert.equal(
    validateApprovedAuthState(
      {
        cookies: [cookie({ path: '/' }), cookie({ path: '/app' })],
      },
      [APPROVED],
    ).cookies.length,
    2,
  );
});

test('shared localStorage array is an alias, not a cycle', () => {
  const other = 'http://other.fixture.local.test:8080';
  const shared = [];
  const input = {
    origins: [
      { origin: APPROVED, localStorage: shared },
      { origin: other, localStorage: shared },
    ],
  };
  const fromObject = validateApprovedAuthState(input, [APPROVED, other]);
  const fromString = validateApprovedAuthState(JSON.stringify(input), [
    APPROVED,
    other,
  ]);
  assert.deepEqual(fromObject, fromString);
  assert.deepEqual(fromObject.origins[0].localStorage, []);
  assert.notEqual(
    fromObject.origins[0].localStorage,
    fromObject.origins[1].localStorage,
  );
  assert.notEqual(fromObject.origins[0].localStorage, shared);
  const cycle = [];
  const entry = { origin: APPROVED, localStorage: cycle };
  cycle.push(entry);
  rejects({ origins: [entry] }, [APPROVED], 'VALIDATION_ERROR');
});

test('non-canonical array keys and accessors are rejected without calling getters', () => {
  let calls = 0;
  const cookies = [cookie({ name: 'a' })];
  Object.defineProperty(cookies, '01', {
    enumerable: true,
    configurable: true,
    get() {
      calls += 1;
      return cookie({ name: 'hidden', value: SECRET });
    },
  });
  rejects({ cookies }, [APPROVED], 'VALIDATION_ERROR');
  assert.equal(calls, 0);
  calls = 0;
  const oversized = [];
  Object.defineProperty(oversized, '0', {
    enumerable: true,
    configurable: true,
    get() {
      calls += 1;
      return cookie();
    },
  });
  oversized.length = 51;
  rejects({ cookies: oversized }, [APPROVED], 'VALIDATION_ERROR');
  assert.equal(calls, 0);
});

test('output serialization cap applies to string input as well as objects', () => {
  const value = '\uD800'.repeat(1365);
  const domain = 'local.test.host';
  const payload = {
    cookies: Array.from({ length: 8 }, (_, index) =>
      cookie({ name: `n${index}`, value, domain }),
    ),
  };
  const text = JSON.stringify(payload).replaceAll('\\ud800', '\uD800');
  const outputBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  assert.equal(Buffer.byteLength(text, 'utf8'), 33277);
  assert.equal(outputBytes, 66037);
  rejects(text, ['http://local.test.host'], 'VALIDATION_ERROR', value);
  rejects(payload, ['http://local.test.host'], 'VALIDATION_ERROR', value);
});

test('failure text never echoes cookie values or JSON source', () => {
  rejects(
    {
      cookies: [cookie({ value: SECRET, domain: 'evil.example' })],
    },
    [APPROVED],
    'TARGET_NOT_ALLOWED',
  );
  rejects(
    `{"cookies":[{"name":"sid","value":"${SECRET}","domain":"${HOST}","path":"/","nope":true}]}`,
    [APPROVED],
    'VALIDATION_ERROR',
  );
});
