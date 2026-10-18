/**
 * Chinese phrase for a failed browser step's reason code. Codes are bounded
 * identifiers persisted on the step document; unknown codes stay untranslated
 * rather than inventing a cause.
 */
const stepReasonLabel: Record<string, string> = {
  VERSION_CONFLICT: '快照已过期',
  REPEATED_ACTION_LIMIT: '重复动作已拦截',
  POLICY_DENIED: '策略拒绝',
  TARGET_NOT_ALLOWED: '目标不在允许范围',
  TARGET_NOT_FOUND: '目标不存在',
  TARGET_AMBIGUOUS: '目标不唯一',
  TARGET_HIDDEN: '目标不可见',
  TARGET_DISABLED: '目标被禁用',
  HIDDEN_INPUT_FORBIDDEN: '隐藏输入框禁止操作',
  SENSITIVE_INPUT_FORBIDDEN: '敏感输入未放行',
  SAVED_CREDENTIAL_INPUT: '与已保存凭据相同',
  OUT_OF_SCOPE_MUTATION: '非提交策略禁止的写操作',
  CASE_ACTION_LIMIT: '用例动作上限已用完',
  ACTION_TIMEOUT: '动作超时',
  VALIDATION_ERROR: '参数无效',
  USER_CANCELLED: '已取消',
  CANCELLED: '已取消',
  BROWSER_UNAVAILABLE: '浏览器不可用',
  BROWSER_FAILED: '浏览器执行失败',
};

export function stepReasonText(
  reasonCode: string | null | undefined,
): string | null {
  if (!reasonCode) return null;
  return stepReasonLabel[reasonCode] ?? null;
}
