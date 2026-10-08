import { parseContract, type SavedCasePage } from '@localqa/contracts';
import type { ApiClient, SavedCase } from '../api/types.ts';
import { isSameProjectId } from './moduleRoles.ts';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSameCaseId(a?: string | null, b?: string | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (UUID_REGEX.test(a) && UUID_REGEX.test(b)) {
    return a.toLowerCase() === b.toLowerCase();
  }
  return false;
}

export interface LifecycleScopeContext {
  projectId: string;
  caseId?: string;
  statusFilter?: string;
  targetProjectId?: string;
}

export class LifecycleSearchError extends Error {
  readonly code: 'SEARCH_LIMIT' | 'REPEATED_CURSOR' | 'PROJECT_MISMATCH';
  constructor(code: 'SEARCH_LIMIT' | 'REPEATED_CURSOR' | 'PROJECT_MISMATCH') {
    super(code);
    this.name = 'LifecycleSearchError';
    this.code = code;
  }
}

function cloneScope(scope: LifecycleScopeContext): LifecycleScopeContext {
  const copy: LifecycleScopeContext = { projectId: scope.projectId };
  if (scope.caseId !== undefined) copy.caseId = scope.caseId;
  if (scope.statusFilter !== undefined) copy.statusFilter = scope.statusFilter;
  if (scope.targetProjectId !== undefined) {
    copy.targetProjectId = scope.targetProjectId;
  }
  return copy;
}

function sameId(kind: 'project' | 'case', a: string, b: string): boolean {
  return kind === 'project' ? isSameProjectId(a, b) : isSameCaseId(a, b);
}

function scopesMatch(
  current: LifecycleScopeContext,
  captured: LifecycleScopeContext,
): boolean {
  if (!sameId('project', current.projectId, captured.projectId)) return false;
  const optional = ['caseId', 'statusFilter', 'targetProjectId'] as const;
  for (const key of optional) {
    const left = current[key];
    const right = captured[key];
    if ((left === undefined) !== (right === undefined)) return false;
    if (left === undefined || right === undefined) continue;
    if (key === 'statusFilter') {
      if (left !== right) return false;
    } else if (!sameId(key === 'caseId' ? 'case' : 'project', left, right)) {
      return false;
    }
  }
  return true;
}

/**
 * Read tokens and mutation captures are separate.
 * resetScope is the only scope switch. startRequest only expires older reads.
 */
export class LifecycleScopeGuard {
  private scopeEpoch = 0;
  private requestSeq = 0;
  private currentScope: LifecycleScopeContext | null = null;

  public resetScope(scope: LifecycleScopeContext | null = null): void {
    this.scopeEpoch++;
    this.requestSeq++;
    this.currentScope = scope ? cloneScope(scope) : null;
  }

  public startRequest(scope: LifecycleScopeContext): {
    generation: number;
    isValid: () => boolean;
  } {
    const requested = cloneScope(scope);
    if (!this.currentScope || !scopesMatch(this.currentScope, requested)) {
      return { generation: this.requestSeq, isValid: () => false };
    }
    const requestSeq = ++this.requestSeq;
    const scopeEpoch = this.scopeEpoch;
    return {
      generation: requestSeq,
      isValid: () =>
        requestSeq === this.requestSeq &&
        scopeEpoch === this.scopeEpoch &&
        this.currentScope !== null &&
        scopesMatch(this.currentScope, requested),
    };
  }

  public captureScope(scope: LifecycleScopeContext): {
    isValid: () => boolean;
  } {
    const captured = cloneScope(scope);
    const scopeEpoch = this.scopeEpoch;
    return {
      isValid: () =>
        scopeEpoch === this.scopeEpoch &&
        this.currentScope !== null &&
        scopesMatch(this.currentScope, captured),
    };
  }

  public isCurrent(generation: number, scope: LifecycleScopeContext): boolean {
    return (
      generation === this.requestSeq &&
      this.currentScope !== null &&
      scopesMatch(this.currentScope, scope)
    );
  }

  public getCurrentGeneration(): number {
    return this.requestSeq;
  }

  public getCurrentScope(): LifecycleScopeContext | null {
    return this.currentScope ? cloneScope(this.currentScope) : null;
  }
}

/**
 * Walk saved-case pages until the case is found or the cursor is exhausted.
 * Does not invent archived/version/baseline fields.
 */
export async function findCaseAcrossPages(
  client: ApiClient,
  projectId: string,
  caseId: string,
  maxPages = 20,
): Promise<SavedCase | null> {
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) {
        throw new LifecycleSearchError('REPEATED_CURSOR');
      }
      seenCursors.add(cursor);
    }
    const body: unknown = await client.listSavedCases(projectId, {
      status: 'all',
      limit: 100,
      cursor,
    });
    const parsed: SavedCasePage = parseContract('SavedCasePage', body);
    for (const item of parsed.items) {
      if (!isSameProjectId(item.projectId, projectId)) {
        throw new LifecycleSearchError('PROJECT_MISMATCH');
      }
    }
    const found = parsed.items.find((item) => isSameCaseId(item.id, caseId));
    if (found) return found;
    if (!parsed.nextCursor) return null;
    if (seenCursors.has(parsed.nextCursor)) {
      throw new LifecycleSearchError('REPEATED_CURSOR');
    }
    cursor = parsed.nextCursor;
  }
  throw new LifecycleSearchError('SEARCH_LIMIT');
}
