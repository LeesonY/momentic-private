import type { PoolClient } from 'pg';
import type {
  Report,
  CaseRecord,
  Verdict,
  Finding,
  Reproduction,
  Artifact,
  ModelUsage,
  CaseDefinition,
} from '@localqa/contracts';
import { parseContract } from '@localqa/contracts';
import { runDTO } from '@localqa/storage';
import { calculateSummary, type CaseOutcome } from './summary.js';
import { validateEvidenceReferences } from '../validation/references.js';
import { assessReplayDegradation } from '../replay/degrade.js';
import type { ArtifactStorageBackend } from '../artifacts/types.js';

export interface ReportBuildOptions {
  artifactStore?: ArtifactStorageBackend;
  example?: boolean;
}

export class ReportBuilder {
  async build(
    client: PoolClient,
    projectId: string,
    runId: string,
    options?: ReportBuildOptions,
  ): Promise<Report> {
    // 1. Fetch Run DTO
    const run = await runDTO(client, projectId, runId);

    // 2. Fetch planned cases
    const casesRows = (
      await client.query<{ id: string; document: CaseDefinition }>(
        'SELECT id, document FROM run_cases WHERE project_id = $1 AND run_id = $2 ORDER BY id',
        [projectId, runId],
      )
    ).rows;

    // 3. Fetch case attempts
    const attemptsRows = (
      await client.query<{
        id: string;
        case_id: string;
        attempt_number: number;
        status: string;
      }>(
        'SELECT id, case_id, attempt_number, status FROM case_attempts WHERE project_id = $1 AND run_id = $2 ORDER BY attempt_number ASC',
        [projectId, runId],
      )
    ).rows;
    const attemptedCaseIds = new Set(attemptsRows.map((a) => a.case_id));

    // 4. Fetch final valid verdicts
    const verdictsRows = (
      await client.query<{
        id: string;
        case_id: string;
        attempt_id: string;
        document: Verdict;
      }>(
        `SELECT v.id, v.case_id, v.attempt_id, v.document
         FROM final_valid_verdicts v
         JOIN run_cases c ON c.id = v.case_id
         WHERE c.project_id = $1 AND c.run_id = $2`,
        [projectId, runId],
      )
    ).rows;
    const verdictByCaseId = new Map<string, Verdict>();
    for (const row of verdictsRows) {
      verdictByCaseId.set(row.case_id, row.document);
    }

    // 5. Fetch findings
    const findingsRows = (
      await client.query<{ document: Finding }>(
        'SELECT document FROM findings WHERE project_id = $1 AND run_id = $2 ORDER BY id ASC',
        [projectId, runId],
      )
    ).rows;
    const findings = findingsRows.map((f) => f.document);

    // 6. Fetch reproductions
    const reproductionsRows = (
      await client.query<{ document: Reproduction }>(
        'SELECT document FROM reproductions WHERE project_id = $1 AND run_id = $2 ORDER BY id ASC',
        [projectId, runId],
      )
    ).rows;
    const reproductions = reproductionsRows.map((r) => r.document);

    // 7. Fetch artifacts
    const artifactsRows = (
      await client.query<{ document: Artifact }>(
        'SELECT document FROM artifacts WHERE project_id = $1 AND run_id = $2 ORDER BY id ASC',
        [projectId, runId],
      )
    ).rows;
    const artifacts = artifactsRows.map((a) => a.document);

    // 8. Fetch steps for replay assessment
    const stepsRows = (
      await client.query<{ document: import('@localqa/contracts').Step }>(
        'SELECT document FROM steps WHERE project_id = $1 AND run_id = $2 ORDER BY seq ASC',
        [projectId, runId],
      )
    ).rows;
    const steps = stepsRows.map((s) => s.document);

    // 9. Fetch model requests and aggregate usage
    const modelReqRows = (
      await client.query<{
        status: string;
        redacted_diagnostic: Record<string, unknown>;
      }>(
        'SELECT status, redacted_diagnostic FROM model_requests WHERE project_id = $1 AND run_id = $2',
        [projectId, runId],
      )
    ).rows;

    const usageMap = new Map<
      string,
      {
        profileId: string;
        configuredModelId: string;
        reportedModelId: string | null;
        requests: number;
        inputTokens: number;
        outputTokens: number;
        sources: Set<string>;
      }
    >();

    for (const req of modelReqRows) {
      const diag = req.redacted_diagnostic || {};
      const profileId = String(
        diag.profileId || run.effectiveConfig.models.coordinator.profileId,
      );
      const configuredModelId = String(diag.configuredModelId || 'unknown');
      const reportedModelId =
        typeof diag.reportedModelId === 'string' ? diag.reportedModelId : null;
      const key = `${profileId}:${configuredModelId}:${reportedModelId ?? ''}`;

      const existing = usageMap.get(key) || {
        profileId,
        configuredModelId,
        reportedModelId,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        sources: new Set<string>(),
      };

      existing.requests += 1;
      const inTok = Number(diag.inputTokens);
      const outTok = Number(diag.outputTokens);
      if (Number.isSafeInteger(inTok) && inTok > 0)
        existing.inputTokens += inTok;
      if (Number.isSafeInteger(outTok) && outTok > 0)
        existing.outputTokens += outTok;

      const src = String(diag.usageSource || 'unknown');
      existing.sources.add(src);
      usageMap.set(key, existing);
    }

    const modelUsage: ModelUsage[] = Array.from(usageMap.values()).map(
      (item) => {
        let usageSource: ModelUsage['usageSource'] = 'unknown';
        if (item.sources.size === 1) {
          const single = Array.from(item.sources)[0];
          if (
            single === 'reported' ||
            single === 'estimated' ||
            single === 'unknown'
          ) {
            usageSource = single;
          } else {
            usageSource = 'mixed';
          }
        } else if (item.sources.size > 1) {
          usageSource = 'mixed';
        }

        return {
          profileId: item.profileId,
          configuredModelId: item.configuredModelId,
          reportedModelId: item.reportedModelId,
          requests: item.requests,
          inputTokens: item.inputTokens > 0 ? item.inputTokens : null,
          outputTokens: item.outputTokens > 0 ? item.outputTokens : null,
          usageSource,
        };
      },
    );

    // 10. Build case records and determine outcomes
    const cases: CaseRecord[] = [];
    const outcomes: CaseOutcome[] = [];

    for (const caseRow of casesRows) {
      const caseId = caseRow.id;
      const definition = caseRow.document;
      const verdict = verdictByCaseId.get(caseId);

      let outcome: CaseOutcome;
      if (verdict) {
        outcome = verdict.status;
      } else if (attemptedCaseIds.has(caseId)) {
        outcome = 'inconclusive';
      } else {
        outcome = 'not_run';
      }

      outcomes.push(outcome);
      cases.push({
        definition,
        outcome,
        verdict: verdict ?? null,
      });
    }

    // 11. Calculate summary from database facts
    const summary = calculateSummary(outcomes);

    // 12. Validate evidence references and check missing files
    const allVerdicts = Array.from(verdictByCaseId.values());
    const refCheck = await validateEvidenceReferences(
      projectId,
      runId,
      artifacts,
      allVerdicts,
      findings,
      reproductions,
      options?.artifactStore,
    );

    // 13. Replay assessment
    const replayAssessment = assessReplayDegradation(
      artifacts,
      steps,
      refCheck.manifest,
    );

    // 14. Aggregate warnings
    const warnings: string[] = [
      ...refCheck.warnings,
      ...replayAssessment.warnings,
    ];

    if (run.budgetUsed.actions >= run.effectiveConfig.budget.maxActions) {
      warnings.push('Run reached maximum configured action budget limit');
    }
    if (run.budgetUsed.modelCalls >= run.effectiveConfig.budget.maxModelCalls) {
      warnings.push('Run reached maximum configured model call budget limit');
    }

    // 15. Coverage gaps calculation
    const coverageGaps: string[] = [];
    if (summary.notRun > 0) {
      const notRunTitles = cases
        .filter((c) => c.outcome === 'not_run')
        .map((c) => c.definition.title);
      coverageGaps.push(
        `${summary.notRun} planned test case(s) were not started: ${notRunTitles.slice(0, 5).join(', ')}${notRunTitles.length > 5 ? '...' : ''}`,
      );
    }
    if (summary.blocked > 0) {
      coverageGaps.push(
        `${summary.blocked} test case(s) were blocked by environmental or condition constraints`,
      );
    }
    if (summary.inconclusive > 0) {
      coverageGaps.push(
        `${summary.inconclusive} test case(s) ended with inconclusive evidence`,
      );
    }
    if (run.terminationReason && run.terminationReason !== 'normal') {
      coverageGaps.push(
        `Execution stopped early due to termination reason: ${run.terminationReason}`,
      );
    }
    if (coverageGaps.length === 0) {
      coverageGaps.push(
        `All ${summary.planned} planned case(s) were executed and evaluated in scope. Deeper paths beyond maxDepth=${run.effectiveConfig.budget.maxDepth} or unapproved origins were excluded by policy.`,
      );
    }

    // 16. Cleanup status
    let cleanupStatus: Report['cleanupStatus'] = 'not_required';
    if (['completed', 'cancelled', 'failed'].includes(run.status)) {
      cleanupStatus = 'succeeded';
    } else if (
      ['running', 'awaiting_input', 'cancelling'].includes(run.status)
    ) {
      cleanupStatus = 'pending';
    }

    const reportData: Report = {
      schemaVersion: 1,
      example: options?.example ?? false,
      generatedAt: new Date().toISOString(),
      run,
      summary,
      cases,
      findings,
      reproductions,
      artifacts,
      modelUsage,
      coverageGaps,
      cleanupStatus,
      warnings,
    };

    return parseContract('Report', reportData);
  }
}
