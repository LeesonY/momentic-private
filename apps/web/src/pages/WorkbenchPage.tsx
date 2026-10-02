import React, { useState, useEffect } from 'react';
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
  const [selectedRunId, setSelectedRunId] = useState<string>(routeParams.runId || '');

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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }} data-testid="workbench-page">
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
    sseStatus,
    reconnectAttempt,
    cancelRun,
    sendMessage,
    respondInput,
    retrySse
  } = useRunStore();

  const [inputMsg, setInputMsg] = useState('');
  const [sendingMsg, setSendingMsg] = useState(false);

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
  const isPartial = run.completion === 'partial' || run.terminationReason === 'budget_limit';

  return (
    <div className="workbench-layout" data-testid="workbench-container">
      {/* 1. LEFT PANEL: RUN HISTORY & FILTERS */}
      <RunHistoryList runs={runs} activeRunId={activeRunId} onSelectRun={onSelectRun} />

      {/* 2. MIDDLE PANEL: REAL-TIME STAGE PROGRESS & WORKBENCH */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          overflowY: 'auto',
          paddingRight: '4px'
        }}
        data-testid="workbench-center-panel"
      >
        {/* SSE Reconnecting Banner if network disrupted */}
        <ReconnectBanner status={sseStatus} attempt={reconnectAttempt} onRetry={retrySse} />

        {/* Partial Report Notice Banner */}
        {isPartial && (
          <ErrorCard
            type="partial_report"
            message={`本次运行因触发预算阈值 (${run.terminationReason}) 提前完成收尾。未全部执行的用例与未探索的控件已列入覆盖缺口，不影响已有通过结论。`}
          />
        )}

        {/* Run Top Header */}
        <div className="card" style={{ marginBottom: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <h2 style={{ fontSize: '1.15rem', fontWeight: 700 }}>
                运行: <code>{run.id}</code>
              </h2>
              <StatusBadge status={isPartial ? 'partial' : run.status} />
              <span className="badge badge-neutral">上下文版本: v{run.contextVersion}</span>
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

          <div style={{ fontSize: '0.875rem', color: 'var(--color-text-main)', marginBottom: '8px' }}>
            目标站点: <a href={run.targetUrl} target="_blank" rel="noreferrer"><strong>{run.targetUrl}</strong></a>
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
              marginTop: '8px'
            }}
            data-testid="budget-metrics-bar"
          >
            <div>
              时间消耗: <strong>{run.budgetUsed.activeSeconds}s</strong> / {run.effectiveConfig?.budget.maxActiveSeconds || 600}s
            </div>
            <div>
              动作步数: <strong>{run.budgetUsed.actions}</strong> / {run.effectiveConfig?.budget.maxActions || 120}
            </div>
            <div>
              模型调用: <strong>{run.budgetUsed.modelCalls}</strong> / {run.effectiveConfig?.budget.maxModelCalls || 100}
            </div>
            <div>
              Token 消耗: <strong>{run.budgetUsed.totalTokens.toLocaleString()}</strong> / {(run.effectiveConfig?.budget.maxTotalTokens || 300000).toLocaleString()}
            </div>
            <div>
              复现次数: <strong>{run.budgetUsed.reproductions}</strong> / {run.effectiveConfig?.budget.maxReproductions || 3}
            </div>
          </div>
        </div>

        {/* Lifecycle Phase Progress */}
        <PhaseProgress currentPhase={run.phase} status={run.status} />

        {/* Input Request Bar (when awaiting_input) */}
        {activeInputRequest && (
          <InputRequestBar request={activeInputRequest} onRespond={respondInput} />
        )}

        {/* User Scope Supplement Message Box */}
        {!isCompleted && (
          <form
            onSubmit={handleSendMessage}
            className="card"
            style={{ marginBottom: '16px', display: 'flex', gap: '10px', alignItems: 'center' }}
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
              className="btn btn-secondary btn-sm"
              disabled={sendingMsg}
              data-testid="btn-send-message"
            >
              {sendingMsg ? '发送中...' : '补充说明'}
            </button>
          </form>
        )}

        {/* Live Timeline & Execution Stream */}
        <div className="card" style={{ flex: 1, overflowY: 'auto' }} data-testid="timeline-card">
          <div className="card-header">
            <h3 className="card-title">实时执行动态 (Timeline Events)</h3>
            <span style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)' }}>
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
                  backgroundColor: 'var(--color-bg-surface)'
                }}
              >
                <div style={{ fontSize: '0.75rem', color: 'var(--color-text-muted)', minWidth: '70px' }}>
                  耗时: {task.elapsedSeconds}s
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>[{task.role.toUpperCase()}]</span>
                    <StatusBadge status={task.status} size="sm" />
                  </div>
                  <div style={{ fontSize: '0.825rem', color: 'var(--color-text-main)', marginTop: '2px' }}>
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
      />
    </div>
  );
};
