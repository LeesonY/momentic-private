import { createHash, randomUUID } from 'node:crypto';
import { parseContract, previewLocatorMaintenance } from '@localqa/contracts';
import { validateTarget } from '@localqa/domain';
import { authorize, audit, hashPayload, StorageError } from '@localqa/storage';
import { requireAuth } from '../auth.js';
import type { Router } from '../router.js';
import type { RequestContext } from '../types.js';
import { parseRegressionPayload } from './savedCases.js';

function versionInput(body: unknown): number {
  if (
    !body ||
    typeof body !== 'object' ||
    Object.keys(body).length !== 1 ||
    !('expectedVersion' in body)
  )
    throw new StorageError('VALIDATION_ERROR');
  const n = body.expectedVersion;
  if (
    typeof n !== 'number' ||
    !Number.isSafeInteger(n) ||
    n < 1 ||
    n > 2147483647
  )
    throw new StorageError('VALIDATION_ERROR');
  return n;
}

function allowedVerificationDocument(
  document: ReturnType<typeof parseRegressionPayload>,
): void {
  const steps = document.steps;
  if (
    steps.length === 0 ||
    steps.length > 30 ||
    !steps.some((step) => step.kind === 'navigate') ||
    !steps.some((step) => step.kind === 'assert') ||
    steps.some(
      (step) =>
        !['navigate', 'click', 'type_text', 'assert'].includes(step.kind),
    ) ||
    (document.fixtureRefs?.length ?? 0) !== 0 ||
    document.criteria.length === 0 ||
    document.criteria.some(
      (criterion) =>
        ![
          'element_visible',
          'text_equals',
          'url_matches',
          'http_status',
        ].includes(criterion.kind),
    )
  )
    throw new StorageError('VALIDATION_ERROR');
  const origins = new Set<string>();
  for (const step of steps) {
    if (step.kind !== 'navigate') continue;
    let url: URL;
    try {
      url = new URL(step.url);
    } catch {
      throw new StorageError('VALIDATION_ERROR');
    }
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new StorageError('VALIDATION_ERROR');
    try {
      validateTarget(url.href, [url.origin]);
    } catch {
      throw new StorageError('TARGET_NOT_ALLOWED');
    }
    origins.add(url.origin);
  }
  if (origins.size !== 1) throw new StorageError('VALIDATION_ERROR');
}

function verificationOutput(row: {
  id: string;
  status: string;
  outcome: string | null;
  result: {
    reasonCode?: string;
    observedSteps?: number;
    verifiedCriteria?: number;
  };
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}) {
  return {
    id: row.id,
    status: row.status,
    outcome: row.outcome,
    reasonCode: row.result?.reasonCode ?? null,
    observedSteps: row.result?.observedSteps ?? 0,
    verifiedCriteria: row.result?.verifiedCriteria ?? 0,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

export function registerLocatorMaintenanceRoutes(router: Router): void {
  // Creates the ENTIRE candidate from a DB-bound executor witness. The
  // caller is not allowed to supply a free-form document or a source hash.
  router.post(
    '/api/v1/saved-cases/{caseId}/locator-maintenance/{taskId}/draft',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const expected = versionInput(ctx.body);
      const result = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const saved = (
          await client.query<{
            id: string;
            project_id: string;
            version: number;
            status: string;
            current_approved_version_id: string | null;
          }>(
            'SELECT id,project_id,version,status,current_approved_version_id FROM saved_cases WHERE id=$1 FOR UPDATE',
            [ctx.params.caseId!],
          )
        ).rows[0];
        if (!saved) throw new StorageError('NOT_FOUND');
        await authorize(client, saved.project_id, 'run');
        if (saved.status !== 'active') throw new StorageError('POLICY_DENIED');
        if (saved.version !== expected)
          throw new StorageError('VERSION_CONFLICT');
        const evidence = (
          await client.query<{
            run_id: string;
            source_version_id: string;
            source_sha256: string;
            source_doc: unknown;
            source_version: number;
            source_created_by: string;
            source_created_at: Date;
            source_reviewed_by: string | null;
            source_reviewed_at: Date | null;
            hints: unknown;
          }>(
            `SELECT j.run_id,b.source_version_id,b.source_sha256,
                  src.document AS source_doc,src.version AS source_version,
                  src.created_by AS source_created_by,src.created_at AS source_created_at,
                  src.reviewed_by AS source_reviewed_by,src.reviewed_at AS source_reviewed_at,
                  j.result->'repairSuggestions' AS hints
           FROM jobs j
           JOIN run_case_regression_bindings b
             ON b.project_id=j.project_id AND b.run_id=j.run_id AND b.case_id=j.case_id
           JOIN saved_case_versions src
             ON src.project_id=b.project_id AND src.id=b.source_version_id
             AND src.sha256=b.source_sha256 AND src.case_id=$2
           WHERE j.id=$1 AND j.project_id=$3 AND j.role='executor'
             AND j.status='succeeded'
             AND src.review_status='approved'
             AND j.result->>'sourceVersionId'=src.id::text
             AND j.result->>'sourceDocumentSha256'=src.sha256
             AND j.result->'regressionReplay'->>'status'='failed'
             AND j.result->'regressionReplay'->>'reasonCode'='LOCATOR_NOT_FOUND'
             AND jsonb_typeof(j.result->'repairSuggestions')='array'`,
            [ctx.params.taskId!, saved.id, saved.project_id],
          )
        ).rows[0];
        if (
          !evidence ||
          saved.current_approved_version_id !== evidence.source_version_id
        )
          throw new StorageError('POLICY_DENIED');
        if (!Array.isArray(evidence.hints) || evidence.hints.length !== 1)
          throw new StorageError('VALIDATION_ERROR');
        const suggestion = parseContract('RepairSuggestionRecord', {
          taskId: ctx.params.taskId!,
          runId: evidence.run_id,
          sourceVersionId: evidence.source_version_id,
          suggestion: evidence.hints[0],
        });
        const source = parseContract('SavedCaseVersion', {
          id: evidence.source_version_id,
          caseId: saved.id,
          version: evidence.source_version,
          document: evidence.source_doc,
          sha256: evidence.source_sha256,
          reviewStatus: 'approved',
          createdBy: evidence.source_created_by,
          createdAt: evidence.source_created_at.toISOString(),
          reviewedBy: evidence.source_reviewed_by,
          reviewedAt: evidence.source_reviewed_at?.toISOString() ?? null,
        });
        let candidate;
        try {
          candidate = parseRegressionPayload(
            previewLocatorMaintenance(source, suggestion).document,
          );
        } catch {
          throw new StorageError('VALIDATION_ERROR');
        }
        // The safety lane cannot run free-form AI, modules, non-submitting
        // writes, credentials, fixture mutation or other origins.
        allowedVerificationDocument(candidate);
        const sha = hashPayload(candidate);
        if (sha === evidence.source_sha256)
          throw new StorageError('VALIDATION_ERROR');
        const id = randomUUID(),
          maintenanceId = randomUUID();
        const next = saved.version + 1;
        const inserted = (
          await client.query<{ created_at: Date }>(
            `INSERT INTO saved_case_versions
            (id,case_id,project_id,version,document,sha256,review_status,created_by)
           VALUES($1,$2,$3,$4,$5,$6,'draft',$7) RETURNING created_at`,
            [
              id,
              saved.id,
              saved.project_id,
              next,
              candidate,
              sha,
              ctx.actor!.userId,
            ],
          )
        ).rows[0]!;
        await client.query(
          `INSERT INTO locator_maintenance_drafts
            (id,project_id,case_id,case_version_id,source_version_id,
             source_sha256,candidate_sha256,task_id,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            maintenanceId,
            saved.project_id,
            saved.id,
            id,
            evidence.source_version_id,
            evidence.source_sha256,
            sha,
            ctx.params.taskId!,
            ctx.actor!.userId,
          ],
        );
        await client.query(
          'UPDATE saved_cases SET version=version+1 WHERE project_id=$1 AND id=$2',
          [saved.project_id, saved.id],
        );
        await audit(
          client,
          'locator_maintenance.draft_created',
          id,
          saved.project_id,
          next,
        );
        return parseContract('SavedCaseVersion', {
          id,
          caseId: saved.id,
          version: next,
          document: candidate,
          sha256: sha,
          reviewStatus: 'draft',
          createdBy: ctx.actor!.userId,
          createdAt: inserted.created_at.toISOString(),
          reviewedBy: null,
          reviewedAt: null,
        });
      });
      ctx.res.statusCode = 201;
      return result;
    },
  );

  const base = '/api/v1/saved-case-versions/{versionId}/locator-maintenance';
  router.get(base, async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const info = await ctx.api.db.actor(ctx.actor!, async (client) => {
      const row = (
        await client.query<{
          id: string;
          project_id: string;
          case_version_id: string;
          source_version_id: string;
          task_id: string;
        }>(
          'SELECT id,project_id,case_version_id,source_version_id,task_id FROM locator_maintenance_drafts WHERE case_version_id=$1',
          [ctx.params.versionId!],
        )
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      await authorize(client, row.project_id, 'read');
      return {
        maintenanceId: row.id,
        candidateVersionId: row.case_version_id,
        sourceVersionId: row.source_version_id,
        taskId: row.task_id,
      };
    });
    ctx.res.setHeader('Cache-Control', 'private, no-store');
    return info;
  });

  const verifications = base + '/verifications';
  router.post(verifications, async (ctx: RequestContext) => {
    await requireAuth(ctx);
    // Only an empty body is valid. Never let clients submit a false verdict.
    if (
      ctx.body !== undefined &&
      (!ctx.body ||
        typeof ctx.body !== 'object' ||
        Object.keys(ctx.body).length !== 0)
    )
      throw new StorageError('VALIDATION_ERROR');
    const result = await ctx.api.db.actor(ctx.actor!, async (client) => {
      const row = (
        await client.query<{
          id: string;
          project_id: string;
          case_id: string;
          case_version_id: string;
          source_version_id: string;
          candidate_sha256: string;
          source_sha256: string;
          document: unknown;
          review_status: string;
          current_approved_version_id: string | null;
          status: string;
        }>(
          `SELECT d.id,d.project_id,d.case_id,d.case_version_id,d.source_version_id,
                d.candidate_sha256,d.source_sha256,v.document,v.review_status,
                c.current_approved_version_id,c.status
         FROM locator_maintenance_drafts d
         JOIN saved_case_versions v ON v.project_id=d.project_id AND v.id=d.case_version_id
         JOIN saved_cases c ON c.project_id=d.project_id AND c.id=d.case_id
         WHERE d.case_version_id=$1 FOR SHARE OF d,v,c`,
          [ctx.params.versionId!],
        )
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      await authorize(client, row.project_id, 'run');
      if (
        row.status !== 'active' ||
        row.review_status !== 'draft' ||
        row.current_approved_version_id !== row.source_version_id ||
        hashPayload(row.document) !== row.candidate_sha256
      )
        throw new StorageError('POLICY_DENIED');
      allowedVerificationDocument(parseRegressionPayload(row.document));
      const exists = await client.query(
        `SELECT 1 FROM repair_candidate_verifications
         WHERE project_id=$1 AND case_version_id=$2
           AND status IN ('queued','running') LIMIT 1`,
        [row.project_id, row.case_version_id],
      );
      if (exists.rowCount) throw new StorageError('VERSION_CONFLICT');
      const id = randomUUID();
      const created = (
        await client.query<{
          id: string;
          status: string;
          outcome: string | null;
          result: {
            reasonCode?: string;
            observedSteps?: number;
            verifiedCriteria?: number;
          };
          created_at: Date;
          started_at: Date | null;
          finished_at: Date | null;
        }>(
          `INSERT INTO repair_candidate_verifications
          (id,project_id,maintenance_id,case_id,case_version_id,candidate_sha256,requested_by)
         VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [
            id,
            row.project_id,
            row.id,
            row.case_id,
            row.case_version_id,
            row.candidate_sha256,
            ctx.actor!.userId,
          ],
        )
      ).rows[0]!;
      await audit(
        client,
        'locator_maintenance.verification_requested',
        id,
        row.project_id,
      );
      return verificationOutput(created);
    });
    ctx.res.statusCode = 202;
    return result;
  });
  router.get(verifications, async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const items = await ctx.api.db.actor(ctx.actor!, async (client) => {
      const scope = (
        await client.query<{ id: string; project_id: string }>(
          'SELECT id,project_id FROM locator_maintenance_drafts WHERE case_version_id=$1',
          [ctx.params.versionId!],
        )
      ).rows[0];
      if (!scope) throw new StorageError('NOT_FOUND');
      await authorize(client, scope.project_id, 'read');
      const rows = (
        await client.query<{
          id: string;
          status: string;
          outcome: string | null;
          result: {
            reasonCode?: string;
            observedSteps?: number;
            verifiedCriteria?: number;
          };
          created_at: Date;
          started_at: Date | null;
          finished_at: Date | null;
        }>(
          `SELECT * FROM repair_candidate_verifications
         WHERE project_id=$1 AND maintenance_id=$2
         ORDER BY created_at DESC,id DESC LIMIT 30`,
          [scope.project_id, scope.id],
        )
      ).rows;
      return rows.map(verificationOutput);
    });
    ctx.res.setHeader('Cache-Control', 'private, no-store');
    return { items };
  });

  async function evidenceScope(ctx: RequestContext): Promise<string> {
    await requireAuth(ctx);
    return ctx.api.db.actor(ctx.actor!, async (client) => {
      const row = (
        await client.query<{ project_id: string }>(
          `SELECT m.project_id FROM locator_maintenance_drafts m
         JOIN repair_candidate_verifications v
           ON v.project_id=m.project_id AND v.maintenance_id=m.id
         WHERE m.case_version_id=$1 AND v.id=$2`,
          [ctx.params.versionId!, ctx.params.verificationId!],
        )
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      await authorize(client, row.project_id, 'config.write');
      const role = (
        await client.query<{ allowed: boolean }>(
          "SELECT can_project($1,'owner') AS allowed",
          [row.project_id],
        )
      ).rows[0];
      if (!role?.allowed) throw new StorageError('NOT_FOUND');
      return row.project_id;
    });
  }

  const evidencePath = verifications + '/{verificationId}/evidence';
  router.get(evidencePath, async (ctx: RequestContext) => {
    const projectId = await evidenceScope(ctx);
    const items = await ctx.api.db.actor(ctx.actor!, async (client) => {
      const rows = (
        await client.query<{
          id: string;
          verification_id: string;
          case_version_id: string;
          step_index: number;
          step_kind: string;
          criterion_id: string | null;
          criterion_passed: boolean | null;
          snapshot_id: string;
          snapshot_sha256: string;
          snapshot_document: { displayUrl?: string };
          screenshot_sha256: string | null;
          screenshot_bytes: number | null;
          retention: 'available' | 'purged';
          purged_at: Date | null;
          created_at: Date;
        }>(
          `SELECT id,verification_id,case_version_id,step_index,step_kind,
                criterion_id,criterion_passed,snapshot_id,snapshot_sha256,
                snapshot_document,screenshot_sha256,screenshot_bytes,
                'available'::text AS retention,NULL::timestamptz AS purged_at,created_at
         FROM repair_candidate_evidence
         WHERE project_id=$1 AND verification_id=$2
         UNION ALL
         SELECT id,verification_id,case_version_id,step_index,step_kind,
                criterion_id,criterion_passed,snapshot_id,snapshot_sha256,
                jsonb_build_object('displayUrl',display_url),screenshot_sha256,
                screenshot_bytes,'purged'::text,purged_at,created_at
         FROM repair_candidate_evidence_receipts
         WHERE project_id=$1 AND verification_id=$2
         ORDER BY step_index`,
          [projectId, ctx.params.verificationId!],
        )
      ).rows;
      return rows.map((r) =>
        parseContract('RepairCandidateEvidence', {
          id: r.id,
          verificationId: r.verification_id,
          candidateVersionId: r.case_version_id,
          stepIndex: r.step_index,
          stepKind: r.step_kind,
          criterionId: r.criterion_id,
          criterionPassed: r.criterion_passed,
          snapshotId: r.snapshot_id,
          snapshotSha256: r.snapshot_sha256,
          displayUrl: r.snapshot_document.displayUrl ?? '',
          screenshotSha256: r.screenshot_sha256,
          screenshotBytes: r.screenshot_bytes,
          retention: r.retention,
          purgedAt: r.purged_at?.toISOString() ?? null,
          createdAt: r.created_at.toISOString(),
        }),
      );
    });
    ctx.res.setHeader('Cache-Control', 'private, no-store');
    return parseContract('RepairCandidateEvidencePage', { items });
  });

  router.get(
    evidencePath + '/{evidenceId}/screenshot',
    async (ctx: RequestContext) => {
      const projectId = await evidenceScope(ctx);
      const row = await ctx.api.db.actor(
        ctx.actor!,
        async (client) =>
          (
            await client.query<{
              id: string;
              screenshot_sha256: string | null;
              screenshot_bytes: number | null;
              screenshot_ciphertext: Buffer | null;
              screenshot_nonce: Buffer | null;
              screenshot_tag: Buffer | null;
              screenshot_key_version: number | null;
            }>(
              `SELECT id,screenshot_sha256,screenshot_bytes,screenshot_ciphertext,
                screenshot_nonce,screenshot_tag,screenshot_key_version
         FROM repair_candidate_evidence
         WHERE project_id=$1 AND verification_id=$2 AND id=$3`,
              [projectId, ctx.params.verificationId!, ctx.params.evidenceId!],
            )
          ).rows[0],
      );
      if (
        !row?.screenshot_ciphertext ||
        !row.screenshot_nonce ||
        !row.screenshot_tag ||
        !row.screenshot_key_version ||
        !row.screenshot_sha256 ||
        !row.screenshot_bytes
      )
        throw new StorageError('NOT_FOUND');
      const decoded = ctx.api.vault.decrypt(
        {
          ciphertext: row.screenshot_ciphertext,
          nonce: row.screenshot_nonce,
          authTag: row.screenshot_tag,
          keyVersion: row.screenshot_key_version,
        },
        { projectId, secretId: row.id, purpose: 'candidate_screenshot' },
      );
      const bytes = Buffer.from(decoded, 'base64');
      if (
        bytes.length !== row.screenshot_bytes ||
        createHash('sha256').update(bytes).digest('hex') !==
          row.screenshot_sha256 ||
        !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
      )
        throw new StorageError('SERVICE_UNAVAILABLE');
      ctx.res.setHeader('Content-Type', 'image/png');
      ctx.res.setHeader('Cache-Control', 'private, no-store');
      ctx.res.setHeader('X-Content-Type-Options', 'nosniff');
      ctx.res.setHeader('Referrer-Policy', 'no-referrer');
      ctx.res.end(bytes);
    },
  );
}
