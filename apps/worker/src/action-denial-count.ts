import { parseContract, type BrowserSnapshot, type ToolCall } from '@localqa/contracts';

/** Task-local, value-free refusal counts. Semantic identity survives fresh
 * snapshot/node ids, but different controls and refusal reasons stay apart. */
export function createActionDenialCounter() {
  const counts = new Map<string, number>();
  return (input: unknown, snapshot: BrowserSnapshot | null, reason: string): string => {
    let call: ToolCall;
    try { call = parseContract('ToolCall', input); }
    catch { call = { name: 'observe', args: {} }; }
    const target = 'target' in call.args ? call.args.target : undefined;
    const node = target && snapshot?.nodes.find((node) =>
      node.nodeId === target.nodeId && node.frameId === (target.frameId ?? 'main'));
    const key = JSON.stringify([
      reason,
      snapshot?.displayUrl ?? '',
      target?.frameId ?? 'main',
      node?.role ?? '',
      node?.name ?? target?.nodeId ?? call.name,
    ]);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count < 2 ? '' :
      `这是本任务同一目标因 ${reason} 第 ${count} 次被拒。动作没有执行；必须换目标或结束并如实说明，不要继续重试这个目标。`;
  };
}
