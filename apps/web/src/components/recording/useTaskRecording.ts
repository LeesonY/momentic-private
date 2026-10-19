import { useEffect, useState } from 'react';
import type { Step } from '@localqa/contracts';
import { defaultApiClient } from '../../api/index.ts';
import { MAX_PAGE_LIMIT } from '../../api/pagination.ts';
import {
  loadRecordingPayload,
  loadTaskRecording,
  type RecordingPayload,
} from '../../api/recording.ts';
import type { RecordingInfo } from '../../utils/recording.ts';

/** A recorded step; `thought` is the agent's own reasoning for it. */
export type ReplayStep = Step;

/** The contract caps `limit` at 100 (README: apps/web/src/api/pagination.ts). */
export const STEP_PAGE_LIMIT = MAX_PAGE_LIMIT;
/** A session with more steps than this is shown cut, with a note. */
export const MAX_STEPS = 1000;

export interface TaskRecordingState {
  loading: boolean;
  /** A player can be shown: a recording exists and has replayable events. */
  playable: boolean;
  recording: RecordingInfo | null;
  payload: RecordingPayload | null;
  /** Degraded evidence (e.g. a recording cut at the size cap) and its reason. */
  warnings: string[];
  /** The task's steps, for the activity tab and the steps timeline. */
  steps: ReplayStep[];
  /** Why the steps could not be read; never silently zero steps. */
  stepsError: string | null;
  /** More steps exist than MAX_STEPS and the list was cut. */
  stepsTruncated: boolean;
  error: string | null;
}

const IDLE: TaskRecordingState = {
  loading: false,
  playable: false,
  recording: null,
  payload: null,
  warnings: [],
  steps: [],
  stepsError: null,
  stepsTruncated: false,
  error: null,
};

export type TaskStepLoader = (
  taskId: string,
  query: { limit: number; cursor?: string },
) => Promise<{ items: ReplayStep[]; nextCursor?: string | null }>;

/**
 * Every step of a task, page by page. `limit` may not exceed the contract's 100,
 * so asking for 200 was a 422 that produced an empty timeline and an empty
 * activity list. A repeated cursor is an API error, not a reason to loop.
 */
export async function readAllTaskSteps(
  taskId: string,
  load: TaskStepLoader = (id, query) =>
    defaultApiClient.listTaskSteps(id, query),
): Promise<{ steps: ReplayStep[]; truncated: boolean }> {
  const steps: ReplayStep[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await load(taskId, {
      limit: STEP_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    steps.push(...page.items);
    const next = page.nextCursor ?? null;
    if (!next)
      return {
        steps: steps.slice(0, MAX_STEPS),
        truncated: steps.length > MAX_STEPS,
      };
    if (seen.has(next)) throw new Error('分页游标重复，请刷新后重试');
    seen.add(next);
    if (steps.length >= MAX_STEPS)
      return { steps: steps.slice(0, MAX_STEPS), truncated: true };
    cursor = next;
  }
}

/**
 * Loads one task's replay evidence. A missing recording is a normal answer
 * (`playable: false`), not an error; a failed download is reported so the UI can
 * say so instead of showing an empty player.
 */
export function useTaskRecording(
  taskId: string | null,
  enabled: boolean,
  runId: string | null = null,
): TaskRecordingState {
  const [state, setState] = useState<TaskRecordingState>(IDLE);

  useEffect(() => {
    let active = true;
    if (!taskId || !enabled) {
      setState(IDLE);
      return;
    }
    setState({ ...IDLE, loading: true });
    void (async () => {
      try {
        const recording = await loadTaskRecording(taskId);
        if (!active) return;
        if (
          recording.status !== 'available' &&
          recording.status !== 'degraded'
        ) {
          setState({
            loading: false,
            playable: false,
            recording,
            payload: null,
            warnings: [],
            steps: [],
            stepsError: null,
            stepsTruncated: false,
            error: null,
          });
          return;
        }
        let payload: RecordingPayload = {
          events: [],
          consoleLines: [],
          networkLines: [],
          warnings: [],
        };
        let error: string | null = null;
        try {
          payload = await loadRecordingPayload(recording, runId);
        } catch (reason) {
          error = reason instanceof Error ? reason.message : '录像读取失败';
        }
        // Steps are the activity rows; a steps failure must not hide the replay,
        // but it is reported instead of pretending the task made no steps.
        let steps: ReplayStep[] = [];
        let stepsError: string | null = null;
        let stepsTruncated = false;
        try {
          const read = await readAllTaskSteps(taskId);
          steps = read.steps;
          stepsTruncated = read.truncated;
        } catch (reason) {
          stepsError =
            reason instanceof Error && reason.message
              ? reason.message
              : '步骤加载失败';
        }
        if (!active) return;
        setState({
          loading: false,
          playable: payload.events.length > 0,
          recording,
          payload,
          warnings: payload.warnings,
          steps,
          stepsError,
          stepsTruncated,
          error,
        });
      } catch (reason) {
        if (!active) return;
        setState({
          ...IDLE,
          error: reason instanceof Error ? reason.message : '录像读取失败',
        });
      }
    })();
    return () => {
      active = false;
    };
  }, [taskId, enabled, runId]);

  return state;
}
