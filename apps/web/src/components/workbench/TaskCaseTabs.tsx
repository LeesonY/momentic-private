import React, { useState } from 'react';
import type {
  CaseRecord,
  Finding,
  Task,
  Report,
  Run,
} from '@localqa/contracts';
import { StatusBadge } from '../ui/Badge.tsx';
import { EmptyState } from '../ui/EmptyState.tsx';
import { ErrorCard } from '../ui/ErrorCard.tsx';
import { ReportExportPanel } from './ReportExportPanel.tsx';
import { useApp } from '../../state/AppContext.tsx';
import { getRegressionProvenanceStatus } from '../../utils/provenance.ts';

interface TaskCaseTabsProps {
  cases: CaseRecord[];
  findings: Finding[];
  tasks: Task[];
  report: Report | null;
  runId: string;
  run?: Run | null;
  onRefreshReport?: () => void;
}

export const TaskCaseTabs: React.FC<TaskCaseTabsProps> = ({
  cases,
  findings,
  tasks,
  report,
  runId,
  run,
  onRefreshReport,
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
                  {cases.map((c) => {
                    const isNotRun = c.outcome === 'not_run' || !c.verdict;
                    const verdictStatus = c.verdict ? c.verdict.status : null;
                    const isRegressionCase =
                      !!c.definition.regression ||
                      run?.executionMode === 'regression';
                    const regression = c.definition.regression;

                    return (
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
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '6px',
                            }}
                          >
                            {isRegressionCase && (
                              <span
                                className="badge badge-primary"
                                style={{
                                  fontSize: '0.68rem',
                                  padding: '1px 5px',
                                }}
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
                          </div>
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
                            marginBottom: '4px',
                          }}
                        >
                          {c.definition.summary}
                        </p>

                        {/* Regression Provenance Metadata */}
                        {regression ? (
                          <div
                            style={{
                              display: 'flex',
                              flexWrap: 'wrap',
                              gap: '6px',
                              alignItems: 'center',
                              fontSize: '0.72rem',
                              padding: '4px 8px',
                              backgroundColor: 'var(--color-bg-subtle)',
                              borderRadius: 'var(--radius-sm)',
                              margin: '6px 0',
                            }}
                            data-testid={`case-provenance-meta-${c.definition.id}`}
                          >
                            <span>
                              源版本:{' '}
                              {regression.sourceVersionId ? (
                                <code>
                                  {regression.sourceVersionId.slice(0, 8)}...
                                </code>
                              ) : (
                                <strong
                                  style={{ color: 'var(--color-danger)' }}
                                >
                                  未验证
                                </strong>
                              )}
                            </span>
                            <span>·</span>
                            <span>
                              原SHA:{' '}
                              {regression.sourceDocumentSha256 ? (
                                <code>
                                  {regression.sourceDocumentSha256.slice(0, 8)}
                                  ...
                                </code>
                              ) : (
                                <strong
                                  style={{ color: 'var(--color-danger)' }}
                                >
                                  未验证
                                </strong>
                              )}
                            </span>
                            {regression.snapshotDocumentSha256 && (
                              <>
                                <span>·</span>
                                <span>
                                  快照SHA:{' '}
                                  <code>
                                    {regression.snapshotDocumentSha256.slice(
                                      0,
                                      8,
                                    )}
                                    ...
                                  </code>
                                </span>
                              </>
                            )}
                            <span>·</span>
                            <span>
                              模块: {regression.moduleSnapshots?.length ?? 0}
                            </span>
                            {(() => {
                              const provStatus =
                                getRegressionProvenanceStatus(regression);
                              return (
                                <span
                                  className={`badge badge-${provStatus.badgeVariant}`}
                                  style={{
                                    fontSize: '0.65rem',
                                    padding: '1px 5px',
                                  }}
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
                            style={{
                              padding: '4px 8px',
                              backgroundColor: 'var(--color-warning-subtle)',
                              color: 'var(--color-warning-text)',
                              borderRadius: 'var(--radius-sm)',
                              fontSize: '0.72rem',
                              margin: '6px 0',
                            }}
                            data-testid={`case-missing-regression-binding-${c.definition.id}`}
                          >
                            ⚠️ 回归来源缺失: 未关联冻结基线版本与用例库来源
                            (未验证)
                          </div>
                        ) : null}

                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'flex-end',
                            marginTop: '6px',
                          }}
                        >
                          <button
                            className="btn btn-secondary btn-xs"
                            style={{ fontSize: '0.72rem', padding: '2px 8px' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              setRoute('case-detail', {
                                caseId: c.definition.id,
                                runId,
                              });
                            }}
                            data-testid={`btn-case-detail-${c.definition.id}`}
                          >
                            查看详情与保存到用例库 ↗
                          </button>
                        </div>
                      </div>
                    );
                  })}
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
                  icon="check-circle"
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
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                data-testid="btn-refresh-report"
                onClick={onRefreshReport}
                disabled={!onRefreshReport}
                style={{ marginBottom: 10 }}
              >
                刷新运行与报告
              </button>
              {!report ? (
                <EmptyState
                  title="报告暂不可用"
                  description="运行可能尚未形成可用报告，或报告加载失败。可刷新重试；不要将缺失的报告视为通过。"
                />
              ) : (
                <div>
                  {report.run.completion === 'partial' && (
                    <ErrorCard
                      type="partial_report"
                      message="该报告为预算用尽或中途停止产生的 Partial 报告，仅代表已完成区间的有效结论。"
                    />
                  )}

                  {/* Execution Mode Card */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '8px 12px',
                      backgroundColor: 'var(--color-bg-subtle)',
                      borderRadius: 'var(--radius-sm)',
                      marginBottom: '10px',
                      fontSize: '0.85rem',
                    }}
                    data-testid="report-execution-mode-card"
                  >
                    <div>
                      执行模式:{' '}
                      <strong>
                        {report.run.executionMode === 'regression' ||
                        run?.executionMode === 'regression'
                          ? '自动化回归 (Regression)'
                          : '冒烟探索 (Smoke)'}
                      </strong>
                    </div>
                    <StatusBadge
                      status={
                        report.run.executionMode === 'regression' ||
                        run?.executionMode === 'regression'
                          ? 'regression'
                          : 'smoke'
                      }
                      size="sm"
                    />
                  </div>

                  {/* Regression Audit Provenance (when regression mode) */}
                  {(report.run.executionMode === 'regression' ||
                    run?.executionMode === 'regression') && (
                    <div
                      className="card"
                      style={{
                        marginBottom: '14px',
                        backgroundColor: 'var(--color-bg-subtle)',
                        borderLeft: '4px solid var(--color-primary)',
                      }}
                      data-testid="report-regression-audit-card"
                    >
                      <h4
                        style={{
                          fontSize: '0.85rem',
                          fontWeight: 600,
                          marginBottom: '6px',
                        }}
                      >
                        回归用例基线与来源说明审计 (Regression Baseline Audit)
                      </h4>
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '4px',
                          fontSize: '0.8rem',
                          color: 'var(--color-text-main)',
                        }}
                      >
                        <div>
                          回归用例总数: <strong>{cases.length}</strong>
                        </div>
                        <div>
                          来源信息完整用例:{' '}
                          <strong style={{ color: 'var(--color-success)' }}>
                            {
                              cases.filter(
                                (c) =>
                                  getRegressionProvenanceStatus(
                                    c.definition.regression,
                                  ).isComplete,
                              ).length
                            }
                          </strong>
                        </div>
                        {cases.some(
                          (c) =>
                            !getRegressionProvenanceStatus(
                              c.definition.regression,
                            ).isComplete,
                        ) && (
                          <div
                            style={{ color: 'var(--color-danger)' }}
                            data-testid="report-unverified-cases-count"
                          >
                            ⚠️ 包含未验证/来源信息不完整用例:{' '}
                            <strong>
                              {
                                cases.filter(
                                  (c) =>
                                    !getRegressionProvenanceStatus(
                                      c.definition.regression,
                                    ).isComplete,
                                ).length
                              }
                            </strong>
                          </div>
                        )}
                        <div
                          style={{
                            fontSize: '0.72rem',
                            color: 'var(--color-text-subtle)',
                            marginTop: '6px',
                          }}
                        >
                          *
                          溯源审计仅反映基线元数据契约完整性，未验证状态独立于运行裁决
                          (Verdict)，不影响既有用例判定。
                        </div>
                      </div>
                    </div>
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
                      <div>
                        不确定: <strong>{report.summary.inconclusive}</strong>
                      </div>
                      <div>
                        未执行: <strong>{report.summary.notRun}</strong>
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
                      <div>
                        尝试率：
                        {report.summary.attemptRate !== null
                          ? `${Math.round(report.summary.attemptRate * 100)}%`
                          : '暂无数据'}
                      </div>
                    </div>
                  </div>

                  <div
                    data-testid="report-evidence-summary"
                    style={{ fontSize: '0.8rem' }}
                  >
                    <p>
                      缺陷：{report.findings.length} · 复现：
                      {report.reproductions.length} · 证据：
                      {report.artifacts.length} · 清理状态：
                      {report.cleanupStatus}
                    </p>
                    {report.coverageGaps.length > 0 && (
                      <div>
                        <strong>覆盖缺口</strong>
                        <ul>
                          {report.coverageGaps.map((gap, i) => (
                            <li key={i}>{gap}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {report.warnings.length > 0 && (
                      <div>
                        <strong>运行警告</strong>
                        <ul>
                          {report.warnings.map((warning, i) => (
                            <li key={i}>{warning}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                  {report.findings.length > 0 && (
                    <div
                      data-testid="report-findings"
                      style={{ fontSize: '0.8rem' }}
                    >
                      <strong>缺陷明细（查看证据）</strong>
                      {report.findings.map((finding) => (
                        <div key={finding.id} style={{ marginTop: 6 }}>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            data-testid={`report-finding-${finding.id}`}
                            onClick={() =>
                              setRoute('finding-detail', {
                                findingId: finding.id,
                                runId,
                              })
                            }
                          >
                            {finding.title} · {finding.status} · 证据{' '}
                            {finding.evidenceRefs.length} 条
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div
                    data-testid="report-case-results"
                    style={{ fontSize: '0.8rem', marginTop: 12 }}
                  >
                    <strong>报告用例判定（{report.cases.length}）</strong>
                    {report.cases.map((item) => (
                      <div key={item.definition.id} style={{ marginTop: 5 }}>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          data-testid={`report-case-${item.definition.id}`}
                          onClick={() =>
                            setRoute('case-detail', {
                              caseId: item.definition.id,
                              runId,
                            })
                          }
                        >
                          {item.definition.title} · {item.outcome} ·
                          {item.verdict
                            ? ` ${item.verdict.status}`
                            : ' 未形成判定'}
                        </button>
                      </div>
                    ))}
                  </div>
                  <ReportExportPanel runId={runId} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
