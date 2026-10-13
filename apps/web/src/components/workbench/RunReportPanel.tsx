import React from 'react';
import type { CaseRecord, Report, Run } from '@localqa/contracts';
import { StatusBadge } from '../ui/Badge.tsx';
import { EmptyState } from '../ui/EmptyState.tsx';
import { ErrorCard } from '../ui/ErrorCard.tsx';
import { AppIcon } from '../ui/AppIcon.tsx';
import { ReportExportPanel } from './ReportExportPanel.tsx';
import { useApp } from '../../state/AppContext.tsx';
import { getRegressionProvenanceStatus } from '../../utils/provenance.ts';

const cleanupLabels: Record<string, string> = {
  not_required: '无需清理',
  pending: '待清理',
  running: '清理中',
  succeeded: '已清理',
  failed: '清理失败',
  manual_required: '需人工清理',
};

/** The run report, exports included, as one panel of the session pane. */
export const RunReportPanel: React.FC<{
  cases: CaseRecord[];
  report: Report | null;
  runId: string;
  run?: Run | null;
  onRefreshReport?: () => void;
}> = ({ cases, report, runId, run, onRefreshReport }) => {
  const { setRoute } = useApp();
  const isRegressionRun =
    report?.run.executionMode === 'regression' ||
    run?.executionMode === 'regression';
  const completeCases = cases.filter(
    (c) => getRegressionProvenanceStatus(c.definition.regression).isComplete,
  ).length;
  const percent = (value: number | null, empty: string) =>
    value !== null ? `${Math.round(value * 100)}%` : empty;

  return (
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
              <strong>{isRegressionRun ? '自动化回归' : '冒烟探索'}</strong>
            </span>
            <StatusBadge
              status={isRegressionRun ? 'regression' : 'smoke'}
              size="sm"
            />
          </div>

          {isRegressionRun && (
            <div className="panel" data-testid="report-regression-audit-card">
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
            <div className="lqa-item-card" data-testid="report-session-summary">
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
                {cleanupLabels[report.cleanupStatus] ?? report.cleanupStatus}
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
                  <span className="truncate">{item.definition.title}</span>
                  {item.verdict ? (
                    <StatusBadge status={item.verdict.status} size="sm" />
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
  );
};
