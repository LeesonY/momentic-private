import React, { useState } from 'react';
import type { CaseRecord, Finding, Task, Report } from '@localqa/contracts';
import { StatusBadge } from '../ui/Badge.tsx';
import { EmptyState } from '../ui/EmptyState.tsx';
import { ErrorCard } from '../ui/ErrorCard.tsx';
import { useApp } from '../../state/AppContext.tsx';

interface TaskCaseTabsProps {
  cases: CaseRecord[];
  findings: Finding[];
  tasks: Task[];
  report: Report | null;
  runId: string;
}

export const TaskCaseTabs: React.FC<TaskCaseTabsProps> = ({
  cases,
  findings,
  tasks,
  report,
  runId,
}) => {
  const [activeTab, setActiveTab] = useState<
    'cases' | 'findings' | 'tasks' | 'report'
  >('cases');
  const [isCollapsed, setIsCollapsed] = useState(false);
  const { setRoute } = useApp();

  return (
    <div
      className="card workbench-right-panel"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: '16px',
        overflow: 'hidden',
        width: isCollapsed ? '48px' : '420px',
        transition: 'width 0.2s ease-in-out',
      }}
      data-testid="workbench-tabs-panel"
    >
      {/* Panel Header & Collapse Toggle */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '12px',
        }}
      >
        {!isCollapsed && (
          <div style={{ display: 'flex', gap: '4px', overflowX: 'auto' }}>
            <button
              className={`btn btn-sm ${activeTab === 'cases' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveTab('cases')}
              data-testid="tab-btn-cases"
            >
              用例 ({cases.length})
            </button>
            <button
              className={`btn btn-sm ${activeTab === 'findings' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveTab('findings')}
              data-testid="tab-btn-findings"
            >
              缺陷 ({findings.length})
            </button>
            <button
              className={`btn btn-sm ${activeTab === 'tasks' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveTab('tasks')}
              data-testid="tab-btn-tasks"
            >
              任务 ({tasks.length})
            </button>
            <button
              className={`btn btn-sm ${activeTab === 'report' ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setActiveTab('report')}
              data-testid="tab-btn-report"
            >
              报告
            </button>
          </div>
        )}
        <button
          className="btn btn-secondary btn-sm"
          style={{ padding: '4px 6px', fontSize: '0.8rem' }}
          onClick={() => setIsCollapsed(!isCollapsed)}
          title={isCollapsed ? '展开面板' : '折叠面板'}
          data-testid="btn-toggle-tabs-collapse"
        >
          {isCollapsed ? '◀' : '▶'}
        </button>
      </div>

      {isCollapsed ? null : (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {/* TAB 1: CASES */}
          {activeTab === 'cases' && (
            <div data-testid="tab-content-cases">
              {cases.length === 0 ? (
                <EmptyState
                  title="暂无用例记录"
                  description="冒烟规划中或此运行尚未生成用例。"
                />
              ) : (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                  }}
                >
                  {cases.map((c) => (
                    <div
                      key={c.definition.id}
                      style={{
                        padding: '12px',
                        border: '1px solid var(--color-border-subtle)',
                        borderRadius: 'var(--radius-md)',
                        cursor: 'pointer',
                        transition: 'background-color 0.15s',
                      }}
                      onClick={() =>
                        setRoute('case-detail', {
                          caseId: c.definition.id,
                          runId,
                        })
                      }
                      data-testid={`case-item-${c.definition.id}`}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          marginBottom: '6px',
                        }}
                      >
                        <span
                          style={{
                            fontSize: '0.75rem',
                            color: 'var(--color-text-subtle)',
                          }}
                        >
                          {c.definition.id}
                        </span>
                        <StatusBadge status={c.outcome} size="sm" />
                      </div>
                      <div
                        style={{
                          fontSize: '0.875rem',
                          fontWeight: 600,
                          color: 'var(--color-text-main)',
                          marginBottom: '4px',
                        }}
                      >
                        {c.definition.title}
                      </div>
                      <p
                        style={{
                          fontSize: '0.8rem',
                          color: 'var(--color-text-muted)',
                          lineHeight: 1.4,
                        }}
                      >
                        {c.definition.summary}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 2: FINDINGS */}
          {activeTab === 'findings' && (
            <div data-testid="tab-content-findings">
              {findings.length === 0 ? (
                <EmptyState
                  title="未发现任何缺陷"
                  description="当前所有自动化检查均未触发失败判定。"
                  icon="🎉"
                />
              ) : (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                  }}
                >
                  {findings.map((f) => (
                    <div
                      key={f.id}
                      style={{
                        padding: '12px',
                        border: '1px solid var(--color-danger-border)',
                        backgroundColor: 'var(--color-danger-bg)',
                        borderRadius: 'var(--radius-md)',
                        cursor: 'pointer',
                      }}
                      onClick={() =>
                        setRoute('finding-detail', { findingId: f.id, runId })
                      }
                      data-testid={`finding-item-${f.id}`}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          marginBottom: '6px',
                        }}
                      >
                        <span
                          style={{
                            fontSize: '0.75rem',
                            color: 'var(--color-danger-text)',
                          }}
                        >
                          {f.id}
                        </span>
                        <StatusBadge status={f.status} size="sm" />
                      </div>
                      <div
                        style={{
                          fontSize: '0.875rem',
                          fontWeight: 600,
                          color: 'var(--color-danger-text)',
                          marginBottom: '4px',
                        }}
                      >
                        {f.title}
                      </div>
                      <div
                        style={{
                          fontSize: '0.8rem',
                          color: 'var(--color-text-main)',
                        }}
                      >
                        实际结果: {f.actual}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: TASKS */}
          {activeTab === 'tasks' && (
            <div data-testid="tab-content-tasks">
              {tasks.length === 0 ? (
                <EmptyState title="暂无任务队列" />
              ) : (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px',
                  }}
                >
                  {tasks.map((t) => (
                    <div
                      key={t.id}
                      style={{
                        padding: '12px',
                        border: '1px solid var(--color-border-subtle)',
                        borderRadius: 'var(--radius-md)',
                      }}
                      data-testid={`task-item-${t.id}`}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          marginBottom: '4px',
                        }}
                      >
                        <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>
                          角色: {t.role.toUpperCase()}
                        </span>
                        <StatusBadge status={t.status} size="sm" />
                      </div>
                      <div
                        style={{
                          fontSize: '0.8rem',
                          color: 'var(--color-text-muted)',
                        }}
                      >
                        {t.summary || '任务执行中...'}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 4: REPORT */}
          {activeTab === 'report' && (
            <div data-testid="tab-content-report">
              {!report ? (
                <EmptyState
                  title="报告尚未就绪"
                  description="运行进入 finalize 阶段后将自动生成终态验收报告。"
                />
              ) : (
                <div>
                  {report.run.completion === 'partial' && (
                    <ErrorCard
                      type="partial_report"
                      message="该报告为预算用尽或中途停止产生的 Partial 报告，仅代表已完成区间的有效结论。"
                    />
                  )}

                  <div
                    className="card"
                    style={{
                      marginBottom: '14px',
                      backgroundColor: 'var(--color-bg-subtle)',
                    }}
                  >
                    <h4
                      style={{
                        fontSize: '0.9rem',
                        fontWeight: 600,
                        marginBottom: '8px',
                      }}
                    >
                      统计指标 (Metrics)
                    </h4>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr',
                        gap: '8px',
                        fontSize: '0.85rem',
                      }}
                    >
                      <div>
                        计划用例: <strong>{report.summary.planned}</strong>
                      </div>
                      <div>
                        已尝试: <strong>{report.summary.attempted}</strong>
                      </div>
                      <div>
                        已判定: <strong>{report.summary.evaluated}</strong>
                      </div>
                      <div>
                        已通过:{' '}
                        <strong style={{ color: 'var(--color-success)' }}>
                          {report.summary.passed}
                        </strong>
                      </div>
                      <div>
                        发现缺陷:{' '}
                        <strong style={{ color: 'var(--color-danger)' }}>
                          {report.summary.issueFound}
                        </strong>
                      </div>
                      <div>
                        受阻:{' '}
                        <strong style={{ color: 'var(--color-warning)' }}>
                          {report.summary.blocked}
                        </strong>
                      </div>
                    </div>
                    <div
                      style={{
                        marginTop: '10px',
                        paddingTop: '10px',
                        borderTop: '1px solid var(--color-border-subtle)',
                      }}
                    >
                      <div>
                        通过率:{' '}
                        <strong>
                          {report.summary.passRate !== null
                            ? `${Math.round(report.summary.passRate * 100)}%`
                            : '无判定'}
                        </strong>
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '8px' }}>
                    <button
                      className="btn btn-secondary btn-sm"
                      style={{ flex: 1 }}
                      onClick={() => alert('已导出 JSON 报告')}
                    >
                      导出 JSON
                    </button>
                    <button
                      className="btn btn-secondary btn-sm"
                      style={{ flex: 1 }}
                      onClick={() => alert('已导出 Markdown 报告')}
                    >
                      导出 Markdown
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
