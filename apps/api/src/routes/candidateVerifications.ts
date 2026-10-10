import { createHash, randomUUID } from 'node:crypto';
import { parseContract } from '@localqa/contracts';
import { validateTarget } from '@localqa/domain';
import { authorize, audit, hashPayload, StorageError } from '@localqa/storage';
import { requireAuth } from '../auth.js';
import { parsePagination, type Router } from '../router.js';
import type { RequestContext } from '../types.js';

interface VerificationRow {
  id: string;
  project_id: string;
  proposal_id: string;
  case_id: string;
  case_version_id: string;
  candidate_sha256: string;
  status: 'queued' | 'running' | 'completed';
  outcome: 'passed' | 'failed' | 'inconclusive' | null;
  result: {
    reasonCode?: string;
    observedSteps?: number;
    verifiedCriteria?: number;
  };
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

function response(row: VerificationRow) {
  return parseContract('RepairCandidateVerification', {
    id: row.id,
    projectId: row.project_id,
    proposalId: row.proposal_id,
    caseId: row.case_id,
    candidateVersionId: row.case_version_id,
    candidateSha256: row.candidate_sha256,
    status: row.status,
    outcome: row.outcome,
    reasonCode: row.result?.reasonCode ?? null,
    observedSteps: row.result?.observedSteps ?? 0,
    verifiedCriteria: row.result?.verifiedCriteria ?? 0,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  });
}

export function registerCandidateVerificationRoutes(router: Router): void {
  const path =
    '/api/v1/saved-cases/{caseId}/repair-proposals/{proposalId}/verifications';
  const evidencePath = path + '/{verificationId}/evidence';

  async function evidenceScope(ctx: RequestContext) {
    await requireAuth(ctx);
    return ctx.api.db.actor(ctx.actor!, async (client) => {
      const row = (
        await client.query<{ project_id: string }>(
          `SELECT d.project_id
           FROM repair_candidate_drafts d
           JOIN repair_candidate_verifications v
             ON v.project_id=d.project_id AND v.proposal_id=d.proposal_id
             AND v.case_id=d.case_id AND v.case_version_id=d.case_version_id
           WHERE d.case_id=$1 AND d.proposal_id=$2 AND v.id=$3`,
          [
            ctx.params.caseId!,
            ctx.params.proposalId!,
            ctx.params.verificationId!,
          ],
        )
      ).rows[0];
      if (!row) throw new StorageError('NOT_FOUND');
      await authorize(client, row.project_id, 'config.write');
      const authorized = (
        await client.query<{ valid: boolean }>(
          "SELECT can_project($1,'owner') AS valid",
          [row.project_id],
        )
      ).rows[0];
      if (!authorized?.valid) throw new StorageError('NOT_FOUND');
      return row.project_id;
    });
  }

  router.get(evidencePath, async (ctx: RequestContext) => {
    const projectId = await evidenceScope(ctx);
    ctx.res.setHeader('Cache-Control', 'private, no-store');
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
                  'available'::text AS retention,NULL::timestamptz AS purged_at,
                  created_at
           FROM repair_candidate_evidence
           WHERE project_id=$1 AND verification_id=$2
           UNION ALL
           SELECT id,verification_id,case_version_id,step_index,step_kind,
                  criterion_id,criterion_passed,snapshot_id,snapshot_sha256,
                  jsonb_build_object('displayUrl',display_url) AS snapshot_document,
                  screenshot_sha256,screenshot_bytes,
                  'purged'::text AS retention,purged_at,created_at
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

  router.post(path, async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const id = randomUUID();
    const result = await ctx.api.db.actor(ctx.actor!, async (client) => {
      const rows = (
        await client.query<{
          project_id: string;
          case_id: string;
          candidate_id: string;
          sha256: string;
          document: unknown;
          case_status: string;
          review_status: string;
          proposal_status: string;
        }>(
          `SELECT d.project_id,d.case_id,d.case_version_id AS candidate_id,
                  v.sha256,v.document,c.status AS case_status,
                  v.review_status,p.status AS proposal_status
           FROM repair_candidate_drafts d
           JOIN saved_case_versions v ON v.project_id=d.project_id
             AND v.case_id=d.case_id AND v.id=d.case_version_id
           JOIN saved_cases c ON c.project_id=d.project_id AND c.id=d.case_id
           JOIN repair_proposals p ON p.project_id=d.project_id
             AND p.id=d.proposal_id AND p.case_id=d.case_id
           WHERE d.proposal_id=$1 AND d.case_id=$2 FOR SHARE OF d,v,c,p`,
          [ctx.params.proposalId!, ctx.params.caseId!],
        )
      ).rows[0];
      if (!rows) throw new StorageError('NOT_FOUND');
      await authorize(client, rows.project_id, 'run');
      if (
        rows.case_status !== 'active' ||
        rows.review_status !== 'draft' ||
        rows.proposal_status !== 'approved' ||
        hashPayload(rows.document) !== rows.sha256
      )
        throw new StorageError('POLICY_DENIED');
      const doc = parseContract('RegressionDocument', rows.document);
      // Candidate verification is intentionally deterministic and
      // credential-free; never silently grant AI actions, modules, hooks,
      // fixture state or mutation authority from a draft.
      const supported = new Set(['navigate', 'click', 'type_text', 'assert']);
      if (
        doc.steps.length === 0 ||
        doc.steps.length > 30 ||
        doc.steps.some((step) => !supported.has(step.kind)) ||
        !doc.steps.some((step) => step.kind === 'navigate') ||
        !doc.steps.some((step) => step.kind === 'assert') ||
        (doc.fixtureRefs?.length ?? 0) !== 0 ||
        doc.criteria.some(
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
      const destinations = doc.steps
        .filter(
          (
            step,
          ): step is Extract<
            (typeof doc.steps)[number],
            { kind: 'navigate' }
          > => step.kind === 'navigate',
        )
        .map((step) => {
          let target: URL;
          try {
            target = new URL(step.url);
          } catch {
            throw new StorageError('VALIDATION_ERROR');
          }
          if (
            !['https:', 'http:'].includes(target.protocol) ||
            target.username ||
            target.password ||
            target.hash ||
            target.search
          )
            throw new StorageError('VALIDATION_ERROR');
          try {
            validateTarget(target.href, [target.origin]);
          } catch {
            throw new StorageError('TARGET_NOT_ALLOWED');
          }
          return target.origin;
        });
      if (new Set(destinations).size !== 1)
        throw new StorageError('VALIDATION_ERROR');
      const exists = (
        await client.query(
          `SELECT 1 FROM repair_candidate_verifications WHERE
           project_id=$1 AND case_version_id=$2
           AND status IN ('queued','running') LIMIT 1`,
          [rows.project_id, rows.candidate_id],
        )
      ).rowCount;
      if (exists) throw new StorageError('VERSION_CONFLICT');
      const inserted = (
        await client.query<VerificationRow>(
          `INSERT INTO repair_candidate_verifications(
            id,project_id,proposal_id,case_id,case_version_id,
            candidate_sha256,requested_by
          ) VALUES($1,$2,$3,$4,$5,$6,$7)
          RETURNING *`,
          [
            id,
            rows.project_id,
            ctx.params.proposalId!,
            rows.case_id,
            rows.candidate_id,
            rows.sha256,
            ctx.actor!.userId,
          ],
        )
      ).rows[0]!;
      await audit(
        client,
        'repair_candidate.verification_requested',
        id,
        rows.project_id,
      );
      return response(inserted);
    });
    ctx.res.statusCode = 202;
    return result;
  });

  router.get(path, async (ctx: RequestContext) => {
    await requireAuth(ctx);
    const { limit, offset } = parsePagination(ctx.query);
    const result = await ctx.api.db.actor(ctx.actor!, async (client) => {
      const d = (
        await client.query<{ project_id: string }>(
          'SELECT project_id FROM repair_candidate_drafts WHERE proposal_id=$1 AND case_id=$2',
          [ctx.params.proposalId!, ctx.params.caseId!],
        )
      ).rows[0];
      if (!d) throw new StorageError('NOT_FOUND');
      await authorize(client, d.project_id, 'read');
      const rows = (
        await client.query<VerificationRow>(
          `SELECT * FROM repair_candidate_verifications
           WHERE project_id=$1 AND proposal_id=$2 AND case_id=$3
           ORDER BY created_at DESC,id DESC LIMIT $4 OFFSET $5`,
          [
            d.project_id,
            ctx.params.proposalId!,
            ctx.params.caseId!,
            limit + 1,
            offset,
          ],
        )
      ).rows;
      return {
        items: rows.slice(0, limit).map(response),
        nextCursor:
          rows.length > limit
            ? Buffer.from(String(offset + limit)).toString('base64url')
            : null,
      };
    });
    return parseContract('RepairCandidateVerificationPage', result);
  });
}
