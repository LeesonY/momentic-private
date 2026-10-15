/**
 * Outbound redaction for model context.
 *
 * Everything here runs BEFORE a request leaves the process: `redactMessages` is
 * applied to the message list that the adapter turns into the provider body, so
 * a value that this module removes never reaches the network.
 *
 * The previous implementation was a single regex over `key=value`, which missed
 * the most common real shape — a JSON field, where the value is quoted:
 * `{"password":"hunter2"}` did not match because the character after `:` is a
 * quote, and the value class excluded quotes. Passing page observations and tool
 * results through unchanged therefore leaked quoted secrets.
 *
 * Redaction is now layered, cheapest and most precise first:
 *
 *  1. structure: real JSON (whole text, or a balanced span inside free text) is
 *     walked key-by-key, so nested objects, arrays, escapes and numbers are all
 *     handled by a parser instead of a pattern;
 *  2. syntax: quoted/unquoted `key[:=]value` pairs cover JavaScript literals,
 *     query strings, headers and form bodies that are not valid JSON;
 *  3. tokens: Bearer/Basic credentials, JWTs and cookie headers;
 *  4. known values: an exact match of a registered secret is removed even if it
 *     appears with no key at all.
 *
 * Layer 4 is the only one that needs the real secret, and it is also the only
 * one that cannot be defeated by an unusual encoding of the surrounding syntax.
 */
import { createHash } from 'node:crypto';
import type { ModelMessage, ModelPart } from '@localqa/contracts';

export const REDACTED = '[redacted]';

/** JSON values this module can walk. `JSON.parse` only ever produces these. */
type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

/** What replaces a sensitive field: a marker, or an emptied array. */
type RedactionMarker = string | string[];

/**
 * Field names whose values must never leave the process. Deliberately narrow:
 * over-redacting ordinary page text destroys the context the model needs, so
 * only names that denote an actual credential are listed. Each entry is matched
 * as a whole key (not a substring), so `sessionTimeoutMs` and `tokenCount` are
 * untouched while `sessionId` and `refreshToken` are redacted.
 */
const SENSITIVE_KEY =
  /(?:pass(?:word|wd|phrase)?|pwd|secret|client[-_]?secret|secret[-_]?key|token|(?:access|refresh|id|session|bearer|api|auth|csrf|xsrf|verification|one[-_]?time)[-_]?token|api[-_]?key|apikey|access[-_]?key|private[-_]?key|kms[-_]?key|auth|authorization|credential(?:s)?|session(?:[-_]?id)?|cookie|set[-_]?cookie|(?:jsession|php)?sid|otp|one[-_]?time[-_]?(?:code|password)|verification[-_]?code|passcode|pin|cvv|cvc|card[-_]?number|ssn|csrf(?:[-_]?token)?|xsrf(?:[-_]?token)?|signature|salt|vault)/i;

/** A key must be a complete identifier, never a prefix of a longer word. */
const KEY_BOUNDARY_START = '(?<![A-Za-z0-9_])';

/**
 * Whole-key sensitivity test used by the structural pass, where a JSON key name
 * is available in full.
 *
 * This cannot reuse the unanchored `SENSITIVE_KEY`: `max_tokens` contains the
 * substring `token`, so an unanchored test marks it sensitive and the probe
 * budget in the wire body would be replaced by the marker. Keys are therefore
 * normalised (case, `-`, `_` and spaces removed) and compared as complete names.
 */
const SENSITIVE_KEY_NAMES = new Set([
  'password',
  'passwd',
  'passphrase',
  'pwd',
  'secret',
  'clientsecret',
  'secretkey',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'authtoken',
  'bearertoken',
  'apitoken',
  'csrftoken',
  'xsrftoken',
  'verificationtoken',
  'apikey',
  'accesskey',
  'privatekey',
  'kmskey',
  'auth',
  'authorization',
  'credential',
  'credentials',
  'session',
  'sessionid',
  'cookie',
  'setcookie',
  'jsessionid',
  'phpsessid',
  'sid',
  'otp',
  'passcode',
  'pin',
  'cvv',
  'cvc',
  'cardnumber',
  'ssn',
  'signature',
  'salt',
  'vault',
  'onetimecode',
  'onetimepassword',
  'verificationcode',
]);
/** Transport prefixes that wrap a sensitive name without changing its meaning. */
const KEY_PREFIXES = ['x', 'set', 'csrf', 'xsrf', 'auth', 'bearer', 'proxy'];

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s.]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SENSITIVE_KEY_NAMES.has(normalized)) return true;
  for (const prefix of KEY_PREFIXES) {
    if (!normalized.startsWith(prefix)) continue;
    if (SENSITIVE_KEY_NAMES.has(normalized.slice(prefix.length))) return true;
  }
  return false;
}

const QUOTED_VALUE = '"(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`';
const BARE_VALUE = '[^\\s,;&)\\]}<>]+';
// The marker itself must not be re-redacted. Otherwise the first pass yields
// `Authorization: [redacted]` and this pass matches the bracketed value, adding
// a second bracket.
const NOT_REDACTED = '(?!\\[redacted\\])';

/** `"password": "x"`, `password=x`, `password: 'x'`, `\"password\":\"x\"`. */
const KEY_VALUE = new RegExp(
  `(${KEY_BOUNDARY_START}["']?(?:\\\\["'])?)(${SENSITIVE_KEY.source})((?:\\\\["'])?["']?)(\\s*[:=]\\s*)(${NOT_REDACTED}(?:${QUOTED_VALUE}|${BARE_VALUE}))`,
  'gi',
);

/**
 * Header-style values.
 *
 * A header spans to the end of its line, but model context is often a single
 * line of serialized JSON, where "end of line" is the end of the request. The
 * value class therefore stops at the first structural delimiter as well, and
 * consumes a complete quoted string when one is present. Without this bound a
 * body containing the word `authorization` anywhere would be truncated, which
 * destroys exactly the context the model needs.
 */
const HEADER_VALUE =
  '(?:"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|[^\\n"\',}\\];]*)';
const COOKIE_HEADER = new RegExp(
  `((?<![A-Za-z0-9_-])(?:set-)?cookie(?![A-Za-z0-9_-])\\s*[:=]\\s*)(${HEADER_VALUE})`,
  'gi',
);
const AUTHORIZATION_HEADER = new RegExp(
  `((?<![A-Za-z0-9_-])authorization(?![A-Za-z0-9_-])\\s*[:=]\\s*)(${HEADER_VALUE})`,
  'gi',
);

const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/=]{8,}/gi;

/** JWTs are recognisable without any key: three base64url segments. */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

const QUERY_SECRET = new RegExp(
  `([?&#](?:${SENSITIVE_KEY.source})=)[^&#\\s]*`,
  'gi',
);

/** `data:image/...;base64,<payload>` is transport noise, not model context. */
const DATA_IMAGE = /data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{16,}/gi;

const MAX_STRUCTURED_SCAN = 512 * 1024;
const MAX_SPAN_DEPTH = 32;

export function redactText(text: string): string {
  if (!text) return text;
  let result = redactStructuredSpans(text);
  result = result
    .replace(AUTHORIZATION_HEADER, `$1${REDACTED}`)
    .replace(COOKIE_HEADER, `$1${REDACTED}`)
    .replace(BEARER, '$1 [redacted]')
    .replace(JWT, REDACTED)
    .replace(KEY_VALUE, (_match, prefix, key, quote, separator) => {
      // Preserve the original quoting so surrounding syntax stays valid.
      const hasQuote = quote.includes('"') || quote.includes("'");
      return `${prefix}${key}${quote}${separator}${hasQuote ? `"${REDACTED}"` : REDACTED}`;
    })
    .replace(QUERY_SECRET, `$1${REDACTED}`)
    .replace(DATA_IMAGE, 'data:image;base64,[redacted]');
  return result;
}

/** Removes a concrete secret wherever it appears, regardless of surrounding syntax. */
export function hideSecret(text: string, secret: string): string {
  if (!secret || secret.length < 4) return text;
  let result = text.split(secret).join(REDACTED);
  // Escaped forms appear when a secret is embedded in a string literal.
  const encoded = JSON.stringify(secret).slice(1, -1);
  if (encoded !== secret) result = result.split(encoded).join(REDACTED);
  const uriEncoded = encodeURIComponent(secret);
  if (uriEncoded !== secret) result = result.split(uriEncoded).join(REDACTED);
  return result;
}

/**
 * Structural pass: rewrite sensitive members of real JSON, whether the text is
 * a JSON document or free text that embeds one.
 */
export function redactStructuredSpans(text: string): string {
  if (text.length > MAX_STRUCTURED_SCAN) return redactWholeJson(text) ?? text;
  const whole = redactWholeJson(text);
  if (whole !== null) return whole;
  return rewriteEmbeddedJson(text);
}

/** Returns null when the text is not JSON (or not a JSON object/array). */
function parseJson(text: string): Json | null {
  let parsed: Json;
  try {
    // SAFETY: JSON.parse can only produce the Json union; its single failure
    // mode (SyntaxError) is caught here and reported as null.
    parsed = JSON.parse(text) as Json;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  return parsed;
}

function redactWholeJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  if (!trimmed.endsWith('}') && !trimmed.endsWith(']')) return null;
  const parsed = parseJson(trimmed);
  if (parsed === null) return null;
  const { value, changed } = redactValue(parsed, 0);
  if (!changed) return text;
  return JSON.stringify(value);
}

/**
 * Finds balanced `{...}`/`[...]` spans in free text and rewrites the ones that
 * are valid JSON. Bounded by depth and by a single scan so a pathological input
 * cannot turn this into quadratic work.
 */
function rewriteEmbeddedJson(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char !== '{' && char !== '[') {
      out += char;
      index += 1;
      continue;
    }
    const end = findBalancedEnd(text, index);
    if (end < 0) {
      out += char;
      index += 1;
      continue;
    }
    const candidate = text.slice(index, end);
    const parsed = parseJson(candidate);
    if (parsed === null) {
      out += char;
      index += 1;
      continue;
    }
    // Only treat it as JSON when at least one key or value looks sensitive:
    // rewriting every brace-shaped fragment would churn ordinary page text.
    if (!mentionsSensitiveKey(candidate)) {
      out += candidate;
      index = end;
      continue;
    }
    const { value, changed } = redactValue(parsed, 0);
    out += changed ? JSON.stringify(value) : candidate;
    index = end;
  }
  return out;
}

function findBalancedEnd(text: string, start: number): number {
  const open = text.charAt(start);
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === open) {
      depth += 1;
      if (depth > MAX_SPAN_DEPTH) return -1;
      continue;
    }
    if (char === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function mentionsSensitiveKey(text: string): boolean {
  // Cheap pre-filter over the raw text; the structural walk applies the exact
  // whole-key test afterwards, so a false positive here only costs a parse.
  return new RegExp(`["']?${SENSITIVE_KEY.source}["']?\\s*[:=]`, 'i').test(text);
}

function redactValue(
  value: Json,
  depth: number,
): { value: Json; changed: boolean } {
  if (depth > MAX_SPAN_DEPTH) return { value, changed: false };
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const result = redactValue(item, depth + 1);
      if (result.changed) changed = true;
      return result.value;
    });
    return { value: changed ? next : value, changed };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next: { [key: string]: Json } = {};
    for (const [key, member] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        changed = true;
        next[key] = redactStructuredLeaf(member);
        continue;
      }
      const result = redactValue(member, depth + 1);
      if (result.changed) changed = true;
      next[key] = result.value;
    }
    return { value: changed ? next : value, changed };
  }
  return { value, changed: false };
}

/**
 * A sensitive field may hold a nested object (for example a form descriptor
 * that includes the value to type). Keep the shape but remove the payload, so
 * the model still understands that a credential exists without receiving it.
 */
function redactStructuredLeaf(value: Json): RedactionMarker {
  // Keep the shape (an empty array stays an array) so the model still sees that
  // a credential field exists, without receiving the payload.
  if (Array.isArray(value)) return value.length > 0 ? [REDACTED] : [];
  return REDACTED;
}

function isText(part: ModelPart): part is { type: 'text'; text: string } {
  return part.type === 'text';
}

export function messageText(message: ModelMessage): string {
  return message.content
    .filter(isText)
    .map((part) => part.text)
    .join('\n');
}

export interface RedactionResult {
  messages: ModelMessage[];
  droppedImageIds: string[];
  redactionCount: number;
}

/** Page text is observation. A system message carrying it is demoted to user. */
export function redactMessages(
  messages: readonly ModelMessage[],
  approvedImageIds: readonly string[],
  knownSecrets: readonly string[] = [],
): RedactionResult {
  const approved = new Set(approvedImageIds);
  const secrets = knownSecrets.filter((secret) => secret && secret.length >= 4);
  const droppedImageIds: string[] = [];
  let redactionCount = 0;
  const next: ModelMessage[] = [];
  for (const message of messages) {
    const content: ModelPart[] = [];
    for (const part of message.content) {
      if (part.type === 'image') {
        if (!approved.has(part.artifactId)) {
          droppedImageIds.push(part.artifactId);
          redactionCount += 1;
          continue;
        }
        content.push(part);
        continue;
      }
      let cleaned = redactText(part.text);
      for (const secret of secrets) cleaned = hideSecret(cleaned, secret);
      if (cleaned !== part.text) redactionCount += 1;
      content.push({ type: 'text', text: cleaned });
    }
    if (content.length === 0) continue;
    let role = message.role;
    const text = content
      .filter(isText)
      .map((part) => part.text)
      .join('\n');
    if (role === 'system' && text.includes('PAGE_OBSERVATION:')) {
      role = 'user';
      redactionCount += 1;
    }
    next.push({ role, content: content as ModelMessage['content'] });
  }
  return { messages: next, droppedImageIds, redactionCount };
}

/**
 * Stable fingerprint of the redaction policy for audit records: an operator can
 * tell which policy version produced a stored diagnostic without storing text.
 */
export function redactionPolicyId(): string {
  return createHash('sha256')
    .update(SENSITIVE_KEY.source)
    .update(BEARER.source)
    .update(JWT.source)
    .digest('hex')
    .slice(0, 16);
}
