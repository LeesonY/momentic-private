/**
 * Model-facing node window.
 *
 * The observation projections send only a slice of a snapshot so a session's
 * token budget survives. A bare `slice(0, limit)` however drops exactly the
 * diagnostic part of a long page: with 250 visible controls, the validation
 * message under control #230 never reached the model and the agent reported
 * "no hint at all". Urgent nodes are therefore promoted into the window
 * together with the control a text node describes, while the rest of the window
 * stays the page-order head, so an ordinary page looks exactly as before.
 */
export interface ObservableNode {
  nodeId: string;
  role: string;
  relatedNodeId?: string | undefined;
}

/** Live-region roles whose text is a notice the model must not lose. */
const LIVE_ROLES = new Set(['alert', 'status', 'log']);
/** Upper bound on promoted ids (a text node and its control count separately). */
const PROMOTED_LIMIT = 60;

export function observeWindow<T extends ObservableNode>(
  nodes: readonly T[],
  limit: number,
): T[] {
  if (nodes.length <= limit) return [...nodes];
  const order = new Map(nodes.map((node, index) => [node.nodeId, index]));
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const promoted = new Set<string>();
  // A notice first: a toast or an aria-live message is the page telling the
  // user (and the model) what just happened.
  for (const node of nodes) {
    if (promoted.size >= PROMOTED_LIMIT) break;
    if (LIVE_ROLES.has(node.role)) promoted.add(node.nodeId);
  }
  // Then a field's message together with the field itself. Labels are skipped:
  // a label's text is already the control's name, and a long form has hundreds
  // of them, which would spend the whole promotion budget on the first fields.
  for (const node of nodes) {
    if (promoted.size >= PROMOTED_LIMIT) break;
    if (!node.relatedNodeId || node.role === 'label') continue;
    promoted.add(node.nodeId);
    if (byId.has(node.relatedNodeId)) promoted.add(node.relatedNodeId);
  }
  const urgent = nodes.filter((node) => promoted.has(node.nodeId));
  const room = Math.max(0, limit - urgent.length);
  const head = nodes
    .filter((node) => !promoted.has(node.nodeId))
    .slice(0, room);
  return [...head, ...urgent].sort(
    (left, right) =>
      (order.get(left.nodeId) ?? 0) - (order.get(right.nodeId) ?? 0),
  );
}
