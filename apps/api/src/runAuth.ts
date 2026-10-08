import { parseContract } from '@localqa/contracts';
import type { AuthProfile } from '@localqa/contracts';
import { StorageError } from '@localqa/storage';
import type { PoolClient } from 'pg';

/** Admission metadata only. Secrets are resolved later by the lease-bound broker. */
export async function resolveRunAuth(
  client: PoolClient,
  projectId: string,
  authProfileId: string | null | undefined,
  environmentId: string | undefined,
  allowedOrigins: readonly string[],
  regression: boolean,
): Promise<AuthProfile | null> {
  if (!authProfileId) return null;
  const row = (
    await client.query<{ document: unknown; revoked: boolean }>(
      'SELECT v.document,p.revoked FROM auth_profiles p JOIN auth_profile_versions v ON v.project_id=p.project_id AND v.auth_profile_id=p.id AND v.version=p.version WHERE p.project_id=$1 AND p.id=$2',
      [projectId, authProfileId],
    )
  ).rows[0];
  if (!row) throw new StorageError('NOT_FOUND');
  const profile = parseContract('AuthProfile', row.document);
  if (profile.projectId !== projectId || profile.id !== authProfileId)
    throw new StorageError('NOT_FOUND');
  if (row.revoked || profile.status !== 'active')
    throw new StorageError('VALIDATION_ERROR');
  if (profile.environmentId !== null && profile.environmentId !== environmentId)
    throw new StorageError('VALIDATION_ERROR');
  const approvedOrigins = new Set(
    profile.allowedOrigins.map((origin) => new URL(origin).origin),
  );
  if (
    allowedOrigins.some(
      (origin) => !approvedOrigins.has(new URL(origin).origin),
    )
  )
    throw new StorageError('TARGET_NOT_ALLOWED');
  if (regression && profile.mode !== 'none') {
    const error = new StorageError('VALIDATION_ERROR');
    error.message = 'Regression auth profile execution is not connected yet';
    throw error;
  }
  return profile;
}
