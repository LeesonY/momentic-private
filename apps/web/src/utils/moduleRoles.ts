import {
  type RegressionModuleRecord,
  type RegressionModuleReviewPreview,
  validateContract,
} from '@localqa/contracts';

export type ProjectRole = 'owner' | 'operator' | 'viewer';

export interface ModuleRolePermissions {
  canRegister: boolean;
  canReview: boolean;
  isReadOnly: boolean;
  roleLabel: string;
}

/**
 * Returns role permissions for module management:
 * - owner (or admin): full permissions, including registration and two-stage review approval.
 * - operator: can register new modules and new draft versions; cannot perform review approval.
 * - viewer: read-only access to modules, history, and diffs.
 */
export function getModuleRolePermissions(
  role: string | null | undefined,
  globalRole?: string | null,
): ModuleRolePermissions {
  const isOwner = role === 'owner' || globalRole === 'admin';
  const isOperator = role === 'operator';
  const isViewer = !isOwner && !isOperator;

  return {
    canRegister: isOwner || isOperator,
    canReview: isOwner,
    isReadOnly: isViewer,
    roleLabel: isOwner
      ? '项目所有者 (Owner)'
      : isOperator
        ? '操作员 (Operator)'
        : '查看者 (Viewer)',
  };
}

export interface PreviewValidationResult {
  valid: boolean;
  issues: string[];
}

/**
 * Validates that a review preview matches all required invariants before allowing commit:
 * - projectId, moduleName, version, documentSha256, expectedVersion, decision, reason, and not expired.
 */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSameProjectId(a: string, b: string): boolean {
  if (a === b) return true;
  if (UUID_REGEX.test(a) && UUID_REGEX.test(b)) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return false;
}

export function validateModuleReviewPreview(
  preview: RegressionModuleReviewPreview | null | undefined,
  target: {
    projectId: string;
    moduleName: string;
    version: number;
    documentSha256: string;
    expectedVersion: number;
    decision: 'approve' | 'reject';
    reason: string;
  },
  now = new Date(),
): PreviewValidationResult {
  const issues: string[] = [];
  if (!preview) {
    return { valid: false, issues: ['缺少审查预览对象 (preview 为空)'] };
  }

  const contractResult = validateContract(
    'RegressionModuleReviewPreview',
    preview,
  );
  if (!contractResult.success) {
    issues.push('审查预览对象未通过规范契约校验');
  }

  if (!isSameProjectId(preview.projectId, target.projectId)) {
    issues.push(
      `项目ID不一致: preview=${preview.projectId}, target=${target.projectId}`,
    );
  }
  if (preview.moduleName !== target.moduleName) {
    issues.push(
      `模块名不一致: preview=${preview.moduleName}, target=${target.moduleName}`,
    );
  }
  if (preview.version !== target.version) {
    issues.push(
      `版本号不一致: preview=${preview.version}, target=${target.version}`,
    );
  }
  if (preview.documentSha256 !== target.documentSha256) {
    issues.push(
      `文档指纹不一致: preview=${preview.documentSha256}, target=${target.documentSha256}`,
    );
  }
  if (preview.expectedVersion !== target.expectedVersion) {
    issues.push(
      `期望版本不一致: preview=${preview.expectedVersion}, target=${target.expectedVersion}`,
    );
  }
  if (preview.decision !== target.decision) {
    issues.push(
      `审批决议不一致: preview=${preview.decision}, target=${target.decision}`,
    );
  }
  if (preview.reason !== target.reason) {
    issues.push('审批理由已变更，须重新生成预览');
  }
  if (
    !preview.confirmationToken ||
    typeof preview.confirmationToken !== 'string'
  ) {
    issues.push('确认 Token 缺失或无效');
  }

  const expiresTime = new Date(preview.expiresAt).getTime();
  if (isNaN(expiresTime) || now.getTime() >= expiresTime) {
    issues.push('审查预览已过期，请重新生成预览');
  }

  return {
    valid: issues.length === 0,
    issues,
  };
}

/**
 * Checks if a regression module is approved.
 * Draft or rejected modules CANNOT be used as approved modules for playback/execution.
 */
export function isModuleApproved(
  module: RegressionModuleRecord | null | undefined,
): boolean {
  return module?.reviewStatus === 'approved';
}

/**
 * Asserts that a module version is a valid positive integer within Postgres integer bounds (1..2147483647).
 */
export function assertValidModuleVersion(version: unknown): number {
  const num = typeof version === 'number' ? version : Number(version);
  if (!Number.isInteger(num) || num < 1 || num > 2147483647) {
    throw new Error(
      `Invalid module version: must be a positive integer between 1 and 2147483647, got ${version}`,
    );
  }
  return num;
}
