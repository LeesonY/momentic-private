import type { SessionDecision, RunConfig } from '@localqa/contracts';

/** The API freezes actionPolicy at run creation. A reply to an AI question
 * cannot elevate it, so these requests must become a coverage gap instead
 * of a paid clarification loop. Other questions remain answerable. */
export function finishPermissionLockedQuestion(
  actionPolicy: RunConfig['actionPolicy'],
  decision: SessionDecision,
): SessionDecision | null {
  if (actionPolicy !== 'non_submitting' || decision.action !== 'ask') return null;
  const question = decision.question ?? '';
  const permissionTerms = /actionPolicy|writeScope|non_submitting|approved_workflows|允许业务操作|(?:提交|写入|操作)权限|(?:提交|写入)授权|授权(?:创建|删除|修改|提交)|(?:开启|授予).{0,15}(?:权限|写操作|提交)/i;
  if (!permissionTerms.test(question)) return null;
  return {
    action: 'finish',
    ...(decision.title ? { title: decision.title } : {}),
    rationale: '当前运行是只读策略，无法在会话中追加业务写入权限。请结束后新建允许业务操作的运行。',
    cases: [],
    exploreTargets: [],
    coverageGaps: [
      ...new Set([
        ...decision.coverageGaps,
        '运行策略为 non_submitting：本次未执行创建、提交、修改或删除等写操作；须重新创建明确授权的运行。',
      ]),
    ].slice(0, 20),
  };
}
