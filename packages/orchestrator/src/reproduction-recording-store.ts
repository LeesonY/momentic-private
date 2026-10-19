import type { PoolClient } from 'pg';
import { parseContract, type Finding, type Step } from '@localqa/contracts';
import { mapReproductionRecording } from './reproduction-recording.js';

/** The capture worker supplies its persisted TaskRecording with finish().
 * The model report cannot authorize an artifact: check the actual artifact
 * row under the finish transaction and only read this task's persisted steps. */
export async function reproductionRecordingIn(
  client: PoolClient,
  input: {
    projectId: string;
    runId: string;
    taskId: string;
    reproductionId: string;
    finding: Finding;
    outcome: string;
    taskRecording: unknown;
    anchors: unknown;
  },
): Promise<Finding['recording']> {
  if (input.finding.kind !== 'functional' || input.outcome !== 'reproduced')
    return null;
  let recording;
  try {
    recording = parseContract('TaskRecording', input.taskRecording);
  } catch {
    return null;
  }
  if (
    recording.taskId !== input.taskId ||
    !recording.rrwebArtifactId ||
    !['available', 'degraded'].includes(recording.status)
  )
    return null;
  const owned = await client.query(
    `SELECT id FROM artifacts WHERE project_id=$1 AND run_id=$2 AND task_id=$3 AND id=$4
     AND document->>'kind'='rrweb' AND document->>'status' IN ('available','degraded')
     AND document->>'redaction'='applied'`,
    [input.projectId, input.runId, input.taskId, recording.rrwebArtifactId],
  );
  if (!owned.rowCount) return null;
  const rows = await client.query<{ document: Step }>(
    'SELECT document FROM steps WHERE project_id=$1 AND run_id=$2 AND task_id=$3 ORDER BY seq',
    [input.projectId, input.runId, input.taskId],
  );
  const result = mapReproductionRecording({
    kind: input.finding.kind,
    outcome: input.outcome,
    reproductionId: input.reproductionId,
    taskId: input.taskId,
    recording,
    steps: rows.rows.map(({ document }) => document),
    anchors: input.anchors,
    reproStepCount: input.finding.reproSteps.length,
  });
  if (result)
    await client.query(
      `INSERT INTO artifact_references(project_id,artifact_id,ref_kind,ref_id)
     VALUES($1,$2,'finding',$3) ON CONFLICT DO NOTHING`,
      [input.projectId, recording.rrwebArtifactId, input.finding.id],
    );
  return result;
}
