import type { Artifact, Step } from '@localqa/contracts';
import type { ManifestMap } from '../artifacts/types.js';

export interface ReplayTimelineItem {
  seq: number;
  stepId: string;
  toolName: string;
  status: Step['status'];
  targetDescription: string;
  summary: string;
  createdAt: string;
  finishedAt: string | null;
  screenshotArtifactId: string | null;
  screenshotPath: string | null;
}

export interface ReplayAssessmentResult {
  mode: 'full' | 'degraded';
  hasTrace: boolean;
  hasRrweb: boolean;
  timeline: ReplayTimelineItem[];
  warnings: string[];
}

export function assessReplayDegradation(
  artifacts: readonly Artifact[],
  steps: readonly Step[],
  manifest?: ManifestMap,
): ReplayAssessmentResult {
  const traceArtifact = artifacts.find(
    (a) => a.kind === 'trace' && a.status === 'available',
  );
  const rrwebArtifact = artifacts.find(
    (a) => a.kind === 'rrweb' && a.status === 'available',
  );

  const hasTrace = Boolean(
    traceArtifact && manifest?.get(traceArtifact.id)?.status === 'available',
  );
  const hasRrweb = Boolean(
    rrwebArtifact && manifest?.get(rrwebArtifact.id)?.status === 'available',
  );

  const warnings: string[] = [];
  const mode = hasTrace || hasRrweb ? 'full' : 'degraded';

  if (mode === 'degraded') {
    warnings.push(
      'Full session replay (Playwright trace/rrweb) not available; degraded to step events and screenshot timeline',
    );
  }

  // Build ordered timeline from steps and associated screenshots
  const timeline: ReplayTimelineItem[] = [];
  const sortedSteps = [...steps].sort((a, b) => a.seq - b.seq);

  for (const step of sortedSteps) {
    let screenshotArtifactId: string | null = null;
    let screenshotPath: string | null = null;

    for (const refId of step.evidenceRefs) {
      const art = artifacts.find(
        (a) => a.id === refId && a.kind === 'screenshot',
      );
      if (art) {
        screenshotArtifactId = art.id;
        screenshotPath = manifest?.get(art.id)?.relativePath ?? null;
        break;
      }
    }

    timeline.push({
      seq: step.seq,
      stepId: step.id,
      toolName: step.toolName,
      status: step.status,
      targetDescription: step.targetDescription,
      summary: step.summary,
      createdAt: step.createdAt,
      finishedAt: step.finishedAt,
      screenshotArtifactId,
      screenshotPath,
    });
  }

  return {
    mode,
    hasTrace,
    hasRrweb,
    timeline,
    warnings,
  };
}
