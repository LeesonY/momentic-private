/** Constant-only diagnostics: never persist exception messages or model/page text. */
export const TRANSIENT_REPRODUCTION_FAILURES = new Set([
  'MODEL_FAILURE',
  'MODEL_VALIDATION_FAILED',
  'MODEL_INVALID_JSON',
  'MODEL_SCHEMA_MISMATCH',
  'MODEL_TOOL_CONTRACT_INVALID',
  'MODEL_OUTPUT_TRUNCATED',
  'MODEL_TIMEOUT',
  'SERVICE_UNAVAILABLE',
  'RATE_LIMITED',
  'WORKER_FAILURE',
  'TASK_INTERRUPTED',
  'LEASE_EXPIRED',
]);

const outcomes: Record<string, string> = {
  malformed: '模型输出不合规（修复后仍不符合 Schema）',
  refused: '模型拒绝了请求',
  timeout: '模型请求超时',
  provider_error: '模型服务返回错误',
  unavailable: '模型服务暂不可用',
  rate_limited: '模型服务请求被限流',
  not_configured: '模型服务配置缺失或不可用',
  capability_missing: '模型缺少所需能力',
  billing_required: '模型服务余额或计费配置不可用',
  budget_exceeded: '模型调用预算已用完',
};
export function taskFailure(
  code: string,
  outcome?: string,
): { code: string; detail: string } {
  const safeCode = /^[A-Z][A-Z0-9_]{1,47}$/.test(code)
    ? code
    : 'WORKER_FAILURE';
  const safeOutcome =
    outcome && Object.hasOwn(outcomes, outcome) ? outcome : null;
  const detail = safeOutcome
    ? `${safeOutcome}: ${outcomes[safeOutcome]}`
    : safeCode === 'LEASE_EXPIRED'
      ? '租约丢失，任务未完成'
      : safeCode === 'TASK_INTERRUPTED'
        ? '任务执行中断，未得到复现结论'
        : safeCode === 'WORKER_FAILURE'
          ? '执行器偶发失败，任务未完成'
          : `任务未完成（${safeCode}）`;
  return { code: safeCode, detail: detail.slice(0, 300) };
}
