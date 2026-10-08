import {
  type RegressionModuleRecord,
  type RegressionModuleRecordPage,
  validateContract,
} from '@localqa/contracts';
import type { ApiClient, PaginationQuery } from '../api/types.ts';
import { isSameProjectId } from './moduleRoles.ts';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Returns a canonical identity key for a module record across projects and versions.
 * Prevents cross-project name collisions and normalizes UUID casing.
 */
export function getModuleRecordKey(record: RegressionModuleRecord): string {
  const canonicalProj = UUID_REGEX.test(record.projectId)
    ? record.projectId.toLowerCase()
    : record.projectId;
  return `${canonicalProj}:${record.name}:v${record.version}`;
}

/**
 * Merges newly fetched module records into an existing list,
 * preserving existing order while avoiding duplicates by canonical project + name + version.
 */
export function mergeModuleRecords(
  existing: RegressionModuleRecord[],
  incoming: RegressionModuleRecord[],
): RegressionModuleRecord[] {
  const seen = new Set(existing.map(getModuleRecordKey));
  const merged = [...existing];
  for (const item of incoming) {
    const key = getModuleRecordKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

/**
 * Resolves the true latest version and its corresponding document for a module,
 * inspecting all known modules and version history strictly scoped to targetMod.projectId and name.
 * UUID matching is case-insensitive. Items from other projects are strictly filtered out.
 */
export function resolveLatestModuleVersion(
  targetMod: RegressionModuleRecord,
  knownModules: RegressionModuleRecord[],
  knownHistory: RegressionModuleRecord[] = [],
): {
  latestVersion: number;
  latestDocument: RegressionModuleRecord['document'];
} {
  const isTargetMatch = (m: RegressionModuleRecord) =>
    isSameProjectId(m.projectId, targetMod.projectId) &&
    m.name === targetMod.name;

  const pool = [
    targetMod,
    ...knownModules.filter(isTargetMatch),
    ...knownHistory.filter(isTargetMatch),
  ];

  let maxVer = targetMod.version;
  let latestDoc = targetMod.document;

  for (const item of pool) {
    if (item.version > maxVer) {
      maxVer = item.version;
      latestDoc = item.document;
    }
  }

  return { latestVersion: maxVer, latestDocument: latestDoc };
}

/**
 * Fetches a single page of regression modules for a project.
 * Enforces canonical page contract and verifies every returned item belongs to expected projectId.
 */
export async function fetchModulePage(
  client: Pick<ApiClient, 'listRegressionModules'>,
  projectId: string,
  query?: PaginationQuery,
): Promise<RegressionModuleRecordPage> {
  const page = await client.listRegressionModules(projectId, query);

  const pageValidation = validateContract('RegressionModuleRecordPage', page);
  if (!pageValidation.success) {
    throw new Error(
      `Module page contract validation failed: ${pageValidation.errors?.map((e) => e.message).join('; ') || 'invalid page schema'}`,
    );
  }

  for (const item of page.items) {
    const recordValidation = validateContract('RegressionModuleRecord', item);
    if (!recordValidation.success) {
      throw new Error(
        `Module record contract validation failed for ${item.name}@v${item.version}`,
      );
    }
    if (!isSameProjectId(item.projectId, projectId)) {
      throw new Error(
        `Module page contains item from mismatched project: expected ${projectId}, got ${item.projectId} (${item.name}@v${item.version})`,
      );
    }
  }

  return page;
}

/**
 * Fetches a single page of regression module versions.
 * Enforces canonical page contract and verifies every returned item belongs to expected projectId and moduleName.
 */
export async function fetchModuleVersionPage(
  client: Pick<ApiClient, 'listRegressionModuleVersions'>,
  projectId: string,
  moduleName: string,
  query?: PaginationQuery,
): Promise<RegressionModuleRecordPage> {
  const page = await client.listRegressionModuleVersions(
    projectId,
    moduleName,
    query,
  );

  const pageValidation = validateContract('RegressionModuleRecordPage', page);
  if (!pageValidation.success) {
    throw new Error(
      `Version page contract validation failed: ${pageValidation.errors?.map((e) => e.message).join('; ') || 'invalid page schema'}`,
    );
  }

  for (const item of page.items) {
    const recordValidation = validateContract('RegressionModuleRecord', item);
    if (!recordValidation.success) {
      throw new Error(
        `Version record contract validation failed for ${item.name}@v${item.version}`,
      );
    }
    if (!isSameProjectId(item.projectId, projectId)) {
      throw new Error(
        `Version page contains item from mismatched project: expected ${projectId}, got ${item.projectId} (${item.name}@v${item.version})`,
      );
    }
    if (item.name !== moduleName) {
      throw new Error(
        `Version page contains item from mismatched module: expected ${moduleName}, got ${item.name}@v${item.version}`,
      );
    }
  }

  return page;
}

export interface RequestScopeContext {
  projectId: string;
  moduleName?: string;
}

/**
 * RequestScopeGuard manages asynchronous request generations and project scopes.
 * Used by ModulesPage to prevent slow stale responses from overwriting current state
 * when users switch projects or selected modules.
 */
export class RequestScopeGuard {
  private currentGeneration = 0;
  private currentScope: RequestScopeContext | null = null;

  public resetScope(scope: RequestScopeContext | null): void {
    this.currentGeneration++;
    this.currentScope = scope ? { ...scope } : null;
  }

  public startRequest(scope: RequestScopeContext): {
    generation: number;
    isValid: () => boolean;
  } {
    const requestGen = ++this.currentGeneration;
    this.currentScope = { ...scope };

    return {
      generation: requestGen,
      isValid: () => {
        if (requestGen !== this.currentGeneration) return false;
        if (!this.currentScope) return false;
        if (!isSameProjectId(this.currentScope.projectId, scope.projectId)) {
          return false;
        }
        if (
          scope.moduleName !== undefined &&
          this.currentScope.moduleName !== scope.moduleName
        ) {
          return false;
        }
        return true;
      },
    };
  }

  public isCurrent(generation: number, scope: RequestScopeContext): boolean {
    if (generation !== this.currentGeneration) return false;
    if (!this.currentScope) return false;
    if (!isSameProjectId(this.currentScope.projectId, scope.projectId)) {
      return false;
    }
    if (
      scope.moduleName !== undefined &&
      this.currentScope.moduleName !== scope.moduleName
    ) {
      return false;
    }
    return true;
  }

  public getCurrentGeneration(): number {
    return this.currentGeneration;
  }
}
