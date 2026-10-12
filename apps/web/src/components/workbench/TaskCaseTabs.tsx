import React, { useState } from 'react';
import type {
  CaseRecord,
  Finding,
  Task,
  Report,
  SessionReport,
  Run,
} from '@localqa/contracts';
import { StatusBadge } from '../ui/Badge.tsx';
import { EmptyState } from '../ui/EmptyState.tsx';
import { ErrorCard } from '../ui/ErrorCard.tsx';
import { AppIcon } from '../ui/AppIcon.tsx';
import { ReportExportPanel } from './ReportExportPanel.tsx';
import { useApp } from '../../state/AppContext.tsx';
import { getRegressionProvenanceStatus } from '../../utils/provenance.ts';
import {
  TaskExecutionDetail,
  taskRoleLabel,
  taskStageLabel,
  taskDurationLabel,
} from './TaskExecutionDetail.tsx';

const cleanupLabels: Record<string, string> = {
  not_required: '无需清理',
  pending: '待清理',
  running: '清理中',
  succeeded: '已清理',
  failed: '清理失败',
  manual_required: '需人工清理',
};

interface TaskCaseTabsProps {
  cases: CaseRecord[];
  findings: Finding[];
  tasks: Task[];
  report: Report | null;
  session?: SessionReport | null;
  runId: string;
  run?: Run | null;
  onRefreshReport?: () => void;
}

export const TaskCaseTabs: React.FC<TaskCaseTabsProps> = ({
  cases,
  findings,
  tasks,
  report,
  session,
  runId,
  run,
  onRefreshReport,
}) => {
  const [activeTab, setActiveTab] = useState<
    'planning' | 'cases' | 'findings' | 'tasks' | 'report'
  >('cases');
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const { setRoute } = useApp();
  const isRegressionRun =
    report?.run.executionMode === 'regression' ||
    run?.executionMode === 'regression';
  const completeCases = cases.filter(
    (c) => getRegressionProvenanceStatus(c.definition.regression).isComplete,
  ).length;
  const percent = (value: number | null, empty: string) =>
    value !== null ? `${Math.round(value * 100)}%` : empty;

  const tabs = [
    ...(session
      ? [
          {
            key: 'planning' as const,
            label: '主 AI 规划',
            count: session.round,
          },
        ]
      : []),
    { key: 'cases' as const, label: '用例', count: cases.length },
    { key: 'findings' as const, label: '缺陷', count: findings.length },
    { key: 'tasks' as const, label: '任务', count: tasks.length },
    { key: 'report' as const, label: '报告', count: null },
  ];

  return (
    <section
      className={`card workbench-column workbench-right-panel ${isCollapsed ? 'is-collapsed' : ''}`}
      data-testid="workbench-tabs-panel"
    >
      <div className="lqa-tabs-header">
        {!isCollapsed && (
          <div className="tabs-list" role="tablist">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.key}
                className={`tab-trigger ${activeTab === tab.key ? 'is-active' : ''}`}
                onClick={() => setActiveTab(tab.key)}
                data-testid={`tab-btn-${tab.key}`}
              >
                {tab.label}
                {tab.count !== null && (
                  <span className="tab-count">{tab.count}</span>
                )}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className="lqa-icon-button"
          onClick={() => setIsCollapsed(!isCollapsed)}
          title={isCollapsed ? '展开面板' : '折叠面板'}
          aria-label={isCollapsed ? '展开面板' : '折叠面板'}
          data-testid="btn-toggle-tabs-collapse"
        >
          <AppIcon
            name={isCollapsed ? 'chevron-left' : 'chevron-right'}
            size={16}
          />
        </button>
      </div>

      {isCollapsed ? null : (
        <div className="lqa-tabs-body">
          {activeTab === 'cases' && (
            <div data-testid="tab-content-cases">
              {cases.length === 0 ? (
                <EmptyState
                  compact
                  icon="list"
                  title="暂无用例记录"
                  description={
                    run &&
                    ['completed', 'cancelled', 'failed'].includes(run.status)
                      ? '本次运行尚未形成可验证用例，不能据此认定测试通过。'
                      : '正在等待规划或执行回传真实用例。'
                  }
                />
              ) : (
                <div className="lqa-card-list">
                  {cases.map((c) => {
                    const isNotRun = c.outcome === 'not_run' || !c.verdict;
                    const verdictStatus = c.verdict ? c.verdict.status : null;
                    const isRegressionCase =
                      !!c.definition.regression ||
                      run?.executionMode === 'regression';
                    const regression = c.definition.regression;
                    const openDetail = () =>
                      setRoute('case-detail', {
                        caseId: c.definition.id,
                        runId,
                      });

                    return (
                      <div
                        key={c.definition.id}
                        className="lqa-item-card is-clickable"
                        role="button"
                        tabIndex={0}
                        onClick={openDetail}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') openDetail();
                        }}
                        data-testid={`case-item-${c.definition.id}`}
                      >
                        <div className="lqa-item-top">
                          <span className="lqa-item-id">{c.definition.id}</span>
                          <span className="row">
                            {isRegressionCase && (
                              <span
                                className="badge badge-primary badge-sm"
                                data-testid={`badge-regression-case-${c.definition.id}`}
                              >
                                回归用例
                              </span>
                            )}
                            {isNotRun ? (
                              <StatusBadge
                                status="not_run"
                                label="未执行"
                                size="sm"
                              />
                            ) : (
                              <StatusBadge status={verdictStatus!} size="sm" />
                            )}
                          </span>
                        </div>
                        <div className="lqa-item-title">
                          {c.definition.title}
                        </div>
                        <p className="lqa-item-text">{c.definition.summary}</p>

                        {regression ? (
                          <div
                            className="lqa-provenance"
                            data-testid={`case-provenance-meta-${c.definition.id}`}
                          >
                            <span>
                              源版本{' '}
                              {regression.sourceVersionId ? (
                                <code>
                                  {regression.sourceVersionId.slice(0, 8)}
                                </code>
                              ) : (
                                <strong className="text-danger">未验证</strong>
                              )}
                            </span>
                            <span>
                              原 SHA{' '}
                              {regression.sourceDocumentSha256 ? (
                                <code>
                                  {regression.sourceDocumentSha256.slice(0, 8)}
                                </code>
                              ) : (
                                <strong className="text-danger">未验证</strong>
                              )}
                            </span>
                            {regression.snapshotDocumentSha256 && (
                              <span>
                                快照 SHA{' '}
                                <code>
                                  {regression.snapshotDocumentSha256.slice(
                                    0,
                                    8,
                                  )}
                                </code>
                              </span>
                            )}
                            <span>
                              模块 {regression.moduleSnapshots?.length ?? 0}
                            </span>
                            {(() => {
                              const provStatus =
                                getRegressionProvenanceStatus(regression);
                              return (
                                <span
                                  className={`badge badge-sm badge-${provStatus.badgeVariant}`}
                                  data-testid={
                                    provStatus.isComplete
                                      ? `badge-case-provenance-complete-${c.definition.id}`
                                      : `badge-case-unverified-${c.definition.id}`
                                  }
                                >
                                  {provStatus.statusLabel}
                                </span>
                              );
                            })()}
                          </div>
                        ) : isRegressionCase ? (
                          <div
                            className="lqa-provenance is-warning"
                            data-testid={`case-missing-regression-binding-${c.definition.id}`}
                          >
                            <AppIcon name="alert-triangle" size={12} />
                            回归来源缺失：未关联冻结基线版本与用例库来源（未验证）
                          </div>
                        ) : null}

                        <div className="lqa-item-footer">
                          <button
                            type="button"
                            className="btn btn-link text-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              openDetail();
                            }}
                            data-testid={`btn-case-detail-${c.definition.id}`}
                          >
                            查看详情 / 保存到用例库
                            <AppIcon name="arrow-right" size={12} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === 'planning' && session && (
            <div
              className="stack stack-md"
              data-testid="session-planning-panel"
            >
              <div className="alert alert-info">
                <div className="alert-body">
                  <strong>
                    {
                      {
                        planning:
                          run &&
                          ['completed', 'failed', 'cancelled'].includes(
                            run.status,
                          )
                            ? '规划未完成'
                            : '正在规划覆盖范围',
                        working: '子任务执行中',
                        reviewing: '正在复核结果与规划补测',
                        finalizing: '正在验收总结',
                        complete: '会话已结束',
                      }[session.status]
                    }
                  </strong>
                  <p>
                    第 {session.round} 轮 · 最多 6 轮 · {session.caseIds.length}{' '}
                    条用例 · {session.exploredUrls.length} 个探索入口
                  </p>
                </div>
              </div>
              <div>
                <div className="section-label">测试目标</div>
                <p>
                  {session.objective ||
                    '探索目标页面和可观察流程，检查页面可用性。'}
                </p>
              </div>
              <div>
                <div className="section-label">当前计划</div>
                <p data-testid="session-current-plan">
                  {session.plan ||
                    (run &&
                    ['completed', 'failed', 'cancelled'].includes(run.status)
                      ? '没有有效的 AI 规划输出。请检查模型错误与覆盖缺口；不能认定规划完成。'
                      : '等待主 AI 返回可核验的第一轮计划…')}
                </p>
              </div>
              {session.history.map((round) => (
                <div
                  className="lqa-item-card"
                  key={round.round}
                  data-testid={`session-round-${round.round}`}
                >
                  <div className="lqa-item-top">
                    <strong>第 {round.round} 轮</strong>
                    <span>
                      {round.caseIds.length} 条执行用例 ·{' '}
                      {round.exploreTargets.length} 个探索任务
                    </span>
                  </div>
                  <p className="lqa-item-text">{round.reason}</p>
                </div>
              ))}
              {session.summary && (
                <div>
                  <div className="section-label">主 AI 总结</div>
                  <p data-testid="session-summary">{session.summary}</p>
                  <p className="field-hint">
                    通过数、缺陷数及复现状态以「报告」中的执行记录为准。
                  </p>
                </div>
              )}
              {session.coverageGaps.length > 0 && (
                <div>
                  <div className="section-label">覆盖缺口与限制</div>
                  <ul>
                    {session.coverageGaps.map((gap, i) => (
                      <li key={i}>{gap}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {activeTab === 'findings' && (
            <div data-testid="tab-content-findings">
              {findings.length === 0 ? (
                <EmptyState
                  compact
                  title={
                    run &&
                    ['completed', 'cancelled', 'failed'].includes(run.status) &&
                    cases.length > 0 &&
                    cases.every((c) => !!c.verdict)
                      ? '本次没有已确认缺陷'
                      : '尚无已确认缺陷'
                  }
                  description={
                    cases.length === 0
                      ? '尚无已验证的用例，0 个缺陷不代表产品没有问题。'
                      : '缺陷仅以已执行用例及真实 Verdict 为准，未覆盖的业务不在结论范围内。'
                  }
                  icon="check-circle"
                />
              ) : (
                <div className="lqa-card-list">
                  {findings.map((f) => (
                    <div
                      key={f.id}
                      className="lqa-item-card is-clickable is-danger"
                      role="button"
                      tabIndex={0}
                      onClick={() =>
                        setRoute('finding-detail', { findingId: f.id, runId })
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter')
                          setRoute('finding-detail', {
                            findingId: f.id,
                            runId,
                          });
                      }}
                      data-testid={`finding-item-${f.id}`}
                    >
                      <div className="lqa-item-top">
                        <span className="lqa-item-id">{f.id}</span>
                        <StatusBadge status={f.status} size="sm" />
                      </div>
                      <div className="lqa-item-title">{f.title}</div>
                      <p className="lqa-item-text">实际结果：{f.actual}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'tasks' && (
            <div data-testid="tab-content-tasks">
              {tasks.length === 0 ? (
                <EmptyState compact icon="list" title="暂无任务" />
              ) : (
                <div className="lqa-card-list">
                  {tasks.map((t) => (
                    <div
                      key={t.id}
                      className="lqa-item-card"
                      data-testid={`task-item-${t.id}`}
                    >
                      <button
                        type="button"
                        className="mo-dispatch-card"
                        onClick={() =>
                          setExpandedTaskId((old) =>
                            old === t.id ? null : t.id,
                          )
                        }
                        aria-expanded={expandedTaskId === t.id}
                        data-testid={`btn-expand-task-${t.id}`}
                      >
                        <span className="mo-dispatch-copy">
                          <strong>{taskRoleLabel[t.role]}</strong>
                          <span>{taskStageLabel[t.summary] ?? t.summary}</span>
                          <span className="text-xs muted">
                            {taskDurationLabel(t.elapsedSeconds)}
                          </span>
                        </span>
                        <StatusBadge status={t.status} size="sm" />
                      </button>
                      {expandedTaskId === t.id && (
                        <TaskExecutionDetail
                          task={t}
                          active={t.status === 'running'}
                          runTargetUrl={run?.targetUrl ?? ''}
                          onClose={() => setExpandedTaskId(null)}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'report' && (
            <div className="stack stack-sm" data-testid="tab-content-report">
              <div className="row spread">
                <span className="section-label lqa-flush-label">运行报告</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  data-testid="btn-refresh-report"
                  onClick={onRefreshReport}
                  disabled={!onRefreshReport}
                >
                  <AppIcon name="refresh" size={13} />
                  刷新
                </button>
              </div>
              {!report ? (
                <EmptyState
                  compact
                  icon="file-text"
                  title="报告暂不可用"
                  description="运行可能尚未形成报告，或报告加载失败。可刷新重试；不要把缺失的报告当作通过。"
                />
              ) : (
                <>
                  {report.run.completion === 'partial' && (
                    <ErrorCard
                      type="partial_report"
                      message="该报告因预算用尽或中途停止而只覆盖部分范围，仅代表已完成部分的结论。"
                    />
                  )}

                  <div
                    className="lqa-report-mode"
                    data-testid="report-execution-mode-card"
                  >
                    <span>
                      执行模式：
                      <strong>
                        {isRegressionRun ? '自动化回归' : '冒烟探索'}
                      </strong>
                    </span>
                    <StatusBadge
                      status={isRegressionRun ? 'regression' : 'smoke'}
                      size="sm"
                    />
                  </div>

                  {isRegressionRun && (
                    <div
                      className="panel"
                      data-testid="report-regression-audit-card"
                    >
                      <div className="section-label">回归基线来源审计</div>
                      <dl className="kv">
                        <dt>回归用例</dt>
                        <dd>{cases.length}</dd>
                        <dt>来源信息完整</dt>
                        <dd className="text-success strong">{completeCases}</dd>
                        {completeCases < cases.length && (
                          <>
                            <dt>来源不完整</dt>
                            <dd
                              className="text-danger strong"
                              data-testid="report-unverified-cases-count"
                            >
                              {cases.length - completeCases}
                            </dd>
                          </>
                        )}
                      </dl>
                      <p className="field-hint lqa-panel-note">
                        来源审计只反映基线元数据是否完整；「未验证」与运行判定相互独立，不影响已有用例的结论。
                      </p>
                    </div>
                  )}

                  {report.session?.summary && (
                    <div
                      className="lqa-item-card"
                      data-testid="report-session-summary"
                    >
                      <div className="section-label">主 AI 总结</div>
                      <p>{report.session.summary}</p>
                    </div>
                  )}
                  <div className="stat-grid lqa-report-stats">
                    {[
                      ['计划用例', report.summary.planned, ''],
                      ['已尝试', report.summary.attempted, ''],
                      ['已判定', report.summary.evaluated, ''],
                      ['已通过', report.summary.passed, 'text-success'],
                      ['发现缺陷', report.summary.issueFound, 'text-danger'],
                      ['受阻', report.summary.blocked, 'text-warning'],
                      ['不确定', report.summary.inconclusive, ''],
                      ['未执行', report.summary.notRun, ''],
                    ].map(([label, value, tone]) => (
                      <div className="stat" key={label as string}>
                        <div className="stat-label">{label}</div>
                        <div className={`stat-value ${tone}`}>{value}</div>
                      </div>
                    ))}
                    <div className="stat">
                      <div className="stat-label">通过率</div>
                      <div className="stat-value">
                        {percent(report.summary.passRate, '无判定')}
                      </div>
                    </div>
                    <div className="stat">
                      <div className="stat-label">尝试率</div>
                      <div className="stat-value">
                        {percent(report.summary.attemptRate, '暂无')}
                      </div>
                    </div>
                  </div>

                  <div
                    className="panel stack stack-sm"
                    data-testid="report-evidence-summary"
                  >
                    <dl className="kv">
                      <dt>缺陷</dt>
                      <dd>{report.findings.length}</dd>
                      <dt>复现</dt>
                      <dd>{report.reproductions.length}</dd>
                      <dt>证据</dt>
                      <dd>{report.artifacts.length}</dd>
                      <dt>清理状态</dt>
                      <dd title={report.cleanupStatus}>
                        {cleanupLabels[report.cleanupStatus] ??
                          report.cleanupStatus}
                      </dd>
                    </dl>
                    {report.coverageGaps.length > 0 && (
                      <div>
                        <div className="section-label">覆盖缺口</div>
                        <ul className="lqa-bullets">
                          {report.coverageGaps.map((gap, i) => (
                            <li key={i}>{gap}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {report.warnings.length > 0 && (
                      <div>
                        <div className="section-label">运行警告</div>
                        <ul className="lqa-bullets">
                          {report.warnings.map((warning, i) => (
                            <li key={i}>{warning}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>

                  {report.findings.length > 0 && (
                    <div data-testid="report-findings">
                      <div className="section-label">缺陷明细</div>
                      <div className="lqa-link-list">
                        {report.findings.map((finding) => (
                          <button
                            key={finding.id}
                            type="button"
                            className="lqa-link-row"
                            data-testid={`report-finding-${finding.id}`}
                            onClick={() =>
                              setRoute('finding-detail', {
                                findingId: finding.id,
                                runId,
                              })
                            }
                          >
                            <span className="truncate">{finding.title}</span>
                            <span className="row nowrap">
                              <span className="subtle text-xs">
                                证据 {finding.evidenceRefs.length} 条
                              </span>
                              <StatusBadge status={finding.status} size="sm" />
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div data-testid="report-case-results">
                    <div className="section-label">
                      用例判定（{report.cases.length}）
                    </div>
                    <div className="lqa-link-list">
                      {report.cases.map((item) => (
                        <button
                          key={item.definition.id}
                          type="button"
                          className="lqa-link-row"
                          data-testid={`report-case-${item.definition.id}`}
                          onClick={() =>
                            setRoute('case-detail', {
                              caseId: item.definition.id,
                              runId,
                            })
                          }
                        >
                          <span className="truncate">
                            {item.definition.title}
                          </span>
                          {item.verdict ? (
                            <StatusBadge
                              status={item.verdict.status}
                              size="sm"
                            />
                          ) : (
                            <StatusBadge
                              status={item.outcome}
                              label="未形成判定"
                              size="sm"
                            />
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                  <ReportExportPanel runId={runId} />
                </>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
};
