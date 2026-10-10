import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import type { Run } from '@localqa/contracts';
import { RunStoreProvider, useRunStore } from '../state/RunStore.tsx';
import { AppHeader } from '../components/layout/AppHeader.tsx';
import { ReconnectBanner } from '../components/layout/ReconnectBanner.tsx';
import { PhaseProgress } from '../components/workbench/PhaseProgress.tsx';
import { InputRequestBar } from '../components/workbench/InputRequestBar.tsx';
import { RunHistoryList } from '../components/workbench/RunHistoryList.tsx';
import { TaskCaseTabs } from '../components/workbench/TaskCaseTabs.tsx';
import { StatusBadge } from '../components/ui/Badge.tsx';
import { ErrorCard } from '../components/ui/ErrorCard.tsx';

export const WorkbenchPage: React.FC = () => {
  const { currentProject, routeParams, setRoute } = useApp();
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>(
    routeParams.runId || '',
  );

  // Load runs list
  useEffect(() => {
    if (!currentProject) return;
    const projId = currentProject.id;
    async function load() {
      try {
        const res = await defaultApiClient.listRuns(projId);
        setRuns(res.items);
        if (!selectedRunId && res.items.length > 0) {
          setSelectedRunId(res.items[0].id);
          setRoute('workbench', { runId: res.items[0].id });
        }
      } catch (err) {
        console.warn('Failed to load runs:', err);
      }
    }
    load();
  }, [currentProject]);

  // When routeParams change, sync selectedRunId
  useEffect(() => {
    if (routeParams.runId && routeParams.runId !== selectedRunId) {
      setSelectedRunId(routeParams.runId);
    }
  }, [routeParams.runId]);

  const handleSelectRun = (id: string) => {
    setSelectedRunId(id);
    setRoute('workbench', { runId: id });
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        overflow: 'hidden',
      }}
      data-testid="workbench-page"
    >
      <AppHeader />
      <div style={{ flex: 1, padding: '16px 20px', overflow: 'hidden' }}>
        {selectedRunId ? (
          <RunStoreProvider runId={selectedRunId} key={selectedRunId}>
            <WorkbenchContent
              runs={runs}
              activeRunId={selectedRunId}
              onSelectRun={handleSelectRun}
            />
          </RunStoreProvider>
        ) : (
          <div style={{ padding: '40px', textAlign: 'center' }}>
            <h3>正在加载工作台运行数据...</h3>
          </div>
        )}
      </div>
    </div>
  );
};

const WorkbenchContent: React.FC<{
  runs: Run[];
  activeRunId: string;
  onSelectRun: (id: string) => void;
}> = ({ runs, activeRunId, onSelectRun }) => {
  const {
    run,
    cases,
    tasks,
    findings,
    report,
    activeInputRequest,
    messages,
    sseStatus,
    reconnectAttempt,
    cancelRun,
    sendMessage,
    respondInput,
    retrySse,
    reload,
  } = useRunStore();

  const [inputMsg, setInputMsg] = useState('');
  const [sendingMsg, setSendingMsg] = useState(false);
  const [, setInputResponding] = useState(false);
  const inputRespondingRef = useRef(false);
  const activeInputScopeRef = useRef<{
    runId: string;
    requestId: string;
    epoch: number;
  } | null>(null);
  const scopeEpochRef = useRef(0);

  useEffect(() => {
    scopeEpochRef.current += 1;
    if (activeInputRequest && run) {
      activeInputScopeRef.current = {
        runId: run.id,
        requestId: activeInputRequest.id,
        epoch: scopeEpochRef.current,
      };
    } else {
      activeInputScopeRef.current = null;
    }
    inputRespondingRef.current = false;
    setInputResponding(false);
  }, [run?.id, activeInputRequest?.id]);

  const handleRespondInput = useCallback(
    async (decision: 'provide' | 'approve' | 'reject', text?: string) => {
      if (!activeInputRequest || !run) return;
      if (inputRespondingRef.current) return; // Prevent duplicate/concurrent submissions

      const capturedEpoch = scopeEpochRef.current;
      const capturedRunId = run.id;
      const capturedRequestId = activeInputRequest.id;
      const isAuthKind =
        activeInputRequest.kind === 'auth_profile' ||
        activeInputRequest.kind === 'one_time_code';

      // A code may only be sent via the dedicated InputResponse.oneTimeCode.
      if (isAuthKind && activeInputRequest.kind !== 'one_time_code') {
        if (decision !== 'reject') {
          throw new Error('认证服务当前尚未接线，仅允许拒绝操作');
        }
        text = undefined;
      }
      if (
        activeInputRequest.kind === 'one_time_code' &&
        (decision === 'approve' ||
          (decision === 'provide' &&
            (typeof text !== 'string' || !/^[A-Za-z0-9]{4,32}$/.test(text))))
      )
        throw new Error('INVALID_OTP_INPUT');
      if (decision === 'reject') {
        text = undefined;
      }

      inputRespondingRef.current = true;
      setInputResponding(true);
      try {
        await respondInput(decision, text);
      } finally {
        if (
          scopeEpochRef.current === capturedEpoch &&
          activeInputScopeRef.current?.runId === capturedRunId &&
          activeInputScopeRef.current?.requestId === capturedRequestId
        ) {
          inputRespondingRef.current = false;
          setInputResponding(false);
        }
      }
    },
    [activeInputRequest, run, respondInput],
  );

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputMsg.trim()) return;
    setSendingMsg(true);
    try {
      await sendMessage(inputMsg);
      setInputMsg('');
    } finally {
      setSendingMsg(false);
    }
  };

  if (!run) {
    return <div style={{ padding: '20px' }}>加载运行中...</div>;
  }

  const isCompleted = ['completed', 'cancelled', 'failed'].includes(run.status);
  const isPartial =
    run.completion === 'partial' || run.terminationReason === 'budget_limit';

  return (
    <div className="workbench-layout" data-testid="workbench-container">
      {/* 1. LEFT PANEL: RUN HISTORY & FILTERS */}
      <RunHistoryList
        runs={runs}
        activeRunId={activeRunId}
        onSelectRun={onSelectRun}
      />

      {/* 2. MIDDLE PANEL: REAL-TIME STAGE PROGRESS & WORKBENCH */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          overflowY: 'auto',
          paddingRight: '4px',
        }}
        data-testid="workbench-center-panel"
      >
        {/* SSE Reconnecting Banner if network disrupted */}
        <ReconnectBanner
          status={sseStatus}
          attempt={reconnectAttempt}
          onRetry={retrySse}
        />

        {/* Partial Report Notice Banner */}
        {isPartial && (
          <ErrorCard
            type="partial_report"
            message={`本次运行因触发预算阈值 (${run.terminationReason}) 提前完成收尾。未全部执行的用例与未探索的控件已列入覆盖缺口，不影响已有通过结论。`}
          />
        )}

        {/* Queued Run Notice Banner */}
        {run.status === 'queued' && (
          <div
            className="card"
            style={{
              marginBottom: '16px',
              padding: '12px 16px',
              backgroundColor: 'var(--color-bg-subtle)',
              borderLeft: '4px solid var(--color-info)',
            }}
            data-testid="queued-run-notice"
          >
            <div
              style={{
                fontWeight: 600,
                fontSize: '0.85rem',
                color: 'var(--color-text-main)',
              }}
            >
              🕒 运行排队中 (Queued)
            </div>
            <div
              style={{
                fontSize: '0.8rem',
                color: 'var(--color-text-muted)',
                marginTop: '2px',
              }}
            >
              该运行处于任务排队队列中，等待 Worker
              节点领取，尚未执行回放。通过结论及用例判定将在 Worker 真实执行后由
              verdict 字段判定。
            </div>
          </div>
        )}

        {/* Run Top Header */}
        <div className="card" style={{ marginBottom: '16px' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '8px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <h2 style={{ fontSize: '1.15rem', fontWeight: 700 }}>
                运行: <code>{run.id}</code>
              </h2>
              <StatusBadge status={isPartial ? 'partial' : run.status} />
              {run.executionMode === 'regression' ? (
                <span
                  className="badge badge-primary"
                  data-testid="badge-execution-mode"
                >
                  回归模式 (Regression)
                </span>
              ) : (
                <span
                  className="badge badge-info"
                  data-testid="badge-execution-mode"
                >
                  冒烟模式 (Smoke)
                </span>
              )}
              <span className="badge badge-neutral">
                上下文版本: v{run.contextVersion}
              </span>
            </div>

            {!isCompleted && (
              <button
                className="btn btn-danger btn-sm"
                onClick={cancelRun}
                data-testid="btn-cancel-run"
              >
                停止运行 (Cancel)
              </button>
            )}
          </div>

          {/* Regression Mode Banner */}
          {run.executionMode === 'regression' && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 12px',
                backgroundColor: 'var(--color-primary-subtle)',
                borderRadius: 'var(--radius-sm)',
                fontSize: '0.8rem',
                color: 'var(--color-text-main)',
                marginBottom: '8px',
              }}
              data-testid="workbench-regression-banner"
            >
              <div>
                <strong>
                  {run.status === 'queued'
                    ? '自动化回归排队等待中 (Worker 待调度):'
                    : run.status === 'running'
                      ? '自动化回归回放执行中:'
                      : run.status === 'completed'
                        ? '自动化回归已完成:'
                        : run.status === 'failed'
                          ? '自动化回归执行失败:'
                          : run.status === 'cancelled'
                            ? '自动化回归已取消:'
                            : '自动化回归运行:'}{' '}
                </strong>
                关联用例均受已审查批准的冻结基线版本与用例库来源约束
              </div>
              <span
                className="badge badge-primary"
                style={{ fontSize: '0.7rem' }}
              >
                {cases.length} 个回归用例
              </span>
            </div>
          )}

          <div
            style={{
              fontSize: '0.875rem',
              color: 'var(--color-text-main)',
              marginBottom: '8px',
            }}
          >
            目标站点:{' '}
            <a href={run.targetUrl} target="_blank" rel="noreferrer">
              <strong>{run.targetUrl}</strong>
            </a>
          </div>

          {/* Budget Consumption Bar */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: '10px',
              backgroundColor: 'var(--color-bg-subtle)',
              padding: '10px 14px',
              borderRadius: 'var(--radius-md)',
              fontSize: '0.8rem',
              marginTop: '8px',
            }}
            data-testid="budget-metrics-bar"
          >
            <div>
              时间消耗: <strong>{run.budgetUsed.activeSeconds}s</strong> /{' '}
              {run.effectiveConfig?.budget.maxActiveSeconds || 600}s
            </div>
            <div>
              动作步数: <strong>{run.budgetUsed.actions}</strong> /{' '}
              {run.effectiveConfig?.budget.maxActions || 120}
            </div>
            <div>
              模型调用: <strong>{run.budgetUsed.modelCalls}</strong> /{' '}
              {run.effectiveConfig?.budget.maxModelCalls || 100}
            </div>
            <div>
              Token 消耗:{' '}
              <strong>{run.budgetUsed.totalTokens.toLocaleString()}</strong> /{' '}
              {(
                run.effectiveConfig?.budget.maxTotalTokens || 300000
              ).toLocaleString()}
            </div>
            <div>
              复现次数: <strong>{run.budgetUsed.reproductions}</strong> /{' '}
              {run.effectiveConfig?.budget.maxReproductions || 3}
            </div>
          </div>
        </div>

        {/* Lifecycle Phase Progress */}
        <PhaseProgress
          currentPhase={run.phase}
          status={run.status}
          executionMode={run.executionMode}
        />

        {/* Input Request Bar (when awaiting_input) */}
        {activeInputRequest && (
          <InputRequestBar
            request={activeInputRequest}
            onRespond={handleRespondInput}
          />
        )}

        {/* User Scope Supplement Message Box & Messages List */}
        <div
          className="card"
          style={{ marginBottom: '16px' }}
          data-testid="run-messages-card"
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '10px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h3 style={{ fontSize: '0.95rem', fontWeight: 600 }}>
                补充说明与交互消息 (Run Messages)
              </h3>
              <span
                className="badge badge-neutral"
                data-testid="run-messages-count"
              >
                {messages.length}
              </span>
            </div>
            <span
              style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}
            >
              按时钟打点记录业务预期、排除路径与运行消息
            </span>
          </div>

          {messages.length === 0 ? (
            <div
              style={{
                padding: '12px 14px',
                textAlign: 'center',
                color: 'var(--color-text-muted)',
                fontSize: '0.85rem',
                backgroundColor: 'var(--color-bg-subtle)',
                borderRadius: 'var(--radius-sm)',
                marginBottom: isCompleted ? 0 : '10px',
              }}
              data-testid="no-messages-notice"
            >
              暂无运行补充消息。如需提供业务预期或排除路径，请在下方发送。
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                maxHeight: '220px',
                overflowY: 'auto',
                marginBottom: isCompleted ? 0 : '10px',
              }}
              data-testid="run-messages-list"
            >
              {messages.map((m) => (
                <div
                  key={m.id}
                  style={{
                    padding: '8px 12px',
                    backgroundColor: 'var(--color-bg-subtle)',
                    border: '1px solid var(--color-border-subtle)',
                    borderRadius: 'var(--radius-md)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '4px',
                  }}
                  data-testid="run-message-item"
                  data-message-id={m.id}
                  data-redacted-text={m.redactedText}
                  data-context-version={m.contextVersion}
                  data-created-at={m.createdAt}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      fontSize: '0.75rem',
                      color: 'var(--color-text-muted)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                      }}
                    >
                      <span
                        className="badge badge-info"
                        style={{ fontSize: '0.7rem' }}
                      >
                        v{m.contextVersion}
                      </span>
                      <span>操作员</span>
                    </div>
                    <span>{new Date(m.createdAt).toLocaleTimeString()}</span>
                  </div>
                  <div
                    style={{
                      fontSize: '0.875rem',
                      color: 'var(--color-text-main)',
                      fontWeight: 500,
                      wordBreak: 'break-word',
                    }}
                    data-testid="run-message-text"
                  >
                    {m.redactedText}
                  </div>
                </div>
              ))}
            </div>
          )}

          {!isCompleted && (
            <form
              onSubmit={handleSendMessage}
              style={{
                display: 'flex',
                gap: '10px',
                alignItems: 'center',
              }}
              data-testid="send-message-box"
            >
              <input
                type="text"
                className="form-input"
                style={{ flex: 1 }}
                placeholder="在此输入补充说明、业务预期或排除路径（将推进上下文版本）..."
                value={inputMsg}
                onChange={(e) => setInputMsg(e.target.value)}
                data-testid="input-run-message"
              />
              <button
                type="submit"
                className="btn btn-primary btn-sm"
                disabled={sendingMsg}
                data-testid="btn-send-message"
              >
                {sendingMsg ? '发送中...' : '发送补充说明'}
              </button>
            </form>
          )}
        </div>

        {/* Live Timeline & Execution Stream */}
        <div
          className="card"
          style={{ flex: 1, overflowY: 'auto' }}
          data-testid="timeline-card"
        >
          <div className="card-header">
            <h3 className="card-title">实时执行动态 (Timeline Events)</h3>
            <span
              style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}
            >
              已过滤模型隐藏推理，保证事实记录真实可见
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {tasks.map((task) => (
              <div
                key={task.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '12px',
                  padding: '10px',
                  borderLeft: '3px solid var(--color-primary)',
                  backgroundColor: 'var(--color-bg-surface)',
                }}
              >
                <div
                  style={{
                    fontSize: '0.75rem',
                    color: 'var(--color-text-muted)',
                    minWidth: '70px',
                  }}
                >
                  耗时: {task.elapsedSeconds}s
                </div>
                <div style={{ flex: 1 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>
                      [{task.role.toUpperCase()}]
                    </span>
                    <StatusBadge status={task.status} size="sm" />
                  </div>
                  <div
                    style={{
                      fontSize: '0.825rem',
                      color: 'var(--color-text-main)',
                      marginTop: '2px',
                    }}
                  >
                    {task.summary || '任务执行中...'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 3. RIGHT PANEL: TASKS / CASES / FINDINGS / REPORT TABS */}
      <TaskCaseTabs
        cases={cases}
        findings={findings}
        tasks={tasks}
        report={report}
        runId={activeRunId}
        run={run}
        onRefreshReport={() => void reload()}
      />
    </div>
  );
};
