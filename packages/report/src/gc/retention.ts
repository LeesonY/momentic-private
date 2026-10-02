import type { PoolClient } from 'pg';
import { audit } from '@localqa/storage';
import type { ArtifactStorageBackend } from '../artifacts/types.js';

export interface RetentionPolicyConfig {
  reportRetentionDays?: number; // default 90
  artifactRetentionDays?: number; // default 30
  auditLogRetentionDays?: number; // default 180
}

export const DEFAULT_RETENTION_POLICY: Required<RetentionPolicyConfig> = {
  reportRetentionDays: 90,
  artifactRetentionDays: 30,
  auditLogRetentionDays: 180,
};

export interface GCResult {
  inspectedArtifacts: number;
  deletedArtifacts: number;
  protectedActiveRuns: number;
  protectedManualRetention: number;
  protectedExportReferences: number;
  cleanedAuditLogs: number;
  deletedArtifactIds: string[];
}

export class GarbageCollector {
  readonly config: Required<RetentionPolicyConfig>;

  constructor(config?: RetentionPolicyConfig) {
    this.config = {
      ...DEFAULT_RETENTION_POLICY,
      ...config,
    };
  }

  async runGC(
    client: PoolClient,
    projectId: string,
    artifactStore: ArtifactStorageBackend,
  ): Promise<GCResult> {
    const result: GCResult = {
      inspectedArtifacts: 0,
      deletedArtifacts: 0,
      protectedActiveRuns: 0,
      protectedManualRetention: 0,
      protectedExportReferences: 0,
      cleanedAuditLogs: 0,
      deletedArtifactIds: [],
    };

    // 1. Fetch all artifacts in this project
    const artifactsQuery = await client.query<{
      id: string;
      project_id: string;
      run_id: string;
      retain_until: Date;
      held: boolean;
      document: Record<string, unknown>;
    }>(
      'SELECT id, project_id, run_id, retain_until, held, document FROM artifacts WHERE project_id = $1',
      [projectId],
    );

    result.inspectedArtifacts = artifactsQuery.rows.length;

    // 2. Fetch active runs in this project
    const activeRunsQuery = await client.query<{ id: string }>(
      `SELECT id FROM runs
       WHERE project_id = $1
         AND status IN ('draft', 'queued', 'running', 'awaiting_input', 'cancelling')`,
      [projectId],
    );
    const activeRunIds = new Set(activeRunsQuery.rows.map((r) => r.id));

    // 3. Fetch active exports (held or retain_until > now) and their referenced artifacts
    const activeExportsQuery = await client.query<{
      id: string;
      artifact_id: string | null;
      report_snapshot: Record<string, unknown>;
    }>(
      `SELECT id, artifact_id, report_snapshot FROM exports
       WHERE project_id = $1
         AND (held = true OR retain_until > clock_timestamp())`,
      [projectId],
    );

    const protectedExportArtifactIds = new Set<string>();
    for (const exp of activeExportsQuery.rows) {
      if (exp.artifact_id) {
        protectedExportArtifactIds.add(exp.artifact_id);
      }
      // Check artifacts listed in report_snapshot
      const snapshot = exp.report_snapshot;
      if (snapshot && Array.isArray(snapshot.artifacts)) {
        for (const a of snapshot.artifacts) {
          if (a && typeof a.id === 'string') {
            protectedExportArtifactIds.add(a.id);
          }
        }
      }
    }

    const now = Date.now();

    // 4. Process each artifact with 4-line defense
    for (const a of artifactsQuery.rows) {
      // Line 1: Active Run Protection
      if (activeRunIds.has(a.run_id)) {
        result.protectedActiveRuns++;
        continue;
      }

      // Line 2: Manual Retention (held = true or retain_until > now)
      if (a.held || (a.retain_until && a.retain_until.getTime() > now)) {
        result.protectedManualRetention++;
        continue;
      }

      // Line 3: Active Export Reference Protection
      if (protectedExportArtifactIds.has(a.id)) {
        result.protectedExportReferences++;
        continue;
      }

      // If we reach here, the artifact has expired, is not held, is not in an active run,
      // and is not referenced by an active export. It is eligible for GC.
      await artifactStore.delete(projectId, a.run_id, a.id);

      // Update database record to reflect garbage collection
      const updatedDoc = {
        ...a.document,
        status: 'missing',
        error: 'Artifact deleted by retention policy (expired)',
      };

      await client.query(
        'UPDATE artifacts SET document = $2 WHERE project_id = $1 AND id = $3',
        [projectId, updatedDoc, a.id],
      );

      result.deletedArtifacts++;
      result.deletedArtifactIds.push(a.id);

      // Audit GC action
      await audit(client, 'artifact.deleted', a.id, projectId, 1);
    }

    // 5. Audit log retention is managed at superuser/maintenance level;
    // audit_log table is append-only for localqa_app role under forced RLS.
    result.cleanedAuditLogs = 0;

    return result;
  }
}
