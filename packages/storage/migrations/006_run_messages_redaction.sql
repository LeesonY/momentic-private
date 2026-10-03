-- Defense-in-depth: run_messages.redacted_text must never contain obvious
-- secret key/value pairs even if the upstream RedactionPolicy is bypassed.
-- The column is free-form text (not jsonb), so we check for the sensitive
-- key patterns at the text level. The app replaces values with the literal
-- '[redacted]', so we must not reject the placeholder itself.
ALTER TABLE run_messages ADD CONSTRAINT run_messages_no_secret_text
  CHECK (redacted_text !~* '(password|apikey|token|secret|authorization|cookie|session|bearer)\s*[=:]\s*(?!\[redacted\])[^\s]');
