import React, { useMemo, useState } from 'react';
import type {
  CaseRecord,
  Run,
  RunEvent,
  SessionReport,
  Task,
} from '@localqa/contracts';
import type { RunMessage } from '../../api/index.ts';
import { AppIcon } from '../ui/AppIcon.tsx';
import { StatusBadge } from '../ui/Badge.tsx';
import {
  TaskExecutionDetail,
  taskDurationLabel,
  taskRoleLabel,
  taskStageLabel,
} from './TaskExecutionDetail.tsx';

type FeedEntry = {
  key: string;
  at: string;
  label: string;
  text: string;
  kind: 'user' | 'agent' | 'task' | 'case' | 'run';
  taskId?: string;
  status?: string;
};

const safeTime = (iso: string) => {
  const stamp = new Date(iso).getTime();
  return Number.isFinite(stamp) ? stamp : 0;
};

/** Only server events and persisted redacted messages are displayed as facts. */
export function buildRunFeed(
  events: RunEvent[],
  messages: RunMessage[],
): FeedEntry[] {
  const items: FeedEntry[] = messages.map((message) => ({
    key: `msg-${message.id}`,
    at: message.createdAt,
    label: '操作员',
    text: message.redactedText,
    kind: 'user',
  }));
  for (const event of events) {
    const data = event.payload;
    let entry: FeedEntry | null = null;
    if (event.type === 'task.updated' && typeof data.id === 'string') {
      const task = data as unknown as Task;
      const role = taskRoleLabel[task.role] || task.role;
      const stage = taskStageLabel[task.summary] || task.summary || '等待反馈';
      entry = {
        key: event.id,
        at: event.at,
        label: role,
        kind: 'task',
        status: task.status,
        taskId: task.id,
        text: `${stage} · ${task.status === 'queued' ? '已派工' : task.status === 'running' ? '正在执行' : task.status === 'succeeded' ? '任务完成' : task.status === 'waiting' ? '等待外部输入' : '任务' + task.status}`,
      };
    } else if (event.type === 'session.updated') {
      const session = data as unknown as SessionReport;
      const message =
        session.status === 'complete'
          ? session.summary?.trim()
          : session.plan?.trim();
      if (message) {
        entry = {
          key: event.id,
          at: event.at,
          label:
            session.status === 'complete' ? '主 AI 结果总结' : '主 AI 计划',
          kind: 'agent',
          text: message,
        };
      }
    } else if (event.type === 'case.result') {
      const record = data as unknown as CaseRecord;
      entry = {
        key: event.id,
        at: event.at,
        label: '验证结果',
        kind: 'case',
        status: record.verdict?.status || 'not_run',
        text: `${record.definition?.title || '测试用例'}：${record.verdict?.summary || '尚无可核验的最终判定'}`,
      };
    } else if (event.type === 'run.finished') {
      const result = data as unknown as Run;
      entry = {
        key: event.id,
        at: event.at,
        label: '会话执行结束',
        kind: 'run',
        status: result.status,
        text:
          result.status === 'completed'
            ? '执行已结束，请以实际用例判定和覆盖缺口为准。'
            : `执行已终止：${result.terminationReason ?? result.status}；未验证不等于通过。`,
      };
    }
    if (entry) items.push(entry);
  }
  return items.sort((a, b) => safeTime(a.at) - safeTime(b.at));
}

export const RunConversationFeed: React.FC<{
  run: Run;
  tasks: Task[];
  cases: CaseRecord[];
  events: RunEvent[];
  messages: RunMessage[];
  session?: SessionReport | null;
}> = ({ run, tasks, cases, events, messages, session }) => {
  const [selectedTask, setSelectedTask] = useState<string | null | undefined>(
    undefined,
  );
  const feed = useMemo(
    () => buildRunFeed(events, messages),
    [events, messages],
  );
  const activeBrowserTask = [...tasks]
    .reverse()
    .find(
      (t) =>
        ['explorer', 'executor', 'reproducer'].includes(t.role) &&
        ['running', 'succeeded'].includes(t.status),
    );
  const focusedTaskId =
    selectedTask === undefined ? (activeBrowserTask?.id ?? null) : selectedTask;
  const focusedTask = tasks.find((task) => task.id === focusedTaskId);
  const runTerminal = ['completed', 'failed', 'cancelled'].includes(run.status);
  const persistedTasks = tasks.filter((task) => task.runId === run.id);

  return (
    <section
      className="card mo-conversation"
      data-testid="mo-conversation-feed"
    >
      <div className="card-header">
        <div className="card-heading">
          <h3 className="card-title">
            <AppIcon name="send" size={17} /> 测试会话
          </h3>
          <p className="card-description">
            从真实运行事件生成的对话与派工时间线。点击代理卡，查看浏览器动作与证据。
          </p>
        </div>
        <span className="badge badge-neutral">
          {runTerminal ? '已结束' : '运行中'}
        </span>
      </div>
      <div className="mo-feed" aria-live="polite">
        <div
          className="mo-feed-entry mo-feed-request"
          data-testid="mo-user-request"
        >
          <div className="mo-feed-avatar">任务</div>
          <div className="mo-feed-main">
            <strong>本次测试目标</strong>
            <p>
              {session?.objective?.trim() || '根据本次冻结测试范围执行目标检查'}
            </p>
            <p className="break-all text-xs muted">{run.targetUrl}</p>
            <span className="text-xs muted">执行范围以本次冻结配置为准</span>
          </div>
        </div>
        {feed.length === 0 && persistedTasks.length === 0 && (
          <div className="mo-feed-entry" data-testid="mo-waiting-feedback">
            <div className="mo-feed-avatar">AI</div>
            <div className="mo-feed-main">
              <strong>
                {runTerminal ? '没有可展示的执行记录' : '等待实际任务反馈'}
              </strong>
              <p>
                {runTerminal
                  ? '运行已结束，但任务和历史事件均不可用，不能据此判断已完成哪些验证。'
                  : run.status === 'queued'
                    ? '正在等待 Worker 领取任务。'
                    : '已提交执行请求，等待运行事件和可验证证据。'}
              </p>
            </div>
          </div>
        )}
        {feed.length === 0 && persistedTasks.length > 0 && (
          <div className="mo-feed-entry" data-testid="mo-persisted-tasks">
            <div className="mo-feed-avatar">AI</div>
            <div className="mo-feed-main">
              <strong>已保存的代理任务</strong>
              <p className="text-xs muted">
                本次未取得完整历史事件；下列记录来自持久化任务状态，不代表可还原的操作时间线。
              </p>
              {persistedTasks.map((task) => (
                <button
                  className="mo-dispatch-card"
                  type="button"
                  key={task.id}
                  onClick={() =>
                    setSelectedTask((current) =>
                      current === task.id ? null : task.id,
                    )
                  }
                  aria-expanded={focusedTaskId === task.id}
                  data-testid={`mo-task-${task.id}`}
                >
                  <span className="mo-dispatch-copy">
                    <strong>{taskRoleLabel[task.role]}</strong>
                    <span>{taskStageLabel[task.summary] ?? task.summary}</span>
                    <span className="text-xs muted">
                      {taskDurationLabel(task.elapsedSeconds)}
                    </span>
                  </span>
                  <StatusBadge status={task.status} size="sm" />
                </button>
              ))}
            </div>
          </div>
        )}
        {feed.map((entry) => {
          const task = entry.taskId
            ? tasks.find((item) => item.id === entry.taskId)
            : null;
          return (
            <div
              className={`mo-feed-entry mo-feed-${entry.kind}`}
              key={entry.key}
              data-testid="mo-feed-entry"
            >
              <div className="mo-feed-avatar">
                {entry.kind === 'user'
                  ? '我'
                  : entry.kind === 'task'
                    ? 'AI'
                    : '✓'}
              </div>
              <div className="mo-feed-main">
                <div className="row row-wrap spread">
                  <strong>{entry.label}</strong>
                  <span className="text-xs muted">
                    {new Date(entry.at).toLocaleTimeString()}
                  </span>
                </div>
                {task ? (
                  <button
                    className="mo-dispatch-card"
                    type="button"
                    onClick={() =>
                      setSelectedTask((current) =>
                        current === task.id ? null : task.id,
                      )
                    }
                    aria-expanded={focusedTaskId === task.id}
                    data-testid={`mo-task-${task.id}`}
                  >
                    <span className="mo-dispatch-copy">
                      <span>{entry.text}</span>
                      <span className="text-xs muted">
                        代理 #{task.attempt} ·{' '}
                        {taskDurationLabel(task.elapsedSeconds)} ·
                        点击查看执行详情
                      </span>
                    </span>
                    <StatusBadge
                      status={entry.status ?? task.status}
                      size="sm"
                    />
                  </button>
                ) : (
                  <p>{entry.text}</p>
                )}
              </div>
            </div>
          );
        })}
        {runTerminal && cases.length === 0 && (
          <div
            className="mo-feed-entry mo-feed-run"
            data-testid="mo-no-verification"
          >
            <div className="mo-feed-avatar">!</div>
            <div className="mo-feed-main">
              <strong>尚未完成任何用例验证</strong>
              <p>
                0 个用例、0
                个缺陷不代表通过或没有缺陷，需查看终止原因和覆盖缺口。
              </p>
            </div>
          </div>
        )}
      </div>
      {focusedTask && (
        <div className="mo-feed-task-detail">
          <TaskExecutionDetail
            task={focusedTask}
            active={
              !runTerminal &&
              ['running', 'waiting'].includes(focusedTask.status)
            }
            runTargetUrl={run.targetUrl}
            onClose={() => setSelectedTask(null)}
          />
        </div>
      )}
    </section>
  );
};
