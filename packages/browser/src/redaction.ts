/**
 * Redaction utilities for URLs, headers, bodies, console logs, and DOM elements.
 * Adheres to LocalQA RedactionPolicy (docs/02-technical-design.md §7).
 */

const SENSITIVE_QUERY_PATTERNS = [
  /token/i,
  /auth/i,
  /key/i,
  /secret/i,
  /sig/i,
  /signature/i,
  /password/i,
  /passwd/i,
  /code/i,
  /otp/i,
  /session/i,
  /credential/i,
  /bearer/i
];

const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token'
]);

/**
 * Sanitizes URLs by replacing values of sensitive query parameters with '[redacted]'.
 */
export function sanitizeUrl(urlStr: string): string {
  try {
    const url = new URL(urlStr);
    let changed = false;
    for (const [key] of url.searchParams.entries()) {
      if (SENSITIVE_QUERY_PATTERNS.some((pattern) => pattern.test(key))) {
        url.searchParams.set(key, '[redacted]');
        changed = true;
      }
    }
    return changed ? url.toString() : urlStr;
  } catch {
    return urlStr;
  }
}

/**
 * Redacts sensitive headers.
 */
export function sanitizeHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (!val) continue;
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_HEADER_NAMES.has(lowerKey)) {
      sanitized[lowerKey] = '[redacted]';
    } else {
      sanitized[lowerKey] = Array.isArray(val) ? val.join(', ') : String(val);
    }
  }
  return sanitized;
}

/**
 * Redacts sensitive tokens or payloads in text strings.
 */
export function sanitizeText(text: string): string {
  if (!text) return '';
  let result = text;

  // Mask Bearer tokens
  result = result.replace(/Bearer\s+([A-Za-z0-9\-._~+/]+=*)/gi, 'Bearer [redacted]');

  // Mask passwords/secrets in query-like strings: password=xxx, token=xxx
  result = result.replace(
    /([?&]?(?:password|token|secret|apiKey|access_token|session_token)=)[^& \n\r"']+/gi,
    '$1[redacted]'
  );

  return result;
}

/**
 * Redacts JSON or plain text body payloads.
 */
export function sanitizeBody(body: unknown): string {
  if (body === null || body === undefined) return '';

  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      return JSON.stringify(sanitizeJsonObject(parsed));
    } catch {
      return sanitizeText(body);
    }
  }

  if (typeof body === 'object') {
    return JSON.stringify(sanitizeJsonObject(body));
  }

  return sanitizeText(String(body));
}

function sanitizeJsonObject(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(sanitizeJsonObject);
  }
  if (obj && typeof obj === 'object') {
    const res: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SENSITIVE_QUERY_PATTERNS.some((p) => p.test(k))) {
        res[k] = '[redacted]';
      } else {
        res[k] = sanitizeJsonObject(v);
      }
    }
    return res;
  }
  return obj;
}
