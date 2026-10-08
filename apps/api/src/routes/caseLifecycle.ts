import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { parseContract, getApiValidator } from '@localqa/contracts';
import type { RegressionDocument } from '@localqa/contracts';
import { StorageError, hashPayload } from '@localqa/storage';
import { requireAuth } from '../auth.js';
import type { Router } from '../router.js';
import type { RequestContext } from '../types.js';
import { validateRegressionDocument } from '../yaml.js';
import {
  validateModuleTemplateStatic,
  validateModuleName,
  parseModuleVersion,
  type ApprovedModuleLookup,
} from '../moduleTemplate.js';

const validateArchive = getApiValidator('archiveSavedCase', {
  kind: 'parameters',
  location: 'path',
});
const validateRestore = getApiValidator('restoreSavedCase', {
  kind: 'parameters',
  location: 'path',
});
const validateDuplicate = getApiValidator('duplicateSavedCase', {
  kind: 'parameters',
  location: 'path',
});

const SLUG_REGEX = /^[a-zA-Z0-9_.-]+$/;

async function requireVisibleCaseOperator(
  client: PoolClient,
  caseId: string,
): Promise<void> {
  // SELECT FOR UPDATE also applies write RLS: a visible viewer's row would
  // disappear. Establish visibility (404) and permission (403) before locking.
  const visible = (
    await client.query<{ project_id: string }>(
      'SELECT project_id FROM saved_cases WHERE id = $1',
      [caseId],
    )
  ).rows[0];
  if (!visible) throw new StorageError('NOT_FOUND');
  const permission = (
    await client.query<{ allowed: boolean }>(
      "SELECT can_project($1, 'operator') AS allowed",
      [visible.project_id],
    )
  ).rows[0];
  if (!permission?.allowed) throw new StorageError('FORBIDDEN');
}

export function registerCaseLifecycleRoutes(router: Router): void {
  // POST /api/v1/saved-cases/{caseId}/archive
  router.post(
    '/api/v1/saved-cases/{caseId}/archive',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const rawCaseId = ctx.params.caseId!;
      if (!validateArchive({ caseId: rawCaseId })) {
        throw new StorageError('VALIDATION_ERROR');
      }
      const caseId = rawCaseId.toLowerCase();

      const input = parseContract('SavedCaseArchiveInput', ctx.body);
      if (
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 1 ||
        input.expectedVersion > 2147483647
      ) {
        throw new StorageError('VALIDATION_ERROR');
      }

      const result = await ctx.api.db.actor(ctx.actor!, async (client) => {
        await requireVisibleCaseOperator(client, caseId);
        const row = (
          await client.query<{
            id: string;
            project_id: string;
            slug: string;
            name: string;
            status: 'active' | 'archived';
            current_approved_version_id: string | null;
            version: number;
            created_at: Date;
          }>(
            'SELECT id, project_id, slug, name, status, current_approved_version_id, version, created_at FROM saved_cases WHERE id = $1 FOR UPDATE',
            [caseId],
          )
        ).rows[0];

        if (!row) throw new StorageError('NOT_FOUND');

        if (row.version !== input.expectedVersion) {
          throw new StorageError('VERSION_CONFLICT');
        }
        if (row.status === 'archived') {
          throw new StorageError('VERSION_CONFLICT');
        }

        const nextVersion = row.version + 1;
        if (nextVersion > 2147483647) {
          const err = new StorageError('VALIDATION_ERROR');
          err.message = 'SavedCase version upper bound reached';
          throw err;
        }

        const updated = (
          await client.query<{
            id: string;
            project_id: string;
            slug: string;
            name: string;
            status: 'active' | 'archived';
            current_approved_version_id: string | null;
            version: number;
            created_at: Date;
          }>(
            "UPDATE saved_cases SET status = 'archived', version = $1 WHERE id = $2 AND project_id = $3 RETURNING id, project_id, slug, name, status, current_approved_version_id, version, created_at",
            [nextVersion, caseId, row.project_id],
          )
        ).rows[0]!;

        await client.query(
          `INSERT INTO audit_log(id, project_id, actor_id, action, object_id, result, redacted_summary)
           VALUES($1, $2, $3, 'saved_case.archived', $4, 'ok', $5)`,
          [
            randomUUID(),
            row.project_id,
            ctx.actor!.userId,
            caseId,
            JSON.stringify({
              caseId,
              slug: updated.slug,
              version: nextVersion,
            }),
          ],
        );

        return parseContract('SavedCase', {
          id: updated.id,
          projectId: updated.project_id,
          slug: updated.slug,
          name: updated.name,
          status: updated.status,
          currentApprovedVersionId: updated.current_approved_version_id,
          version: updated.version,
          createdAt: updated.created_at.toISOString(),
        });
      });

      ctx.res.statusCode = 200;
      return result;
    },
  );

  // POST /api/v1/saved-cases/{caseId}/restore
  router.post(
    '/api/v1/saved-cases/{caseId}/restore',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const rawCaseId = ctx.params.caseId!;
      if (!validateRestore({ caseId: rawCaseId })) {
        throw new StorageError('VALIDATION_ERROR');
      }
      const caseId = rawCaseId.toLowerCase();

      const input = parseContract('SavedCaseRestoreInput', ctx.body);
      if (
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 1 ||
        input.expectedVersion > 2147483647
      ) {
        throw new StorageError('VALIDATION_ERROR');
      }

      const result = await ctx.api.db.actor(ctx.actor!, async (client) => {
        await requireVisibleCaseOperator(client, caseId);
        const row = (
          await client.query<{
            id: string;
            project_id: string;
            slug: string;
            name: string;
            status: 'active' | 'archived';
            current_approved_version_id: string | null;
            version: number;
            created_at: Date;
          }>(
            'SELECT id, project_id, slug, name, status, current_approved_version_id, version, created_at FROM saved_cases WHERE id = $1 FOR UPDATE',
            [caseId],
          )
        ).rows[0];

        if (!row) throw new StorageError('NOT_FOUND');

        if (row.version !== input.expectedVersion) {
          throw new StorageError('VERSION_CONFLICT');
        }
        if (row.status === 'active') {
          throw new StorageError('VERSION_CONFLICT');
        }

        const nextVersion = row.version + 1;
        if (nextVersion > 2147483647) {
          const err = new StorageError('VALIDATION_ERROR');
          err.message = 'SavedCase version upper bound reached';
          throw err;
        }

        const updated = (
          await client.query<{
            id: string;
            project_id: string;
            slug: string;
            name: string;
            status: 'active' | 'archived';
            current_approved_version_id: string | null;
            version: number;
            created_at: Date;
          }>(
            "UPDATE saved_cases SET status = 'active', version = $1 WHERE id = $2 AND project_id = $3 RETURNING id, project_id, slug, name, status, current_approved_version_id, version, created_at",
            [nextVersion, caseId, row.project_id],
          )
        ).rows[0]!;

        await client.query(
          `INSERT INTO audit_log(id, project_id, actor_id, action, object_id, result, redacted_summary)
           VALUES($1, $2, $3, 'saved_case.restored', $4, 'ok', $5)`,
          [
            randomUUID(),
            row.project_id,
            ctx.actor!.userId,
            caseId,
            JSON.stringify({
              caseId,
              slug: updated.slug,
              version: nextVersion,
            }),
          ],
        );

        return parseContract('SavedCase', {
          id: updated.id,
          projectId: updated.project_id,
          slug: updated.slug,
          name: updated.name,
          status: updated.status,
          currentApprovedVersionId: updated.current_approved_version_id,
          version: updated.version,
          createdAt: updated.created_at.toISOString(),
        });
      });

      ctx.res.statusCode = 200;
      return result;
    },
  );

  // POST /api/v1/saved-cases/{caseId}/duplicate
  router.post(
    '/api/v1/saved-cases/{caseId}/duplicate',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const rawCaseId = ctx.params.caseId!;
      if (!validateDuplicate({ caseId: rawCaseId })) {
        throw new StorageError('VALIDATION_ERROR');
      }
      const caseId = rawCaseId.toLowerCase();

      const input = parseContract('SavedCaseDuplicateInput', ctx.body);
      const sourceVersionId = input.sourceVersionId.toLowerCase();
      const targetProjectId = input.targetProjectId
        ? input.targetProjectId.toLowerCase()
        : undefined;

      // Validate slug syntax
      if (
        typeof input.newSlug !== 'string' ||
        input.newSlug.length < 1 ||
        input.newSlug.length > 120 ||
        !SLUG_REGEX.test(input.newSlug)
      ) {
        throw new StorageError('VALIDATION_ERROR');
      }
      if (
        typeof input.newName !== 'string' ||
        input.newName.length < 1 ||
        input.newName.length > 200
      ) {
        throw new StorageError('VALIDATION_ERROR');
      }

      const result = await ctx.api.db.actor(ctx.actor!, async (client) => {
        // 1. Source case and version query under caller's RLS
        const sourceRow = (
          await client.query<{
            case_id: string;
            project_id: string;
            slug: string;
            name: string;
            version_id: string;
            version: number;
            document: unknown;
            sha256: string;
            review_status: string;
          }>(
            `SELECT c.id AS case_id, c.project_id, c.slug, c.name,
                    v.id AS version_id, v.version, v.document, v.sha256, v.review_status
             FROM saved_cases c
             JOIN saved_case_versions v ON v.case_id = c.id AND v.project_id = c.project_id
             WHERE c.id = $1 AND v.id = $2`,
            [caseId, sourceVersionId],
          )
        ).rows[0];

        if (!sourceRow) throw new StorageError('NOT_FOUND');

        const finalTargetProjectId = targetProjectId ?? sourceRow.project_id;

        // 2. Target project existence check under caller RLS (404 first, no leak)
        const targetProj = (
          await client.query<{ id: string }>(
            'SELECT id FROM projects WHERE id = $1',
            [finalTargetProjectId],
          )
        ).rows[0];
        if (!targetProj) throw new StorageError('NOT_FOUND');

        // 3. Target project operator role check (403 if only viewer)
        const canWriteTarget = (
          await client.query<{ allowed: boolean }>(
            "SELECT can_project($1, 'operator') AS allowed",
            [finalTargetProjectId],
          )
        ).rows[0]?.allowed;
        if (!canWriteTarget) throw new StorageError('FORBIDDEN');

        // 4. Target slug conflict check
        const existingSlug = (
          await client.query<{ id: string }>(
            'SELECT id FROM saved_cases WHERE project_id = $1 AND slug = $2',
            [finalTargetProjectId, input.newSlug],
          )
        ).rows[0];
        if (existingSlug) throw new StorageError('IDEMPOTENCY_CONFLICT');

        // 5. Build and validate new document for target project boundaries
        const sourceDoc = sourceRow.document as RegressionDocument;
        if (sourceDoc.fixtureRefs?.length) {
          throw new StorageError('VALIDATION_ERROR');
        }

        const newDoc: RegressionDocument = {
          ...sourceDoc,
          id: input.newSlug,
          name: input.newName,
        };
        validateRegressionDocument(newDoc);

        // Load only reachable dependencies, before any INSERT. Compare both stored
        // and canonical hashes; a missing source must never authorize rebinding.
        const modules = new Map<string, ApprovedModuleLookup>();
        const active = new Set<string>();
        let expandedSteps = 0;
        // Match moduleTemplate.ts exactly; module invocations do not count as
        // executable steps, and the SavedCase itself is not a module layer.
        const MAX_EXPANDED_STEPS = 100;
        const MAX_DOCUMENT_STEPS = 100;
        const MAX_MODULE_DEPTH = 8;
        const inspectDependencies = async (
          document: RegressionDocument,
          depth: number,
        ): Promise<void> => {
          // Reject malformed/empty documents before following any child refs.
          // With nonempty steps and bounded path depth, every completed branch
          // contributes executable steps; the global cap bounds DAG traversal.
          if (
            !Array.isArray(document.steps) ||
            document.steps.length < 1 ||
            document.steps.length > MAX_DOCUMENT_STEPS
          )
            throw new StorageError('VALIDATION_ERROR');
          validateRegressionDocument(document);
          for (const step of document.steps) {
            if (step.kind !== 'module') {
              if (++expandedSteps > MAX_EXPANDED_STEPS)
                throw new StorageError('VALIDATION_ERROR');
              continue;
            }
            const match = /^(.+)@([1-9][0-9]*)$/.exec(step.ref);
            if (!match) throw new StorageError('VALIDATION_ERROR');
            const name = match[1]!;
            validateModuleName(name);
            const version = parseModuleVersion(match[2]!);
            if (depth >= MAX_MODULE_DEPTH || active.has(step.ref))
              throw new StorageError('VALIDATION_ERROR');
            // Cache lookup results, never path validation: repeated DAG refs
            // still consume the global budgets and check their current depth.
            let approved = modules.get(step.ref);
            if (!approved) {
              const rows = (
                await client.query<{
                  project_id: string;
                  document: RegressionDocument;
                  sha256: string;
                }>(
                  "SELECT project_id, document, sha256 FROM regression_module_versions WHERE project_id = ANY($1::uuid[]) AND name = $2 AND version = $3 AND review_status = 'approved' ORDER BY project_id",
                  [[sourceRow.project_id, finalTargetProjectId], name, version],
                )
              ).rows;
              const source = rows.find(
                (r) => r.project_id === sourceRow.project_id,
              );
              const target = rows.find(
                (r) => r.project_id === finalTargetProjectId,
              );
              if (
                !source ||
                !target ||
                source.sha256 !== target.sha256 ||
                hashPayload(source.document) !== source.sha256 ||
                hashPayload(target.document) !== target.sha256
              ) {
                const err = new StorageError('VALIDATION_ERROR');
                err.message =
                  'Referenced module missing, unapproved or canonical SHA mismatch';
                throw err;
              }
              approved = {
                document: target.document,
                sha256: target.sha256,
                reviewStatus: 'approved',
              };
              modules.set(step.ref, approved);
            }
            active.add(step.ref);
            await inspectDependencies(approved.document, depth + 1);
            active.delete(step.ref);
          }
        };
        await inspectDependencies(newDoc, 0);
        // Existing structural expansion helper: no environment evaluation and
        // no model/browser calls. Enforces fixtures, criteria, templates, cycles,
        // depth and the aggregate expanded-step limit, not just direct refs.
        // A SavedCase is not itself a module invocation. Starting at zero
        // matches the runtime compiler and the preflight traversal above;
        // module registration keeps the helper's default initial depth of one.
        validateModuleTemplateStatic(
          newDoc,
          (name, version) => modules.get(`${name}@${version}`),
          0,
        );

        const newCaseId = randomUUID();
        const newVersionId = randomUUID();
        const canonicalSha = hashPayload(newDoc);

        // 6. Insert new saved_cases
        await client.query(
          "INSERT INTO saved_cases(id, project_id, slug, name, status, current_approved_version_id, version) VALUES($1, $2, $3, $4, 'active', NULL, 1)",
          [newCaseId, finalTargetProjectId, input.newSlug, input.newName],
        );

        // 7. Insert draft version 1 (never inherits approved status)
        await client.query(
          "INSERT INTO saved_case_versions(id, case_id, project_id, version, document, sha256, review_status, created_by) VALUES($1, $2, $3, 1, $4, $5, 'draft', $6)",
          [
            newVersionId,
            newCaseId,
            finalTargetProjectId,
            newDoc,
            canonicalSha,
            ctx.actor!.userId,
          ],
        );

        // 8. Audit log recording source case, version, and original stored hash
        await client.query(
          `INSERT INTO audit_log(id, project_id, actor_id, action, object_id, result, redacted_summary)
           VALUES($1, $2, $3, 'saved_case.duplicated', $4, 'ok', $5)`,
          [
            randomUUID(),
            finalTargetProjectId,
            ctx.actor!.userId,
            newCaseId,
            JSON.stringify({
              sourceCaseId: sourceRow.case_id,
              sourceVersionId: sourceRow.version_id,
              sourceDocumentSha256: sourceRow.sha256,
              targetProjectId: finalTargetProjectId,
              newSlug: input.newSlug,
              newVersionId,
              canonicalSha,
            }),
          ],
        );

        return parseContract('SavedCase', {
          id: newCaseId,
          projectId: finalTargetProjectId,
          slug: input.newSlug,
          name: input.newName,
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
}
