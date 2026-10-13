import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { parseContract } from '@localqa/contracts';
import { authorize, audit, StorageError, hashPayload } from '@localqa/storage';
import { requireAuth } from '../auth.js';
import { parseRegressionPayload } from './savedCases.js';
import { parsePagination, type Router } from '../router.js';
import type { RequestContext } from '../types.js';

type ProposalRow = {
  id: string;
  case_id: string;
  finding_id: string;
  proposed_version: number;
  diff: string;
  verification_run_id: string | null;
  status: 'draft' | 'approved' | 'rejected';
  created_at: Date;
  review_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
};

function output(row: ProposalRow) {
  return parseContract('RepairProposal', {
    id: row.id,
    caseId: row.case_id,
    findingId: row.finding_id,
    proposedVersion: row.proposed_version,
    diff: row.diff,
    verificationRunId: row.verification_run_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    reviewReason: row.review_reason,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
  });
}

async function visibleCase(
  client: PoolClient,
  caseId: string,
  capability: 'read' | 'run',
): Promise<{ id: string; project_id: string; status: string }> {
  const row = (
    await client.query<{ id: string; project_id: string; status: string }>(
      'SELECT id, project_id, status FROM saved_cases WHERE id=$1',
      [caseId],
    )
  ).rows[0];
  if (!row) throw new StorageError('NOT_FOUND');
  await authorize(client, row.project_id, capability);
  return row;
}

export function registerRepairProposalRoutes(router: Router): void {
  router.get(
    '/api/v1/saved-cases/{caseId}/repair-proposals/{proposalId}/candidate-version',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const result = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const saved = await visibleCase(client, ctx.params.caseId!, 'read');
        const candidate = (
          await client.query<{
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
            `SELECT v.id,v.version,v.document,v.sha256,v.review_status,
                    v.created_by,v.created_at,v.reviewed_by,v.reviewed_at
             FROM repair_candidate_drafts d
             JOIN saved_case_versions v
               ON v.project_id=d.project_id AND v.case_id=d.case_id
              AND v.id=d.case_version_id
             WHERE d.project_id=$1 AND d.case_id=$2 AND d.proposal_id=$3`,
            [saved.project_id, saved.id, ctx.params.proposalId!],
          )
        ).rows[0];
        if (!candidate) throw new StorageError('NOT_FOUND');
        return parseContract('SavedCaseVersion', {
          id: candidate.id,
          caseId: saved.id,
          version: candidate.version,
          document: candidate.document,
          sha256: candidate.sha256,
          reviewStatus: candidate.review_status,
          createdBy: candidate.created_by,
          createdAt: candidate.created_at.toISOString(),
          reviewedBy: candidate.reviewed_by,
          reviewedAt: candidate.reviewed_at?.toISOString() ?? null,
        });
      });
      return result;
    },
  );

  router.post(
    '/api/v1/saved-cases/{caseId}/repair-proposals/{proposalId}/candidate-version',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const input = parseContract('SavedCaseVersionCreate', ctx.body);
      // An explicitly supplied full candidate document is required. Never
      // interpret free-text diff instructions as a trustworthy DSL mutation.
      const document = parseRegressionPayload(input.document);
      const sha256 = hashPayload(document);
      const result = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const saved = await visibleCase(client, ctx.params.caseId!, 'run');
        const current = (
          await client.query<{
            version: number;
            status: string;
            current_approved_version_id: string | null;
          }>(
            'SELECT version,status,current_approved_version_id FROM saved_cases WHERE project_id=$1 AND id=$2 FOR UPDATE',
            [saved.project_id, saved.id],
          )
        ).rows[0];
        if (!current || current.status !== 'active')
          throw new StorageError('VALIDATION_ERROR');
        if (current.version !== input.expectedVersion)
          throw new StorageError('VERSION_CONFLICT');
        const proposal = (
          await client.query<{ proposed_version: number; status: string }>(
            `SELECT proposed_version,status FROM repair_proposals
             WHERE project_id=$1 AND case_id=$2 AND id=$3 FOR UPDATE`,
            [saved.project_id, saved.id, ctx.params.proposalId!],
          )
        ).rows[0];
        if (!proposal) throw new StorageError('NOT_FOUND');
        if (proposal.status !== 'approved')
          throw new StorageError('POLICY_DENIED');
        const nextVersion = current.version + 1;
        if (nextVersion !== proposal.proposed_version)
          throw new StorageError('VERSION_CONFLICT');
        const baseline = (
          await client.query<{ sha256: string }>(
            `SELECT sha256 FROM saved_case_versions
             WHERE project_id=$1 AND case_id=$2 AND id=$3
               AND review_status='approved'`,
            [saved.project_id, saved.id, current.current_approved_version_id],
          )
        ).rows[0];
        if (!baseline || baseline.sha256 === sha256)
          throw new StorageError('VALIDATION_ERROR');
        const versionId = randomUUID();
        const inserted = (
          await client.query<{ created_at: Date }>(
            `INSERT INTO saved_case_versions(
               id,case_id,project_id,version,document,sha256,
               review_status,created_by
             ) VALUES($1,$2,$3,$4,$5,$6,'draft',$7)
             RETURNING created_at`,
            [
              versionId,
              saved.id,
              saved.project_id,
              nextVersion,
              document,
              sha256,
              ctx.actor!.userId,
            ],
          )
        ).rows[0]!;
        await client.query(
          `INSERT INTO repair_candidate_drafts(
             project_id,proposal_id,case_id,case_version_id
           ) VALUES($1,$2,$3,$4)`,
          [saved.project_id, ctx.params.proposalId!, saved.id, versionId],
        );
        await client.query(
          'UPDATE saved_cases SET version=version+1 WHERE project_id=$1 AND id=$2',
          [saved.project_id, saved.id],
        );
        await audit(
          client,
          'repair_candidate.draft_created',
          versionId,
          saved.project_id,
          nextVersion,
        );
        return parseContract('SavedCaseVersion', {
          id: versionId,
          caseId: saved.id,
          version: nextVersion,
          document,
          sha256,
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

  router.get(
    '/api/v1/saved-cases/{caseId}/repair-proposals',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const { limit, offset } = parsePagination(ctx.query);
      const result = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const saved = await visibleCase(client, ctx.params.caseId!, 'read');
        const rows = (
          await client.query<ProposalRow>(
            `SELECT id,case_id,finding_id,proposed_version,diff,
                    verification_run_id,status,created_at,
                    review_reason,reviewed_by,reviewed_at
             FROM repair_proposals
             WHERE project_id=$1 AND case_id=$2
             ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4`,
            [saved.project_id, saved.id, limit + 1, offset],
          )
        ).rows;
        // These are read-only execution observations, NOT repair_proposals.
        // A version id in worker result JSON alone is not authority. Verify
        // the immutable, DB-guarded run-case regression binding for this exact
        // executor task, run, source hash and approved saved-case version.
        // Otherwise a task for case B could be attributed to case A simply by
        // carrying A's sourceVersionId in its untrusted result payload.
        const suggestions = (
          await client.query<{
            id: string;
            run_id: string;
            source_version_id: string;
            hints: unknown;
          }>(
            `SELECT j.id,j.run_id,
                    j.result->>'sourceVersionId' AS source_version_id,
                    j.result->'repairSuggestions' AS hints
             FROM jobs j
             JOIN run_case_regression_bindings b
               ON b.project_id=j.project_id
              AND b.run_id=j.run_id AND b.case_id=j.case_id
              AND b.source_version_id::text=j.result->>'sourceVersionId'
              AND b.source_sha256=j.result->>'sourceDocumentSha256'
             JOIN saved_case_versions v
               ON v.project_id=b.project_id
              AND v.id=b.source_version_id AND v.sha256=b.source_sha256
             WHERE j.project_id=$1 AND v.case_id=$2
               AND v.review_status='approved' AND j.role='executor'
               AND j.status='succeeded'
               AND j.result->'regressionReplay'->>'status'='failed'
               AND j.result->'regressionReplay'->>'reasonCode'='LOCATOR_NOT_FOUND'
               AND jsonb_typeof(j.result->'repairSuggestions')='array'
             ORDER BY j.finished_at DESC NULLS LAST, j.id DESC LIMIT 30`,
            [saved.project_id, saved.id],
          )
        ).rows
          .flatMap((row) => {
            if (!Array.isArray(row.hints)) return [];
            // Fail closed on stale/malformed result JSON. The signed result
            // remains available for audit, but is never made a client DTO.
            return row.hints.slice(0, 1).flatMap((hint) => {
              try {
                return [
                  parseContract('RepairSuggestionRecord', {
                    runId: row.run_id,
                    taskId: row.id,
                    sourceVersionId: row.source_version_id,
                    suggestion: hint,
                  }),
                ];
              } catch {
                return [];
              }
            });
          })
          .slice(0, 10);
        return {
          items: rows.slice(0, limit).map(output),
          repairSuggestions: suggestions,
          nextCursor:
            rows.length > limit
              ? Buffer.from(String(offset + limit)).toString('base64url')
              : null,
        };
      });
      return parseContract('RepairProposalPage', result);
    },
  );

  router.post(
    '/api/v1/saved-cases/{caseId}/repair-proposals',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const input = parseContract('RepairProposalCreate', ctx.body);
      // This is an inert, human-reviewable suggestion, not executable
      // JavaScript, a published version, or a self-approved changed oracle.
      if (!input.diff.trim()) throw new StorageError('VALIDATION_ERROR');
      const result = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const saved = await visibleCase(client, ctx.params.caseId!, 'run');
        if (saved.status !== 'active')
          throw new StorageError('VALIDATION_ERROR');
        const finding = (
          await client.query<{ id: string }>(
            `SELECT f.id FROM findings f
             JOIN reproductions re ON re.project_id=f.project_id
               AND re.run_id=f.run_id AND re.id=f.reproduction_id
             JOIN run_cases rc ON rc.project_id=f.project_id
               AND rc.run_id=f.run_id AND rc.id=f.case_id
             JOIN saved_case_versions v ON v.project_id=rc.project_id
               AND v.id=(rc.document->'regression'->>'sourceVersionId')::uuid
             WHERE f.id=$1 AND f.project_id=$2 AND v.case_id=$3
               AND f.status='confirmed' AND re.outcome='reproduced'
               AND re.fresh_context=true AND v.review_status='approved'
             FOR SHARE OF f`,
            [input.findingId, saved.project_id, saved.id],
          )
        ).rows[0];
        if (!finding) throw new StorageError('VALIDATION_ERROR');
        // A proposal only points to the next potential saved-case version.
        // Nothing is added to saved_case_versions, and no baseline is updated.
        const version = (
          await client.query<{ next: number }>(
            'SELECT COALESCE(MAX(version),0)+1 AS next FROM saved_case_versions WHERE project_id=$1 AND case_id=$2',
            [saved.project_id, saved.id],
          )
        ).rows[0]?.next;
        if (!version || version > 2147483647)
          throw new StorageError('VALIDATION_ERROR');
        const id = randomUUID();
        const row = (
          await client.query<ProposalRow>(
            `INSERT INTO repair_proposals(
               id,project_id,case_id,finding_id,proposed_version,diff,status
             ) VALUES($1,$2,$3,$4,$5,$6,'draft')
             RETURNING id,case_id,finding_id,proposed_version,diff,
                       verification_run_id,status,created_at,
                       review_reason,reviewed_by,reviewed_at`,
            [
              id,
              saved.project_id,
              saved.id,
              input.findingId,
              version,
              input.diff.trim(),
            ],
          )
        ).rows[0]!;
        await audit(client, 'repair_proposal.created', id, saved.project_id);
        return output(row);
      });
      ctx.res.statusCode = 201;
      return result;
    },
  );

  // Human owner review accepts or rejects the SUGGESTION only. It never
  // applies the patch, creates an approved case version or changes oracles.
  router.post(
    '/api/v1/saved-cases/{caseId}/repair-proposals/{proposalId}/review',
    async (ctx: RequestContext) => {
      await requireAuth(ctx);
      const input = parseContract('RepairProposalReviewInput', ctx.body);
      if (input.reason.trim().length < 10)
        throw new StorageError('VALIDATION_ERROR');
      const result = await ctx.api.db.actor(ctx.actor!, async (client) => {
        const saved = await visibleCase(client, ctx.params.caseId!, 'read');
        await authorize(client, saved.project_id, 'config.write');
        const role = (
          await client.query<{ allowed: boolean }>(
            "SELECT can_project($1,'owner') AS allowed",
            [saved.project_id],
          )
        ).rows[0]?.allowed;
        if (!role) throw new StorageError('FORBIDDEN');
        const previous = (
          await client.query<ProposalRow>(
            `SELECT id,case_id,finding_id,proposed_version,diff,
                    verification_run_id,status,created_at,
                    review_reason,reviewed_by,reviewed_at
             FROM repair_proposals
             WHERE id=$1 AND project_id=$2 AND case_id=$3 FOR UPDATE`,
            [ctx.params.proposalId!, saved.project_id, saved.id],
          )
        ).rows[0];
        if (!previous) throw new StorageError('NOT_FOUND');
        if (previous.status !== 'draft')
          throw new StorageError('VERSION_CONFLICT');
        const updated = (
          await client.query<ProposalRow>(
            `UPDATE repair_proposals
             SET status=$2,review_reason=$3,reviewed_by=$4,
                 reviewed_at=clock_timestamp()
             WHERE id=$1
             RETURNING id,case_id,finding_id,proposed_version,diff,
                       verification_run_id,status,created_at,
                       review_reason,reviewed_by,reviewed_at`,
            [
              previous.id,
              input.decision === 'approve' ? 'approved' : 'rejected',
              input.reason.trim(),
              ctx.actor!.userId,
            ],
          )
        ).rows[0]!;
        await audit(
          client,
          'repair_proposal.reviewed',
          previous.id,
          saved.project_id,
        );
        return output(updated);
      });
      return result;
    },
  );
}
