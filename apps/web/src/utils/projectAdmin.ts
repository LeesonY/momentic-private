import type {
  ModelProfile,
  Project,
  ProjectDeletionPreview,
} from '@localqa/contracts';

/**
 * Pure helpers behind the 项目管理 page. Keeping them out of the component lets
 * the rules (name validation, which project to switch to after a deletion, how a
 * deletion preview reads) be tested without a browser.
 */

export const PROJECT_NAME_MAX = 120;

export type ProjectNameCheck =
  { ok: true; name: string } | { ok: false; name: string; error: string };

/** The server trims and bounds project names; so does the dialog. */
export function validateProjectName(raw: string): ProjectNameCheck {
  const name = raw.trim();
  if (name.length === 0) return { ok: false, name, error: '项目名称不能为空' };
  if (name.length > PROJECT_NAME_MAX)
    return {
      ok: false,
      name,
      error: `项目名称不能超过 ${PROJECT_NAME_MAX} 个字符`,
    };
  return { ok: true, name };
}

export function projectStatusLabel(status: Project['status']): string {
  return status === 'archived' ? '已归档' : '进行中';
}

/**
 * The default model column: a missing binding, a live model, or a model that no
 * longer exists (the id survives on the project, the profile does not).
 */
export function describeDefaultModel(
  models: readonly Pick<ModelProfile, 'id' | 'name'>[],
  modelId: string | null | undefined,
): string {
  if (!modelId) return '未设置';
  const model = models.find((candidate) => candidate.id === modelId);
  return model ? model.name : '已删除的模型';
}

/**
 * After a project is removed the shell needs a project that can actually be
 * used: the first active one, then anything left, then nothing (empty state).
 */
export function nextProjectAfterRemoval(
  projects: readonly Project[],
  removedId: string,
): Project | null {
  const remaining = projects.filter((project) => project.id !== removedId);
  return (
    remaining.find((project) => project.status === 'active') ??
    remaining[0] ??
    null
  );
}

/** Projects that would break if this model were deleted. */
export function projectsUsingDefaultModel(
  projects: readonly Pick<Project, 'id' | 'name' | 'defaultModelProfileId'>[],
  modelId: string | null | undefined,
): Array<Pick<Project, 'id' | 'name' | 'defaultModelProfileId'>> {
  if (!modelId) return [];
  return projects.filter(
    (project) => project.defaultModelProfileId === modelId,
  );
}

/**
 * The deletion preview in words, in the order the dialog shows it. Zero counts
 * are left out so an almost empty project reads short.
 */
export function deletionPreviewLines(
  preview: Pick<ProjectDeletionPreview, 'counts'>,
): string[] {
  const { counts } = preview;
  const lines: string[] = [];
  if (counts.runs > 0) lines.push(`${counts.runs} 个会话`);
  if (counts.savedCases > 0) lines.push(`${counts.savedCases} 条用例`);
  if (counts.environments > 0) lines.push(`${counts.environments} 个环境`);
  if (counts.authProfiles > 0) lines.push(`${counts.authProfiles} 个凭证`);
  if (counts.enabledSchedules > 0)
    lines.push(`${counts.enabledSchedules} 个启用的定时计划（将停用）`);
  if (counts.activeApiKeys > 0)
    lines.push(`${counts.activeApiKeys} 个 API Key（将吊销）`);
  if (counts.members > 0) lines.push(`${counts.members} 位成员`);
  return lines;
}

/** 「包含 3 个会话、2 条用例…」，or the empty-project sentence. */
export function deletionPreviewSummary(
  preview: Pick<ProjectDeletionPreview, 'counts' | 'empty'>,
): string {
  if (preview.empty) return '该项目没有任何数据，删除是立即且不可恢复的。';
  const lines = deletionPreviewLines(preview);
  return lines.length > 0
    ? `包含 ${lines.join('、')}。`
    : '该项目只有基础配置。';
}

/**
 * A blocked deletion (sessions still running) is not a failure the user can
 * retry; it needs them to stop the sessions first.
 */
export function deletionBlocker(
  preview: Pick<ProjectDeletionPreview, 'counts'> | null,
): string | null {
  if (!preview || preview.counts.activeRuns <= 0) return null;
  return `项目还有 ${preview.counts.activeRuns} 个会话没结束，请先停止后再删除`;
}

/** Server errors that mean "someone changed this project under you". */
export function isVersionConflict(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'VERSION_CONFLICT') return true;
  return error instanceof Error && /VERSION_CONFLICT/.test(error.message);
}
