import { randomUUID } from 'node:crypto';
import { createRegressionPlan } from '@localqa/orchestrator';
import { compileRegression } from '@localqa/orchestrator';
import { parseContract } from '@localqa/contracts';
import type { RegressionDocument, RunConfig } from '@localqa/contracts';
import {
  StorageError,
  hashToken,
  hashPayload,
  newToken,
  audit,
} from '@localqa/storage';
import { DEFAULT_LIMITS } from '@localqa/domain';
import { requireAuth } from '../auth.js';
import { resolveRunAuth } from '../runAuth.js';
import { ApiError } from '../errors.js';
import { parsePagination, paginate, type Router } from '../router.js';
import type { RequestContext } from '../types.js';
import {
  parseRegressionYaml,
  stringifyRegressionYaml,
  validateRegressionDocument,
} from '../yaml.js';

export { validateRegressionDocument };

function sha256Json(value: unknown): string {
  // Canonical JSON remains stable after PostgreSQL JSONB key reordering.
  return hashPayload(value);
}

function reviewDocumentDiff(
  previous: unknown | null,
  document: unknown,
): string {
  const before =
    previous === null ? [] : JSON.stringify(previous, null, 2).split('\n');
  const after = JSON.stringify(document, null, 2).split('\n');
  const diff = [
    '--- approved version',
    '+++ draft version',
    `@@ -${before.length === 0 ? 0 : 1},${before.length} +1,${after.length} @@`,
    ...before.map((line) => `-${line}`),
    ...after.map((line) => `+${line}`),
  ].join('\n');
  if (diff.length > 20000) {
    throw new ApiError(
      'VALIDATION_ERROR',
      '审查差异过大，请拆分用例后重新生成完整预览',
      422,
    );
  }
  return diff;
}

// YAML: accept JSON or a minimal YAML subset (no custom tags, no aliases, depth/size limited).
// We deliberately use JSON as the transport and validate against the same RegressionDocument.
export function parseRegressionPayload(body: unknown): RegressionDocument {
  try {
    const doc = parseContract('RegressionDocument', body);
    validateRegressionDocument(doc);
    return doc;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    if (
      error &&
      typeof error === 'object' &&
      ((error as { name?: string }).name === 'ContractValidationError' ||
        'issues' in error ||
        'contract' in error)
    ) {
      const err = new StorageError('VALIDATION_ERROR');
      err.message = (error as Error).message || 'Invalid RegressionDocument';
      throw err;
    }
    throw error;
  }
}

/** Trusted dispatch reuses exactly the ordinary API admission path. Caller must authenticate independently. */
export async function startTrustedRegressionRun(
  ctx: RequestContext,
): Promise<unknown> {
  const input = parseContract('RegressionRunCreate', ctx.body);
  const idempotencyKey = ctx.headers['idempotency-key'];
  if (
    !idempotencyKey ||
    typeof idempotencyKey !== 'string' ||
    idempotencyKey.length < 1 ||
    idempotencyKey.length > 128
  ) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'Idempotency-Key header is required (1-128 chars)',
      422,
    );
  }
  const result = await ctx.api.db.actor(ctx.actor!, async (client) => {
    const versions = (
      await client.query<{
        id: string;
        case_id: string;
        project_id: string;
        document: unknown;
        review_status: string;
        sha256: string;
      }>(
        'SELECT id, case_id, project_id, document, sha256, review_status FROM saved_case_versions WHERE id = ANY($1::uuid[]) AND project_id = $2 ORDER BY array_position($1::uuid[], id)',
        [input.caseVersionIds, input.projectId],
      )
    ).rows;
    if (versions.length !== input.caseVersionIds.length)
      throw new StorageError('NOT_FOUND');
    for (const v of versions) {
      if (v.review_status !== 'approved')
        throw new StorageError('VALIDATION_ERROR');
    }

    // Lock case heads in stable deterministic order FOR SHARE to avoid deadlocks
    // and prevent admission of cases that are concurrently archived.
    const uniqueCaseIds = Array.from(
      new Set(versions.map((v) => v.case_id)),
    ).sort();
    const caseHeads = (
      await client.query<{ id: string; status: string }>(
        'SELECT id, status FROM saved_cases WHERE project_id = $1 AND id = ANY($2::uuid[]) ORDER BY id ASC FOR SHARE',
        [input.projectId, uniqueCaseIds],
      )
    ).rows;

    for (const head of caseHeads) {
      if (head.status !== 'active') {
        const err = new StorageError('VALIDATION_ERROR');
        err.message = 'Archived case cannot be scheduled for regression';
        throw err;
      }
    }
    // Reuse the standard run creation but with the fixed approved documents as trusted cases.
    const regressionRunId = randomUUID();
    const environmentRow = input.environmentId
      ? (
          await client.query(
            'SELECT v.document FROM environments e JOIN environment_versions v ON v.project_id=e.project_id AND v.environment_id=e.id AND v.version=e.version WHERE e.project_id=$1 AND e.id=$2 AND e.deleted_at IS NULL',
            [input.projectId, input.environmentId],
          )
        ).rows[0]
      : null;
    if (input.environmentId && !environmentRow)
      throw new StorageError('NOT_FOUND');
    const environment = environmentRow
      ? parseContract('Environment', environmentRow.document)
      : null;
    const firstUrl = (versions[0]?.document as RegressionDocument).steps.find(
      (s) => s.kind === 'navigate',
    );
    const targetUrl =
      environment?.baseUrl ??
      (firstUrl?.kind === 'navigate' ? firstUrl.url : 'http://localhost:8080/');
    let allowedOrigins: string[];
    try {
      allowedOrigins = environment?.allowedOrigins ?? [
        new URL(targetUrl).origin,
      ];
    } catch {
      throw new StorageError('VALIDATION_ERROR');
    }
    const authProfile = await resolveRunAuth(
      client,
      input.projectId,
      input.authProfileId ?? environment?.defaultAuthProfileId,
      input.environmentId,
      allowedOrigins,
      true,
    );
    const budget = { ...DEFAULT_LIMITS, ...(input.budget ?? {}) };
    const registered = (
      await client.query(
        'SELECT project_id,name,version,sha256,document,review_status FROM regression_module_versions WHERE project_id=$1 ORDER BY name,version',
        [input.projectId],
      )
    ).rows.map((m) =>
      parseContract('RegressionModuleVersion', {
        projectId: m.project_id,
        name: m.name,
        version: m.version,
        sha256: m.sha256,
        document: m.document,
        reviewStatus: m.review_status,
      }),
    );
    const trustedCases = versions.map((v) => {
      const doc = v.document as RegressionDocument;
      const options = {
        projectId: input.projectId,
        allowedOrigins,
        env: { BASE_URL: targetUrl },
        maxExpandedSteps: budget.maxActionsPerCase,
      };
      let plan: ReturnType<typeof createRegressionPlan>;
      let binding;
      try {
        const expanded = compileRegression(doc, {
          ...options,
          resolveModule: (name, version) =>
            registered.find(
              (module) => module.name === name && module.version === version,
            ),
        });
        const used = new Set(
          expanded.flatMap((entry) =>
            entry.source.modulePath.map((module) => module.ref),
          ),
        );
        binding = parseContract('RegressionBinding', {
          sourceVersionId: v.id,
          sourceDocumentSha256: v.sha256,
          snapshotDocumentSha256: hashPayload(doc),
          document: doc,
          moduleSnapshots: registered.filter((module) =>
            used.has(`${module.name}@${module.version}`),
          ),
        });
        plan = createRegressionPlan(binding, options);
      } catch {
        throw new StorageError('VALIDATION_ERROR');
      }
      return parseContract('CaseDefinition', {
        id: randomUUID(),
        runId: regressionRunId,
        projectId: input.projectId,
        version: 1,
        title: doc.name,
        summary: `Regression from saved case version ${v.id}`,
        preconditions: ['approved saved case version'],
        outline: doc.steps.map(
          (s) => `${s.kind} ${JSON.stringify(s).slice(0, 60)}`,
        ),
        criteria: plan.criteria,
        regression: binding,
      });
    });
    const modelBindings = await ctx.api.db.actor(ctx.actor!, async (client) => {
      const projectRow = (
        await client.query<{ default_model_profile_id: string | null }>(
          'SELECT default_model_profile_id FROM projects WHERE id = $1',
          [input.projectId],
        )
      ).rows[0];
      let profileId = projectRow?.default_model_profile_id;
      if (!profileId) {
        const grantRow = (
          await client.query<{ profile_id: string }>(
            'SELECT profile_id FROM model_profile_grants g JOIN model_profiles p ON p.id=g.profile_id WHERE g.project_id = $1 AND p.deleted_at IS NULL ORDER BY profile_id LIMIT 1',
            [input.projectId],
          )
        ).rows[0];
        profileId = grantRow?.profile_id;
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
      if (!versionRow) throw new StorageError('MODEL_NOT_CONFIGURED');
      if (versionRow.status === 'disabled' || versionRow.status === 'revoked')
        throw new StorageError('MODEL_NOT_CONFIGURED');
      const binding = { profileId, version: versionRow.version };
      return {
        coordinator: binding,
        explorer: binding,
        executor: binding,
        assertion: binding,
        reproducer: binding,
      };
    });
    const runConfig: RunConfig = parseContract('RunConfig', {
      allowedOrigins,
      actionPolicy: 'non_submitting',
      environmentVersion: environment?.version ?? null,
      authProfileVersion: authProfile?.version ?? null,
      models: modelBindings,
      knowledgeVersionIds: [],
      budget,
    });
    const run = await ctx.api.coordinator.start(
      ctx.actor!,
      {
        projectId: input.projectId,
        targetUrl,
        brief: `Regression run of ${versions.length} approved case version(s)`,
        ...(input.environmentId !== undefined
          ? { environmentId: input.environmentId }
          : {}),
        ...(authProfile ? { authProfileId: authProfile.id } : {}),
        ...(input.budget !== undefined ? { budget: input.budget } : {}),
      },
      runConfig,
      idempotencyKey,
      trustedCases,
    );
    return parseContract('Run', run);
  });
  ctx.res.statusCode = 202;
  return result;
}

export function registerSavedCaseRoutes(router: Router): void {
  // GET /projects/{projectId}/saved-cases
  router.get(
    '/api/v1/projects/{projectId}/saved-cases',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const projectId = ctx.params.projectId!;
      const statusParam = ctx.query['status'] ?? 'active';
      if (!['active', 'archived', 'all'].includes(statusParam)) {
        throw new StorageError('VALIDATION_ERROR');
      }

      const items = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const visibleProject = await client.query(
          'SELECT id FROM projects WHERE id = $1',
          [projectId],
        );
        if (!visibleProject.rows[0]) throw new StorageError('NOT_FOUND');
        const rows = await client.query<{
          id: string;
          slug: string;
          name: string;
          status: string;
          current_approved_version_id: string | null;
          version: number;
          created_at: Date;
        }>(
          `SELECT id, slug, name, status, current_approved_version_id, version, created_at
           FROM saved_cases
           WHERE project_id = $1
             AND ($2 = 'all' OR status = $2)
           ORDER BY created_at ASC, id ASC`,
          [projectId, statusParam],
        );
        return rows.rows.map((r) =>
          parseContract('SavedCase', {
            id: r.id,
            projectId,
            slug: r.slug,
            name: r.name,
            status: r.status,
            currentApprovedVersionId: r.current_approved_version_id,
            version: r.version,
            createdAt: r.created_at.toISOString(),
          }),
        );
      });
      const { limit, offset } = parsePagination(ctx.query);
      ctx.res.statusCode = 200;
      return parseContract('SavedCasePage', paginate(items, limit, offset));
    },
  );

  // POST /projects/{projectId}/saved-cases
  router.post(
    '/api/v1/projects/{projectId}/saved-cases',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const projectId = ctx.params.projectId!;
      const input = parseContract('SavedCaseCreate', ctx.body);
      const result = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const project = (
          await client.query<{ id: string }>(
            'SELECT id FROM projects WHERE id = $1',
            [projectId],
          )
        ).rows[0];
        if (!project) throw new StorageError('NOT_FOUND');
        const permission = await client.query<{ allowed: boolean }>(
          "SELECT can_project($1, 'operator') AS allowed",
          [projectId],
        );
        if (!permission.rows[0]?.allowed) throw new StorageError('FORBIDDEN');
        if (input.document && input.sourceRunCaseId)
          throw new StorageError('VALIDATION_ERROR');
        if (!input.document && !input.sourceRunCaseId)
          throw new StorageError('VALIDATION_ERROR');
        let document: RegressionDocument;
        if (input.document) {
          document = parseRegressionPayload(input.document);
        } else {
          const runCase = (
            await client.query<{ document: unknown }>(
              'SELECT document FROM run_cases WHERE id = $1 AND project_id = $2',
              [input.sourceRunCaseId!, projectId],
            )
          ).rows[0];
          if (!runCase) throw new StorageError('NOT_FOUND');
          const c = runCase.document as {
            title: string;
            outline: string[];
            criteria: Array<{ id: string }>;
          };
          document = parseRegressionPayload({
            schemaVersion: 1,
            kind: 'localqa/test',
            id: input.slug,
            name: c.title,
            variables: {},
            criteria: c.criteria,
            steps: [
              ...c.outline
                .filter((line) => line.startsWith('Navigate '))
                .map((line) => ({
                  kind: 'navigate',
                  url: line.slice('Navigate '.length),
                })),
              ...c.criteria.map((cr) => ({
                kind: 'assert',
                criterionId: cr.id,
              })),
            ],
          });
        }
        for (const step of document.steps)
          if (step.kind === 'module') {
            const [name, version] = step.ref.split('@');
            const registered = await client.query(
              "SELECT 1 FROM regression_module_versions WHERE project_id=$1 AND name=$2 AND version=$3 AND review_status='approved'",
              [projectId, name, Number(version)],
            );
            if (!registered.rows.length)
              throw new StorageError('VALIDATION_ERROR');
          }
        const caseId = randomUUID();
        const versionId = randomUUID();
        const sha256 = sha256Json(document);
        await client.query(
          "INSERT INTO saved_cases(id, project_id, slug, name, status, current_approved_version_id, version) VALUES($1,$2,$3,$4,'active',NULL,1)",
          [caseId, projectId, input.slug, input.name],
        );
        await client.query(
          "INSERT INTO saved_case_versions(id, case_id, project_id, version, document, sha256, review_status, created_by) VALUES($1,$2,$3,1,$4,$5,'draft',$6)",
          [versionId, caseId, projectId, document, sha256, ctx.actor!.userId],
        );
        await audit(client, 'saved_case.created', caseId, projectId);
        return parseContract('SavedCase', {
          id: caseId,
          projectId,
          slug: input.slug,
          name: input.name,
          status: 'active',
          currentApprovedVersionId: null,
          version: 1,
          createdAt: new Date().toISOString(),
        });
      });
      ctx.res.statusCode = 201;
      return result;
    },
  );

  // POST /projects/{projectId}/saved-cases/import
  router.post(
    '/api/v1/projects/{projectId}/saved-cases/import',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const projectId = ctx.params.projectId!;
      const input = parseContract('SavedCaseYamlImport', ctx.body);
      const result = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const project = (
          await client.query<{ id: string }>(
            'SELECT id FROM projects WHERE id = $1',
            [projectId],
          )
        ).rows[0];
        if (!project) throw new StorageError('NOT_FOUND');
        const permission = await client.query<{ allowed: boolean }>(
          "SELECT can_project($1, 'operator') AS allowed",
          [projectId],
        );
        if (!permission.rows[0]?.allowed) throw new StorageError('FORBIDDEN');

        const document = parseRegressionYaml(input.yaml);

        for (const step of document.steps) {
          if (step.kind === 'module') {
            const [name, version] = step.ref.split('@');
            const registered = await client.query(
              "SELECT 1 FROM regression_module_versions WHERE project_id=$1 AND name=$2 AND version=$3 AND review_status='approved'",
              [projectId, name, Number(version)],
            );
            if (!registered.rows.length)
              throw new StorageError('VALIDATION_ERROR');
          }
        }

        const caseId = randomUUID();
        const versionId = randomUUID();
        const sha256 = sha256Json(document);
        await client.query(
          "INSERT INTO saved_cases(id, project_id, slug, name, status, current_approved_version_id, version) VALUES($1,$2,$3,$4,'active',NULL,1)",
          [caseId, projectId, input.slug, input.name],
        );
        await client.query(
          "INSERT INTO saved_case_versions(id, case_id, project_id, version, document, sha256, review_status, created_by) VALUES($1,$2,$3,1,$4,$5,'draft',$6)",
          [versionId, caseId, projectId, document, sha256, ctx.actor!.userId],
        );
        await audit(client, 'saved_case.created', caseId, projectId);
        return parseContract('SavedCase', {
          id: caseId,
          projectId,
          slug: input.slug,
          name: input.name,
          status: 'active',
          currentApprovedVersionId: null,
          version: 1,
          createdAt: new Date().toISOString(),
        });
      });
      ctx.res.statusCode = 201;
      return result;
    },
  );

  // GET /saved-cases/{caseId}/versions
  router.get(
    '/api/v1/saved-cases/{caseId}/versions',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const caseId = ctx.params.caseId!;
      const items = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const rows = await client.query<{
          id: string;
          version: number;
          document: unknown;
          sha256: string;
          review_status: string;
          created_by: string;
          created_at: Date;
          reviewed_by: string | null;
          reviewed_at: Date | null;
        }>(
          'SELECT id, version, document, sha256, review_status, created_by, created_at, reviewed_by, reviewed_at FROM saved_case_versions WHERE case_id = $1 ORDER BY version ASC',
          [caseId],
        );
        return rows.rows.map((r) =>
          parseContract('SavedCaseVersion', {
            id: r.id,
            caseId,
            version: r.version,
            document: r.document,
            sha256: r.sha256,
            reviewStatus: r.review_status,
            createdBy: r.created_by,
            createdAt: r.created_at.toISOString(),
            reviewedBy: r.reviewed_by,
            reviewedAt: r.reviewed_at?.toISOString() ?? null,
          }),
        );
      });
      const { limit, offset } = parsePagination(ctx.query);
      ctx.res.statusCode = 200;
      return parseContract(
        'SavedCaseVersionPage',
        paginate(items, limit, offset),
      );
    },
  );

  // POST /saved-cases/{caseId}/versions
  router.post(
    '/api/v1/saved-cases/{caseId}/versions',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const caseId = ctx.params.caseId!;
      const input = parseContract('SavedCaseVersionCreate', ctx.body);
      const result = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const caseRow = (
          await client.query<{ project_id: string; version: number }>(
            'SELECT project_id, version FROM saved_cases WHERE id = $1',
            [caseId],
          )
        ).rows[0];
        if (!caseRow) throw new StorageError('NOT_FOUND');
        if (caseRow.version !== input.expectedVersion)
          throw new StorageError('VERSION_CONFLICT');
        const document = parseRegressionPayload(input.document);
        const nextVersion = caseRow.version + 1;
        const versionId = randomUUID();
        const sha256 = sha256Json(document);
        await client.query(
          "INSERT INTO saved_case_versions(id, case_id, project_id, version, document, sha256, review_status, created_by) VALUES($1,$2,$3,$4,$5,$6,'draft',$7)",
          [
            versionId,
            caseId,
            caseRow.project_id,
            nextVersion,
            document,
            sha256,
            ctx.actor!.userId,
          ],
        );
        await client.query(
          'UPDATE saved_cases SET version = version + 1 WHERE id = $1',
          [caseId],
        );
        await audit(
          client,
          'saved_case.version_created',
          versionId,
          caseRow.project_id,
          nextVersion,
        );
        return parseContract('SavedCaseVersion', {
          id: versionId,
          caseId,
          version: nextVersion,
          document,
          sha256,
          reviewStatus: 'draft',
          createdBy: ctx.actor!.userId,
          createdAt: new Date().toISOString(),
          reviewedBy: null,
          reviewedAt: null,
        });
      });
      ctx.res.statusCode = 201;
      return result;
    },
  );

  // POST /saved-case-versions/{versionId}/review-preview
  router.post(
    '/api/v1/saved-case-versions/{versionId}/review-preview',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const versionId = ctx.params.versionId!;
      const input = parseContract('ReviewPreviewInput', ctx.body);
      const preview = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const row = (
          await client.query<{
            project_id: string;
            case_id: string;
            version: number;
            document: unknown;
            sha256: string;
            review_status: string;
          }>(
            'SELECT project_id, case_id, version, document, sha256, review_status FROM saved_case_versions WHERE id = $1',
            [versionId],
          )
        ).rows[0];
        if (!row) throw new StorageError('NOT_FOUND');
        if (row.version !== input.expectedVersion)
          throw new StorageError('VERSION_CONFLICT');
        if (row.review_status !== 'draft')
          throw new StorageError('VALIDATION_ERROR');
        const authority = await client.query<{ allowed: boolean }>(
          "SELECT can_project($1, 'owner') AS allowed",
          [row.project_id],
        );
        if (!authority.rows[0]?.allowed) throw new StorageError('FORBIDDEN');
        const previewId = randomUUID();
        const token = newToken();
        const tokenH = hashToken(token);
        const approvedBody = { versionId, documentHash: row.sha256, ...input };
        const bodyHash = hashPayload(approvedBody);
        const expiresAt = new Date(Date.now() + 300000).toISOString();
        await client.query(
          `INSERT INTO saved_case_review_previews(id, project_id, version_id, actor_id, expected_version, body_hash, token_hash, expires_at, approved_body)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            previewId,
            row.project_id,
            versionId,
            ctx.actor!.userId,
            row.version,
            bodyHash,
            tokenH,
            expiresAt,
            approvedBody,
          ],
        );
        const previous =
          (
            await client.query<{ document: unknown }>(
              `SELECT v.document FROM saved_cases c JOIN saved_case_versions v
         ON v.id=c.current_approved_version_id AND v.project_id=c.project_id AND v.case_id=c.id
         WHERE c.id=$1 AND c.project_id=$2`,
              [row.case_id, row.project_id],
            )
          ).rows[0]?.document ?? null;
        const diff = reviewDocumentDiff(previous, row.document);
        const previewPayload = {
          versionId,
          ...input,
          diff,
          risks: ['review criteria/actions before approval'],
          confirmationToken: token,
          expiresAt,
        };
        return parseContract('ReviewPreview', previewPayload);
      });
      ctx.res.statusCode = 200;
      return preview;
    },
  );

  // POST /saved-case-versions/{versionId}/review
  router.post(
    '/api/v1/saved-case-versions/{versionId}/review',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const versionId = ctx.params.versionId!;
      const input = parseContract('ReviewCommit', ctx.body);
      const updated = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const tokenH = hashToken(input.confirmationToken);
        const previewRow = (
          await client.query<{
            id: string;
            project_id: string;
            version_id: string;
            actor_id: string;
            expected_version: number;
            body_hash: string;
            approved_body: unknown;
            expires_at: Date;
            consumed_at: Date | null;
          }>(
            'SELECT * FROM saved_case_review_previews WHERE token_hash = $1 FOR UPDATE',
            [tokenH],
          )
        ).rows[0];
        if (!previewRow) throw new StorageError('VALIDATION_ERROR');
        if (previewRow.consumed_at !== null)
          throw new StorageError('VERSION_CONFLICT');
        if (previewRow.expires_at.getTime() <= Date.now())
          throw new StorageError('VERSION_CONFLICT');
        if (
          previewRow.version_id !== versionId ||
          previewRow.actor_id !== ctx.actor!.userId
        )
          throw new StorageError('FORBIDDEN');
        const versionRow = (
          await client.query<{
            case_id: string;
            project_id: string;
            version: number;
            document: unknown;
            sha256: string;
            review_status: string;
            created_by: string;
            created_at: Date;
          }>(
            'SELECT case_id, project_id, version, document, sha256, review_status, created_by, created_at FROM saved_case_versions WHERE id = $1 FOR UPDATE',
            [versionId],
          )
        ).rows[0];
        if (!versionRow) throw new StorageError('NOT_FOUND');
        if (versionRow.version !== input.expectedVersion)
          throw new StorageError('VERSION_CONFLICT');
        if (versionRow.review_status !== 'draft')
          throw new StorageError('VALIDATION_ERROR');
        if (previewRow.expected_version !== input.expectedVersion)
          throw new StorageError('VERSION_CONFLICT');
        if (previewRow.project_id !== versionRow.project_id)
          throw new StorageError('FORBIDDEN');
        const authority = await client.query<{ allowed: boolean }>(
          "SELECT can_project($1, 'owner') AS allowed",
          [versionRow.project_id],
        );
        if (!authority.rows[0]?.allowed) throw new StorageError('FORBIDDEN');
        const expectedBodyHash = hashPayload({
          versionId,
          documentHash: versionRow.sha256,
          expectedVersion: input.expectedVersion,
          decision: input.decision,
          reason: input.reason,
        });
        if (
          previewRow.body_hash !== expectedBodyHash ||
          previewRow.body_hash !== hashPayload(previewRow.approved_body)
        )
          throw new StorageError('VALIDATION_ERROR');
        await client.query(
          'UPDATE saved_case_review_previews SET consumed_at = clock_timestamp() WHERE id = $1',
          [previewRow.id],
        );
        const newStatus =
          input.decision === 'approve' ? 'approved' : 'rejected';
        await client.query(
          'UPDATE saved_case_versions SET review_status = $2, reviewed_by = $3, reviewed_at = clock_timestamp() WHERE id = $1',
          [versionId, newStatus, ctx.actor!.userId],
        );
        if (newStatus === 'approved') {
          await client.query(
            'UPDATE saved_cases SET current_approved_version_id = $1, version = version + 1 WHERE id = $2',
            [versionId, versionRow.case_id],
          );
        }
        await audit(
          client,
          'saved_case.reviewed',
          versionId,
          versionRow.project_id,
          versionRow.version,
        );
        return parseContract('SavedCaseVersion', {
          id: versionId,
          caseId: versionRow.case_id,
          version: versionRow.version,
          document: versionRow.document,
          sha256: versionRow.sha256,
          reviewStatus: newStatus,
          createdBy: versionRow.created_by,
          createdAt: versionRow.created_at.toISOString(),
          reviewedBy: ctx.actor!.userId,
          reviewedAt: new Date().toISOString(),
        });
      });
      ctx.res.statusCode = 200;
      return updated;
    },
  );

  // GET /saved-case-versions/{versionId}/yaml
  router.get(
    '/api/v1/saved-case-versions/{versionId}/yaml',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const versionId = ctx.params.versionId!;
      const result = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const row = (
          await client.query<{
            id: string;
            document: RegressionDocument;
            sha256: string;
          }>(
            'SELECT id, document, sha256 FROM saved_case_versions WHERE id = $1',
            [versionId],
          )
        ).rows[0];
        if (!row) throw new StorageError('NOT_FOUND');

        const yamlString = stringifyRegressionYaml(row.document);
        return parseContract('SavedCaseYamlExport', {
          versionId: row.id,
          sourceDocumentSha256: row.sha256,
          yaml: yamlString,
        });
      });
      ctx.res.statusCode = 200;
      return result;
    },
  );

  // POST /regression-runs
  router.post('/api/v1/regression-runs', async (ctx: RequestContext) => {
    await requireAuth(ctx);
    return startTrustedRegressionRun(ctx);
  });

  // GET /runs/{runId}/cache-stats (actual persisted locator cache events)
  router.get(
    '/api/v1/runs/{runId}/cache-stats',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const runId = ctx.params.runId!;
      const stats = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const row = (
          await client.query<{ id: string; project_id: string }>(
            'SELECT id,project_id FROM runs WHERE id=$1',
            [runId],
          )
        ).rows[0];
        if (!row) throw new StorageError('NOT_FOUND');
        const counters = (
          await client.query<{
            hits: number;
            misses: number;
            invalidated: number;
          }>(
            'SELECT hits,misses,invalidated FROM run_locator_cache_stats WHERE project_id=$1 AND run_id=$2',
            [row.project_id, runId],
          )
        ).rows[0];
        return counters ?? { hits: 0, misses: 0, invalidated: 0 };
      });
      ctx.res.statusCode = 200;
      return parseContract('CacheStats', {
        runId,
        hits: stats.hits,
        misses: stats.misses,
        invalidated: stats.invalidated,
        resolution: 'live_snapshot_verified_role_locator_v1',
        savedModelCalls: 0,
        savedMs: 0,
      });
    },
  );
}
