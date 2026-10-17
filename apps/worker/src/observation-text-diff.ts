/**
 * Visible text that one browser action added or removed.
 *
 * An agent only sees the page after its action, so the strongest signal that a
 * field rejected a submit — "请输入账号" appearing under the account box right
 * after the click — looks exactly like a placeholder that was always there.
 * Comparing the two observations makes it explicit.
 *
 * Text is keyed by its own words plus the name of the control it belongs to, not
 * by nodeId: ids are renumbered on every snapshot, and the same message may be
 * remounted under a new id. Both input snapshots are already redacted by the
 * session, so no credential can enter the result.
 */
import type { BrowserSnapshot } from '@localqa/contracts';

export interface TextChangeSummary {
  /** Text that is visible only after the action, e.g. "请输入账号（账号框）". */
  appeared: string[];
  /** Text that was visible before the action and is gone after it. */
  disappeared: string[];
}

/** Roles that carry rendered page text rather than an interactive element. */
const TEXT_ROLES = new Set([
  'statictext',
  'paragraph',
  'label',
  'cell',
  'listitem',
  'alert',
  'status',
  'log',
  'tooltip',
]);

const MAX_ITEMS = 6;
const TEXT_LIMIT = 80;
const OWNER_LIMIT = 40;

const clip = (value: string, max: number) => {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** text + owner key -> "text（owner）" as the model should read it. */
function textKeys(snapshot: BrowserSnapshot | null): Map<string, string> {
  const keys = new Map<string, string>();
  if (!snapshot) return keys;
  const byNodeId = new Map(
    snapshot.nodes.map((node) => [node.nodeId, node] as const),
  );
  for (const node of snapshot.nodes) {
    if (!node.visible) continue;
    if (!TEXT_ROLES.has(node.role)) continue;
    const text = clip(node.name || node.text, TEXT_LIMIT);
    if (!text) continue;
    const owner = node.relatedNodeId
      ? byNodeId.get(node.relatedNodeId)?.name.trim()
      : undefined;
    const ownerLabel = owner ? clip(owner, OWNER_LIMIT) : '';
    const key = `${ownerLabel}\u0000${text}`;
    keys.set(key, ownerLabel ? `${text}（${ownerLabel}）` : text);
  }
  return keys;
}

function collect(difference: Iterable<[string, string]>): {
  items: string[];
  dropped: number;
} {
  const all = [...difference].map(([, label]) => label);
  if (all.length > MAX_ITEMS)
    return {
      items: [
        ...all.slice(0, MAX_ITEMS),
        `…（另有 ${all.length - MAX_ITEMS} 条）`,
      ],
      dropped: all.length - MAX_ITEMS,
    };
  return { items: all, dropped: 0 };
}

/**
 * What the action changed on screen, in words. Returns null when nothing
 * readable appeared or disappeared, so an ordinary action stays quiet.
 */
export function textChanges(
  before: BrowserSnapshot | null,
  after: BrowserSnapshot | null,
): TextChangeSummary | null {
  if (!before || !after) return null;
  const previous = textKeys(before);
  const next = textKeys(after);
  const appeared = collect(
    [...next].filter(([key]) => !previous.has(key)),
  ).items;
  const disappeared = collect(
    [...previous].filter(([key]) => !next.has(key)),
  ).items;
  if (!appeared.length && !disappeared.length) return null;
  return { appeared, disappeared };
}

/**
 * Where keyboard focus is, in words: the focused control's own name (falling
 * back to its role), or null when the page itself has no focused control.
 */
export function focusLabel(snapshot: BrowserSnapshot | null): string | null {
  if (!snapshot) return null;
  const focused = snapshot.nodes.filter((node) => node.focused && node.visible);
  // A child frame's control is more specific than the iframe that hosts it.
  const node =
    focused.find((entry) => entry.role !== 'iframe') ?? focused[0] ?? null;
  if (!node) return null;
  return clip(node.name || node.text || node.role, 60) || node.role;
}

export interface FocusChange {
  from: string | null;
  to: string | null;
}

/** Focus moving between two observations; null when it did not move. */
export function focusChange(
  before: BrowserSnapshot | null,
  after: BrowserSnapshot | null,
): FocusChange | null {
  if (!before || !after) return null;
  const from = focusLabel(before);
  const to = focusLabel(after);
  if (from === to) return null;
  return { from, to };
}

/** How the trail names an action, so the line reads like the report's prose. */
const ACTION_VERBS: Record<string, string> = {
  click: '点击',
  type_text: '输入',
  select_option: '选择',
  press: '按键',
  navigate: '打开',
  scroll: '滚动',
  wait_for: '等待',
};

/** One trail line for the report: 「按键后焦点：账号 → 密码」 */
export function focusChangeLine(
  action: string,
  change: FocusChange | null,
): string | null {
  if (!change) return null;
  const verb = ACTION_VERBS[action] ?? action;
  const from = change.from ?? '无';
  const to = change.to ?? '无';
  return `${verb}后焦点：${from} → ${to}`;
}

/** One trail line for the report: 「点击后新出现：请输入账号（账号框）」 */
export function textChangeLine(
  action: string,
  changes: TextChangeSummary | null,
): string | null {
  if (!changes) return null;
  const parts: string[] = [];
  if (changes.appeared.length)
    parts.push(`新出现：${changes.appeared.join('、')}`);
  if (changes.disappeared.length)
    parts.push(`消失：${changes.disappeared.join('、')}`);
  const verb = ACTION_VERBS[action] ?? action;
  return parts.length ? `${verb}后${parts.join('；')}` : null;
}
