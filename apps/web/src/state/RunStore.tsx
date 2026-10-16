import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from 'react';
import type {
  Run,
  CaseRecord,
  Task,
  Finding,
  Report,
  SessionReport,
  InputRequest,
  InputResponse,
  RunEvent,
  BudgetUsed,
} from '@localqa/contracts';
import {
  defaultApiClient,
  SseClient,
  type SseConnectionStatus,
  fetchRunMessages,
  recordMessageRendered,
  type RunMessage,
} from '../api/index.ts';
import { readAllPages } from '../api/pagination.ts';
import { mergeRunEventHistory } from './runEventHistory.ts';

interface RunState {
  run: Run | null;
  cases: CaseRecord[];
  tasks: Task[];
  findings: Finding[];
  report: Report | null;
  session: SessionReport | null;
  activeInputRequest: InputRequest | null;
  messages: RunMessage[];
  events: RunEvent[];
  sseStatus: SseConnectionStatus;
  reconnectAttempt: number;
  loading: boolean;
  error: string | null;
}

interface RunStoreValue extends RunState {
  reload: () => Promise<void>;
  cancelRun: () => Promise<void>;
  sendMessage: (msg: string) => Promise<void>;
  respondInput: (
    decision: 'provide' | 'approve' | 'reject',
    text?: string,
  ) => Promise<void>;
  retrySse: () => void;
}

const RunStoreContext = createContext<RunStoreValue | null>(null);

export function RunStoreProvider({
  runId,
  children,
}: {
  runId: string;
  children: React.ReactNode;
}) {
  const [run, setRun] = useState<Run | null>(null);
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [session, setSession] = useState<SessionReport | null>(null);
  const [activeInputRequest, setActiveInputRequest] =
    useState<InputRequest | null>(null);
  const [messages, setMessages] = useState<RunMessage[]>([]);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [sseStatus, setSseStatus] =
    useState<SseConnectionStatus>('disconnected');
  const [reconnectAttempt, setReconnectAttempt] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [sseClient, setSseClient] = useState<SseClient | null>(null);

  // Identity and in-flight tracking refs for input responses
  const runIdRef = useRef(runId);
  runIdRef.current = runId;

  const activeInputRequestRef = useRef(activeInputRequest);
  activeInputRequestRef.current = activeInputRequest;

  const respondingInputRef = useRef<string | boolean | null>(false);

  // 1. Fetch initial REST snapshot
  const loadSnapshot = useCallback(async () => {
    if (!runId) return;
    setLoading(true);
    setError(null);
    try {
      const [
        runData,
        caseItems,
        taskItems,
        findItems,
        repData,
        msgs,
        inputs,
        history,
      ] = await Promise.all([
        defaultApiClient.getRun(runId),
        // Mo-style sessions attach several tasks to one case (sign-in,
        // retries, reproduction), so these collections must be read to the
        // end before counting, grouping or labelling attempt numbers.
        readAllPages((query) =>
          defaultApiClient.listRunCases(runId, query),
        ).catch(() => [] as CaseRecord[]),
        readAllPages((query) =>
          defaultApiClient.listRunTasks(runId, query),
        ).catch(() => [] as Task[]),
        readAllPages((query) =>
          defaultApiClient.listRunFindings(runId, query),
        ).catch(() => [] as Finding[]),
        defaultApiClient.getReport(runId).catch(() => null),
        fetchRunMessages('/api/v1', runId),
        // A failed read must not blank the whole session; pending questions
        // still arrive over the event stream.
        defaultApiClient.listRunInputs(runId).catch(() => null),
        defaultApiClient
          .listEventHistory(runId, { limit: 100 })
          .catch(() => null),
      ]);

      if (runIdRef.current !== runId) return;
      setRun(runData);
      setCases(caseItems);
      setTasks(taskItems);
      setFindings(findItems);
      setReport(repData);
      setSession(repData?.session ?? null);
      setMessages(msgs);
      // A live SSE update may arrive before this slower initial REST read.
      // Never replace the newer observed timeline with stale first-page data.
      if (history)
        setEvents((prev) => mergeRunEventHistory(runId, prev, history.items));

      for (const m of msgs) {
        recordMessageRendered(m.redactedText, m.createdAt);
      }

      if (inputs) setActiveInputRequest(inputs.items[0] ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载运行状态失败');
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    loadSnapshot();
  }, [loadSnapshot]);

  // Periodic polling for messages while run is active
  useEffect(() => {
    if (!runId) return;
    const interval = setInterval(() => {
      fetchRunMessages('/api/v1', runId)
        .then((newMsgs) => {
          if (newMsgs.length > 0) {
            setMessages((prev) => {
              const isDifferent =
                newMsgs.length !== prev.length ||
                newMsgs.some((m, idx) => m.id !== prev[idx]?.id);
              if (isDifferent) {
                for (const m of newMsgs) {
                  recordMessageRendered(m.redactedText, m.createdAt);
                }
                return newMsgs;
              }
              return prev;
            });
          }
        })
        .catch(() => {});
    }, 300);
    return () => clearInterval(interval);
  }, [runId]);

  // 2. Event projection handler
  const handleEvent = useCallback(
    (event: RunEvent) => {
      if (event.runId !== runId) return;
      setEvents((prev) => mergeRunEventHistory(runId, prev, [event]));
      switch (event.type) {
        case 'run.updated': {
          const payload = event.payload as unknown as Partial<Run>;
          setRun((prev) => (prev ? { ...prev, ...payload } : (payload as Run)));
          fetchRunMessages('/api/v1', runId)
            .then((newMsgs) => {
              setMessages(newMsgs);
              for (const m of newMsgs) {
                recordMessageRendered(m.redactedText, m.createdAt);
              }
            })
            .catch(() => {});
          break;
        }
        case 'phase.changed': {
          const { phase } = event.payload as unknown as { phase: Run['phase'] };
          setRun((prev) => (prev ? { ...prev, phase } : null));
          break;
        }
        case 'budget.updated': {
          const payload = event.payload as unknown as
            { used?: BudgetUsed } | BudgetUsed;
          const budgetUsed =
            payload && 'used' in payload && payload.used
              ? payload.used
              : (payload as BudgetUsed);
          setRun((prev) => (prev ? { ...prev, budgetUsed } : null));
          break;
        }
        case 'case.created': {
          const payload = event.payload as unknown as
            CaseRecord | CaseRecord['definition'];
          const caseRecord: CaseRecord =
            'definition' in payload
              ? payload
              : { definition: payload, outcome: 'not_run', verdict: null };
          setCases((prev) => {
            if (prev.some((c) => c.definition.id === caseRecord.definition.id))
              return prev;
            return [...prev, caseRecord];
          });
          break;
        }
        case 'case.result': {
          const updatedCase = event.payload as unknown as CaseRecord;
          setCases((prev) =>
            prev.map((c) =>
              c.definition.id === updatedCase.definition.id ? updatedCase : c,
            ),
          );
          break;
        }
        case 'finding.updated': {
          const updatedFinding = event.payload as unknown as Finding;
          setFindings((prev) => {
            const idx = prev.findIndex((f) => f.id === updatedFinding.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = updatedFinding;
              return next;
            }
            return [...prev, updatedFinding];
          });
          break;
        }
        case 'task.updated': {
          const updatedTask = event.payload as unknown as Task;
          setTasks((prev) => {
            const idx = prev.findIndex((t) => t.id === updatedTask.id);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = updatedTask;
              return next;
            }
            return [...prev, updatedTask];
          });
          break;
        }
        case 'input.requested': {
          const request = event.payload as unknown as InputRequest;
          setActiveInputRequest(request);
          // A private OTP challenge deliberately keeps the same leased Worker
          // and browser session active. It is NOT the ordinary job-requeue
          // clarification flow and must not project a false awaiting_input run.
          if (request.kind !== 'one_time_code')
            setRun((prev) =>
              prev ? { ...prev, status: 'awaiting_input' } : null,
            );
          break;
        }
        case 'input.resolved': {
          setActiveInputRequest(null);
          setRun((prev) => (prev ? { ...prev, status: 'running' } : null));
          break;
        }
        case 'session.updated': {
          setSession(event.payload as unknown as SessionReport);
          break;
        }
        case 'report.ready': {
          defaultApiClient
            .getReport(runId)
            .then((report) => {
              if (runIdRef.current !== runId) return;
              setReport(report);
              setSession(report.session ?? null);
            })
            .catch(() => {});
          break;
        }
        case 'run.finished': {
          setRun(event.payload as unknown as Run);
          break;
        }
      }
    },
    [runId],
  );

  // 3. Connect SSE Client
  useEffect(() => {
    if (!runId) return;

    const client = new SseClient({
      runId,
      onEvent: handleEvent,
      onStatusChange: (status, attempt) => {
        setSseStatus(status);
        setReconnectAttempt(attempt);
      },
    });

    setSseClient(client);
    if (typeof window !== 'undefined') {
      (
        window as unknown as { __activeSseClient?: SseClient }
      ).__activeSseClient = client;
    }
    client.connect();

    return () => {
      client.disconnect();
      if (typeof window !== 'undefined') {
        delete (window as unknown as { __activeSseClient?: SseClient })
          .__activeSseClient;
      }
    };
  }, [runId, handleEvent]);

  const cancelRun = async () => {
    const updated = await defaultApiClient.cancelRun(runId);
    setRun((prev) => (prev ? { ...prev, ...updated } : updated));
  };

  const sendMessage = async (msg: string) => {
    const updatedRun = await defaultApiClient.sendRunMessage(
      runId,
      msg,
      run?.contextVersion ?? 1,
    );
    const newMsgs = await fetchRunMessages('/api/v1', runId);
    setMessages(newMsgs);
    for (const m of newMsgs) {
      recordMessageRendered(m.redactedText, m.createdAt);
    }
    setRun((prev) => (prev ? { ...prev, ...updatedRun } : updatedRun));
  };

  const respondInput = async (
    decision: 'provide' | 'approve' | 'reject',
    text?: string,
  ) => {
    // 1. Capture target request and run identity from current refs
    const targetRequest = activeInputRequestRef.current;
    const targetRunId = runIdRef.current;
    if (!targetRequest || !targetRunId) return;

    const capturedRequestId = targetRequest.id;
    const capturedVersion = targetRequest.version;
    const lockToken = `${targetRunId}:${capturedRequestId}:${capturedVersion}`;

    // 2. Synchronous in-flight lock held per run/request/version scope
    if (respondingInputRef.current === lockToken) return;

    // 3. Reject payload must strictly omit text key
    const payload: InputResponse = {
      expectedVersion: capturedVersion,
      decision,
    };
    if (targetRequest.kind === 'one_time_code') {
      if (decision === 'provide' && text) payload.oneTimeCode = text;
    } else if (targetRequest.kind === 'auth_profile') {
      if (decision === 'provide' && text) payload.authProfileId = text;
    } else if (decision !== 'reject' && text !== undefined && text !== '')
      payload.text = text;

    respondingInputRef.current = lockToken;
    try {
      const result: InputRequest = await defaultApiClient.respondToInput(
        targetRunId,
        capturedRequestId,
        payload,
      );

      // 4. Strict check on returned InputRequest object
      const expectedStatus = decision === 'reject' ? 'rejected' : 'resolved';
      if (!result) {
        throw new Error('INVALID_INPUT_RESPONSE');
      }
      if (result.id !== capturedRequestId || result.runId !== targetRunId) {
        throw new Error('INVALID_INPUT_RESPONSE_IDENTITY');
      }
      if (result.version !== capturedVersion + 1) {
        throw new Error('INVALID_INPUT_RESPONSE_VERSION');
      }
      if (result.status !== expectedStatus) {
        throw new Error('INVALID_INPUT_RESPONSE_STATUS');
      }

      // 5. Late response guard: only clear activeInputRequest if still on the same run and request version
      if (
        runIdRef.current === targetRunId &&
        activeInputRequestRef.current?.id === capturedRequestId &&
        activeInputRequestRef.current?.version === capturedVersion
      ) {
        setActiveInputRequest(null);
        await loadSnapshot();
      }
      // Note: Do NOT arbitrarily set run.status to 'running'; run status is managed strictly by server SSE / read polling.
    } finally {
      // 6. Only release if the lock still belongs to this scope
      if (respondingInputRef.current === lockToken) {
        respondingInputRef.current = false;
      }
    }
  };

  const retrySse = () => {
    sseClient?.retry();
  };

  return (
    <RunStoreContext.Provider
      value={{
        run,
        cases,
        tasks,
        findings,
        report,
        session,
        activeInputRequest,
        messages,
        events,
        sseStatus,
        reconnectAttempt,
        loading,
        error,
        reload: loadSnapshot,
        cancelRun,
        sendMessage,
        respondInput,
        retrySse,
      }}
    >
      {children}
    </RunStoreContext.Provider>
  );
}

export function useRunStore(): RunStoreValue {
  const ctx = useContext(RunStoreContext);
  if (!ctx)
    throw new Error('useRunStore must be used within a RunStoreProvider');
  return ctx;
}
