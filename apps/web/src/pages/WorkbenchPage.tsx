import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { RunStoreProvider, useRunStore } from '../state/RunStore.tsx';
import { Page } from '../components/layout/Page.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { Alert } from '../components/ui/Alert.tsx';
import { AppIcon } from '../components/ui/AppIcon.tsx';
import { ReconnectBanner } from '../components/layout/ReconnectBanner.tsx';
import { PhaseProgress } from '../components/workbench/PhaseProgress.tsx';
import { InputRequestBar } from '../components/workbench/InputRequestBar.tsx';
import { TaskCaseTabs } from '../components/workbench/TaskCaseTabs.tsx';
import { StatusBadge } from '../components/ui/Badge.tsx';
import { ErrorCard } from '../components/ui/ErrorCard.tsx';

export const WorkbenchPage: React.FC = () => {
  const { currentProject, routeParams, setRoute } = useApp();
  const [selectedRunId, setSelectedRunId] = useState<string>(
    routeParams.runId || '',
  );
  const [runsLoaded, setRunsLoaded] = useState(false);

  // Load runs list
  useEffect(() => {
    if (!currentProject) return;
    const projId = currentProject.id;
    async function load() {
      try {
        const res = await defaultApiClient.listRuns(projId);
        if (!selectedRunId && res.items.length > 0) {
          setSelectedRunId(res.items[0].id);
          setRoute('workbench', { runId: res.items[0].id });
        }
      } catch (err) {
        console.warn('Failed to load runs:', err);
      } finally {
        setRunsLoaded(true);
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

  return (
    <Page width="full" testId="workbench-page">
      {selectedRunId ? (
        <RunStoreProvider runId={selectedRunId} key={selectedRunId}>
          <WorkbenchContent activeRunId={selectedRunId} />
        </RunStoreProvider>
      ) : runsLoaded ? (
        <EmptyState
          icon="activity"
          title="还没有运行记录"
          description="在项目首页填写目标地址并发起冒烟测试后，运行过程会实时显示在这里。"
          actionText="去发起测试"
          onAction={() => setRoute('home')}
        />
      ) : (
        <div className="lqa-session-loading is-inline">
          正在加载工作台运行数据...
        </div>
      )}
    </Page>
  );
};

const WorkbenchContent: React.FC<{ activeRunId: string }> = ({
  activeRunId,
}) => {
  const {
    run,
    cases,
    tasks,
    findings,
    report,
    session,
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
    return <div className="lqa-session-loading is-inline">加载运行中...</div>;
  }

  const isCompleted = ['completed', 'cancelled', 'failed'].includes(run.status);
  const isPartial =
    run.completion === 'partial' || run.terminationReason === 'budget_limit';
  const budget = run.effectiveConfig?.budget;
  const budgetItems: {
    label: string;
    used: number;
    limit: number;
    unit?: string;
  }[] = [
    {
      label: '执行时长',
      used: run.budgetUsed.activeSeconds,
      limit: budget?.maxActiveSeconds || 600,
      unit: 's',
    },
    {
      label: '动作步数',
      used: run.budgetUsed.actions,
      limit: budget?.maxActions || 120,
    },
    {
      label: '模型调用',
      used: run.budgetUsed.modelCalls,
      limit: budget?.maxModelCalls || 100,
    },
    {
      label: 'Token',
      used: run.budgetUsed.totalTokens,
      limit: budget?.maxTotalTokens || 300000,
    },
    {
      label: '复现次数',
      used: run.budgetUsed.reproductions,
      limit: budget?.maxReproductions || 3,
    },
  ];
  const regressionState: Record<string, string> = {
    queued: '回归排队中，等待 Worker 领取',
    running: '回归回放执行中',
    completed: '回归已完成',
    failed: '回归执行失败',
    cancelled: '回归已取消',
  };

  return (
    <div className="workbench-layout" data-testid="workbench-container">
      <div
        className="workbench-column workbench-center"
        data-testid="workbench-center-panel"
      >
        <ReconnectBanner
          status={sseStatus}
          attempt={reconnectAttempt}
          onRetry={retrySse}
        />

        {isPartial && (
          <ErrorCard
            type="partial_report"
            message={`本次运行因触发预算阈值（${run.terminationReason}）提前收尾。未执行的用例与未探索的控件已列入覆盖缺口，不影响已有的通过结论。`}
          />
        )}

        {run.status === 'queued' && (
          <Alert tone="info" title="运行排队中" testId="queued-run-notice">
            等待 Worker 节点领取，尚未开始执行。用例结论会在 Worker
            真实执行后给出。
          </Alert>
        )}
        {run.status === 'failed' && (
          <Alert tone="danger" title="运行未完成" testId="failed-run-notice">
            {tasks.some(
              (task) =>
                task.summary === 'auth' &&
                ['failed', 'interrupted'].includes(task.status),
            )
              ? '登录认证未完成，测试用例尚未开始执行。'
              : '运行提前终止，结果以实际执行记录为准。'}
            终止原因：
            {(
              {
                setup_failure: '初始化或认证失败',
                model_failure: '模型调用失败',
                worker_failure: '执行器中断',
                budget_limit: '达到预算限制',
              } as Record<string, string>
            )[run.terminationReason ?? ''] ??
              run.terminationReason ??
              '未知'}
            。
            {report?.warnings.map((warning, index) => (
              <p key={index}>{warning}</p>
            ))}
          </Alert>
        )}

        <section className="card lqa-run-header">
          <div className="lqa-run-title-row">
            <div className="lqa-run-title">
              <h2>
                运行 <code title={run.id}>{run.id}</code>
              </h2>
              <div className="row row-wrap">
                <StatusBadge status={isPartial ? 'partial' : run.status} />
                <span
                  className={`badge ${run.executionMode === 'regression' ? 'badge-primary' : 'badge-info'}`}
                  data-testid="badge-execution-mode"
                >
                  {run.executionMode === 'regression'
                    ? '回归模式'
                    : session
                      ? 'AI 探索测试'
                      : '冒烟模式'}
                </span>
                <span className="badge badge-neutral">
                  上下文 v{run.contextVersion}
                </span>
              </div>
            </div>
            {!isCompleted && (
              <button
                className="btn btn-danger-outline btn-sm"
                onClick={cancelRun}
                data-testid="btn-cancel-run"
              >
                <AppIcon name="stop" size={13} />
                停止运行
              </button>
            )}
          </div>

          <a
            className="lqa-run-target"
            href={run.targetUrl}
            target="_blank"
            rel="noreferrer"
          >
            <AppIcon name="globe" size={14} />
            <span className="truncate">{run.targetUrl}</span>
            <AppIcon name="external-link" size={13} />
          </a>

          {run.executionMode === 'regression' && (
            <div
              className="lqa-run-banner"
              data-testid="workbench-regression-banner"
            >
              <span>
                <strong>{regressionState[run.status] ?? '回归运行'}</strong>
                ：关联用例都受经审查批准的冻结基线版本约束。
              </span>
              <span className="badge badge-primary">
                {cases.length} 个回归用例
              </span>
            </div>
          )}

          <div
            className="stat-grid lqa-budget-grid"
            data-testid="budget-metrics-bar"
          >
            {budgetItems.map((item) => (
              <div className="stat" key={item.label}>
                <div className="stat-label">{item.label}</div>
                <div className="stat-value">
                  {item.used.toLocaleString()}
                  {item.unit}
                  <small>
                    {' '}
                    / {item.limit.toLocaleString()}
                    {item.unit}
                  </small>
                </div>
              </div>
            ))}
          </div>
        </section>

        <PhaseProgress
          currentPhase={run.phase}
          status={run.status}
          executionMode={run.executionMode}
          terminationPhase={
            ['failed', 'cancelled'].includes(run.status)
              ? tasks.find((task) =>
                  ['failed', 'interrupted', 'cancelled'].includes(task.status),
                )?.summary
              : undefined
          }
        />

        {activeInputRequest && (
          <InputRequestBar
            request={activeInputRequest}
            onRespond={handleRespondInput}
          />
        )}

        <section className="card" data-testid="run-messages-card">
          <div className="card-header">
            <div className="card-heading">
              <h3 className="card-title">
                <AppIcon name="send" size={16} />
                补充说明
                <span
                  className="badge badge-neutral badge-sm"
                  data-testid="run-messages-count"
                >
                  {messages.length}
                </span>
              </h3>
              <p className="card-description">
                运行过程中补充的业务预期与排除路径，每条消息都会推进上下文版本。
              </p>
            </div>
          </div>

          {messages.length === 0 ? (
            <div className="lqa-muted-box" data-testid="no-messages-notice">
              暂无补充消息。需要提供业务预期或排除路径时，请在下方发送。
            </div>
          ) : (
            <div className="lqa-message-list" data-testid="run-messages-list">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className="lqa-message"
                  data-testid="run-message-item"
                  data-message-id={m.id}
                  data-redacted-text={m.redactedText}
                  data-context-version={m.contextVersion}
                  data-created-at={m.createdAt}
                >
                  <div className="lqa-message-meta">
                    <span className="badge badge-info badge-sm">
                      v{m.contextVersion}
                    </span>
                    <span>操作员</span>
                    <span className="push">
                      {new Date(m.createdAt).toLocaleTimeString()}
                    </span>
                  </div>
                  <div
                    className="lqa-message-text"
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
              className="lqa-message-form"
              data-testid="send-message-box"
            >
              <input
                type="text"
                className="form-input"
                placeholder="输入补充说明、业务预期或排除路径…"
                value={inputMsg}
                onChange={(e) => setInputMsg(e.target.value)}
                data-testid="input-run-message"
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={sendingMsg}
                data-testid="btn-send-message"
              >
                <AppIcon name="send" size={14} />
                {sendingMsg ? '发送中...' : '发送'}
              </button>
            </form>
          )}
        </section>

        <section className="card" data-testid="timeline-card">
          <div className="card-header">
            <div className="card-heading">
              <h3 className="card-title">
                <AppIcon name="activity" size={16} />
                执行动态
              </h3>
              <p className="card-description">
                只展示真实发生的任务事实，模型的隐藏推理已过滤。
              </p>
            </div>
          </div>

          {tasks.length === 0 ? (
            <div className="lqa-muted-box">暂无任务事件。</div>
          ) : (
            <ol className="lqa-timeline">
              {tasks.map((task) => (
                <li
                  key={task.id}
                  className={`lqa-timeline-item is-${task.status}`}
                >
                  <span className="lqa-timeline-dot" aria-hidden="true" />
                  <div className="lqa-timeline-body">
                    <div className="row row-wrap">
                      <span className="lqa-timeline-role">
                        {{
                          coordinator: '主 AI',
                          explorer: '探索 AI',
                          executor: '执行 AI',
                          reproducer: '复现 AI',
                          finalizer: '总结 AI',
                        }[task.role] ?? task.role}
                      </span>
                      <StatusBadge status={task.status} size="sm" />
                      <span className="push subtle text-xs nowrap">
                        {task.elapsedSeconds}s
                      </span>
                    </div>
                    <p>{task.summary || '任务执行中...'}</p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      <TaskCaseTabs
        cases={cases}
        findings={findings}
        tasks={tasks}
        report={report}
        session={session}
        runId={activeRunId}
        run={run}
        onRefreshReport={() => void reload()}
      />
    </div>
  );
};
