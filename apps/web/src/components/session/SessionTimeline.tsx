import React, { useState } from 'react';
import type {
  CaseRecord,
  Finding,
  InputRequest,
  Report,
  Run,
  SessionReport,
  Task,
} from '@localqa/contracts';
import { AppIcon, type AppIconName } from '../ui/AppIcon.tsx';
import { InputRequestBar } from '../workbench/InputRequestBar.tsx';
import {
  agentKind,
  agentTitle,
  elapsedLabel,
  spanLabel,
  type FeedItem,
} from './sessionFeed.ts';
import { isRunActive } from '../sessions/sessionMeta.ts';

export type PaneTab = 'agents' | 'cases' | 'bugs' | 'screen' | 'report';

const taskStatusMeta: Record<
  Task['status'],
  { label: string; icon: AppIconName; tone: string }
> = {
  queued: { label: '已派出', icon: 'clock', tone: 'muted' },
  running: { label: '运行中', icon: 'activity', tone: 'info' },
  waiting: { label: '等待中', icon: 'alert-circle', tone: 'ai' },
  succeeded: { label: '已完成', icon: 'check-circle', tone: 'success' },
  failed: { label: '失败', icon: 'x-circle', tone: 'danger' },
  cancelled: { label: '已取消', icon: 'x-circle', tone: 'warning' },
  interrupted: { label: '中断', icon: 'x-circle', tone: 'danger' },
};

export const TaskStatusPill: React.FC<{ task: Task }> = ({ task }) => {
  const meta = taskStatusMeta[task.status];
  return (
    <span className={`mo-pill is-${meta.tone}`}>
      <AppIcon name={meta.icon} size={12} />
      {meta.label}
    </span>
  );
};

export const taskStatusIcon = (task: Task) => taskStatusMeta[task.status];

const terminationText: Record<string, string> = {
  setup_failure: '初始化或登录没有完成',
  model_failure: '模型调用失败',
  worker_failure: '执行器中断',
  budget_limit: '达到额度上限，提前收尾',
  input_timeout: '等待回复超时',
  user_cancel: '已手动停止',
};

const time = (iso: string) =>
  new Date(iso).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const ActionGroup: React.FC<{
  item: Extract<FeedItem, { kind: 'actions' }>;
  defaultOpen: boolean;
}> = ({ item, defaultOpen }) => {
  const [open, setOpen] = useState(defaultOpen);
  const span = spanLabel(item.at, item.endAt);
  return (
    <div className="mo-actions" data-testid="mo-feed-actions">
      <button
        type="button"
        className="mo-actions-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <AppIcon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        <span>{item.actions.length} 个动作</span>
        {span && <span className="mo-actions-span">{span}</span>}
      </button>
      {open && (
        <ul className="mo-action-rows">
          {item.actions.map((action) => (
            <li key={action.key} className="mo-action-row">
              <AppIcon name="chevron-right" size={13} />
              <span>{action.label}</span>
              {action.chips
                .filter(Boolean)
                .slice(0, 2)
                .map((chip) => (
                  <span className="mo-chip" key={chip} title={chip}>
                    {chip}
                  </span>
                ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

/** Mo's conversation column: request, AI notes, grouped tool rows, agents,
 * a session status card, the AI's question and a working indicator. */
export const SessionTimeline: React.FC<{
  run: Run;
  feed: FeedItem[];
  tasks: Task[];
  cases: CaseRecord[];
  findings: Finding[];
  session: SessionReport | null;
  report: Report | null;
  activeInputRequest: InputRequest | null;
  authProfiles: readonly { id: string; name: string }[];
  onRespond: (
    decision: 'provide' | 'approve' | 'reject',
    text?: string,
  ) => Promise<void>;
  onOpenAgent: (taskId: string) => void;
  onOpenTab: (tab: PaneTab) => void;
}> = ({
  run,
  feed,
  tasks,
  cases,
  findings,
  session,
  report,
  activeInputRequest,
  authProfiles,
  onRespond,
  onOpenAgent,
  onOpenTab,
}) => {
  const active = isRunActive(run);
  const lastGroup = [...feed].reverse().find((item) => item.kind === 'actions');
  const verdictOf = (record: CaseRecord) =>
    record.verdict?.status ?? record.outcome;
  const counts = {
    passed: cases.filter((c) => verdictOf(c) === 'passed').length,
    failed: cases.filter((c) => verdictOf(c) === 'issue_found').length,
    blocked: cases.filter((c) => verdictOf(c) === 'blocked').length,
    pending: cases.filter((c) =>
      ['not_run', 'inconclusive'].includes(verdictOf(c)),
    ).length,
  };
  const agentsRunning = tasks.some(
    (task) =>
      task.role !== 'coordinator' &&
      ['queued', 'running', 'waiting'].includes(task.status),
  );
  const summary =
    session?.status === 'complete' ? session.summary?.trim() : undefined;

  return (
    <div
      className="mo-feed"
      aria-live="polite"
      data-testid="mo-conversation-feed"
    >
      {feed.map((item) => {
        if (item.kind === 'user')
          return (
            <div
              className="mo-msg-user"
              key={item.key}
              data-testid="mo-user-request"
            >
              <time>{time(item.at)}</time>
              <div className="mo-bubble">{item.text}</div>
            </div>
          );
        if (item.kind === 'assistant')
          return (
            <div
              className={`mo-msg-ai ${item.tone ? `is-${item.tone}` : ''}`}
              key={item.key}
            >
              {item.text}
            </div>
          );
        if (item.kind === 'actions')
          return (
            <ActionGroup
              key={item.key}
              item={item}
              defaultOpen={active && item === lastGroup}
            />
          );
        const task = tasks.find((candidate) => candidate.id === item.taskId);
        if (!task) return null;
        return (
          <div className="mo-agent-line" key={item.key}>
            <p>启动了{agentKind(task)}</p>
            <div className="mo-agent-line-row">
              <button
                type="button"
                className="mo-chip is-link"
                onClick={() => onOpenAgent(task.id)}
                data-testid={`mo-task-${task.id}`}
              >
                <AppIcon name="cpu" size={12} />
                <span>{agentTitle(task, cases)}</span>
                <AppIcon name="external-link" size={11} />
              </button>
              <TaskStatusPill task={task} />
              {elapsedLabel(task.elapsedSeconds) && (
                <span className="mo-elapsed">
                  {elapsedLabel(task.elapsedSeconds)}
                </span>
              )}
            </div>
          </div>
        );
      })}

      {summary && <div className="mo-msg-ai">{summary}</div>}

      {(run.status === 'failed' || run.status === 'cancelled') && (
        <div
          className={`mo-msg-ai ${run.status === 'failed' ? 'is-danger' : 'is-warning'}`}
          data-testid={
            run.status === 'failed' ? 'failed-run-notice' : undefined
          }
        >
          {run.status === 'failed' ? '会话没有完成：' : '会话已停止：'}
          {terminationText[run.terminationReason ?? ''] ??
            run.terminationReason ??
            '原因未记录'}
          。已有结果仍可查看，未验证的部分不能算通过。
          {report?.warnings.map((warning, index) => (
            <span className="mo-msg-note" key={index}>
              {warning}
            </span>
          ))}
        </div>
      )}

      {(cases.length > 0 || !active) && (
        <section className="mo-status-card" data-testid="session-status-card">
          <header>
            <span>会话状态</span>
            <button type="button" onClick={() => onOpenTab('cases')}>
              查看用例 <AppIcon name="external-link" size={12} />
            </button>
          </header>
          <div className="mo-status-grid">
            <div>
              <span>通过</span>
              <strong>{counts.passed}</strong>
            </div>
            <div>
              <span>发现问题</span>
              <strong>{counts.failed}</strong>
            </div>
            {counts.blocked > 0 && (
              <div>
                <span>受阻</span>
                <strong>{counts.blocked}</strong>
              </div>
            )}
            {counts.pending > 0 && (
              <div>
                <span>暂无结果</span>
                <strong>{counts.pending}</strong>
              </div>
            )}
          </div>
          <button
            type="button"
            className="mo-status-bugs"
            onClick={() => onOpenTab('bugs')}
          >
            <span>
              缺陷 <AppIcon name="external-link" size={12} />
            </span>
            <strong>{findings.length}</strong>
          </button>
          {!active && cases.length === 0 && (
            <p className="mo-status-note" data-testid="mo-no-verification">
              没有完成任何用例验证；0 个用例不代表通过。
            </p>
          )}
        </section>
      )}

      {active && agentsRunning && !activeInputRequest && (
        <p className="mo-waiting">等待代理回报结果…</p>
      )}

      {activeInputRequest && (
        <InputRequestBar
          request={activeInputRequest}
          authProfiles={authProfiles}
          onRespond={onRespond}
        />
      )}

      {active && !activeInputRequest && (
        <p className="mo-working" data-testid="mo-working">
          <span className="mo-working-dot" />
          {run.status === 'queued' ? '排队中，等待执行器领取…' : 'AI 正在工作'}
        </p>
      )}
    </div>
  );
};
