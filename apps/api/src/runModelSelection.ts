import type { PoolClient } from 'pg';
import { StorageError } from '@localqa/storage';

/** Select an authorized frozen model without exposing provider secrets. */
export async function selectRunModelBinding(
  client: Pick<PoolClient, 'query'>,
  projectId: string,
  requestedModelProfileId?: string,
): Promise<{ profileId: string; version: number }> {
  const projectRow = (
    await client.query<{ default_model_profile_id: string | null }>(
      'SELECT default_model_profile_id FROM projects WHERE id = $1',
      [projectId],
    )
  ).rows[0];
  if (!projectRow) throw new StorageError('NOT_FOUND');
  let profileId =
    requestedModelProfileId ?? projectRow.default_model_profile_id;
  if (requestedModelProfileId) {
    const grant = (
      await client.query(
        'SELECT 1 FROM model_profile_grants WHERE project_id = $1 AND profile_id = $2',
        [projectId, requestedModelProfileId],
      )
    ).rowCount;
    if (!grant) throw new StorageError('MODEL_NOT_CONFIGURED');
  }
  if (!profileId) {
    const grantRow = (
      await client.query<{ profile_id: string }>(
        'SELECT profile_id FROM model_profile_grants g JOIN model_profiles p ON p.id=g.profile_id WHERE g.project_id = $1 AND p.deleted_at IS NULL ORDER BY profile_id LIMIT 1',
        [projectId],
      )
    ).rows[0];
    profileId = grantRow?.profile_id ?? null;
  }
  if (!profileId) throw new StorageError('MODEL_NOT_CONFIGURED');
  const versionRow = (
    await client.query<{ version: number; status: string }>(
      `SELECT p.version, v.document->>'status' AS status
       FROM model_profiles p
       JOIN model_profile_versions v ON v.profile_id=p.id AND v.version=p.version
       WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [profileId],
    )
  ).rows[0];
  if (!versionRow || ['disabled', 'revoked'].includes(versionRow.status))
    throw new StorageError('MODEL_NOT_CONFIGURED');
  return { profileId, version: versionRow.version };
}
