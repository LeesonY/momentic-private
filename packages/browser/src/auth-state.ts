import { STABLE_REASON_CODES, type ApprovedAuthState } from './types.js';

const LIMITS = {
  cookies: 50,
  origins: 30,
  localStorageKeysPerOrigin: 32,
  maxValueUtf8Bytes: 4096,
  maxSerializedUtf8Bytes: 65536,
} as const;

const ROOT_KEYS = new Set(['cookies', 'origins']);
const COOKIE_KEYS = new Set([
  'name',
  'value',
  'domain',
  'path',
  'expires',
  'httpOnly',
  'secure',
  'sameSite',
]);
const COOKIE_REQUIRED = ['name', 'value', 'domain', 'path'] as const;
const ORIGIN_ENTRY_KEYS = new Set(['origin', 'localStorage']);
const STORAGE_ITEM_KEYS = new Set(['name', 'value']);
const SAME_SITE = new Set(['Strict', 'Lax', 'None']);
const DANGEROUS_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

const encoder = new TextEncoder();

export class AuthStateError extends Error {
  readonly code:
    | typeof STABLE_REASON_CODES.VALIDATION_ERROR
    | typeof STABLE_REASON_CODES.TARGET_NOT_ALLOWED;
  constructor(
    code:
      | typeof STABLE_REASON_CODES.VALIDATION_ERROR
      | typeof STABLE_REASON_CODES.TARGET_NOT_ALLOWED,
  ) {
    super(code);
    this.name = 'AuthStateError';
    this.code = code;
  }
}

function fail(
  code:
    | typeof STABLE_REASON_CODES.VALIDATION_ERROR
    | typeof STABLE_REASON_CODES.TARGET_NOT_ALLOWED = STABLE_REASON_CODES.VALIDATION_ERROR,
): never {
  throw new AuthStateError(code);
}

function utf8Bytes(text: string): number {
  return encoder.encode(text).byteLength;
}

function assertUtf8String(value: unknown, allowEmpty: boolean): string {
  if (typeof value !== 'string') fail();
  if (!allowEmpty && value.length === 0) fail();
  if (utf8Bytes(value) > LIMITS.maxValueUtf8Bytes) fail();
  return value;
}

function enter(visiting: WeakSet<object>, value: object): void {
  if (visiting.has(value)) fail();
  visiting.add(value);
}

function leave(visiting: WeakSet<object>, value: object): void {
  visiting.delete(value);
}

function assertPlainDataObject(
  value: unknown,
  allowed: ReadonlySet<string>,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail();
  const record = value as Record<string | symbol, unknown>;
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string') fail();
    if (DANGEROUS_KEYS.has(key) || !allowed.has(key)) fail();
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (
      !descriptor ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    )
      fail();
  }
  return record as Record<string, unknown>;
}

function canonicalIndex(key: string, length: number): number | undefined {
  if (key === '0') return length > 0 ? 0 : undefined;
  if (!/^[1-9][0-9]*$/.test(key)) return undefined;
  const index = Number(key);
  if (
    !Number.isSafeInteger(index) ||
    index >= length ||
    index >= 0xffffffff ||
    String(index) !== key
  )
    return undefined;
  return index;
}

function readArray<T>(
  value: unknown,
  maxLength: number,
  visiting: WeakSet<object>,
  read: (item: unknown) => T,
): T[] {
  if (!Array.isArray(value)) fail();
  if (Object.getPrototypeOf(value) !== Array.prototype) fail();
  enter(visiting, value);
  try {
    const lengthDesc = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      !lengthDesc ||
      lengthDesc.get !== undefined ||
      lengthDesc.set !== undefined ||
      !('value' in lengthDesc) ||
      typeof lengthDesc.value !== 'number' ||
      !Number.isSafeInteger(lengthDesc.value) ||
      lengthDesc.value < 0
    )
      fail();
    const length = lengthDesc.value;
    if (length > maxLength) fail();
    const indexes = new Set<number>();
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      if (typeof key !== 'string') fail();
      const index = canonicalIndex(key, length);
      if (index === undefined) fail();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable ||
        !('value' in descriptor)
      )
        fail();
      indexes.add(index);
    }
    if (indexes.size !== length) fail();
    const items: T[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) fail();
      items.push(read(descriptor.value));
    }
    return items;
  } finally {
    leave(visiting, value);
  }
}

function httpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail();
  if (url.username !== '' || url.password !== '') fail();
  return url;
}

function canonicalOrigin(value: string): string {
  const url = httpUrl(value);
  if (url.search !== '' || url.hash !== '') fail();
  if (url.pathname !== '/' && url.pathname !== '') fail();
  if (value !== url.origin) fail();
  return url.origin;
}

function approvedSets(approvedOrigins: readonly string[]): {
  origins: Set<string>;
  hosts: Set<string>;
} {
  const origins = new Set<string>();
  const hosts = new Set<string>();
  const list = readArray(
    approvedOrigins,
    Number.MAX_SAFE_INTEGER,
    new WeakSet<object>(),
    (item) => {
      if (typeof item !== 'string') fail();
      return item;
    },
  );
  for (const item of list) {
    const url = httpUrl(item);
    origins.add(url.origin);
    hosts.add(url.hostname.toLowerCase());
  }
  return { origins, hosts };
}

function cookieIdentity(name: string, domain: string, path: string): string {
  return `${name}\0${domain.replace(/^\./, '').toLowerCase()}\0${path}`;
}

function readCookie(
  value: unknown,
  hosts: ReadonlySet<string>,
  visiting: WeakSet<object>,
): NonNullable<ApprovedAuthState['cookies']>[number] {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail();
  enter(visiting, value);
  try {
    return readCookieFields(value, hosts);
  } finally {
    leave(visiting, value);
  }
}

function readCookieFields(
  value: object,
  hosts: ReadonlySet<string>,
): NonNullable<ApprovedAuthState['cookies']>[number] {
  const record = assertPlainDataObject(value, COOKIE_KEYS);
  for (const key of COOKIE_REQUIRED) {
    if (!Object.hasOwn(record, key)) fail();
  }
  const name = assertUtf8String(record.name, false);
  const cookieValue = assertUtf8String(record.value, true);
  const domain = assertUtf8String(record.domain, false);
  const path = assertUtf8String(record.path, false);
  const host = domain.replace(/^\./, '').toLowerCase();
  if (!hosts.has(host)) fail(STABLE_REASON_CODES.TARGET_NOT_ALLOWED);
  const cookie: NonNullable<ApprovedAuthState['cookies']>[number] = {
    name,
    value: cookieValue,
    domain,
    path,
  };
  if (Object.hasOwn(record, 'expires')) {
    if (typeof record.expires !== 'number' || !Number.isFinite(record.expires))
      fail();
    cookie.expires = record.expires;
  }
  if (Object.hasOwn(record, 'httpOnly')) {
    if (typeof record.httpOnly !== 'boolean') fail();
    cookie.httpOnly = record.httpOnly;
  }
  if (Object.hasOwn(record, 'secure')) {
    if (typeof record.secure !== 'boolean') fail();
    cookie.secure = record.secure;
  }
  if (Object.hasOwn(record, 'sameSite')) {
    if (typeof record.sameSite !== 'string' || !SAME_SITE.has(record.sameSite))
      fail();
    cookie.sameSite = record.sameSite as 'Strict' | 'Lax' | 'None';
  }
  return cookie;
}

function readStorageItem(
  value: unknown,
  visiting: WeakSet<object>,
): { name: string; value: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail();
  enter(visiting, value);
  try {
    const record = assertPlainDataObject(value, STORAGE_ITEM_KEYS);
    if (!Object.hasOwn(record, 'name') || !Object.hasOwn(record, 'value'))
      fail();
    return {
      name: assertUtf8String(record.name, false),
      value: assertUtf8String(record.value, true),
    };
  } finally {
    leave(visiting, value);
  }
}

function readOriginEntry(
  value: unknown,
  allowedOrigins: ReadonlySet<string>,
  visiting: WeakSet<object>,
): NonNullable<ApprovedAuthState['origins']>[number] {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail();
  enter(visiting, value);
  try {
    const record = assertPlainDataObject(value, ORIGIN_ENTRY_KEYS);
    if (
      !Object.hasOwn(record, 'origin') ||
      !Object.hasOwn(record, 'localStorage')
    )
      fail();
    const origin = canonicalOrigin(assertUtf8String(record.origin, false));
    if (!allowedOrigins.has(origin))
      fail(STABLE_REASON_CODES.TARGET_NOT_ALLOWED);
    const items = readArray(
      record.localStorage,
      LIMITS.localStorageKeysPerOrigin,
      visiting,
      (item) => readStorageItem(item, visiting),
    );
    const localStorage: { name: string; value: string }[] = [];
    const names = new Set<string>();
    for (const entry of items) {
      if (names.has(entry.name)) fail();
      names.add(entry.name);
      localStorage.push(entry);
    }
    return { origin, localStorage };
  } finally {
    leave(visiting, value);
  }
}

function parseRoot(input: unknown): unknown {
  if (typeof input === 'string') {
    if (utf8Bytes(input) > LIMITS.maxSerializedUtf8Bytes) fail();
    try {
      return JSON.parse(input) as unknown;
    } catch {
      fail();
    }
  }
  return input;
}

/**
 * Validates a Playwright-shaped approved auth state. Empty cookies/origins are
 * allowed by schema and do not mean the session is authenticated.
 */
export function validateApprovedAuthState(
  input: unknown,
  approvedOrigins: readonly string[],
): ApprovedAuthState {
  const allowed = approvedSets(approvedOrigins);
  const rootValue = parseRoot(input);
  const visiting = new WeakSet<object>();
  if (
    rootValue === null ||
    typeof rootValue !== 'object' ||
    Array.isArray(rootValue)
  )
    fail();
  enter(visiting, rootValue);
  let result: ApprovedAuthState;
  try {
    const root = assertPlainDataObject(rootValue, ROOT_KEYS);
    result = {};
    if (Object.hasOwn(root, 'cookies')) {
      const cookies = readArray(root.cookies, LIMITS.cookies, visiting, (row) =>
        readCookie(row, allowed.hosts, visiting),
      );
      const identities = new Set<string>();
      for (const cookie of cookies) {
        const identity = cookieIdentity(
          cookie.name,
          cookie.domain,
          cookie.path,
        );
        if (identities.has(identity)) fail();
        identities.add(identity);
      }
      result.cookies = cookies;
    }
    if (Object.hasOwn(root, 'origins')) {
      const origins = readArray(root.origins, LIMITS.origins, visiting, (row) =>
        readOriginEntry(row, allowed.origins, visiting),
      );
      const seenOrigins = new Set<string>();
      for (const entry of origins) {
        if (seenOrigins.has(entry.origin)) fail();
        seenOrigins.add(entry.origin);
      }
      result.origins = origins;
    }
  } finally {
    leave(visiting, rootValue);
  }
  const serialized = JSON.stringify(result);
  if (
    typeof serialized !== 'string' ||
    utf8Bytes(serialized) > LIMITS.maxSerializedUtf8Bytes
  )
    fail();
  return result;
}
