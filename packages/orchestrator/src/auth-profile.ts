import type { PoolClient } from 'pg';
import { parseContract, type AuthProfile, type Run } from '@localqa/contracts';
import {
  StorageError,
  type LeaseProof,
  type SecretVault,
} from '@localqa/storage';

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

/** Bounded collection of string leaves; values never leave the caller. */
const MAX_SAVED_VALUES = 64;
const MAX_SAVED_VALUE_LENGTH = 10_000;

/**
 * Every string value a decrypted credential material document carries (form
 * username/password, agent variables, storage-state cookies/localStorage).
 * Bounded, never logged, and dropped by the caller right after comparison.
 */
export function savedValuesFromMaterial(material: unknown): string[] {
  const values: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (values.length >= MAX_SAVED_VALUES || depth > 8) return;
    if (typeof node === 'string') {
      if (
        node.length > 0 &&
        node.length <= MAX_SAVED_VALUE_LENGTH &&
        !values.includes(node)
      )
        values.push(node);
      // A JSON-encoded storage state hides its values one level deeper.
      if (node.length > 1 && (node[0] === '{' || node[0] === '[')) {
        try {
          visit(JSON.parse(node), depth + 1);
        } catch {
          // Not JSON; the raw string itself is already collected.
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (node && typeof node === 'object')
      for (const value of Object.values(node)) visit(value, depth + 1);
  };
  visit(material, 0);
  return values;
}

/**
 * The saved credential values of the run's bound auth profile: the version a
 * self sign-in would use (the task's pinned session version, else the profile
 * head) and the run's frozen version. Used only by the released signed-out
 * password lane to refuse typing a real credential.
 *
 * No profile or no secret returns []. A bound secret that cannot be read
 * throws AUTH_FAILED so the caller fails closed instead of assuming the input
 * is safe.
 */
export async function readSavedAuthValues(
  client: PoolClient,
  vault: Pick<SecretVault, 'decrypt'>,
  run: Run,
  proof: LeaseProof,
): Promise<string[]> {
  const row = (
    await client.query<{
      auth_profile_id: string | null;
      frozen_version: number | null;
      current_version: number | null;
      task_version: number | null;
    }>(
      `SELECT r.auth_profile_id,
         r.auth_profile_version AS frozen_version,
         (SELECT p.version FROM auth_profiles p
           WHERE p.project_id=r.project_id AND p.id=r.auth_profile_id
             AND p.deleted_at IS NULL) AS current_version,
         (SELECT s.auth_profile_version FROM auth_execution_sessions s
           WHERE s.project_id=r.project_id AND s.run_id=r.id
             AND s.task_id=$3::uuid AND s.fencing_token=$4
             AND s.context_version=$5 AND s.purpose='initializer') AS task_version
       FROM runs r WHERE r.project_id=$1 AND r.id=$2`,
      [
        run.projectId,
        run.id,
        proof.taskId,
        proof.fencingToken,
        proof.contextVersion,
      ],
    )
  ).rows[0];
  if (!row || row.auth_profile_id === null) return [];
  const selected = [
    ...new Set(
      [row.task_version ?? row.current_version, row.frozen_version].filter(
        (version): version is number =>
          typeof version === 'number' && version > 0,
      ),
    ),
  ];
  if (selected.length === 0) throw new StorageError('AUTH_FAILED');
  const refs = (
    await client.query<{
      version: number;
      secret_id: string | null;
      secret_version: number | null;
    }>(
      `SELECT version,secret_id,secret_version FROM auth_profile_versions
       WHERE project_id=$1 AND auth_profile_id=$2 AND version = ANY($3::integer[])`,
      [run.projectId, row.auth_profile_id, selected],
    )
  ).rows;
  const values: string[] = [];
  for (const version of selected) {
    const ref = refs.find((candidate) => candidate.version === version);
    if (!ref) throw new StorageError('AUTH_FAILED');
    // A version without a secret carries no saved credential at all.
    if (!ref.secret_id || !ref.secret_version) continue;
    const secret = (
      await client.query<{
        ciphertext: Buffer;
        nonce: Buffer;
        auth_tag: Buffer;
        key_version: number;
        purpose: string;
      }>(
        `SELECT v.ciphertext,v.nonce,v.auth_tag,v.key_version,s.purpose
         FROM secret_versions v
         JOIN secrets s ON s.id=v.secret_id AND s.project_id=v.project_id
         WHERE v.project_id=$1 AND v.secret_id=$2 AND v.version=$3
           AND NOT s.revoked`,
        [run.projectId, ref.secret_id, ref.secret_version],
      )
    ).rows[0];
    if (!secret) throw new StorageError('AUTH_FAILED');
    let material: unknown;
    try {
      material = JSON.parse(
        vault.decrypt(
          {
            ciphertext: secret.ciphertext,
            nonce: secret.nonce,
            authTag: secret.auth_tag,
            keyVersion: secret.key_version,
          },
          {
            projectId: run.projectId,
            secretId: ref.secret_id,
            purpose: secret.purpose,
          },
        ),
      );
    } catch {
      throw new StorageError('AUTH_FAILED');
    }
    for (const value of savedValuesFromMaterial(material))
      if (!values.includes(value)) values.push(value);
    if (values.length >= MAX_SAVED_VALUES) break;
  }
  return values;
}
