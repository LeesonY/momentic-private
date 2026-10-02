import type { ModelMessage, ModelPart } from '@localqa/contracts';

const SECRET_TEXT =
  /\b(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*([^\s&"',}]+)/gi;
const BEARER = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const QUERY_SECRET =
  /([?&](?:password|passwd|token|secret|auth|key)=)[^&#\s]*/gi;

export function redactText(text: string): string {
  return text
    .replace(BEARER, 'Bearer [redacted]')
    .replace(SECRET_TEXT, '$1=[redacted]')
    .replace(QUERY_SECRET, '$1[redacted]');
}

export function hideSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join('[redacted]');
}

function isText(part: ModelPart): part is { type: 'text'; text: string } {
  return part.type === 'text';
}

export function messageText(message: ModelMessage): string {
  return message.content.filter(isText).map((part) => part.text).join('\n');
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
): RedactionResult {
  const approved = new Set(approvedImageIds);
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
      const cleaned = redactText(part.text);
      if (cleaned !== part.text) redactionCount += 1;
      content.push({ type: 'text', text: cleaned });
    }
    if (content.length === 0) continue;
    let role = message.role;
    const text = content.filter(isText).map((part) => part.text).join('\n');
    if (role === 'system' && text.includes('PAGE_OBSERVATION:')) {
      role = 'user';
      redactionCount += 1;
    }
    next.push({ role, content: content as ModelMessage['content'] });
  }
  return { messages: next, droppedImageIds, redactionCount };
}
