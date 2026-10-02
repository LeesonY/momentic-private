import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type {
  Run,
  CaseRecord,
  Task,
  Finding,
  Report,
  InputRequest,
  RunEvent,
  BudgetUsed
} from '@localqa/contracts';
import { defaultApiClient, SseClient, type SseConnectionStatus } from '../api/index.ts';

interface RunState {
  run: Run | null;
  cases: CaseRecord[];
  tasks: Task[];
  findings: Finding[];
  report: Report | null;
  activeInputRequest: InputRequest | null;
  sseStatus: SseConnectionStatus;
  reconnectAttempt: number;
  loading: boolean;
  error: string | null;
}

interface RunStoreValue extends RunState {
  reload: () => Promise<void>;
  cancelRun: () => Promise<void>;
  sendMessage: (msg: string) => Promise<void>;
  respondInput: (decision: 'provide' | 'approve' | 'reject', text?: string) => Promise<void>;
  retrySse: () => void;
}

const RunStoreContext = createContext<RunStoreValue | null>(null);

export function RunStoreProvider({
  runId,
  children
}: {
  runId: string;
  children: React.ReactNode;
}) {
  const [run, setRun] = useState<Run | null>(null);
  const [cases, setCases] = useState<CaseRecord[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [activeInputRequest, setActiveInputRequest] = useState<InputRequest | null>(null);
  const [sseStatus, setSseStatus] = useState<SseConnectionStatus>('disconnected');
  const [reconnectAttempt, setReconnectAttempt] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [sseClient, setSseClient] = useState<SseClient | null>(null);

  // 1. Fetch initial REST snapshot
  const loadSnapshot = useCallback(async () => {
    if (!runId) return;
    setLoading(true);
    setError(null);
    try {
      const [runData, caseRes, taskRes, findRes, repData] = await Promise.all([
        defaultApiClient.getRun(runId),
        defaultApiClient.listRunCases(runId).catch(() => ({ items: [] })),
        defaultApiClient.listRunTasks(runId).catch(() => ({ items: [] })),
        defaultApiClient.listRunFindings(runId).catch(() => ({ items: [] })),
        defaultApiClient.getReport(runId).catch(() => null)
      ]);

      setRun(runData);
      setCases(caseRes.items);
      setTasks(taskRes.items);
      setFindings(findRes.items);
      setReport(repData);

      if (runData.status === 'awaiting_input') {
        setActiveInputRequest({
          id: 'inp_req_01',
          runId,
          kind: 'auth_profile',
          prompt: '需要补充认证凭据或短信验证码以继续测试受限区域。',
          expiresAt: new Date(Date.now() + 300000).toISOString(),
          status: 'pending',
          version: 1
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载运行状态失败');
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    loadSnapshot();
  }, [loadSnapshot]);

  // 2. Event projection handler
  const handleEvent = useCallback((event: RunEvent) => {
    switch (event.type) {
      case 'run.updated': {
        const payload = event.payload as unknown as Partial<Run>;
        setRun((prev) => (prev ? { ...prev, ...payload } : (payload as Run)));
        break;
      }
      case 'phase.changed': {
        const { phase } = event.payload as unknown as { phase: Run['phase'] };
        setRun((prev) => (prev ? { ...prev, phase } : null));
        break;
      }
      case 'budget.updated': {
        const budgetUsed = event.payload as unknown as BudgetUsed;
        setRun((prev) => (prev ? { ...prev, budgetUsed } : null));
        break;
      }
      case 'case.created': {
        const newCase = event.payload as unknown as CaseRecord;
        setCases((prev) => {
          if (prev.some((c) => c.definition.id === newCase.definition.id)) return prev;
          return [...prev, newCase];
        });
        break;
      }
      case 'case.result': {
        const updatedCase = event.payload as unknown as CaseRecord;
        setCases((prev) => prev.map((c) => (c.definition.id === updatedCase.definition.id ? updatedCase : c)));
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
        setActiveInputRequest(event.payload as unknown as InputRequest);
        setRun((prev) => (prev ? { ...prev, status: 'awaiting_input' } : null));
        break;
      }
      case 'input.resolved': {
        setActiveInputRequest(null);
        setRun((prev) => (prev ? { ...prev, status: 'running' } : null));
        break;
      }
      case 'report.ready': {
        setReport(event.payload as unknown as Report);
        break;
      }
      case 'run.finished': {
        setRun((prev) => (prev ? { ...prev, status: 'completed', updatedAt: new Date().toISOString() } : null));
        break;
      }
    }
  }, []);

  // 3. Connect SSE Client
  useEffect(() => {
    if (!runId) return;

    const client = new SseClient({
      runId,
      onEvent: handleEvent,
      onStatusChange: (status, attempt) => {
        setSseStatus(status);
        setReconnectAttempt(attempt);
      }
    });

    setSseClient(client);
    client.connect();

    return () => {
      client.disconnect();
    };
  }, [runId, handleEvent]);

  const cancelRun = async () => {
    await defaultApiClient.cancelRun(runId);
    setRun((prev) => (prev ? { ...prev, status: 'cancelling' } : null));
  };

  const sendMessage = async (msg: string) => {
    await defaultApiClient.sendRunMessage(runId, msg);
    setRun((prev) => (prev ? { ...prev, contextVersion: prev.contextVersion + 1 } : null));
  };

  const respondInput = async (decision: 'provide' | 'approve' | 'reject', text?: string) => {
    if (!activeInputRequest) return;
    await defaultApiClient.respondToInput(runId, activeInputRequest.id, {
      expectedVersion: activeInputRequest.version,
      decision,
      text
    });
    setActiveInputRequest(null);
    setRun((prev) => (prev ? { ...prev, status: 'running' } : null));
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
        activeInputRequest,
        sseStatus,
        reconnectAttempt,
        loading,
        error,
        reload: loadSnapshot,
        cancelRun,
        sendMessage,
        respondInput,
        retrySse
      }}
    >
      {children}
    </RunStoreContext.Provider>
  );
}

export function useRunStore(): RunStoreValue {
  const ctx = useContext(RunStoreContext);
  if (!ctx) throw new Error('useRunStore must be used within a RunStoreProvider');
  return ctx;
}
