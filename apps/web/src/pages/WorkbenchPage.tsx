import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import { useApp } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { RunStoreProvider, useRunStore } from '../state/RunStore.tsx';
import { Page } from '../components/layout/Page.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { Alert } from '../components/ui/Alert.tsx';
import { AppIcon } from '../components/ui/AppIcon.tsx';
import { ReconnectBanner } from '../components/layout/ReconnectBanner.tsx';
import { Modal } from '../components/ui/Modal.tsx';
import { Popover } from '../components/ui/Popover.tsx';
import {
  SessionTimeline,
  type PaneTab,
} from '../components/session/SessionTimeline.tsx';
import {
  SessionPane,
  type PaneDetail,
} from '../components/session/SessionPane.tsx';
import { buildSessionFeed } from '../components/session/sessionFeed.ts';
import {
  isRunActive,
  sessionStatusLabel,
  sessionStatusMeta,
  sessionTitle,
} from '../components/sessions/sessionMeta.ts';

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
    <Page width="full" testId="workbench-page" className="mo-session-page">
      {selectedRunId ? (
        <RunStoreProvider runId={selectedRunId} key={selectedRunId}>
          <WorkbenchContent />
        </RunStoreProvider>
      ) : runsLoaded ? (
        <EmptyState
          icon="activity"
          title="还没有会话"
          description="新建一个会话，告诉 AI 要测试哪个流程；过程会实时显示在这里。"
          actionText="新建会话"
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

const WorkbenchContent: React.FC = () => {
  const { currentUser, currentProject, setRoute } = useApp();
  const [canDeleteRun, setCanDeleteRun] = useState(false);
  const [showDeleteRun, setShowDeleteRun] = useState(false);
  const [deletingRun, setDeletingRun] = useState(false);
  const [deleteRunError, setDeleteRunError] = useState('');
  const [inputProfiles, setInputProfiles] = useState<
    import('@localqa/contracts').AuthProfile[]
  >([]);
  const [messageError, setMessageError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setInputProfiles([]);
    if (currentProject)
      void defaultApiClient
        .listAuthProfiles(currentProject.id, { limit: 100 })
        .then((page) => {
          if (!cancelled)
            setInputProfiles(
              page.items.filter(
                (profile) =>
                  profile.status === 'active' && profile.mode !== 'none',
              ),
            );
        })
        .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [currentProject?.id]);
  useEffect(() => {
    let cancelled = false;
    setCanDeleteRun(currentUser?.globalRole === 'admin');
    if (currentProject && currentUser?.globalRole !== 'admin') {
      void defaultApiClient
        .listMembers(currentProject.id, { limit: 100 })
        .then((page) => {
          if (!cancelled)
            setCanDeleteRun(
              page.items.some(
                (m) => m.userId === currentUser?.id && m.role === 'owner',
              ),
            );
        })
        .catch(() => {
          if (!cancelled) setCanDeleteRun(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [currentProject?.id, currentUser?.id, currentUser?.globalRole]);
  const {
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
    cancelRun,
    sendMessage,
    respondInput,
    retrySse,
    reload,
  } = useRunStore();
  const deleteRun = async () => {
    if (
      !run ||
      deletingRun ||
      !canDeleteRun ||
      run.projectId !== currentProject?.id
    )
      return;
    setDeletingRun(true);
    setDeleteRunError('');
    try {
      await defaultApiClient.deleteRun(run.id, {
        expectedVersion: run.version,
        confirmRunId: run.id,
      });
      setShowDeleteRun(false);
      setRoute('home');
    } catch (error) {
      setDeleteRunError(
        error instanceof Error ? error.message : '删除失败，请刷新后重试',
      );
    } finally {
      setDeletingRun(false);
    }
  };

  const [paneOpen, setPaneOpen] = useState(true);
  const [paneTab, setPaneTab] = useState<PaneTab | 'detail'>('agents');
  const [paneDetail, setPaneDetail] = useState<PaneDetail>(null);
  const [paneExpanded, setPaneExpanded] = useState(false);
  const [inputMsg, setInputMsg] = useState('');
  const [sendingMsg, setSendingMsg] = useState(false);
  const messageSendingRef = useRef(false);
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
          if (decision !== 'provide' || !text)
            throw new Error('请选择认证配置');
        }
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
    if (!inputMsg.trim() || messageSendingRef.current) return;
    messageSendingRef.current = true;
    setSendingMsg(true);
    setMessageError('');
    try {
      if (activeInputRequest?.kind === 'clarification') {
        await handleRespondInput('provide', inputMsg.trim());
      } else if (
        run &&
        ['completed', 'cancelled', 'failed'].includes(run.status)
      ) {
        const next = await defaultApiClient.continueRun(run.id, {
          expectedVersion: run.version,
          text: inputMsg,
        });
        setRoute('workbench', { runId: next.id });
      } else await sendMessage(inputMsg.trim());
      setInputMsg('');
    } catch (error) {
      setMessageError(
        error instanceof Error ? error.message : '发送失败，请重试',
      );
    } finally {
      messageSendingRef.current = false;
      setSendingMsg(false);
    }
  };

  const objective =
    session?.objective?.trim() || report?.session?.objective?.trim() || '';
  const feed = useMemo(
    () => (run ? buildSessionFeed({ run, events, messages, objective }) : []),
    [run, events, messages, objective],
  );

  if (!run) {
    return <div className="lqa-session-loading is-inline">加载会话中…</div>;
  }

  const active = isRunActive(run);
  const awaitingClarification = activeInputRequest?.kind === 'clarification';
  const statusMeta = sessionStatusMeta[run.status];
  const verified = cases.filter(
    (record) => (record.verdict?.status ?? record.outcome) === 'passed',
  ).length;
  const hasBrowserAgent = tasks.some((task) =>
    ['explorer', 'executor', 'reproducer'].includes(task.role),
  );
  const openTab = (next: PaneTab) => {
    setPaneOpen(true);
    setPaneTab(next);
  };

  return (
    <div className="mo-session" data-testid="workbench-container">
      <header className="mo-session-head">
        <AppIcon
          name={statusMeta.icon}
          size={16}
          className={`mo-status-icon is-${statusMeta.tone}`}
        />
        <h1 className="mo-session-name" title={`${run.targetUrl}\n${run.id}`}>
          {sessionTitle(run)}
        </h1>
        <span className={`mo-session-status is-${statusMeta.tone}`}>
          {sessionStatusLabel(run)}
        </span>
        {run.executionMode === 'regression' && (
          <span className="mo-chip" data-testid="badge-execution-mode">
            回归 · {cases.length} 个用例
          </span>
        )}
        <span className="mo-session-head-spacer" />
        {verified > 0 && (
          <span className="mo-verified">{verified} 个已验证</span>
        )}
        <span
          className="mo-usage"
          title="模型调用 / 浏览器步数 / Token"
          data-testid="budget-metrics-bar"
        >
          {run.budgetUsed.modelCalls} 次调用 · {run.budgetUsed.actions} 步 ·{' '}
          {(run.budgetUsed.totalTokens / 1000).toFixed(1)}k tokens
        </span>
        <Popover
          align="end"
          testId="session-actions-menu"
          trigger={(props) => (
            <button
              type="button"
              {...props}
              className="mo-icon-button"
              aria-label="会话操作"
              title="会话操作"
            >
              <AppIcon name="more" size={16} />
            </button>
          )}
        >
          {(close) => (
            <>
              <a
                className="mo-menu-item"
                href={run.targetUrl}
                target="_blank"
                rel="noreferrer"
                onClick={close}
              >
                打开被测网址
                <AppIcon name="external-link" size={13} />
              </a>
              <button
                type="button"
                className="mo-menu-item"
                onClick={() => {
                  void navigator.clipboard?.writeText(run.id);
                  close();
                }}
              >
                复制会话 ID
              </button>
              {!active &&
                canDeleteRun &&
                run.projectId === currentProject?.id && (
                  <button
                    type="button"
                    className="mo-menu-item is-danger"
                    data-testid="btn-delete-run"
                    onClick={() => {
                      close();
                      setDeleteRunError('');
                      setShowDeleteRun(true);
                    }}
                  >
                    删除会话
                  </button>
                )}
            </>
          )}
        </Popover>
        <button
          type="button"
          className={`mo-icon-button ${paneOpen ? 'is-active' : ''}`}
          aria-label={paneOpen ? '收起侧栏' : '展开侧栏'}
          title={paneOpen ? '收起侧栏' : '展开侧栏'}
          onClick={() => setPaneOpen((open) => !open)}
          data-testid="btn-toggle-tabs-collapse"
        >
          <AppIcon name="panel-right" size={16} />
        </button>
      </header>

      <div
        className={`mo-session-body ${paneOpen ? '' : 'is-pane-hidden'} ${paneExpanded ? 'is-pane-expanded' : ''}`}
      >
        <section
          className="mo-session-main"
          data-testid="workbench-center-panel"
        >
          <div className="mo-session-scroll">
            <ReconnectBanner
              status={sseStatus}
              attempt={reconnectAttempt}
              onRetry={retrySse}
            />
            <SessionTimeline
              run={run}
              feed={feed}
              tasks={tasks}
              cases={cases}
              findings={findings}
              session={session}
              report={report}
              activeInputRequest={activeInputRequest}
              authProfiles={inputProfiles}
              onRespond={handleRespondInput}
              onOpenAgent={(taskId) => {
                setPaneDetail({ type: 'agent', id: taskId });
                setPaneOpen(true);
                setPaneTab('detail');
              }}
              onOpenTab={openTab}
            />
          </div>
          <div className="mo-session-composer" data-testid="run-messages-card">
            {hasBrowserAgent && (
              <button
                type="button"
                className="mo-screen-chip"
                onClick={() => openTab('screen')}
              >
                <span className={active ? 'is-live' : ''}>
                  {active ? '进行中' : '回放'}
                </span>
                AI 的画面
                <AppIcon name="external-link" size={11} />
              </button>
            )}
            {messageError && (
              <Alert tone="danger" testId="run-message-error">
                {messageError}
              </Alert>
            )}
            <form
              onSubmit={handleSendMessage}
              className="mo-composer"
              data-testid="send-message-box"
            >
              <textarea
                className="mo-composer-input"
                rows={1}
                maxLength={4000}
                placeholder={
                  awaitingClarification
                    ? '回答上面的问题…'
                    : active
                      ? '给 AI 补充要求，引导它继续…'
                      : '继续测试：告诉 AI 下一步要做什么…'
                }
                value={inputMsg}
                onChange={(e) => setInputMsg(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === 'Enter' &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
                data-testid="input-run-message"
              />
              <div className="mo-composer-bar">
                <span className="mo-composer-hint">
                  {active
                    ? '会沿用本次的环境和操作范围'
                    : '会作为新一轮测试，沿用本次环境和操作范围'}
                </span>
                {active && !inputMsg.trim() ? (
                  <button
                    type="button"
                    className="mo-send-button is-stop"
                    aria-label="停止会话"
                    title="停止会话"
                    disabled={run.status === 'cancelling'}
                    onClick={() => void cancelRun()}
                    data-testid="btn-cancel-run"
                  >
                    <span className="mo-stop-square" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="mo-send-button"
                    aria-label={active ? '发送' : '继续测试'}
                    title={active ? '发送' : '继续测试'}
                    disabled={sendingMsg || !inputMsg.trim()}
                    data-testid="btn-send-message"
                  >
                    {sendingMsg ? (
                      <span className="mo-send-spinner" />
                    ) : (
                      <AppIcon name="arrow-up" size={16} />
                    )}
                  </button>
                )}
              </div>
            </form>
          </div>
        </section>
        {paneOpen && (
          <SessionPane
            run={run}
            events={events}
            tasks={tasks}
            cases={cases}
            findings={findings}
            report={report}
            tab={paneTab}
            onTab={setPaneTab}
            detail={paneDetail}
            onDetail={setPaneDetail}
            expanded={paneExpanded}
            onToggleExpanded={() => setPaneExpanded((value) => !value)}
            onRefreshReport={() => void reload()}
          />
        )}
      </div>

      {showDeleteRun && (
        <Modal
          title="删除会话"
          testId="run-delete-dialog"
          closeOnOverlay={!deletingRun}
          onClose={() => {
            if (!deletingRun) setShowDeleteRun(false);
          }}
          footer={
            <>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={deletingRun}
                data-testid="run-delete-cancel"
                onClick={() => setShowDeleteRun(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={deletingRun}
                data-testid="run-delete-confirm"
                onClick={() => void deleteRun()}
              >
                {deletingRun ? '删除中…' : '确认删除'}
              </button>
            </>
          }
        >
          <p>
            删除后，这次会话及其报告、执行过程将不再展示。已保存用例和审计记录保留。
          </p>
          <p className="text-sm">
            <code>{run.id}</code>
            <br />
            {run.targetUrl}
          </p>
          {deleteRunError && (
            <Alert tone="danger" role="alert" testId="run-delete-error">
              {deleteRunError}
            </Alert>
          )}
        </Modal>
      )}
    </div>
  );
};
