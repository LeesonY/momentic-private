import React, { useState } from 'react';
import type {
  CaseRecord,
  Finding,
  Report,
  Run,
  Task,
} from '@localqa/contracts';
import { useApp } from '../../state/AppContext.tsx';
import { AppIcon, type AppIconName } from '../ui/AppIcon.tsx';
import { EvidencePreview } from '../workbench/TaskExecutionDetail.tsx';
import { RunReportPanel } from '../workbench/RunReportPanel.tsx';
import { ScreenPanel } from './ScreenPanel.tsx';
import {
  TaskStatusPill,
  taskStatusIcon,
  type PaneTab,
} from './SessionTimeline.tsx';
import { agentKind, agentTitle, elapsedLabel } from './sessionFeed.ts';
import { isRunActive } from '../sessions/sessionMeta.ts';

export type PaneDetail = { type: 'agent' | 'case'; id: string } | null;

const BROWSER_ROLES: Task['role'][] = ['explorer', 'executor', 'reproducer'];

type CaseStatus = 'passed' | 'issue_found' | 'blocked' | 'pending';
const caseStatus = (record: CaseRecord): CaseStatus => {
  const status = record.verdict?.status ?? record.outcome;
  return status === 'passed' || status === 'issue_found' || status === 'blocked'
    ? status
    : 'pending';
};
const caseStatusMeta: Record<
  CaseStatus,
  { label: string; icon: AppIconName; tone: string }
> = {
  passed: { label: '通过', icon: 'check-circle', tone: 'success' },
  issue_found: { label: '发现问题', icon: 'x-circle', tone: 'danger' },
  blocked: { label: '受阻', icon: 'alert-circle', tone: 'warning' },
  pending: { label: '暂无结果', icon: 'clock', tone: 'muted' },
};

const severityLabel: Record<Finding['severity'], string> = {
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
  info: '提示',
};
const findingStatusLabel: Record<Finding['status'], string> = {
  suspected: '待复现',
  confirmed: '已确认',
  unconfirmed: '未复现',
  blocked: '复现受阻',
};

function FilterBar<K extends string>({
  query,
  onQuery,
  placeholder,
  filters,
  value,
  onChange,
}: {
  query: string;
  onQuery: (value: string) => void;
  placeholder: string;
  filters: { key: K; label: string; count: number }[];
  value: K;
  onChange: (value: K) => void;
}) {
  return (
    <div className="mo-pane-filters">
      <label className="mo-search is-wide">
        <AppIcon name="search" size={14} />
        <input
          type="search"
          placeholder={placeholder}
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
      </label>
      <div className="segmented" role="tablist">
        {filters.map((item) => (
          <button
            type="button"
            role="tab"
            key={item.key}
            aria-selected={value === item.key}
            className={value === item.key ? 'is-active' : ''}
            onClick={() => onChange(item.key)}
          >
            {item.label}
            <span className="mo-seg-count">{item.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const AgentList: React.FC<{
  tasks: Task[];
  cases: CaseRecord[];
  onOpen: (taskId: string) => void;
}> = ({ tasks, cases, onOpen }) => {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'running' | 'waiting' | 'done'>(
    'all',
  );
  const groupOf = (task: Task) =>
    ['queued', 'running'].includes(task.status)
      ? 'running'
      : task.status === 'waiting'
        ? 'waiting'
        : 'done';
  const agents = tasks.filter((task) => task.role !== 'coordinator');
  const needle = query.trim().toLowerCase();
  const visible = agents.filter(
    (task) =>
      (filter === 'all' || groupOf(task) === filter) &&
      (!needle || agentTitle(task, cases).toLowerCase().includes(needle)),
  );
  return (
    <div className="mo-pane-list" data-testid="tab-content-tasks">
      <FilterBar
        query={query}
        onQuery={setQuery}
        placeholder="搜索代理…"
        value={filter}
        onChange={setFilter}
        filters={[
          { key: 'all', label: '全部', count: agents.length },
          {
            key: 'running',
            label: '运行中',
            count: agents.filter((t) => groupOf(t) === 'running').length,
          },
          {
            key: 'waiting',
            label: '等待',
            count: agents.filter((t) => groupOf(t) === 'waiting').length,
          },
          {
            key: 'done',
            label: '已结束',
            count: agents.filter((t) => groupOf(t) === 'done').length,
          },
        ]}
      />
      <p className="mo-pane-count">
        显示 {visible.length} / {agents.length} 个代理
      </p>
      {agents.length === 0 ? (
        <div className="mo-pane-empty">
          <p>还没有代理。</p>
        </div>
      ) : (
        visible.map((task) => {
          const meta = taskStatusIcon(task);
          return (
            <button
              type="button"
              key={task.id}
              className="mo-card"
              onClick={() => onOpen(task.id)}
              data-testid={`task-item-${task.id}`}
            >
              <span className="mo-card-head">
                <AppIcon
                  name={meta.icon}
                  size={15}
                  className={`mo-status-icon is-${meta.tone}`}
                />
                <span className="mo-card-title">{agentTitle(task, cases)}</span>
                <span className="mo-elapsed">
                  {elapsedLabel(task.elapsedSeconds)}
                </span>
              </span>
              <span className="mo-card-meta">
                <span className="mo-chip">{agentKind(task)}</span>
                {task.attempt > 1 && <span>第 {task.attempt} 次尝试</span>}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
};

const CaseList: React.FC<{
  cases: CaseRecord[];
  onOpen: (caseId: string) => void;
}> = ({ cases, onOpen }) => {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | CaseStatus>('all');
  const needle = query.trim().toLowerCase();
  const visible = cases.filter(
    (record) =>
      (filter === 'all' || caseStatus(record) === filter) &&
      (!needle || record.definition.title.toLowerCase().includes(needle)),
  );
  const count = (status: CaseStatus) =>
    cases.filter((record) => caseStatus(record) === status).length;
  return (
    <div className="mo-pane-list" data-testid="tab-content-cases">
      <FilterBar
        query={query}
        onQuery={setQuery}
        placeholder="搜索用例…"
        value={filter}
        onChange={setFilter}
        filters={[
          { key: 'all', label: '全部', count: cases.length },
          {
            key: 'issue_found',
            label: '发现问题',
            count: count('issue_found'),
          },
          { key: 'blocked', label: '受阻', count: count('blocked') },
          { key: 'passed', label: '通过', count: count('passed') },
          { key: 'pending', label: '暂无结果', count: count('pending') },
        ]}
      />
      <p className="mo-pane-count">
        显示 {visible.length} / {cases.length} 个用例
      </p>
      {cases.length === 0 ? (
        <div className="mo-pane-empty">
          <p>还没有测试用例。</p>
        </div>
      ) : (
        visible.map((record) => {
          const meta = caseStatusMeta[caseStatus(record)];
          return (
            <button
              type="button"
              key={record.definition.id}
              className="mo-card"
              onClick={() => onOpen(record.definition.id)}
              data-testid={`case-item-${record.definition.id}`}
            >
              <span className="mo-card-head">
                <AppIcon
                  name={meta.icon}
                  size={15}
                  className={`mo-status-icon is-${meta.tone}`}
                />
                <span className="mo-card-title">{record.definition.title}</span>
                {record.definition.regression && (
                  <span className="mo-chip">回归</span>
                )}
              </span>
              {record.definition.summary && (
                <span className="mo-card-text">
                  {record.definition.summary}
                </span>
              )}
            </button>
          );
        })
      )}
    </div>
  );
};

const BugList: React.FC<{ findings: Finding[]; runId: string }> = ({
  findings,
  runId,
}) => {
  const { setRoute } = useApp();
  if (findings.length === 0)
    return (
      <div className="mo-pane-empty" data-testid="tab-content-findings">
        <AppIcon name="bug" size={20} />
        <p>代理发现的问题，会先由独立的复现代理确认，再列在这里。</p>
      </div>
    );
  return (
    <div className="mo-pane-list" data-testid="tab-content-findings">
      {findings.map((finding) => (
        <button
          type="button"
          key={finding.id}
          className="mo-card"
          onClick={() =>
            setRoute('finding-detail', { findingId: finding.id, runId })
          }
          data-testid={`finding-item-${finding.id}`}
        >
          <span className="mo-card-head">
            <AppIcon
              name="bug"
              size={15}
              className={`mo-status-icon is-${finding.status === 'confirmed' ? 'danger' : 'warning'}`}
            />
            <span className="mo-card-title">{finding.title}</span>
            <span className="mo-chip">{severityLabel[finding.severity]}</span>
          </span>
          <span className="mo-card-meta">
            <span>{findingStatusLabel[finding.status]}</span>
            {finding.actual && (
              <span className="mo-card-text">{finding.actual}</span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
};

const CaseDetail: React.FC<{ record: CaseRecord; runId: string }> = ({
  record,
  runId,
}) => {
  const { setRoute } = useApp();
  const meta = caseStatusMeta[caseStatus(record)];
  const results = record.verdict?.criterionResults ?? [];
  const passed = results.filter((r) => r.result === 'passed');
  const others = results.filter((r) => r.result !== 'passed');
  const criterionText = (id: string) =>
    record.definition.criteria.find((c) => c.id === id)?.description ?? id;
  const evidence = results.flatMap((r) => r.evidenceRefs).slice(0, 3);
  return (
    <div
      className="mo-detail"
      data-testid={`mo-case-verifications-${record.definition.id}`}
    >
      <span className={`mo-pill is-${meta.tone}`}>
        <AppIcon name={meta.icon} size={12} />
        {meta.label}
      </span>
      <h3 className="mo-detail-title">{record.definition.title}</h3>
      {record.definition.summary && (
        <p className="mo-detail-sub">{record.definition.summary}</p>
      )}
      {record.verdict?.summary && (
        <p className="mo-detail-body">{record.verdict.summary}</p>
      )}
      {!record.verdict && (
        <p className="mo-detail-body muted">还没有形成判定，不能算通过。</p>
      )}
      {others.length > 0 && (
        <>
          <h4>未通过（{others.length}）</h4>
          <ul className="mo-check-list">
            {others.map((r) => (
              <li key={r.criterionId} className="is-failed">
                <AppIcon name="x-circle" size={15} />
                <span>
                  {criterionText(r.criterionId)}
                  {r.reason && <em>{r.reason}</em>}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {passed.length > 0 && (
        <>
          <h4>通过（{passed.length}）</h4>
          <ul className="mo-check-list">
            {passed.map((r) => (
              <li key={r.criterionId}>
                <AppIcon name="check-circle" size={15} />
                <span>
                  {criterionText(r.criterionId)}
                  {r.reason && <em>{r.reason}</em>}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {record.verdict && record.verdict.gaps.length > 0 && (
        <>
          <h4>未覆盖</h4>
          <ul className="mo-bullets">
            {record.verdict.gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        </>
      )}
      <h4>验收标准</h4>
      <ul className="mo-bullets">
        {record.definition.criteria.map((criterion) => (
          <li key={criterion.id}>{criterion.description}</li>
        ))}
      </ul>
      {record.definition.preconditions.length > 0 && (
        <>
          <h4>前置条件</h4>
          <ul className="mo-bullets">
            {record.definition.preconditions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </>
      )}
      <h4>步骤</h4>
      <ol className="mo-bullets is-ordered">
        {record.definition.outline.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ol>
      {evidence.length > 0 && (
        <>
          <h4>证据</h4>
          {evidence.map((id) => (
            <EvidencePreview artifactId={id} runId={runId} key={id} />
          ))}
        </>
      )}
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() =>
          setRoute('case-detail', { caseId: record.definition.id, runId })
        }
        data-testid={`btn-case-detail-${record.definition.id}`}
      >
        完整详情 / 保存到用例库
        <AppIcon name="arrow-right" size={13} />
      </button>
    </div>
  );
};

const AgentDetail: React.FC<{
  task: Task;
  cases: CaseRecord[];
  run: Run;
}> = ({ task, cases, run }) => (
  <div className="mo-detail" data-testid={`task-detail-${task.id}`}>
    <TaskStatusPill task={task} />
    <h3 className="mo-detail-title">{agentTitle(task, cases)}</h3>
    <p className="mo-detail-sub">
      {agentKind(task)}
      {elapsedLabel(task.elapsedSeconds)
        ? ` · ${elapsedLabel(task.elapsedSeconds)}`
        : ''}
      {task.attempt > 1 ? ` · 第 ${task.attempt} 次尝试` : ''}
    </p>
    {BROWSER_ROLES.includes(task.role) ? (
      <ScreenPanel
        task={task}
        live={isRunActive(run) && ['running', 'waiting'].includes(task.status)}
        targetUrl={run.targetUrl}
      />
    ) : (
      <p className="mo-detail-body muted">这个代理不操作浏览器，没有画面。</p>
    )}
  </div>
);

/** Mo's right pane: agents, test cases, bugs, the AI's screen and the
 * report, plus a tab for whatever agent or case you opened. */
export const SessionPane: React.FC<{
  run: Run;
  tasks: Task[];
  cases: CaseRecord[];
  findings: Finding[];
  report: Report | null;
  tab: PaneTab | 'detail';
  onTab: (tab: PaneTab | 'detail') => void;
  detail: PaneDetail;
  onDetail: (detail: PaneDetail) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  onRefreshReport: () => void;
}> = ({
  run,
  tasks,
  cases,
  findings,
  report,
  tab,
  onTab,
  detail,
  onDetail,
  expanded,
  onToggleExpanded,
  onRefreshReport,
}) => {
  const agents = tasks.filter((task) => task.role !== 'coordinator');
  const browserTask =
    [...tasks]
      .reverse()
      .find(
        (task) =>
          BROWSER_ROLES.includes(task.role) &&
          ['running', 'waiting'].includes(task.status),
      ) ??
    [...tasks].reverse().find((task) => BROWSER_ROLES.includes(task.role)) ??
    null;
  const detailTask =
    detail?.type === 'agent'
      ? tasks.find((t) => t.id === detail.id)
      : undefined;
  const detailCase =
    detail?.type === 'case'
      ? cases.find((c) => c.definition.id === detail.id)
      : undefined;
  const detailLabel = detailTask
    ? agentTitle(detailTask, cases)
    : detailCase?.definition.title;

  const tabs: {
    key: PaneTab;
    label: string;
    icon: AppIconName;
    count?: number;
  }[] = [
    { key: 'agents', label: '代理', icon: 'cpu', count: agents.length },
    { key: 'cases', label: '用例', icon: 'list', count: cases.length },
    { key: 'bugs', label: '缺陷', icon: 'bug', count: findings.length },
    { key: 'screen', label: '画面', icon: 'monitor' },
    { key: 'report', label: '报告', icon: 'file-text' },
  ];

  return (
    <aside
      className={`mo-pane ${expanded ? 'is-expanded' : ''}`}
      data-testid="workbench-tabs-panel"
    >
      <div className="mo-pane-tabs" role="tablist">
        {tabs.map((item) => (
          <button
            type="button"
            role="tab"
            key={item.key}
            aria-selected={tab === item.key}
            className={`mo-pane-tab ${tab === item.key ? 'is-active' : ''}`}
            onClick={() => onTab(item.key)}
            data-testid={`tab-btn-${item.key === 'bugs' ? 'findings' : item.key === 'agents' ? 'tasks' : item.key}`}
          >
            <AppIcon name={item.icon} size={14} />
            {item.label}
            {item.count !== undefined && item.count > 0 && (
              <span className="mo-tab-count">{item.count}</span>
            )}
          </button>
        ))}
        {detail && detailLabel && (
          <span
            className={`mo-pane-tab is-detail ${tab === 'detail' ? 'is-active' : ''}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'detail'}
              onClick={() => onTab('detail')}
              title={detailLabel}
            >
              <AppIcon
                name={detail.type === 'agent' ? 'cpu' : 'list'}
                size={14}
              />
              <span>{detailLabel}</span>
            </button>
            <button
              type="button"
              aria-label="关闭详情"
              onClick={() => {
                onDetail(null);
                if (tab === 'detail')
                  onTab(detail.type === 'agent' ? 'agents' : 'cases');
              }}
            >
              <AppIcon name="close" size={12} />
            </button>
          </span>
        )}
        <button
          type="button"
          className="mo-pane-expand"
          aria-label={expanded ? '还原侧栏' : '展开侧栏'}
          title={expanded ? '还原侧栏' : '展开侧栏'}
          onClick={onToggleExpanded}
        >
          <AppIcon name="maximize" size={14} />
        </button>
      </div>
      <div className="mo-pane-body">
        {tab === 'agents' && (
          <AgentList
            tasks={tasks}
            cases={cases}
            onOpen={(id) => {
              onDetail({ type: 'agent', id });
              onTab('detail');
            }}
          />
        )}
        {tab === 'cases' && (
          <CaseList
            cases={cases}
            onOpen={(id) => {
              onDetail({ type: 'case', id });
              onTab('detail');
            }}
          />
        )}
        {tab === 'bugs' && <BugList findings={findings} runId={run.id} />}
        {tab === 'screen' && (
          <ScreenPanel
            task={browserTask}
            live={
              isRunActive(run) &&
              !!browserTask &&
              ['running', 'waiting'].includes(browserTask.status)
            }
            targetUrl={run.targetUrl}
          />
        )}
        {tab === 'report' && (
          <RunReportPanel
            cases={cases}
            report={report}
            runId={run.id}
            run={run}
            onRefreshReport={onRefreshReport}
          />
        )}
        {tab === 'detail' &&
          (detailTask ? (
            <AgentDetail task={detailTask} cases={cases} run={run} />
          ) : detailCase ? (
            <CaseDetail record={detailCase} runId={run.id} />
          ) : (
            <div className="mo-pane-empty">
              <p>这一项已不在当前会话里。</p>
            </div>
          ))}
      </div>
    </aside>
  );
};
