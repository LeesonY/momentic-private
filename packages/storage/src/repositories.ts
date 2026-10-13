import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { parseContract, validModelTokenBudget } from '@localqa/contracts';
import type {
  Project,
  ProjectCreate,
  ProjectPatch,
  MemberUpdate,
  Environment,
  EnvironmentCreate,
  EnvironmentPatch,
  AuthProfile,
  AuthProfileCreate,
  AuthProfilePatch,
  ConfigDeleteConfirm,
  Knowledge,
  KnowledgeCreate,
  KnowledgePatch,
  ModelProfile,
  ModelProfileCreate,
  ModelProfilePatch,
  ModelDeleteConfirm,
  Run,
  RunDeleteConfirm,
  Task,
  CaseDefinition,
  Artifact,
  Finding,
  InputRequest,
  Export,
  CaseAttempt,
  RunEvent,
  Summary,
} from '@localqa/contracts';
import {
  Database,
  StorageError,
  authorize,
  requireAdmin,
  audit,
} from './database.js';
import type { Actor } from './database.js';
import { SecretVault, hashPayload } from './crypto.js';

const digest = hashPayload;
export const criteriaHash = (definition: CaseDefinition): string =>
  digest(definition.criteria);
export type SecretDescriptor = {
  id: string;
  name: string;
  purpose: string;
  version: number;
  revoked: boolean;
  createdAt: string;
};
type SecretRow = {
  id: string;
  name: string;
  purpose: string;
  version: number;
  revoked: boolean;
  created_at: Date;
};
async function storeSecret(
  client: PoolClient,
  vault: SecretVault,
  projectId: string,
  name: string,
  purpose: string,
  plaintext: string,
): Promise<{ id: string; version: number }> {
  const id = randomUUID(),
    envelope = vault.encrypt(plaintext, { projectId, secretId: id, purpose });
  await client.query(
    'INSERT INTO secrets(id,project_id,name,purpose) VALUES($1,$2,$3,$4)',
    [id, projectId, name, purpose],
  );
  await client.query(
    'INSERT INTO secret_versions(id,project_id,secret_id,version,ciphertext,nonce,auth_tag,key_version) VALUES($1,$2,$3,1,$4,$5,$6,$7)',
    [
      randomUUID(),
      projectId,
      id,
      envelope.ciphertext,
      envelope.nonce,
      envelope.authTag,
      envelope.keyVersion,
    ],
  );
  return { id, version: 1 };
}
export class SecretRepository {
  constructor(
    private db: Database,
    private vault: SecretVault,
  ) {}
  async create(
    actor: Actor,
    projectId: string,
    name: string,
    purpose: string,
    plaintext: string,
  ): Promise<SecretDescriptor> {
    return this.db.actor(actor, async (client) => {
      await authorize(client, projectId, 'secret.manage');
      const ref = await storeSecret(
        client,
        this.vault,
        projectId,
        name,
        purpose,
        plaintext,
      );
      await audit(client, 'secret.created', ref.id, projectId);
      return this.#metadata(client, projectId, ref.id);
    });
  }
  async #metadata(
    client: PoolClient,
    projectId: string,
    id: string,
  ): Promise<SecretDescriptor> {
    const row = (
      await client.query<SecretRow>(
        'SELECT id,name,purpose,version,revoked,created_at FROM secrets WHERE project_id=$1 AND id=$2',
        [projectId, id],
      )
    ).rows[0];
    if (!row) throw new StorageError('NOT_FOUND');
    return {
      id: row.id,
      name: row.name,
      purpose: row.purpose,
      version: row.version,
      revoked: row.revoked,
      createdAt: row.created_at.toISOString(),
    };
  }
  async metadata(
    actor: Actor,
    projectId: string,
    id: string,
  ): Promise<SecretDescriptor> {
    return this.db.actor(actor, async (client) => {
      await authorize(client, projectId, 'read');
      return this.#metadata(client, projectId, id);
    });
  }
  async rotate(
    actor: Actor,
    projectId: string,
    id: string,
    expectedVersion: number,
    newVault: SecretVault,
  ): Promise<SecretDescriptor> {
    return this.db.actor(actor, async (client) => {
      const metadata = await this.#metadata(client, projectId, id);
      await authorize(client, projectId, 'secret.manage');
      if (metadata.version !== expectedVersion)
        throw new StorageError('VERSION_CONFLICT');
      const row = (
        await client.query<{
          ciphertext: Buffer;
          nonce: Buffer;
          auth_tag: Buffer;
          key_version: number;
        }>(
          'SELECT ciphertext,nonce,auth_tag,key_version FROM secret_versions WHERE project_id=$1 AND secret_id=$2 AND version=$3',
          [projectId, id, metadata.version],
        )
      ).rows[0]!;
      const envelope = newVault.rotate(
        {
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          authTag: row.auth_tag,
          keyVersion: row.key_version,
        },
        { projectId, secretId: id, purpose: metadata.purpose },
      );
      const updated = await client.query(
        'UPDATE secrets SET version=version+1 WHERE project_id=$1 AND id=$2 AND version=$3 AND NOT revoked',
        [projectId, id, expectedVersion],
      );
      if (!updated.rowCount) throw new StorageError('VERSION_CONFLICT');
      await client.query(
        'INSERT INTO secret_versions(id,project_id,secret_id,version,ciphertext,nonce,auth_tag,key_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          randomUUID(),
          projectId,
          id,
          expectedVersion + 1,
          envelope.ciphertext,
          envelope.nonce,
          envelope.authTag,
          envelope.keyVersion,
        ],
      );
      await audit(client, 'secret.rotated', id, projectId, expectedVersion + 1);
      return this.#metadata(client, projectId, id);
    });
  }
}
type ProjectRow = {
  id: string;
  name: string;
  status: Project['status'];
  version: number;
  created_at: Date;
  default_model_profile_id: string | null;
};
const projectDTO = (row: ProjectRow): Project =>
  parseContract('Project', {
    id: row.id,
    name: row.name,
    status: row.status,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    defaultModelProfileId: row.default_model_profile_id,
  });
export class ProjectRepository {
  constructor(private db: Database) {}
  /**
   * Permanent deletion is limited to pristine projects. The SECURITY DEFINER
   * database function rechecks admin identity, name, version, ownership and
   * every project-scoped table under a project row lock, preserving audit logs.
   */
  async deleteEmpty(
    actor: Actor,
    id: string,
    input: { expectedVersion: number; confirmName: string },
  ): Promise<void> {
    await this.db.actor(actor, async (client) => {
      await requireAdmin(client);
      const result = await client.query<{ result: string }>(
        'SELECT public.remove_empty_project($1::uuid,$2::integer,$3::text) AS result',
        [id, input.expectedVersion, input.confirmName],
      );
      switch (result.rows[0]?.result) {
        case 'deleted':
          return;
        case 'not_found':
          throw new StorageError('NOT_FOUND');
        case 'version_conflict':
          throw new StorageError('VERSION_CONFLICT');
        case 'not_empty':
          throw new StorageError(
            'VALIDATION_ERROR',
            '项目包含运行、配置、成员或其他业务数据，不能直接删除。请使用归档。',
          );
        default:
          throw new StorageError('VALIDATION_ERROR', '项目名称确认不匹配');
      }
    });
  }
  async create(actor: Actor, input: ProjectCreate): Promise<Project> {
    const data = parseContract('ProjectCreate', input);
    return this.db.actor(actor, async (client) => {
      await requireAdmin(client);
      const id = randomUUID();
      const row = (
        await client.query<ProjectRow>(
          'INSERT INTO projects(id,name) VALUES($1,$2) RETURNING *',
          [id, data.name],
        )
      ).rows[0]!;
      await client.query(
        "INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'owner')",
        [id, actor.userId],
      );
      await audit(client, 'project.created', id, id);
      return projectDTO(row);
    });
  }
  async get(actor: Actor, id: string): Promise<Project> {
    return this.db.actor(actor, async (client) => {
      const row = (
        await client.query<ProjectRow>('SELECT * FROM projects WHERE id=$1', [
          id,
        ])
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      return projectDTO(row);
    });
  }
  async list(actor: Actor): Promise<Project[]> {
    return this.db.actor(actor, async (client) =>
      (
        await client.query<ProjectRow>(
          'SELECT * FROM projects ORDER BY created_at,id',
        )
      ).rows.map(projectDTO),
    );
  }
  async update(
    actor: Actor,
    id: string,
    input: ProjectPatch,
  ): Promise<Project> {
    const data = parseContract('ProjectPatch', input);
    return this.db.actor(actor, async (client) => {
      const old = (
        await client.query<ProjectRow>(
          'SELECT * FROM projects WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!old) throw new StorageError('NOT_FOUND');
      await authorize(client, id, 'config.write');
      if (data.defaultModelProfileId) {
        // Assigning a default is the contract's owner-only authorization boundary.
        // A grant is also required by run_model_bindings and the worker's model lookup.
        // The FK proves the profile exists even when it is not yet visible under RLS.
        try {
          await client.query(
            'INSERT INTO model_profile_grants(project_id,profile_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
            [id, data.defaultModelProfileId],
          );
        } catch (error) {
          if ((error as { code?: string }).code === '23503')
            throw new StorageError('NOT_FOUND');
          throw error;
        }
      }
      const row = (
        await client.query<ProjectRow>(
          'UPDATE projects SET name=$3,status=$4,default_model_profile_id=$5,version=version+1 WHERE id=$1 AND version=$2 RETURNING *',
          [
            id,
            data.expectedVersion,
            data.name ?? old.name,
            data.status ?? old.status,
            data.defaultModelProfileId === undefined
              ? old.default_model_profile_id
              : data.defaultModelProfileId,
          ],
        )
      ).rows[0];
      if (!row) throw new StorageError('VERSION_CONFLICT');
      await audit(client, 'project.updated', id, id, row.version);
      return projectDTO(row);
    });
  }
  async replaceMembers(
    actor: Actor,
    id: string,
    input: MemberUpdate,
  ): Promise<void> {
    const data = parseContract('MemberUpdate', input);
    if (
      !data.members.some((member) => member.role === 'owner') ||
      new Set(data.members.map((member) => member.userId)).size !==
        data.members.length
    )
      throw new StorageError('VALIDATION_ERROR');
    await this.db.actor(actor, async (client) => {
      const exists = (
        await client.query('SELECT id FROM projects WHERE id=$1 FOR UPDATE', [
          id,
        ])
      ).rowCount;
      if (!exists) throw new StorageError('NOT_FOUND');
      await authorize(client, id, 'members.write');
      if (
        !(
          await client.query(
            'UPDATE projects SET version=version+1 WHERE id=$1 AND version=$2',
            [id, data.expectedVersion],
          )
        ).rowCount
      )
        throw new StorageError('VERSION_CONFLICT');
      for (const member of data.members.filter(
        (member) => member.userId !== actor.userId,
      ))
        await client.query(
          'INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role',
          [id, member.userId, member.role],
        );
      await client.query(
        'DELETE FROM project_members WHERE project_id=$1 AND user_id<>$2 AND NOT(user_id=ANY($3::uuid[]))',
        [id, actor.userId, data.members.map((member) => member.userId)],
      );
      await audit(client, 'members.replaced', id, id, data.expectedVersion + 1);
      const self = data.members.find(
        (member) => member.userId === actor.userId,
      );
      if (self)
        await client.query(
          'INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role',
          [id, actor.userId, self.role],
        );
      else
        await client.query(
          'DELETE FROM project_members WHERE project_id=$1 AND user_id=$2',
          [id, actor.userId],
        );
    });
  }
}
const versionSpecs = {
  Environment: {
    head: 'environments',
    versions: 'environment_versions',
    key: 'environment_id',
  },
  AuthProfile: {
    head: 'auth_profiles',
    versions: 'auth_profile_versions',
    key: 'auth_profile_id',
  },
  Knowledge: {
    head: 'knowledge',
    versions: 'knowledge_versions',
    key: 'knowledge_id',
  },
} as const;
type Versioned = {
  Environment: Environment;
  AuthProfile: AuthProfile;
  Knowledge: Knowledge;
};
async function versionDocument<N extends keyof Versioned>(
  client: PoolClient,
  kind: N,
  projectId: string,
  id: string,
): Promise<Versioned[N]> {
  await authorize(client, projectId, 'read');
  const spec = versionSpecs[kind];
  const row = (
    await client.query<{ document: unknown }>(
      `SELECT v.document FROM ${spec.head} h JOIN ${spec.versions} v ON v.project_id=h.project_id AND v.${spec.key}=h.id AND v.version=h.version WHERE h.project_id=$1 AND h.id=$2 ${kind === 'Knowledge' ? '' : 'AND h.deleted_at IS NULL'}`,
      [projectId, id],
    )
  ).rows[0];
  if (!row) throw new StorageError('NOT_FOUND');
  return parseContract(kind, row.document) as Versioned[N];
}
async function bump(
  client: PoolClient,
  table: string,
  projectId: string,
  id: string,
  expectedVersion: number,
): Promise<void> {
  if (
    !(
      await client.query(
        `UPDATE ${table} SET version=version+1 WHERE project_id=$1 AND id=$2 AND version=$3 ${table === 'environments' || table === 'auth_profiles' ? 'AND deleted_at IS NULL' : ''}`,
        [projectId, id, expectedVersion],
      )
    ).rowCount
  )
    throw new StorageError('VERSION_CONFLICT');
}
function validateAuth(data: AuthProfileCreate): void {
  const origins = data.allowedOrigins.map((origin) => new URL(origin).origin);
  if (data.mode !== 'agent' && data.agentConfig)
    throw new StorageError('VALIDATION_ERROR');
  if (data.mode === 'agent') {
    // Every declared variable has exactly one write-only value; no extras.
    const config = data.agentConfig;
    if (!config) throw new StorageError('VALIDATION_ERROR');
    const names = config.variables.map((variable) => variable.name);
    const values = data.secretInput ?? {};
    if (
      new Set(names).size !== names.length ||
      Object.keys(values).some((key) => !names.includes(key)) ||
      names.some((name) => !values[name])
    )
      throw new StorageError('VALIDATION_ERROR');
    if (config.loginUrl && !origins.includes(new URL(config.loginUrl).origin))
      throw new StorageError('TARGET_NOT_ALLOWED');
  }
  if (
    data.mode === 'form' &&
    data.formConfig &&
    !origins.includes(new URL(data.formConfig.loginUrl).origin)
  )
    throw new StorageError('TARGET_NOT_ALLOWED');
  if (data.mode === 'storage_state') {
    // Importing a state alone is not proof that the user is authenticated.
    if (!data.storageCriterion) throw new StorageError('VALIDATION_ERROR');
    try {
      const state = JSON.parse(data.secretInput?.storageState ?? '') as {
        origins?: { origin: string }[];
        cookies?: { domain: string }[];
      };
      if (!Array.isArray(state.origins) || !Array.isArray(state.cookies))
        throw new Error();
      if (
        state.origins.some((origin) => !origins.includes(origin.origin)) ||
        state.cookies.some(
          (cookie) =>
            !origins.some(
              (origin) =>
                new URL(origin).hostname === cookie.domain.replace(/^\./, ''),
            ),
        )
      )
        throw new Error();
    } catch {
      throw new StorageError('TARGET_NOT_ALLOWED');
    }
  }
}
export class ConfigurationRepository {
  constructor(
    private db: Database,
    private vault: SecretVault,
  ) {}
  get<N extends keyof Versioned>(
    actor: Actor,
    kind: N,
    projectId: string,
    id: string,
  ): Promise<Versioned[N]> {
    return this.db.actor(actor, (client) =>
      versionDocument(client, kind, projectId, id),
    );
  }
  async delete(
    actor: Actor,
    kind: 'Environment' | 'AuthProfile',
    projectId: string,
    id: string,
    input: ConfigDeleteConfirm,
  ): Promise<void> {
    const data = parseContract('ConfigDeleteConfirm', input);
    const spec = versionSpecs[kind];
    await this.db.actor(actor, async (client) => {
      await authorize(client, projectId, 'config.write');
      const row = (
        await client.query<{ document: unknown }>(
          `SELECT v.document FROM ${spec.head} h JOIN ${spec.versions} v
         ON v.project_id=h.project_id AND v.${spec.key}=h.id AND v.version=h.version
         WHERE h.project_id=$1 AND h.id=$2 AND h.deleted_at IS NULL FOR UPDATE OF h`,
          [projectId, id],
        )
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      const current = parseContract(kind, row.document);
      if (current.version !== data.expectedVersion)
        throw new StorageError('VERSION_CONFLICT', '配置已更新，请刷新后重试');
      if (current.name !== data.confirmName)
        throw new StorageError('VALIDATION_ERROR', '输入的名称不匹配');
      const column =
        kind === 'Environment' ? 'environment_id' : 'auth_profile_id';
      if (
        (
          await client.query(
            `SELECT 1 FROM runs WHERE project_id=$1 AND ${column}=$2
         AND status NOT IN ('completed','cancelled','failed') LIMIT 1`,
            [projectId, id],
          )
        ).rowCount
      )
        throw new StorageError(
          'CONFIG_IN_USE',
          '配置仍被未结束的测试任务使用，请结束任务后再删除',
        );
      const scheduleCondition =
        kind === 'Environment'
          ? "s.run_template->>'environmentId'=$2::text"
          : `(s.run_template->>'authProfileId'=$2::text OR
            (s.run_template->>'authProfileId' IS NULL AND EXISTS(
             SELECT 1 FROM environments e JOIN environment_versions v
             ON v.project_id=e.project_id AND v.environment_id=e.id AND v.version=e.version
             WHERE e.project_id=s.project_id AND e.deleted_at IS NULL
             AND e.id::text=s.run_template->>'environmentId' AND v.default_auth_profile_id::text=$2::text)))`;
      if (
        (
          await client.query(
            `SELECT 1 FROM schedules s WHERE s.project_id=$1 AND s.enabled AND ${scheduleCondition} LIMIT 1`,
            [projectId, id],
          )
        ).rowCount
      )
        throw new StorageError(
          'CONFIG_IN_USE',
          '配置仍被启用的定时计划使用，请先调整或停用计划',
        );
      if (kind === 'Environment') {
        if (
          (
            await client.query(
              `SELECT 1 FROM auth_profiles a JOIN auth_profile_versions v
           ON v.project_id=a.project_id AND v.auth_profile_id=a.id AND v.version=a.version
           WHERE a.project_id=$1 AND a.deleted_at IS NULL AND v.environment_id=$2 LIMIT 1`,
              [projectId, id],
            )
          ).rowCount
        )
          throw new StorageError(
            'CONFIG_IN_USE',
            '环境下仍有认证配置，请先删除这些认证配置',
          );
      } else {
        const defaults = (
          await client.query<{ document: unknown }>(
            `SELECT v.document FROM environments e JOIN environment_versions v
           ON v.project_id=e.project_id AND v.environment_id=e.id AND v.version=e.version
           WHERE e.project_id=$1 AND e.deleted_at IS NULL AND v.default_auth_profile_id=$2 FOR UPDATE OF e`,
            [projectId, id],
          )
        ).rows;
        for (const row of defaults) {
          const old = parseContract('Environment', row.document);
          const updated = parseContract('Environment', {
            ...old,
            defaultAuthProfileId: null,
            version: old.version + 1,
          });
          await bump(client, 'environments', projectId, old.id, old.version);
          await client.query(
            'INSERT INTO environment_versions(project_id,environment_id,version,document,default_auth_profile_id) VALUES($1,$2,$3,$4,NULL)',
            [projectId, old.id, updated.version, updated],
          );
          await audit(
            client,
            'environment.updated',
            old.id,
            projectId,
            updated.version,
          );
        }
      }
      await client.query(
        `UPDATE ${spec.head} SET deleted_at=clock_timestamp(),version=version+1 ${kind === 'AuthProfile' ? ',revoked=true' : ''} WHERE project_id=$1 AND id=$2`,
        [projectId, id],
      );
      const deleted = parseContract(kind, {
        ...current,
        version: current.version + 1,
        ...(kind === 'AuthProfile' ? { status: 'revoked' } : {}),
      });
      if (kind === 'AuthProfile') {
        await client.query(
          `INSERT INTO auth_profile_versions(project_id,auth_profile_id,version,document,environment_id,secret_id,secret_version)
           SELECT project_id,auth_profile_id,$4,$5,environment_id,secret_id,secret_version
           FROM auth_profile_versions WHERE project_id=$1 AND auth_profile_id=$2 AND version=$3`,
          [projectId, id, current.version, deleted.version, deleted],
        );
      } else {
        const environment = parseContract('Environment', deleted);
        await client.query(
          'INSERT INTO environment_versions(project_id,environment_id,version,document,default_auth_profile_id) VALUES($1,$2,$3,$4,$5)',
          [
            projectId,
            id,
            deleted.version,
            deleted,
            environment.defaultAuthProfileId,
          ],
        );
      }
      await audit(
        client,
        kind === 'Environment' ? 'environment.deleted' : 'auth.deleted',
        id,
        projectId,
        deleted.version,
      );
    });
  }
  async createEnvironment(
    actor: Actor,
    projectId: string,
    input: EnvironmentCreate,
  ): Promise<Environment> {
    const data = parseContract('EnvironmentCreate', input);
    // A new environment cannot yet own an authentication profile.
    if (data.defaultAuthProfileId) throw new StorageError('TARGET_NOT_ALLOWED');
    return this.db.actor(actor, async (client) => {
      await authorize(client, projectId, 'config.write');
      const dto = parseContract('Environment', {
        ...data,
        id: randomUUID(),
        projectId,
        excludedPaths: data.excludedPaths ?? [],
        defaultAuthProfileId: data.defaultAuthProfileId ?? null,
        version: 1,
      });
      await client.query(
        'INSERT INTO environments(id,project_id) VALUES($1,$2)',
        [dto.id, projectId],
      );
      await client.query(
        'INSERT INTO environment_versions(project_id,environment_id,version,document,default_auth_profile_id) VALUES($1,$2,1,$3,$4)',
        [projectId, dto.id, dto, dto.defaultAuthProfileId],
      );
      await audit(client, 'environment.created', dto.id, projectId);
      return dto;
    });
  }
  async updateEnvironment(
    actor: Actor,
    projectId: string,
    id: string,
    input: EnvironmentPatch,
  ): Promise<Environment> {
    const { expectedVersion, ...patch } = parseContract(
      'EnvironmentPatch',
      input,
    );
    return this.db.actor(actor, async (client) => {
      const old = await versionDocument(client, 'Environment', projectId, id);
      await authorize(client, projectId, 'config.write');
      if (old.version !== expectedVersion)
        throw new StorageError('VERSION_CONFLICT');
      const dto = parseContract('Environment', {
        ...old,
        ...patch,
        version: expectedVersion + 1,
      });
      if (dto.defaultAuthProfileId) {
        // Only an active profile *bound to this exact environment* may become
        // its default. This must be enforced server-side, not by the Web select.
        let auth: AuthProfile;
        try {
          auth = await versionDocument(
            client,
            'AuthProfile',
            projectId,
            dto.defaultAuthProfileId,
          );
        } catch (error) {
          if (error instanceof StorageError && error.code === 'NOT_FOUND')
            throw new StorageError('TARGET_NOT_ALLOWED');
          throw error;
        }
        const allowedOrigins = new Set(
          dto.allowedOrigins.map((origin) => new URL(origin).origin),
        );
        if (
          auth.environmentId !== id ||
          auth.status !== 'active' ||
          auth.allowedOrigins.some(
            (origin) => !allowedOrigins.has(new URL(origin).origin),
          )
        )
          throw new StorageError('TARGET_NOT_ALLOWED');
      }
      await bump(client, 'environments', projectId, id, expectedVersion);
      await client.query(
        'INSERT INTO environment_versions(project_id,environment_id,version,document,default_auth_profile_id) VALUES($1,$2,$3,$4,$5)',
        [projectId, id, dto.version, dto, dto.defaultAuthProfileId],
      );
      await audit(client, 'environment.updated', id, projectId, dto.version);
      return dto;
    });
  }
  async createAuthProfile(
    actor: Actor,
    projectId: string,
    input: AuthProfileCreate,
  ): Promise<AuthProfile> {
    const data = parseContract('AuthProfileCreate', input);
    validateAuth(data);
    return this.db.actor(actor, async (client) => {
      await authorize(client, projectId, 'config.write');
      if (data.environmentId) {
        const env = await versionDocument(
          client,
          'Environment',
          projectId,
          data.environmentId,
        );
        const allowedOrigins = new Set(
          env.allowedOrigins.map((origin) => new URL(origin).origin),
        );
        if (
          data.allowedOrigins.some(
            (origin) => !allowedOrigins.has(new URL(origin).origin),
          )
        )
          throw new StorageError('TARGET_NOT_ALLOWED');
      }
      const id = randomUUID();
      const secret = data.secretInput
        ? await storeSecret(
            client,
            this.vault,
            projectId,
            data.name,
            'auth',
            JSON.stringify(data.secretInput),
          )
        : null;
      const dto = parseContract('AuthProfile', {
        id,
        projectId,
        environmentId: data.environmentId ?? null,
        name: data.name,
        mode: data.mode,
        allowedOrigins: data.allowedOrigins,
        sharingPolicy: data.sharingPolicy ?? 'exclusive_run',
        hasSecret: secret !== null,
        version: 1,
        status: 'active',
        formConfig: data.formConfig ?? null,
        ...(data.agentConfig ? { agentConfig: data.agentConfig } : {}),
        ...(data.storageCriterion
          ? { storageCriterion: data.storageCriterion }
          : {}),
      });
      await client.query(
        'INSERT INTO auth_profiles(id,project_id) VALUES($1,$2)',
        [id, projectId],
      );
      await client.query(
        'INSERT INTO auth_profile_versions(project_id,auth_profile_id,version,document,environment_id,secret_id,secret_version) VALUES($1,$2,1,$3,$4,$5,$6)',
        [
          projectId,
          id,
          dto,
          dto.environmentId,
          secret?.id ?? null,
          secret?.version ?? null,
        ],
      );
      await audit(client, 'auth.created', id, projectId);
      return dto;
    });
  }
  async updateAuthProfile(
    actor: Actor,
    projectId: string,
    id: string,
    input: AuthProfilePatch,
  ): Promise<AuthProfile> {
    const { expectedVersion, secretInput, revoke, ...patch } = parseContract(
      'AuthProfilePatch',
      input,
    );
    return this.db.actor(actor, async (client) => {
      const old = await versionDocument(client, 'AuthProfile', projectId, id);
      await authorize(client, projectId, 'config.write');
      const previous = (
        await client.query<{
          secret_id: string | null;
          secret_version: number | null;
        }>(
          'SELECT secret_id,secret_version FROM auth_profile_versions WHERE project_id=$1 AND auth_profile_id=$2 AND version=$3',
          [projectId, id, old.version],
        )
      ).rows[0]!;
      if (old.version !== expectedVersion)
        throw new StorageError('VERSION_CONFLICT');
      if (
        old.mode === 'storage_state' &&
        !(patch.storageCriterion ?? old.storageCriterion)
      )
        throw new StorageError('VALIDATION_ERROR');
      if (patch.agentConfig && old.mode !== 'agent')
        throw new StorageError('VALIDATION_ERROR');
      if (patch.agentConfig && !secretInput) {
        // Without new values the stored secret must still cover every name.
        const before = (old.agentConfig?.variables ?? [])
          .map((variable) => variable.name)
          .sort();
        const after = patch.agentConfig.variables
          .map((variable) => variable.name)
          .sort();
        if (JSON.stringify(before) !== JSON.stringify(after))
          throw new StorageError('VALIDATION_ERROR');
        const loginUrl = patch.agentConfig.loginUrl;
        if (
          loginUrl &&
          !old.allowedOrigins.some(
            (origin) => new URL(origin).origin === new URL(loginUrl).origin,
          )
        )
          throw new StorageError('TARGET_NOT_ALLOWED');
      }
      if (secretInput)
        validateAuth(
          parseContract('AuthProfileCreate', {
            name: old.name,
            mode: old.mode,
            allowedOrigins: old.allowedOrigins,
            secretInput,
            ...(old.mode === 'storage_state'
              ? {
                  storageCriterion:
                    patch.storageCriterion ?? old.storageCriterion,
                }
              : {}),
            ...((patch.formConfig ?? old.formConfig)
              ? { formConfig: patch.formConfig ?? old.formConfig! }
              : {}),
            ...((patch.agentConfig ?? old.agentConfig)
              ? { agentConfig: patch.agentConfig ?? old.agentConfig! }
              : {}),
          }),
        );
      if (revoke) {
        if (
          !(
            await client.query(
              'UPDATE auth_profiles SET revoked=true,version=version+1 WHERE project_id=$1 AND id=$2 AND version=$3',
              [projectId, id, expectedVersion],
            )
          ).rowCount
        )
          throw new StorageError('VERSION_CONFLICT');
      } else
        await bump(client, 'auth_profiles', projectId, id, expectedVersion);
      const secret = secretInput
        ? await storeSecret(
            client,
            this.vault,
            projectId,
            old.name,
            'auth',
            JSON.stringify(secretInput),
          )
        : null;
      const dto = parseContract('AuthProfile', {
        ...old,
        ...patch,
        version: expectedVersion + 1,
        status: revoke ? 'revoked' : old.status,
        hasSecret: secret ? true : old.hasSecret,
      });
      await client.query(
        'INSERT INTO auth_profile_versions(project_id,auth_profile_id,version,document,environment_id,secret_id,secret_version) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          projectId,
          id,
          dto.version,
          dto,
          dto.environmentId,
          secret?.id ?? previous.secret_id,
          secret?.version ?? previous.secret_version,
        ],
      );
      await audit(client, 'auth.updated', id, projectId, dto.version);
      return dto;
    });
  }
  async createKnowledge(
    actor: Actor,
    projectId: string,
    input: KnowledgeCreate,
  ): Promise<Knowledge> {
    const data = parseContract('KnowledgeCreate', input);
    return this.db.actor(actor, async (client) => {
      await authorize(client, projectId, 'knowledge.write');
      const dto = parseContract('Knowledge', {
        ...data,
        id: randomUUID(),
        projectId,
        approved: false,
        version: 1,
      });
      await client.query('INSERT INTO knowledge(id,project_id) VALUES($1,$2)', [
        dto.id,
        projectId,
      ]);
      await client.query(
        'INSERT INTO knowledge_versions(id,project_id,knowledge_id,version,document,author_id) VALUES($1,$2,$3,1,$4,$5)',
        [randomUUID(), projectId, dto.id, dto, actor.userId],
      );
      await audit(client, 'knowledge.created', dto.id, projectId);
      return dto;
    });
  }
  async updateKnowledge(
    actor: Actor,
    projectId: string,
    id: string,
    input: KnowledgePatch,
  ): Promise<Knowledge> {
    const { expectedVersion, ...patch } = parseContract(
      'KnowledgePatch',
      input,
    );
    return this.db.actor(actor, async (client) => {
      const old = await versionDocument(client, 'Knowledge', projectId, id);
      await authorize(client, projectId, 'knowledge.write');
      if (old.version !== expectedVersion)
        throw new StorageError('VERSION_CONFLICT');
      if (patch.approved !== undefined)
        await authorize(client, projectId, 'knowledge.approve');
      await bump(client, 'knowledge', projectId, id, expectedVersion);
      const dto = parseContract('Knowledge', {
        ...old,
        ...patch,
        approved:
          patch.approved ?? (patch.text === undefined ? old.approved : false),
        version: expectedVersion + 1,
      });
      await client.query(
        'INSERT INTO knowledge_versions(id,project_id,knowledge_id,version,document,author_id) VALUES($1,$2,$3,$4,$5,$6)',
        [randomUUID(), projectId, id, dto.version, dto, actor.userId],
      );
      await audit(client, 'knowledge.updated', id, projectId, dto.version);
      return dto;
    });
  }
}
function modelEndpoint(profile: ModelProfileCreate | ModelProfile): void {
  if (!validModelTokenBudget(profile))
    throw new StorageError(
      'VALIDATION_ERROR',
      '上下文窗口必须大于单次输出上限',
    );
  const url = new URL(profile.endpoint);
  if (
    url.username ||
    url.password ||
    url.search ||
    (profile.dataBoundary === 'external' && url.protocol !== 'https:')
  )
    throw new StorageError('TARGET_NOT_ALLOWED');
}
export class ModelRepository {
  constructor(
    private db: Database,
    private vault: SecretVault,
  ) {}
  async create(actor: Actor, input: ModelProfileCreate): Promise<ModelProfile> {
    const data = parseContract('ModelProfileCreate', input);
    modelEndpoint(data);
    return this.db.actor(actor, async (client) => {
      await requireAdmin(client);
      const id = randomUUID();
      const dto = parseContract('ModelProfile', {
        id,
        name: data.name,
        endpoint: data.endpoint,
        configuredModelId: data.configuredModelId,
        ...(data.responseFormat === undefined
          ? {}
          : { responseFormat: data.responseFormat }),
        ...(data.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: data.maxOutputTokens }),
        ...(data.contextWindowTokens === undefined
          ? {}
          : { contextWindowTokens: data.contextWindowTokens }),
        adapter: data.adapter,
        dataBoundary: data.dataBoundary,
        capabilities: {
          structuredOutput: false,
          nativeTools: false,
          imageInput: false,
        },
        status: 'untested',
        version: 1,
      });
      let credential = null;
      if (data.apiKey) {
        credential = randomUUID();
        const e = this.vault.encrypt(data.apiKey, {
          projectId: id,
          secretId: credential,
          purpose: 'model',
        });
        await client.query(
          "INSERT INTO platform_secrets(id,name,purpose,ciphertext,nonce,auth_tag,key_version) VALUES($1,$2,'model',$3,$4,$5,$6)",
          [
            credential,
            data.name,
            e.ciphertext,
            e.nonce,
            e.authTag,
            e.keyVersion,
          ],
        );
      }
      await client.query('INSERT INTO model_profiles(id) VALUES($1)', [id]);
      await client.query(
        'INSERT INTO model_profile_versions(profile_id,version,document,credential_id) VALUES($1,1,$2,$3)',
        [id, dto, credential],
      );
      await audit(client, 'model.created', id);
      return dto;
    });
  }
  async get(actor: Actor, id: string): Promise<ModelProfile> {
    return this.db.actor(actor, async (client) => {
      const row = (
        await client.query<{ document: unknown }>(
          'SELECT v.document FROM model_profiles p JOIN model_profile_versions v ON v.profile_id=p.id AND v.version=p.version WHERE p.id=$1 AND p.deleted_at IS NULL',
          [id],
        )
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      return parseContract('ModelProfile', row.document);
    });
  }
  async grant(
    actor: Actor,
    projectId: string,
    profileId: string,
  ): Promise<void> {
    await this.db.actor(actor, async (client) => {
      await requireAdmin(client);
      await authorize(client, projectId, 'config.write');
      await client.query(
        'INSERT INTO model_profile_grants(project_id,profile_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [projectId, profileId],
      );
      await audit(client, 'model.granted', profileId, projectId);
    });
  }
  async delete(
    actor: Actor,
    id: string,
    input: ModelDeleteConfirm,
  ): Promise<void> {
    const data = parseContract('ModelDeleteConfirm', input);
    await this.db.actor(actor, async (client) => {
      await requireAdmin(client);
      const row = (
        await client.query<{ document: unknown; credential_id: string | null }>(
          `SELECT v.document,v.credential_id FROM model_profiles p
           JOIN model_profile_versions v ON v.profile_id=p.id AND v.version=p.version
           WHERE p.id=$1 AND p.deleted_at IS NULL FOR UPDATE OF p`,
          [id],
        )
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      const current = parseContract('ModelProfile', row.document);
      if (current.version !== data.expectedVersion)
        throw new StorageError(
          'VERSION_CONFLICT',
          '模型配置已更新，请刷新后重试',
        );
      if (current.name !== data.confirmName)
        throw new StorageError('VALIDATION_ERROR', '输入的模型名称不匹配');
      const inUse = (
        await client.query<{ reason: string }>(
          `SELECT 'default' AS reason FROM projects WHERE default_model_profile_id=$1
           UNION ALL
           SELECT 'run' FROM run_model_bindings b
           JOIN runs r ON r.id=b.run_id AND r.project_id=b.project_id
           WHERE b.profile_id=$1 AND r.status NOT IN ('completed','cancelled','failed')
           UNION ALL
           SELECT 'schedule' FROM schedules s JOIN projects p ON p.id=s.project_id
           WHERE s.enabled AND (s.run_template->>'modelProfileId'=$1::text
             OR (s.run_template->>'modelProfileId' IS NULL
               AND p.default_model_profile_id IS NULL AND $1=(
                 SELECT g.profile_id FROM model_profile_grants g
                 JOIN model_profiles m ON m.id=g.profile_id
                 WHERE g.project_id=s.project_id AND m.deleted_at IS NULL
                 ORDER BY g.profile_id LIMIT 1)))
           LIMIT 1`,
          [id],
        )
      ).rows[0];
      if (inUse)
        throw new StorageError(
          'MODEL_NOT_CONFIGURED',
          inUse.reason === 'default'
            ? '该模型仍是项目默认模型，请先在对应项目中更换或清除默认模型'
            : inUse.reason === 'run'
              ? '该模型仍有未结束的测试任务，请结束任务后再删除'
              : '该模型仍被启用的定时计划引用，请先调整或停用计划',
        );
      const deleted = parseContract('ModelProfile', {
        ...current,
        status: 'disabled',
        version: current.version + 1,
      });
      await client.query(
        'UPDATE model_profiles SET deleted_at=clock_timestamp(),version=version+1 WHERE id=$1',
        [id],
      );
      await client.query(
        'INSERT INTO model_profile_versions(profile_id,version,document,credential_id) VALUES($1,$2,$3,$4)',
        [id, deleted.version, deleted, row.credential_id],
      );
      await audit(client, 'model.deleted', id, null, deleted.version);
    });
  }
  async update(
    actor: Actor,
    id: string,
    input: ModelProfilePatch,
  ): Promise<ModelProfile> {
    const { expectedVersion, apiKey, contextWindowTokens, ...patch } =
      parseContract('ModelProfilePatch', input);
    return this.db.actor(actor, async (client) => {
      const row = (
        await client.query<{
          document: ModelProfile;
          credential_id: string | null;
        }>(
          'SELECT v.document,v.credential_id FROM model_profiles p JOIN model_profile_versions v ON v.profile_id=p.id AND v.version=p.version WHERE p.id=$1 AND p.deleted_at IS NULL',
          [id],
        )
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      await requireAdmin(client);
      if (row.document.version !== expectedVersion)
        throw new StorageError('VERSION_CONFLICT');
      const previous = { ...row.document };
      if (contextWindowTokens === null) delete previous.contextWindowTokens;
      const dto = parseContract('ModelProfile', {
        ...previous,
        ...patch,
        ...(typeof contextWindowTokens === 'number'
          ? { contextWindowTokens }
          : {}),
        ...(apiKey !== undefined ||
        (patch.configuredModelId !== undefined &&
          patch.configuredModelId !== row.document.configuredModelId) ||
        (patch.endpoint !== undefined &&
          patch.endpoint !== row.document.endpoint) ||
        (patch.responseFormat !== undefined &&
          patch.responseFormat !==
            (row.document.responseFormat ?? 'json_schema'))
          ? {
              capabilities: {
                structuredOutput: false,
                nativeTools: false,
                imageInput: false,
              },
              status:
                patch.status ??
                (row.document.status === 'disabled' ? 'disabled' : 'untested'),
            }
          : {}),
        version: expectedVersion + 1,
      });
      modelEndpoint(dto);
      if (
        !(
          await client.query(
            'UPDATE model_profiles SET version=version+1 WHERE id=$1 AND version=$2 AND deleted_at IS NULL',
            [id, expectedVersion],
          )
        ).rowCount
      )
        throw new StorageError('VERSION_CONFLICT');
      let credential = row.credential_id;
      if (apiKey !== undefined) {
        credential = randomUUID();
        const e = this.vault.encrypt(apiKey, {
          projectId: id,
          secretId: credential,
          purpose: 'model',
        });
        await client.query(
          "INSERT INTO platform_secrets(id,name,purpose,ciphertext,nonce,auth_tag,key_version) VALUES($1,$2,'model',$3,$4,$5,$6)",
          [
            credential,
            dto.name,
            e.ciphertext,
            e.nonce,
            e.authTag,
            e.keyVersion,
          ],
        );
      }
      await client.query(
        'INSERT INTO model_profile_versions(profile_id,version,document,credential_id) VALUES($1,$2,$3,$4)',
        [id, dto.version, dto, credential],
      );
      await audit(client, 'model.updated', id, null, dto.version);
      return dto;
    });
  }

  /**
   * Read one frozen version and, when a credential row exists, decrypt it
   * with the same binding create/update used. Pass projectId to require a grant.
   */
  async readVersion(
    actor: Actor,
    profileId: string,
    version: number,
    projectId?: string,
  ): Promise<{ document: ModelProfile; apiKey: string | null }> {
    return this.db.actor(actor, async (client) => {
      const params = projectId
        ? [profileId, version, projectId]
        : [profileId, version];
      const row = (
        await client.query<{
          document: unknown;
          credential_id: string | null;
          ciphertext: Buffer | null;
          nonce: Buffer | null;
          auth_tag: Buffer | null;
          key_version: number | null;
        }>(
          projectId
            ? `SELECT v.document, v.credential_id, s.ciphertext, s.nonce, s.auth_tag, s.key_version
               FROM model_profile_versions v
               JOIN model_profile_grants g ON g.profile_id = v.profile_id
               LEFT JOIN platform_secrets s ON s.id = v.credential_id
               WHERE v.profile_id = $1 AND v.version = $2 AND g.project_id = $3`
            : `SELECT v.document, v.credential_id, s.ciphertext, s.nonce, s.auth_tag, s.key_version
               FROM model_profile_versions v
               LEFT JOIN platform_secrets s ON s.id = v.credential_id
               WHERE v.profile_id = $1 AND v.version = $2`,
          params,
        )
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      const document = parseContract('ModelProfile', row.document);
      if (
        !row.credential_id ||
        !row.ciphertext ||
        !row.nonce ||
        !row.auth_tag ||
        row.key_version == null
      ) {
        return { document, apiKey: null };
      }
      const apiKey = this.vault.decrypt(
        {
          ciphertext: row.ciphertext,
          nonce: row.nonce,
          authTag: row.auth_tag,
          keyVersion: row.key_version,
        },
        {
          projectId: profileId,
          secretId: row.credential_id,
          purpose: 'model',
        },
      );
      return { document, apiKey };
    });
  }

  /**
   * Write probed capabilities only when expectedVersion is still current and
   * the profile is not disabled. A conflict or a disabled row writes nothing.
   */
  async recordProbe(
    actor: Actor,
    profileId: string,
    expectedVersion: number,
    next: {
      capabilities: ModelProfile['capabilities'];
      status: 'ready' | 'degraded' | 'disabled';
    },
  ): Promise<ModelProfile | null> {
    return this.db.actor(actor, async (client) => {
      await requireAdmin(client);
      const row = (
        await client.query<{
          document: unknown;
          credential_id: string | null;
        }>(
          `SELECT v.document, v.credential_id
           FROM model_profiles p
           JOIN model_profile_versions v
             ON v.profile_id = p.id AND v.version = p.version
           WHERE p.id = $1 AND p.deleted_at IS NULL
           FOR UPDATE OF p`,
          [profileId],
        )
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      const current = parseContract('ModelProfile', row.document);
      if (current.version !== expectedVersion)
        throw new StorageError('VERSION_CONFLICT');
      if (current.status === 'disabled') return null;
      const dto = parseContract('ModelProfile', {
        ...current,
        capabilities: next.capabilities,
        status: next.status,
        version: expectedVersion + 1,
      });
      if (
        !(
          await client.query(
            'UPDATE model_profiles SET version=version+1 WHERE id=$1 AND version=$2 AND deleted_at IS NULL',
            [profileId, expectedVersion],
          )
        ).rowCount
      )
        throw new StorageError('VERSION_CONFLICT');
      await client.query(
        'INSERT INTO model_profile_versions(profile_id,version,document,credential_id) VALUES($1,$2,$3,$4)',
        [profileId, dto.version, dto, row.credential_id],
      );
      await audit(client, 'model.probed', profileId, null, dto.version);
      return dto;
    });
  }
}

// Bounded resource lookup: caller supplies a project; both project filter and RLS apply.
const resources = {
  Task: ['jobs', 'Task'],
  CaseDefinition: ['run_cases', 'CaseDefinition'],
  Artifact: ['artifacts', 'Artifact'],
  Finding: ['findings', 'Finding'],
  InputRequest: ['input_requests', 'InputRequest'],
  Export: ['exports', 'Export'],
} as const;
type Resources = {
  Task: Task;
  CaseDefinition: CaseDefinition;
  Artifact: Artifact;
  Finding: Finding;
  InputRequest: InputRequest;
  Export: Export;
};
export class RunRepository {
  constructor(
    private db: Database,
    private vault: SecretVault,
  ) {}
  async create(
    actor: Actor,
    input: Run,
    tasks: Task[] = [],
    refs: { environmentId?: string; authProfileId?: string } = {},
  ): Promise<Run> {
    const run = parseContract('Run', input);
    if (
      run.creatorId !== actor.userId ||
      run.status !== 'queued' ||
      run.contextVersion !== 1 ||
      run.version !== 1
    )
      throw new StorageError('VALIDATION_ERROR');
    return this.db.actor(actor, async (client) => {
      await authorize(client, run.projectId, 'run');
      const project = (
        await client.query<{ status: string }>(
          'SELECT status FROM projects WHERE id=$1',
          [run.projectId],
        )
      ).rows[0]!;
      if (project.status === 'archived')
        throw new StorageError('PROJECT_ARCHIVED');
      const url = new URL(run.targetUrl);
      if (url.username || url.password)
        throw new StorageError('TARGET_NOT_ALLOWED');
      const secret = url.search
        ? await storeSecret(
            client,
            this.vault,
            run.projectId,
            'Run URL',
            'run_url',
            run.targetUrl,
          )
        : null;
      url.search = '';
      url.hash = '';
      const display = parseContract('Run', {
        ...run,
        targetUrl: url.toString(),
      });
      await client.query(
        'INSERT INTO runs(id,project_id,creator_id,display_url,raw_url_secret_id,raw_url_secret_version,status,phase,completion,termination_reason,context_version,version,effective_config,budget_used,environment_id,environment_version,auth_profile_id,auth_profile_version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)',
        [
          run.id,
          run.projectId,
          run.creatorId,
          display.targetUrl,
          secret?.id ?? null,
          secret?.version ?? null,
          run.status,
          run.phase,
          run.completion,
          run.terminationReason,
          run.contextVersion,
          run.version,
          run.effectiveConfig,
          run.budgetUsed,
          refs.environmentId ?? null,
          run.effectiveConfig.environmentVersion,
          refs.authProfileId ?? null,
          run.effectiveConfig.authProfileVersion,
          run.createdAt,
          run.updatedAt,
        ],
      );
      for (const [role, binding] of Object.entries(run.effectiveConfig.models))
        await client.query(
          'INSERT INTO run_model_bindings(project_id,run_id,role,profile_id,version) VALUES($1,$2,$3,$4,$5)',
          [run.projectId, run.id, role, binding.profileId, binding.version],
        );
      for (const id of run.effectiveConfig.knowledgeVersionIds)
        await client.query(
          'INSERT INTO run_knowledge_bindings(project_id,run_id,knowledge_version_id) VALUES($1,$2,$3)',
          [run.projectId, run.id, id],
        );
      await client.query(
        'INSERT INTO run_budgets(project_id,run_id,limits,used) VALUES($1,$2,$3,$4)',
        [run.projectId, run.id, run.effectiveConfig.budget, run.budgetUsed],
      );
      for (const task of tasks) await this.#insertTask(client, run, task);
      await appendEvent(client, run.projectId, run.id, 'run.updated', display);
      await audit(client, 'run.created', run.id, run.projectId);
      return display;
    });
  }
  async #insertTask(client: PoolClient, run: Run, input: Task): Promise<void> {
    const task = parseContract('Task', input);
    if (task.runId !== run.id) throw new StorageError('VALIDATION_ERROR');
    await client.query(
      'INSERT INTO jobs(id,project_id,run_id,case_id,unique_key,role,status,attempt,document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        task.id,
        run.projectId,
        task.runId,
        task.caseId,
        `${run.id}:${task.role}:${task.caseId ?? 'prepare'}:${task.attempt}`,
        task.role,
        task.status,
        task.attempt,
        task,
      ],
    );
  }
  async get(actor: Actor, projectId: string, id: string): Promise<Run> {
    return this.db.actor(actor, async (client) =>
      runDTO(client, projectId, id),
    );
  }
  async delete(
    actor: Actor,
    id: string,
    input: RunDeleteConfirm,
  ): Promise<void> {
    const data = parseContract('RunDeleteConfirm', input);
    await this.db.actor(actor, async (client) => {
      const project = (
        await client.query<{ project_id: string }>(
          'SELECT project_id FROM runs WHERE id=$1',
          [id],
        )
      ).rows[0];
      if (!project) throw new StorageError('NOT_FOUND');
      await authorize(client, project.project_id, 'config.write');
      const row = (
        await client.query<{
          project_id: string;
          status: string;
          version: number;
        }>(
          'SELECT project_id,status,version FROM runs WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      if (data.confirmRunId !== id)
        throw new StorageError('VALIDATION_ERROR', '确认的运行记录不匹配');
      if (data.expectedVersion !== row.version)
        throw new StorageError(
          'VERSION_CONFLICT',
          '运行状态已更新，请刷新后重试',
        );
      if (!['completed', 'cancelled', 'failed'].includes(row.status))
        throw new StorageError(
          'CONFIG_IN_USE',
          '运行尚未结束，请先停止运行后再删除',
        );
      await client.query(
        'INSERT INTO run_deletions(project_id,run_id,deleted_by) VALUES($1,$2,$3)',
        [row.project_id, id, actor.userId],
      );
      await audit(client, 'run.deleted', id, row.project_id, row.version);
    });
  }
  async resource<N extends keyof Resources>(
    actor: Actor,
    kind: N,
    projectId: string,
    id: string,
  ): Promise<Resources[N]> {
    return this.db.actor(actor, async (client) => {
      const [table, schema] = resources[kind];
      const row = (
        await client.query<{ document: unknown; status?: Task['status'] }>(
          `SELECT document${kind === 'Task' ? ',status' : ''} FROM ${table} WHERE project_id=$1 AND id=$2`,
          [projectId, id],
        )
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      const document =
        kind === 'Task'
          ? { ...(row.document as Task), status: row.status }
          : row.document;
      return parseContract(schema, document) as Resources[N];
    });
  }
  async addCase(actor: Actor, input: CaseDefinition): Promise<void> {
    const dto = parseContract('CaseDefinition', input);
    await this.db.actor(actor, async (client) => {
      await runDTO(client, dto.projectId, dto.runId);
      await authorize(client, dto.projectId, 'run');
      await client.query(
        'INSERT INTO run_cases(id,project_id,run_id,document,criteria_hash) VALUES($1,$2,$3,$4,$5)',
        [dto.id, dto.projectId, dto.runId, dto, criteriaHash(dto)],
      );
    });
  }
  async transition(
    actor: Actor,
    projectId: string,
    id: string,
    expectedVersion: number,
    status: Run['status'],
  ): Promise<Run> {
    return this.db.actor(actor, async (client) => {
      await runDTO(client, projectId, id);
      await authorize(client, projectId, 'run');
      if (
        !(
          await client.query(
            'UPDATE runs SET status=$4,version=version+1,updated_at=clock_timestamp() WHERE project_id=$1 AND id=$2 AND version=$3',
            [projectId, id, expectedVersion, status],
          )
        ).rowCount
      )
        throw new StorageError('VERSION_CONFLICT');
      const dto = await runDTO(client, projectId, id);
      await appendEvent(client, projectId, id, 'run.updated', dto);
      return dto;
    });
  }
  async events(
    actor: Actor,
    projectId: string,
    runId: string,
    afterSeq = 0,
  ): Promise<RunEvent[]> {
    return this.db.actor(actor, async (client) => {
      await runDTO(client, projectId, runId);
      const rows = await client.query<{
        seq: string;
        type: RunEvent['type'];
        payload: unknown;
        created_at: Date;
      }>(
        'SELECT seq,type,payload,created_at FROM run_events WHERE project_id=$1 AND run_id=$2 AND seq>$3 ORDER BY seq LIMIT 100',
        [projectId, runId, afterSeq],
      );
      return rows.rows.map((row) =>
        parseContract('RunEvent', {
          schemaVersion: 1,
          id: String(row.seq),
          runId,
          seq: Number(row.seq),
          type: row.type,
          at: row.created_at.toISOString(),
          payload: row.payload,
        }),
      );
    });
  }
  async summary(
    actor: Actor,
    projectId: string,
    runId: string,
  ): Promise<Summary> {
    return this.db.actor(actor, async (client) => {
      await runDTO(client, projectId, runId);
      const rows = await client.query<{ status: string | null }>(
        "SELECT COALESCE(v.document->>'status',CASE WHEN EXISTS(SELECT 1 FROM case_attempts ca WHERE ca.case_id=c.id AND ca.status IN ('running','completed','interrupted','cancelled')) THEN 'inconclusive' END) AS status FROM run_cases c LEFT JOIN final_valid_verdicts v ON v.case_id=c.id WHERE c.project_id=$1 AND c.run_id=$2",
        [projectId, runId],
      );
      const counts = {
        passed: 0,
        issueFound: 0,
        blocked: 0,
        inconclusive: 0,
        notRun: 0,
      };
      for (const row of rows.rows) {
        const key = {
          passed: 'passed',
          issue_found: 'issueFound',
          blocked: 'blocked',
          inconclusive: 'inconclusive',
        }[row.status ?? ''];
        counts[(key ?? 'notRun') as keyof typeof counts]++;
      }
      const planned = rows.rowCount ?? 0,
        evaluated = counts.passed + counts.issueFound,
        attempted = planned - counts.notRun;
      return parseContract('Summary', {
        ...counts,
        planned,
        evaluated,
        attempted,
        passRate: evaluated ? counts.passed / evaluated : null,
        attemptRate: planned ? attempted / planned : null,
      });
    });
  }
}
export async function appendEvent(
  client: PoolClient,
  projectId: string,
  runId: string,
  type: RunEvent['type'],
  payload: unknown,
): Promise<void> {
  const row = (
    await client.query<{ event_seq: string }>(
      'SELECT event_seq FROM runs WHERE project_id=$1 AND id=$2 FOR UPDATE',
      [projectId, runId],
    )
  ).rows[0];
  if (!row) throw new StorageError('NOT_FOUND');
  const seq = Number(row.event_seq) + 1;
  parseContract('RunEvent', {
    schemaVersion: 1,
    id: String(seq),
    runId,
    seq,
    type,
    payload,
    at: new Date().toISOString(),
  });
  await client.query(
    'INSERT INTO run_events(project_id,run_id,seq,type,payload) VALUES($1,$2,$3,$4,$5)',
    [projectId, runId, seq, type, payload],
  );
}
export async function runDTO(
  client: PoolClient,
  projectId: string,
  id: string,
): Promise<Run> {
  await authorize(client, projectId, 'read');
  const row = (
    await client.query<{ dto: unknown }>(
      `SELECT jsonb_build_object('id',id,'projectId',project_id,'creatorId',creator_id,'targetUrl',display_url,'title',(SELECT s.document->>'title' FROM run_sessions s WHERE s.project_id=runs.project_id AND s.run_id=runs.id),'stats',jsonb_build_object('cases',(SELECT count(*)::int FROM run_cases c WHERE c.project_id=runs.project_id AND c.run_id=runs.id),'passed',(SELECT count(*)::int FROM run_cases c JOIN final_valid_verdicts v ON v.project_id=c.project_id AND v.case_id=c.id WHERE c.project_id=runs.project_id AND c.run_id=runs.id AND v.document->>'status'='passed'),'issues',(SELECT count(*)::int FROM run_cases c JOIN final_valid_verdicts v ON v.project_id=c.project_id AND v.case_id=c.id WHERE c.project_id=runs.project_id AND c.run_id=runs.id AND v.document->>'status'='issue_found'),'blocked',(SELECT count(*)::int FROM run_cases c JOIN final_valid_verdicts v ON v.project_id=c.project_id AND v.case_id=c.id WHERE c.project_id=runs.project_id AND c.run_id=runs.id AND v.document->>'status'='blocked'),'findings',(SELECT count(*)::int FROM findings f WHERE f.project_id=runs.project_id AND f.run_id=runs.id)),'executionMode',execution_mode,'status',status,'phase',phase,'completion',completion,'terminationReason',termination_reason,'contextVersion',context_version,'version',version,'effectiveConfig',effective_config,'budgetUsed',COALESCE((SELECT b.used FROM run_budgets b WHERE b.run_id=runs.id),budget_used),'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'updatedAt',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS dto FROM runs WHERE project_id=$1 AND id=$2`,
      [projectId, id],
    )
  ).rows[0];
  if (!row) throw new StorageError('NOT_FOUND');
  return parseContract('Run', row.dto);
}
// Projection helper for attempts; mutable status/timestamps, immutable verdict history.
export async function attemptDTO(
  client: PoolClient,
  projectId: string,
  id: string,
): Promise<CaseAttempt> {
  await authorize(client, projectId, 'read');
  const row = (
    await client.query<{ dto: unknown }>(
      `SELECT jsonb_build_object('id',a.id,'caseId',a.case_id,'taskId',a.task_id,'attemptNumber',a.attempt_number,'status',a.status,'verdict',v.document,'startedAt',CASE WHEN a.started_at IS NULL THEN NULL ELSE to_char(a.started_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,'finishedAt',CASE WHEN a.finished_at IS NULL THEN NULL ELSE to_char(a.finished_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END) dto FROM case_attempts a LEFT JOIN verdicts v ON v.attempt_id=a.id WHERE a.project_id=$1 AND a.id=$2`,
      [projectId, id],
    )
  ).rows[0];
  if (!row) throw new StorageError('NOT_FOUND');
  return parseContract('CaseAttempt', row.dto);
}
