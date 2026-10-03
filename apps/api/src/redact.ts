/**
 * Free-text redaction for user-supplied strings (run messages, briefs) that
 * flow into model context and reports. Server-side counterpart to the browser
 * package's URL/header redaction; no DOM types so it is safe for apps/api.
 */

const SENSITIVE_TEXT_PATTERNS: Array<[RegExp, string]> = [
  // Bearer tokens
  [/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [redacted]'],
  // key=value / key: value pairs for well-known secret keys
  [
    /((?:password|passwd|token|secret|api[_-]?key|access[_-]?token|session[_-]?token|authorization|cookie|credential)\s*[=:])\s*[^\s&"']+/gi,
    '$1[redacted]',
  ],
];

export function sanitizeUserText(text: string): string {
  if (!text) return '';
  let result = text;
  for (const [pattern, replacement] of SENSITIVE_TEXT_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
