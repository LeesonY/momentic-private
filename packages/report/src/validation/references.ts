import type {
  Artifact,
  Verdict,
  Finding,
  Reproduction,
} from '@localqa/contracts';
import type {
  ArtifactStorageBackend,
  ArtifactManifestEntry,
  ManifestMap,
  ArtifactKind,
} from '../artifacts/types.js';

export interface EvidenceReferenceCheckResult {
  manifest: ManifestMap;
  invalidReferences: Array<{
    refId: string;
    sourceType: 'verdict' | 'finding' | 'reproduction';
    sourceId: string;
    reason: string;
  }>;
  warnings: string[];
}

function getFileExtension(kind: ArtifactKind): string {
  switch (kind) {
    case 'screenshot':
      return '.png';
    case 'trace':
      return '.zip';
    case 'rrweb':
      return '.json';
    case 'network':
    case 'console':
      return '.json';
    case 'export':
      return '.zip';
    default:
      return '.bin';
  }
}

export async function validateEvidenceReferences(
  projectId: string,
  runId: string,
  artifacts: readonly Artifact[],
  verdicts: readonly Verdict[],
  findings: readonly Finding[],
  reproductions: readonly Reproduction[],
  artifactStore?: ArtifactStorageBackend,
): Promise<EvidenceReferenceCheckResult> {
  const artifactMap = new Map<string, Artifact>();
  for (const a of artifacts) {
    artifactMap.set(a.id, a);
  }

  const manifest: ManifestMap = new Map();
  const invalidReferences: EvidenceReferenceCheckResult['invalidReferences'] =
    [];
  const warnings: string[] = [];

  // Manifest status stays on the Artifact.status enum and is not written
  // back onto artifacts.document. The export projection only decides whether
  // a binary is linked.
  for (const a of artifacts) {
    let status: ArtifactManifestEntry['status'] = a.status;
    let error: string | null = a.error ?? null;
    let relativePath: string | null = null;

    if (a.redaction === 'failed') {
      status = 'failed';
      error = error ?? 'Artifact redaction failed; binary omitted from export';
    } else if (a.bytes !== null && a.bytes > 25 * 1024 * 1024) {
      status = 'failed';
      error = error ?? 'Artifact exceeds 25MiB limit';
    } else if (a.status === 'missing') {
      status = 'missing';
      error = error ?? 'Artifact marked missing';
    } else if (a.status === 'failed') {
      status = 'failed';
      error = error ?? 'Artifact marked failed';
    } else if (a.status === 'degraded') {
      status = 'degraded';
      error =
        error ?? 'Artifact content is degraded; binary omitted from export';
    } else if (artifactStore) {
      const existsOnDisk = await artifactStore.exists(projectId, runId, a.id);
      if (!existsOnDisk) {
        status = 'missing';
        error = 'Binary file missing from artifact storage';
      } else {
        status = 'available';
      }
    }

    if (status === 'available') {
      const ext = getFileExtension(a.kind);
      relativePath = `artifacts/${a.id}${ext}`;
    }

    const entry: ArtifactManifestEntry = {
      id: a.id,
      kind: a.kind,
      status,
      bytes: a.bytes,
      sha256: a.sha256,
      relativePath,
      error,
    };
    manifest.set(a.id, entry);
  }

  // Check references in verdicts
  for (const v of verdicts) {
    for (const cr of v.criterionResults) {
      for (const refId of cr.evidenceRefs) {
        const found = artifactMap.get(refId);
        if (!found) {
          invalidReferences.push({
            refId,
            sourceType: 'verdict',
            sourceId: v.id,
            reason: `Referenced artifact ${refId} does not belong to run ${runId}`,
          });
          warnings.push(
            `Verdict ${v.id} references non-existent or foreign artifact ${refId}`,
          );
        } else {
          const m = manifest.get(refId);
          if (m && m.status !== 'available') {
            warnings.push(
              `Verdict ${v.id} references artifact ${refId} which is ${m.status}: ${m.error}`,
            );
          }
        }
      }
    }
  }

  // Check references in findings
  for (const f of findings) {
    for (const refId of f.evidenceRefs) {
      const found = artifactMap.get(refId);
      if (!found) {
        invalidReferences.push({
          refId,
          sourceType: 'finding',
          sourceId: f.id,
          reason: `Referenced artifact ${refId} does not belong to run ${runId}`,
        });
        warnings.push(
          `Finding ${f.id} references non-existent or foreign artifact ${refId}`,
        );
      } else {
        const m = manifest.get(refId);
        if (m && m.status !== 'available') {
          warnings.push(
            `Finding ${f.id} references artifact ${refId} which is ${m.status}: ${m.error}`,
          );
        }
      }
    }
  }

  // Check references in reproductions
  for (const r of reproductions) {
    for (const refId of r.evidenceRefs) {
      const found = artifactMap.get(refId);
      if (!found) {
        invalidReferences.push({
          refId,
          sourceType: 'reproduction',
          sourceId: r.id,
          reason: `Referenced artifact ${refId} does not belong to run ${runId}`,
        });
        warnings.push(
          `Reproduction ${r.id} references non-existent or foreign artifact ${refId}`,
        );
      }
    }
  }

  return {
    manifest,
    invalidReferences,
    warnings,
  };
}
