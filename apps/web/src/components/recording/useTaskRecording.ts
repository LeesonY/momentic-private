import { useEffect, useState } from 'react';
import type { Step } from '@localqa/contracts';
import { defaultApiClient } from '../../api/index.ts';
import {
  loadRecordingPayload,
  loadTaskRecording,
  type RecordingPayload,
} from '../../api/recording.ts';
import type { RecordingInfo } from '../../utils/recording.ts';

/** A recorded step; `thought` is the agent's own reasoning for it. */
export type ReplayStep = Step;

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
  error: string | null;
}

const IDLE: TaskRecordingState = {
  loading: false,
  playable: false,
  recording: null,
  payload: null,
  warnings: [],
  steps: [],
  error: null,
};

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
        // Steps are the activity rows; a steps failure must not hide the replay.
        let steps: ReplayStep[] = [];
        try {
          steps = (await defaultApiClient.listTaskSteps(taskId, { limit: 200 }))
            .items as ReplayStep[];
        } catch {
          steps = [];
        }
        if (!active) return;
        setState({
          loading: false,
          playable: payload.events.length > 0,
          recording,
          payload,
          warnings: payload.warnings,
          steps,
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
