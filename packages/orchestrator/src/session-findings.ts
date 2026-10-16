import type { PoolClient } from 'pg';
import {
  parseContract,
  type Finding,
  type Run,
  type SessionDuplicateFinding,
} from '@localqa/contracts';
import { appendEvent } from '@localqa/storage';

/** Additional occurrences are not the original task's confirmation evidence.
 * Keep finding_evidence / reproduction_evidence immutable and use the existing
 * generic references for merged evidence retention instead. */
export async function linkMergedFindingEvidence(
  client: PoolClient,
  run: Run,
  findingId: string,
  evidenceRefs: readonly string[],
): Promise<void> {
  if (!evidenceRefs.length) return;
  await client.query(
    `INSERT INTO artifact_references(project_id,artifact_id,ref_kind,ref_id)
     SELECT $1,id,'finding',$3 FROM artifacts
     WHERE project_id=$1 AND run_id=$2 AND id=ANY($4::uuid[])
     ON CONFLICT DO NOTHING`,
    [run.projectId, run.id, findingId, evidenceRefs],
  );
}

/** Merge only references/triage, never status or independent confirmation IDs. */
export async function mergeSessionFindings(
  client: PoolClient,
  run: Run,
  entries: readonly SessionDuplicateFinding[],
): Promise<string[]> {
  if (!entries.length) return [];
  // Lock in stable order, including existing aliases, so re-merging a retained
  // finding can redirect its aliases to the new root without leaving chains.
  const findings = new Map(
    (
      await client.query<{ id: string; document: unknown }>(
        `SELECT id,document FROM findings
         WHERE project_id=$1 AND run_id=$2 ORDER BY id FOR UPDATE`,
        [run.projectId, run.id],
      )
    ).rows.map((row) => [row.id, parseContract('Finding', row.document)]),
  );
  const notes: string[] = [];
  const duplicate = (finding: Finding) =>
    finding.triageDisposition === 'duplicate' || !!finding.duplicateOf;
  const update = async (finding: Finding) => {
    await client.query(
      `UPDATE findings SET version=version+1,document=$3
       WHERE project_id=$1 AND run_id=$2 AND id=$4`,
      [run.projectId, run.id, finding, finding.id],
    );
    findings.set(finding.id, finding);
    await appendEvent(
      client,
      run.projectId,
      run.id,
      'finding.updated',
      finding,
    );
  };
  for (const entry of entries) {
    const source = findings.get(entry.findingId);
    const target = findings.get(entry.sameAs);
    const invalid =
      !source || !target || source.runId !== run.id || target.runId !== run.id
        ? '缺陷不属于本运行或不存在'
        : source.id === target.id
          ? '不能与自身合并'
          : duplicate(target)
            ? '保留目标已被合并'
            : duplicate(source)
              ? '该缺陷已被合并'
              : null;
    if (invalid || !source || !target) {
      notes.push(
        `缺陷合并已忽略（${entry.findingId} → ${entry.sameAs}）：${invalid}。`,
      );
      continue;
    }
    const reproductionEvidence = (
      await client.query<{ artifact_id: string }>(
        `SELECT e.artifact_id FROM reproduction_evidence e
         JOIN reproductions r ON r.id=e.reproduction_id AND r.project_id=e.project_id
         WHERE r.project_id=$1 AND r.run_id=$2 AND r.finding_id=$3`,
        [run.projectId, run.id, source.id],
      )
    ).rows.map((row) => row.artifact_id);
    const evidenceRefs = [
      ...new Set([
        ...target.evidenceRefs,
        ...source.evidenceRefs,
        ...reproductionEvidence,
      ]),
    ];
    const ownedEvidence = new Set(
      evidenceRefs.length
        ? (
            await client.query<{ id: string }>(
              'SELECT id FROM artifacts WHERE project_id=$1 AND run_id=$2 AND id=ANY($3::uuid[])',
              [run.projectId, run.id, evidenceRefs],
            )
          ).rows.map((row) => row.id)
        : [],
    );
    if (evidenceRefs.some((id) => !ownedEvidence.has(id))) {
      notes.push(
        `缺陷合并已忽略（${source.id} → ${target.id}）：证据不属于本运行或不存在。`,
      );
      continue;
    }
    let grouped: Finding;
    let merged: Finding;
    try {
      grouped = parseContract('Finding', {
        ...target,
        caseIds: [...new Set([...target.caseIds, ...source.caseIds])],
        evidenceRefs,
        version: target.version + 1,
      });
      merged = parseContract('Finding', {
        ...source,
        triageDisposition: 'duplicate',
        duplicateOf: target.id,
        version: source.version + 1,
      });
    } catch {
      notes.push(
        `缺陷合并已忽略（${source.id} → ${target.id}）：合并后的字段超出契约限制。`,
      );
      continue;
    }
    await linkMergedFindingEvidence(client, run, target.id, evidenceRefs);
    await update(grouped);
    await update(merged);
    for (const alias of findings.values()) {
      if (alias.duplicateOf !== source.id) continue;
      await update(
        parseContract('Finding', {
          ...alias,
          duplicateOf: target.id,
          version: alias.version + 1,
        }),
      );
    }
    notes.push(
      `缺陷已合并：${source.id} → ${target.id}；${entry.reason.trim().slice(0, 1000)}`,
    );
  }
  return notes;
}
