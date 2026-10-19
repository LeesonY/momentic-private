import type { Step } from '@localqa/contracts';

/** Report-only metadata, not a browser instruction. Both indices are 1-based. */
export interface ReproStepAction {
  index: number;
  seq: number;
}

type RecordedStep = Pick<Step, 'taskId' | 'seq' | 'createdAt' | 'finishedAt'>;

/** Invalid anchors are ignored independently. Keep report order rather than
 * sorting a backwards mapping into something the reproducer never claimed. */
export function parseReproStepActions(
  value: unknown,
  stepCount = 30,
  taskSteps?: readonly Pick<Step, 'seq'>[],
): ReproStepAction[] {
  if (!Array.isArray(value)) return [];
  const available = taskSteps && new Set(taskSteps.map((step) => step.seq));
  const result: ReproStepAction[] = [];
  let previousIndex = 0;
  let previousSeq = 0;
  for (const item of value.slice(0, 300)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const { index, seq } = item as Record<string, unknown>;
    if (
      typeof index !== 'number' ||
      !Number.isSafeInteger(index) ||
      index <= previousIndex ||
      index > Math.min(30, stepCount) ||
      typeof seq !== 'number' ||
      !Number.isSafeInteger(seq) ||
      seq < 1 ||
      seq < previousSeq ||
      (available && !available.has(seq))
    )
      continue;
    result.push({ index, seq });
    previousIndex = index;
    previousSeq = seq;
  }
  return result;
}

/** Structural seams until the shared replay contract lands. No field is
 * persisted by this module; the finish transaction owns validation/authority. */
export interface RecordingSource {
  taskId: string;
  status: string;
  rrwebArtifactId: string | null;
  startedAt: string | null;
  endedAt: string | null;
}
export interface ReproductionRecordingLink {
  reproductionId: string;
  taskId: string;
  startedAt: string;
  endedAt: string;
  steps: { index: number; at: string }[];
}

const timestamp = (value: string | null): number =>
  value ? Date.parse(value) : NaN;

/** Link only the confirming reproducer's own recording. The entire rrweb
 * artifact is retained: these times select playback, never trim DOM events. */
export function mapReproductionRecording(input: {
  kind: string;
  outcome: string;
  reproductionId: string;
  taskId: string;
  recording: RecordingSource | null;
  steps: readonly RecordedStep[];
  anchors: unknown;
  reproStepCount: number;
}): ReproductionRecordingLink | null {
  const recording = input.recording;
  if (
    input.kind !== 'functional' ||
    input.outcome !== 'reproduced' ||
    !recording ||
    recording.taskId !== input.taskId ||
    !['available', 'degraded'].includes(recording.status) ||
    !recording.rrwebArtifactId
  )
    return null;
  const begin = timestamp(recording.startedAt);
  const end = timestamp(recording.endedAt);
  if (!Number.isFinite(begin) || !Number.isFinite(end) || begin > end)
    return null;
  const steps = input.steps.filter((step) => step.taskId === input.taskId);
  const bySeq = new Map(steps.map((step) => [step.seq, step]));
  const anchors = parseReproStepActions(
    input.anchors,
    input.reproStepCount,
    steps,
  );
  const mapped: {
    index: number;
    at: string;
    created: number;
    finished: number;
  }[] = [];
  for (const anchor of anchors) {
    const step = bySeq.get(anchor.seq)!;
    const created = timestamp(step.createdAt);
    const finished = timestamp(step.finishedAt ?? step.createdAt);
    if (
      !Number.isFinite(created) ||
      !Number.isFinite(finished) ||
      finished < created ||
      finished < begin ||
      finished > end ||
      (mapped.length && finished < mapped[mapped.length - 1]!.finished)
    )
      continue;
    mapped.push({
      index: anchor.index,
      at: new Date(finished).toISOString(),
      created,
      finished,
    });
  }
  return {
    reproductionId: input.reproductionId,
    taskId: input.taskId,
    startedAt: new Date(
      mapped.length ? Math.max(begin, mapped[0]!.created - 3000) : begin,
    ).toISOString(),
    endedAt: new Date(
      mapped.length
        ? Math.min(end, mapped[mapped.length - 1]!.finished + 3000)
        : end,
    ).toISOString(),
    steps: mapped.map(({ index, at }) => ({ index, at })),
  };
}
