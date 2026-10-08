import { parseContract } from '@localqa/contracts';
import type { ApiClient, SavedCaseVersion } from '../api/types.ts';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SavedCaseVersionPageError extends Error {
  readonly code:
    | 'SEARCH_LIMIT'
    | 'REPEATED_CURSOR'
    | 'CASE_MISMATCH'
    | 'CONTENT_CONFLICT'
    | 'VALIDATION_ERROR';
  constructor(
    code:
      | 'SEARCH_LIMIT'
      | 'REPEATED_CURSOR'
      | 'CASE_MISMATCH'
      | 'CONTENT_CONFLICT'
      | 'VALIDATION_ERROR',
  ) {
    super(code);
    this.name = 'SavedCaseVersionPageError';
    this.code = code;
  }
}

function canonicalUuid(value: string): string {
  if (!UUID_REGEX.test(value)) {
    throw new SavedCaseVersionPageError('VALIDATION_ERROR');
  }
  return value.toLowerCase();
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return value;
}

function contentIdentity(item: SavedCaseVersion): string {
  return JSON.stringify(
    canonicalJson({
      id: item.id.toLowerCase(),
      caseId: item.caseId.toLowerCase(),
      version: item.version,
      sha256: item.sha256,
      reviewStatus: item.reviewStatus,
      document: item.document,
      createdBy: item.createdBy.toLowerCase(),
      createdAt: item.createdAt,
      reviewedBy: item.reviewedBy?.toLowerCase() ?? null,
      reviewedAt: item.reviewedAt,
    }),
  );
}

export async function fetchSavedCaseVersionsAcrossPages(
  client: Pick<ApiClient, 'listSavedCaseVersions'>,
  caseId: string,
  maxPages = 20,
): Promise<SavedCaseVersion[]> {
  const targetCaseId = canonicalUuid(caseId);
  const seenCursors = new Set<string>();
  const seenVersions = new Map<string, string>();
  const versions: SavedCaseVersion[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) {
        throw new SavedCaseVersionPageError('REPEATED_CURSOR');
      }
      seenCursors.add(cursor);
    }
    const body: unknown = await client.listSavedCaseVersions(caseId, {
      limit: 100,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    const parsed = parseContract('SavedCaseVersionPage', body);
    for (const item of parsed.items) {
      if (canonicalUuid(item.caseId) !== targetCaseId) {
        throw new SavedCaseVersionPageError('CASE_MISMATCH');
      }
      const versionId = canonicalUuid(item.id);
      const identity = contentIdentity(item);
      const previous = seenVersions.get(versionId);
      if (previous !== undefined) {
        if (previous !== identity) {
          throw new SavedCaseVersionPageError('CONTENT_CONFLICT');
        }
        continue;
      }
      seenVersions.set(versionId, identity);
      versions.push(item);
    }
    if (!parsed.nextCursor) return versions;
    if (seenCursors.has(parsed.nextCursor)) {
      throw new SavedCaseVersionPageError('REPEATED_CURSOR');
    }
    cursor = parsed.nextCursor;
  }
  throw new SavedCaseVersionPageError('SEARCH_LIMIT');
}
