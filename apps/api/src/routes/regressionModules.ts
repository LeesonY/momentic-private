import { randomUUID } from 'node:crypto';
import { parseContract, getApiValidator } from '@localqa/contracts';
import type {
  RegressionModuleRecord,
  RegressionDocument,
} from '@localqa/contracts';
import {
  StorageError,
  hashToken,
  hashPayload,
  newToken,
} from '@localqa/storage';
import { requireAuth } from '../auth.js';
import { parsePagination, paginate, type Router } from '../router.js';
import type { RequestContext } from '../types.js';
import {
  validateModuleName,
  parseModuleVersion,
  validateModuleTemplateStatic,
} from '../moduleTemplate.js';

const validateCreatePath = getApiValidator('createRegressionModule', {
  kind: 'parameters',
  location: 'path',
});
const validateListPath = getApiValidator('listRegressionModules', {
  kind: 'parameters',
  location: 'path',
});
const validateVersionsPath = getApiValidator('listRegressionModuleVersions', {
  kind: 'parameters',
  location: 'path',
});
const validatePreviewPath = getApiValidator('previewRegressionModuleReview', {
  kind: 'parameters',
  location: 'path',
});
const validateReviewPath = getApiValidator('reviewRegressionModuleVersion', {
  kind: 'parameters',
  location: 'path',
});

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
    const error = new StorageError('VALIDATION_ERROR');
    error.message = '审查差异过大，请拆分用例后重新生成完整预览';
    throw error;
  }
  return diff;
}

export function registerRegressionModuleRoutes(router: Router): void {
  // POST /api/v1/projects/{projectId}/regression-modules
  router.post(
    '/api/v1/projects/{projectId}/regression-modules',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const rawProjectId = ctx.params.projectId!;
      if (!validateCreatePath({ projectId: rawProjectId })) {
        throw new StorageError('VALIDATION_ERROR');
      }
      const projectId = rawProjectId.toLowerCase();

      const input = parseContract('RegressionModuleCreate', ctx.body);
      validateModuleName(input.name);

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

        // Fetch all approved modules in project for static topology validation
        const approvedModules = (
          await client.query<{
            name: string;
            version: number;
            document: RegressionDocument;
            sha256: string;
            review_status: string;
          }>(
            "SELECT name, version, document, sha256, review_status FROM regression_module_versions WHERE project_id = $1 AND review_status = 'approved'",
            [projectId],
          )
        ).rows;

        const approvedMap = new Map(
          approvedModules.map((m) => [
            `${m.name}@${m.version}`,
            {
              document: m.document,
              sha256: m.sha256,
              reviewStatus: m.review_status,
            },
          ]),
        );

        validateModuleTemplateStatic(input.document, (name, version) =>
          approvedMap.get(`${name}@${version}`),
        );

        // Lock project+module for optimistic version allocation
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1 || ':' || $2, 0))",
          [projectId, input.name],
        );

        const currentMaxRow = (
          await client.query<{ current_version: number }>(
            'SELECT COALESCE(max(version), 0)::integer AS current_version FROM regression_module_versions WHERE project_id = $1 AND name = $2',
            [projectId, input.name],
          )
        ).rows[0]!;
        const currentVersion = currentMaxRow.current_version;

        if (
          input.expectedVersion !== undefined &&
          input.expectedVersion !== null
        ) {
          if (currentVersion !== input.expectedVersion) {
            throw new StorageError('VERSION_CONFLICT');
          }
        } else {
          if (currentVersion > 0) {
            throw new StorageError('VERSION_CONFLICT');
          }
        }

        const nextVersion = currentVersion + 1;
        if (nextVersion > 2147483647) {
          const err = new StorageError('VALIDATION_ERROR');
          err.message = 'Module version upper bound reached';
          throw err;
        }

        const sha256 = hashPayload(input.document);

        const inserted = (
          await client.query<{
            project_id: string;
            name: string;
            version: number;
            sha256: string;
            document: RegressionDocument;
            review_status: RegressionModuleRecord['reviewStatus'];
            created_by: string | null;
            created_at: Date | null;
            reviewed_by: string | null;
            reviewed_at: Date | null;
          }>(
            `INSERT INTO regression_module_versions(
               project_id, name, version, sha256, document, review_status, created_by, created_at
             ) VALUES($1, $2, $3, $4, $5, 'draft', $6, clock_timestamp())
             RETURNING project_id, name, version, sha256, document, review_status, created_by, created_at, reviewed_by, reviewed_at`,
            [
              projectId,
              input.name,
              nextVersion,
              sha256,
              input.document,
              ctx.actor!.userId,
            ],
          )
        ).rows[0]!;

        // Dedicated audit log without composite string in object_id
        await client.query(
          `INSERT INTO audit_log(id, project_id, actor_id, action, object_id, result, redacted_summary)
           VALUES($1, $2, $3, 'regression_module.created', NULL, 'ok', $4)`,
          [
            randomUUID(),
            projectId,
            ctx.actor!.userId,
            JSON.stringify({
              name: input.name,
              version: nextVersion,
              sha256,
            }),
          ],
        );

        return parseContract('RegressionModuleRecord', {
          projectId: inserted.project_id,
          name: inserted.name,
          version: inserted.version,
          sha256: inserted.sha256,
          document: inserted.document,
          reviewStatus: inserted.review_status,
          createdBy: inserted.created_by,
          createdAt: inserted.created_at?.toISOString() ?? null,
          reviewedBy: inserted.reviewed_by,
          reviewedAt: inserted.reviewed_at?.toISOString() ?? null,
        });
      });

      ctx.res.statusCode = 201;
      return result;
    },
  );

  // GET /api/v1/projects/{projectId}/regression-modules
  router.get(
    '/api/v1/projects/{projectId}/regression-modules',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const rawProjectId = ctx.params.projectId!;
      if (!validateListPath({ projectId: rawProjectId })) {
        throw new StorageError('VALIDATION_ERROR');
      }
      const projectId = rawProjectId.toLowerCase();

      const items = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const visible = (
          await client.query('SELECT id FROM projects WHERE id = $1', [
            projectId,
          ])
        ).rows[0];
        if (!visible) throw new StorageError('NOT_FOUND');

        const rows = (
          await client.query<{
            project_id: string;
            name: string;
            version: number;
            sha256: string;
            document: RegressionDocument;
            review_status: RegressionModuleRecord['reviewStatus'];
            created_by: string | null;
            created_at: Date | null;
            reviewed_by: string | null;
            reviewed_at: Date | null;
          }>(
            `SELECT project_id, name, version, sha256, document, review_status,
                    created_by, created_at, reviewed_by, reviewed_at
             FROM regression_module_versions
             WHERE project_id = $1
             ORDER BY name ASC, version DESC`,
            [projectId],
          )
        ).rows;

        return rows.map((r) =>
          parseContract('RegressionModuleRecord', {
            projectId: r.project_id,
            name: r.name,
            version: r.version,
            sha256: r.sha256,
            document: r.document,
            reviewStatus: r.review_status,
            createdBy: r.created_by,
            createdAt: r.created_at?.toISOString() ?? null,
            reviewedBy: r.reviewed_by,
            reviewedAt: r.reviewed_at?.toISOString() ?? null,
          }),
        );
      });

      const { limit, offset } = parsePagination(ctx.query);
      ctx.res.statusCode = 200;
      return parseContract(
        'RegressionModuleRecordPage',
        paginate(items, limit, offset),
      );
    },
  );

  // GET /api/v1/projects/{projectId}/regression-modules/{moduleName}/versions
  router.get(
    '/api/v1/projects/{projectId}/regression-modules/{moduleName}/versions',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const rawProjectId = ctx.params.projectId!;
      const moduleName = ctx.params.moduleName!;
      validateModuleName(moduleName);
      if (!validateVersionsPath({ projectId: rawProjectId, moduleName })) {
        throw new StorageError('VALIDATION_ERROR');
      }
      const projectId = rawProjectId.toLowerCase();

      const items = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const visible = (
          await client.query('SELECT id FROM projects WHERE id = $1', [
            projectId,
          ])
        ).rows[0];
        if (!visible) throw new StorageError('NOT_FOUND');

        const rows = (
          await client.query<{
            project_id: string;
            name: string;
            version: number;
            sha256: string;
            document: RegressionDocument;
            review_status: RegressionModuleRecord['reviewStatus'];
            created_by: string | null;
            created_at: Date | null;
            reviewed_by: string | null;
            reviewed_at: Date | null;
          }>(
            `SELECT project_id, name, version, sha256, document, review_status,
                    created_by, created_at, reviewed_by, reviewed_at
             FROM regression_module_versions
             WHERE project_id = $1 AND name = $2
             ORDER BY version DESC`,
            [projectId, moduleName],
          )
        ).rows;

        if (rows.length === 0) {
          throw new StorageError('NOT_FOUND');
        }

        return rows.map((r) =>
          parseContract('RegressionModuleRecord', {
            projectId: r.project_id,
            name: r.name,
            version: r.version,
            sha256: r.sha256,
            document: r.document,
            reviewStatus: r.review_status,
            createdBy: r.created_by,
            createdAt: r.created_at?.toISOString() ?? null,
            reviewedBy: r.reviewed_by,
            reviewedAt: r.reviewed_at?.toISOString() ?? null,
          }),
        );
      });

      const { limit, offset } = parsePagination(ctx.query);
      ctx.res.statusCode = 200;
      return parseContract(
        'RegressionModuleRecordPage',
        paginate(items, limit, offset),
      );
    },
  );

  // POST /api/v1/projects/{projectId}/regression-modules/{moduleName}/versions/{version}/review-preview
  router.post(
    '/api/v1/projects/{projectId}/regression-modules/{moduleName}/versions/{version}/review-preview',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const rawProjectId = ctx.params.projectId!;
      const moduleName = ctx.params.moduleName!;
      validateModuleName(moduleName);
      const version = parseModuleVersion(ctx.params.version!);
      if (
        !validatePreviewPath({ projectId: rawProjectId, moduleName, version })
      ) {
        throw new StorageError('VALIDATION_ERROR');
      }
      const projectId = rawProjectId.toLowerCase();

      const input = parseContract(
        'RegressionModuleReviewPreviewInput',
        ctx.body,
      );

      const preview = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const project = (
          await client.query<{ id: string }>(
            'SELECT id FROM projects WHERE id = $1',
            [projectId],
          )
        ).rows[0];
        if (!project) throw new StorageError('NOT_FOUND');

        const isOwner = (
          await client.query<{ allowed: boolean }>(
            "SELECT can_project($1, 'owner') AS allowed",
            [projectId],
          )
        ).rows[0]?.allowed;
        if (!isOwner) throw new StorageError('FORBIDDEN');

        const row = (
          await client.query<{
            project_id: string;
            name: string;
            version: number;
            document: unknown;
            sha256: string;
            review_status: string;
          }>(
            'SELECT project_id, name, version, document, sha256, review_status FROM regression_module_versions WHERE project_id = $1 AND name = $2 AND version = $3',
            [projectId, moduleName, version],
          )
        ).rows[0];

        if (!row) throw new StorageError('NOT_FOUND');
        if (row.review_status !== 'draft') {
          throw new StorageError('VERSION_CONFLICT');
        }
        if (input.expectedVersion !== row.version) {
          throw new StorageError('VERSION_CONFLICT');
        }

        const previewId = randomUUID();
        const token = newToken();
        const tokenH = hashToken(token);
        const expiresAt = new Date(Date.now() + 300000).toISOString();
        const bodyHash = hashPayload(row.document);

        await client.query(
          `INSERT INTO regression_module_review_previews(
             id, project_id, module_name, version, actor_id, expected_version,
             body_hash, token_hash, decision, reason, expires_at, approved_body
           ) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            previewId,
            projectId,
            moduleName,
            version,
            ctx.actor!.userId,
            input.expectedVersion,
            bodyHash,
            tokenH,
            input.decision,
            input.reason,
            expiresAt,
            row.document,
          ],
        );

        const previousRow = (
          await client.query<{ document: unknown }>(
            'SELECT document FROM regression_module_versions WHERE project_id = $1 AND name = $2 AND version = $3',
            [projectId, moduleName, version - 1],
          )
        ).rows[0];

        const diff = reviewDocumentDiff(
          previousRow?.document ?? null,
          row.document,
        );

        return parseContract('RegressionModuleReviewPreview', {
          projectId,
          moduleName,
          version: row.version,
          documentSha256: row.sha256,
          expectedVersion: input.expectedVersion,
          decision: input.decision,
          reason: input.reason,
          diff,
          risks: ['review criteria/actions before approval'],
          confirmationToken: token,
          expiresAt,
        });
      });

      ctx.res.statusCode = 200;
      return preview;
    },
  );

  // POST /api/v1/projects/{projectId}/regression-modules/{moduleName}/versions/{version}/review
  router.post(
    '/api/v1/projects/{projectId}/regression-modules/{moduleName}/versions/{version}/review',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const rawProjectId = ctx.params.projectId!;
      const moduleName = ctx.params.moduleName!;
      validateModuleName(moduleName);
      const version = parseModuleVersion(ctx.params.version!);
      if (
        !validateReviewPath({ projectId: rawProjectId, moduleName, version })
      ) {
        throw new StorageError('VALIDATION_ERROR');
      }
      const projectId = rawProjectId.toLowerCase();

      const input = parseContract('RegressionModuleReviewCommit', ctx.body);

      const updated = await ctx.api.db.actor(ctx.actor!, async (client) => {
        // Project RLS existence check first (404 NOT_FOUND for cross-project non-member)
        const project = (
          await client.query<{ id: string }>(
            'SELECT id FROM projects WHERE id = $1',
            [projectId],
          )
        ).rows[0];
        if (!project) throw new StorageError('NOT_FOUND');

        const isOwner = (
          await client.query<{ allowed: boolean }>(
            "SELECT can_project($1, 'owner') AS allowed",
            [projectId],
          )
        ).rows[0]?.allowed;
        if (!isOwner) throw new StorageError('FORBIDDEN');

        const tokenH = hashToken(input.confirmationToken);
        const previewRow = (
          await client.query<{
            id: string;
            project_id: string;
            module_name: string;
            version: number;
            actor_id: string;
            expected_version: number;
            body_hash: string;
            decision: string;
            reason: string;
            expires_at: Date;
            consumed_at: Date | null;
          }>(
            'SELECT * FROM regression_module_review_previews WHERE token_hash = $1 FOR UPDATE',
            [tokenH],
          )
        ).rows[0];

        // Cross-actor hidden token, expired, consumed, or mismatch: uniformly returns 409
        if (!previewRow) throw new StorageError('VERSION_CONFLICT');
        if (previewRow.consumed_at !== null)
          throw new StorageError('VERSION_CONFLICT');
        if (previewRow.expires_at.getTime() <= Date.now())
          throw new StorageError('VERSION_CONFLICT');
        if (
          previewRow.project_id.toLowerCase() !== projectId ||
          previewRow.module_name !== moduleName ||
          previewRow.version !== version
        ) {
          throw new StorageError('VERSION_CONFLICT');
        }
        if (
          previewRow.expected_version !== input.expectedVersion ||
          previewRow.decision !== input.decision ||
          previewRow.reason !== input.reason
        ) {
          throw new StorageError('VERSION_CONFLICT');
        }

        const versionRow = (
          await client.query<{
            project_id: string;
            name: string;
            version: number;
            document: unknown;
            sha256: string;
            review_status: string;
          }>(
            'SELECT * FROM regression_module_versions WHERE project_id = $1 AND name = $2 AND version = $3 FOR UPDATE',
            [projectId, moduleName, version],
          )
        ).rows[0];

        if (!versionRow) throw new StorageError('NOT_FOUND');
        if (versionRow.review_status !== 'draft') {
          throw new StorageError('VERSION_CONFLICT');
        }

        const currentBodyHash = hashPayload(versionRow.document);
        if (currentBodyHash !== previewRow.body_hash) {
          throw new StorageError('VERSION_CONFLICT');
        }

        // Consume preview
        await client.query(
          'UPDATE regression_module_review_previews SET consumed_at = clock_timestamp() WHERE id = $1',
          [previewRow.id],
        );

        const newStatus =
          input.decision === 'approve' ? 'approved' : 'rejected';

        const updatedRow = (
          await client.query<{
            project_id: string;
            name: string;
            version: number;
            sha256: string;
            document: RegressionDocument;
            review_status: RegressionModuleRecord['reviewStatus'];
            created_by: string | null;
            created_at: Date | null;
            reviewed_by: string | null;
            reviewed_at: Date | null;
          }>(
            `UPDATE regression_module_versions
             SET review_status = $1, reviewed_by = $2, reviewed_at = clock_timestamp()
             WHERE project_id = $3 AND name = $4 AND version = $5
             RETURNING project_id, name, version, sha256, document, review_status, created_by, created_at, reviewed_by, reviewed_at`,
            [newStatus, ctx.actor!.userId, projectId, moduleName, version],
          )
        ).rows[0]!;

        // Dedicated audit log using previewRow.id UUID and composite summary
        await client.query(
          `INSERT INTO audit_log(id, project_id, actor_id, action, object_id, result, redacted_summary)
           VALUES($1, $2, $3, 'regression_module.reviewed', $4, 'ok', $5)`,
          [
            randomUUID(),
            projectId,
            ctx.actor!.userId,
            previewRow.id,
            JSON.stringify({
              name: moduleName,
              version,
              decision: input.decision,
              sha256: updatedRow.sha256,
            }),
          ],
        );

        return parseContract('RegressionModuleRecord', {
          projectId: updatedRow.project_id,
          name: updatedRow.name,
          version: updatedRow.version,
          sha256: updatedRow.sha256,
          document: updatedRow.document,
          reviewStatus: updatedRow.review_status,
          createdBy: updatedRow.created_by,
          createdAt: updatedRow.created_at?.toISOString() ?? null,
          reviewedBy: updatedRow.reviewed_by,
          reviewedAt: updatedRow.reviewed_at?.toISOString() ?? null,
        });
      });

      ctx.res.statusCode = 200;
      return updated;
    },
  );
}
