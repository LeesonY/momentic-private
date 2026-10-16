import type { PoolClient } from 'pg';
import { parseContract, type AuthProfile, type Run } from '@localqa/contracts';
import { StorageError, type LeaseProof } from '@localqa/storage';

/** Same run-bound profile ID/project/environment; only self sign-ins may select
 * its current version. Once allocated, the task's private session pins it. */
export async function readRunAuthProfile(
  client: PoolClient,
  run: Run,
  selfSignIn = false,
  proof?: LeaseProof,
): Promise<AuthProfile | null> {
  const row = (
    await client.query<{
      auth_profile_id: string | null;
      auth_profile_version: number | null;
      environment_id: string | null;
      revoked: boolean | null;
      current_status: string | null;
      selected_version: number | null;
      document: unknown;
    }>(
      `SELECT r.auth_profile_id,r.auth_profile_version,r.environment_id,p.revoked,
         h.document->>'status' AS current_status,v.version AS selected_version,v.document
       FROM runs r
       LEFT JOIN auth_profiles p ON p.project_id=r.project_id AND p.id=r.auth_profile_id
         AND p.deleted_at IS NULL
       LEFT JOIN auth_profile_versions h ON h.project_id=p.project_id
         AND h.auth_profile_id=p.id AND h.version=p.version
       LEFT JOIN auth_profile_versions v ON v.project_id=r.project_id
         AND v.auth_profile_id=r.auth_profile_id
         AND v.version=CASE WHEN $3::boolean THEN COALESCE((
           SELECT s.auth_profile_version FROM auth_execution_sessions s
           WHERE s.project_id=r.project_id AND s.run_id=r.id AND s.task_id=$4::uuid
             AND s.fencing_token=$5 AND s.context_version=$6 AND s.purpose='initializer'
         ),p.version) ELSE r.auth_profile_version END
       WHERE r.project_id=$1 AND r.id=$2`,
      [
        run.projectId,
        run.id,
        selfSignIn,
        proof?.taskId ?? null,
        proof?.fencingToken ?? null,
        proof?.contextVersion ?? null,
      ],
    )
  ).rows[0];
  if (!row) throw new StorageError('AUTH_FAILED');
  if (
    row.auth_profile_id === null &&
    row.auth_profile_version === null &&
    run.effectiveConfig.authProfileVersion === null
  )
    return null;
  if (
    !row.auth_profile_id ||
    row.auth_profile_version !== run.effectiveConfig.authProfileVersion ||
    row.revoked !== false ||
    !row.document ||
    (selfSignIn && row.current_status !== 'active')
  )
    throw new StorageError('AUTH_FAILED');
  const profile = parseContract('AuthProfile', row.document);
  if (
    profile.id !== row.auth_profile_id ||
    profile.projectId !== run.projectId ||
    profile.version !== row.selected_version ||
    (!selfSignIn && profile.version !== row.auth_profile_version) ||
    profile.status !== 'active' ||
    (profile.environmentId !== null &&
      profile.environmentId !== row.environment_id)
  )
    throw new StorageError('AUTH_FAILED');
  const allowed = new Set(profile.allowedOrigins.map((o) => new URL(o).origin));
  if (
    run.effectiveConfig.allowedOrigins.some(
      (o) => !allowed.has(new URL(o).origin),
    )
  )
    throw new StorageError('TARGET_NOT_ALLOWED');
  return profile;
}
