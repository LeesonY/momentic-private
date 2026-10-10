import React, { useEffect, useState } from 'react';
import type { CaseRecord, Step, CaseAttempt, Run } from '@localqa/contracts';
import { useAppContext } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { Page } from '../components/layout/Page.tsx';
import { StatusBadge } from '../components/ui/Badge.tsx';
import { ErrorCard } from '../components/ui/ErrorCard.tsx';
import { SaveToLibraryModal } from '../components/saved-cases/SaveToLibraryModal.tsx';
import { getRegressionProvenanceStatus } from '../utils/provenance.ts';

export const CaseDetailPage: React.FC = () => {
  const { routeParams, setRoute, currentProject } = useAppContext();
  const caseId = routeParams.caseId;
  const runId = routeParams.runId;

  const [caseRecord, setCaseRecord] = useState<CaseRecord | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [attempts, setAttempts] = useState<CaseAttempt[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveModalOpen, setSaveModalOpen] = useState(false);

  useEffect(() => {
    if (!caseId) return;

    let mounted = true;
    setLoading(true);
    setError(null);

    Promise.all([
      defaultApiClient.getCase(caseId),
      defaultApiClient.listTaskSteps(caseId).catch(() => ({ items: [] })),
      defaultApiClient.listCaseAttempts(caseId).catch(() => ({ items: [] })),
      runId
        ? defaultApiClient.getRun(runId).catch(() => null)
        : Promise.resolve(null),
    ])
      .then(([c, st, att, r]) => {
        if (!mounted) return;
        setCaseRecord(c);
        setSteps(st.items);
        setAttempts(att.items);
        setRun(r);
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err.message || '加载用例详情失败');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [caseId, runId]);

  if (loading) {
    return (
      <Page testId="case-detail-loading">
        <div style={{ color: 'var(--color-text-muted)' }}>
          正在加载用例详情...
        </div>
      </Page>
    );
  }

  if (error || !caseRecord) {
    return (
      <Page testId="case-detail-error">
        <ErrorCard
          type="missing_evidence"
          message={error || '用例记录不存在或未找到'}
        />
        <button
          className="btn btn-secondary"
          onClick={() => setRoute('workbench', { runId })}
          style={{ marginTop: '16px' }}
        >
          返回工作台
        </button>
      </Page>
    );
  }

  const isNotRun = caseRecord.outcome === 'not_run' || !caseRecord.verdict;
  const verdictStatus = caseRecord.verdict ? caseRecord.verdict.status : null;
  const isRegressionCase =
    !!caseRecord.definition.regression || run?.executionMode === 'regression';
  const regression = caseRecord.definition.regression;
  const provenanceStatus = getRegressionProvenanceStatus(regression);

  return (
    <Page testId="case-detail-page">
      <div style={{ marginBottom: '16px' }}>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => setRoute('workbench', { runId })}
          data-testid="btn-back-workbench"
        >
          ← 返回运行工作台 ({runId})
        </button>
      </div>

      {/* Case Header Card */}
      <div className="card" style={{ marginBottom: '20px' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span
              style={{
                fontSize: '0.85rem',
                color: 'var(--color-text-muted)',
              }}
            >
              用例编号: <code>{caseRecord.definition.id}</code>
            </span>
            {isNotRun ? (
              <StatusBadge status="not_run" label="未执行 (Not Run)" />
            ) : (
              <StatusBadge status={verdictStatus!} />
            )}
            {isRegressionCase ? (
              <span
                className="badge badge-primary"
                data-testid="badge-case-type"
              >
                回归用例 (Regression)
              </span>
            ) : (
              <span
                className="badge badge-neutral"
                data-testid="badge-case-type"
              >
                冒烟用例 (Smoke)
              </span>
            )}
            {isNotRun && (
              <span
                className="badge badge-neutral"
                data-testid="notice-replay-state"
              >
                排队中 / 未执行 (非已完成回放)
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => setSaveModalOpen(true)}
              data-testid="btn-save-to-library"
            >
              💾 保存到用例库
            </button>
            <span
              style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}
            >
              执行尝试次数: <strong>{attempts.length}</strong>
            </span>
          </div>
        </div>

        <h2
          style={{ fontSize: '1.3rem', fontWeight: 700, marginBottom: '8px' }}
        >
          {caseRecord.definition.title}
        </h2>

        <p
          style={{
            fontSize: '0.9rem',
            color: 'var(--color-text-main)',
            lineHeight: 1.6,
          }}
        >
          {caseRecord.definition.summary}
        </p>

        <div
          style={{
            marginTop: '16px',
            padding: '12px 16px',
            backgroundColor: 'var(--color-bg-subtle)',
            borderRadius: 'var(--radius-md)',
            borderLeft: `4px solid ${
              verdictStatus === 'passed'
                ? 'var(--color-success)'
                : isNotRun
                  ? 'var(--color-border)'
                  : 'var(--color-warning)'
            }`,
          }}
        >
          <div
            style={{
              fontSize: '0.8rem',
              fontWeight: 600,
              color: 'var(--color-text-muted)',
            }}
          >
            最终裁决总结 (Verdict Summary):
          </div>
          <div
            style={{
              fontSize: '0.875rem',
              color: 'var(--color-text-main)',
              marginTop: '4px',
            }}
            data-testid="verdict-summary-text"
          >
            {caseRecord.verdict?.summary ||
              '尚未生成终态裁决总结 (用例处于未执行/排队状态)'}
          </div>
        </div>
      </div>

      {/* Auditable Regression Provenance Card (when regression case) */}
      {isRegressionCase && (
        <div
          className="card"
          style={{ marginBottom: '20px' }}
          data-testid="regression-provenance-card"
        >
          <div
            className="card-header"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <h3 className="card-title">
                冻结基线版本与用例库来源说明 (Frozen Baseline & Provenance)
              </h3>
              <div
                style={{
                  fontSize: '0.75rem',
                  color: 'var(--color-text-subtle)',
                  marginTop: '2px',
                }}
              >
                注:
                来源说明仅表明基线绑定与契约规范合规性，未验证状态不代表用例判定裁决
                (Verdict)
              </div>
            </div>
            <span
              className={`badge badge-${provenanceStatus.badgeVariant}`}
              data-testid={
                provenanceStatus.isComplete
                  ? 'badge-provenance-complete'
                  : 'badge-provenance-unverified'
              }
            >
              {provenanceStatus.statusLabel}
            </span>
          </div>

          {regression ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}
            >
              {!provenanceStatus.isComplete &&
                provenanceStatus.missingFields.length > 0 && (
                  <div
                    style={{
                      padding: '10px 14px',
                      backgroundColor: 'rgba(239, 68, 68, 0.08)',
                      border: '1px solid var(--color-danger, #ef4444)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: '0.8rem',
                      color: 'var(--color-danger, #ef4444)',
                    }}
                    data-testid="provenance-validation-errors"
                  >
                    <strong>⚠️ 来源信息未通过规范校验 (未验证):</strong>
                    <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                      {provenanceStatus.missingFields.map((err, idx) => (
                        <li key={idx}>{err}</li>
                      ))}
                    </ul>
                  </div>
                )}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                  gap: '12px',
                  backgroundColor: 'var(--color-bg-subtle)',
                  padding: '14px',
                  borderRadius: 'var(--radius-md)',
                  fontSize: '0.85rem',
                }}
              >
                <div>
                  <div
                    style={{
                      color: 'var(--color-text-muted)',
                      fontSize: '0.75rem',
                      marginBottom: '2px',
                    }}
                  >
                    源用例版本 ID (Source Version ID):
                  </div>
                  {regression.sourceVersionId ? (
                    <code data-testid="provenance-source-version">
                      {regression.sourceVersionId}
                    </code>
                  ) : (
                    <span
                      className="badge badge-danger"
                      data-testid="provenance-source-version-missing"
                    >
                      未验证
                    </span>
                  )}
                </div>

                <div>
                  <div
                    style={{
                      color: 'var(--color-text-muted)',
                      fontSize: '0.75rem',
                      marginBottom: '2px',
                    }}
                  >
                    原文档 SHA-256 (Source Document SHA):
                  </div>
                  {regression.sourceDocumentSha256 ? (
                    <code data-testid="provenance-source-sha">
                      {regression.sourceDocumentSha256}
                    </code>
                  ) : (
                    <span
                      className="badge badge-danger"
                      data-testid="provenance-source-sha-missing"
                    >
                      未验证
                    </span>
                  )}
                </div>

                <div>
                  <div
                    style={{
                      color: 'var(--color-text-muted)',
                      fontSize: '0.75rem',
                      marginBottom: '2px',
                    }}
                  >
                    快照文档 SHA-256 (Snapshot SHA):
                  </div>
                  {regression.snapshotDocumentSha256 ? (
                    <code data-testid="provenance-snapshot-sha">
                      {regression.snapshotDocumentSha256}
                    </code>
                  ) : (
                    <span
                      style={{ color: 'var(--color-text-muted)' }}
                      data-testid="provenance-snapshot-sha-empty"
                    >
                      未生成快照 (可选)
                    </span>
                  )}
                </div>

                <div>
                  <div
                    style={{
                      color: 'var(--color-text-muted)',
                      fontSize: '0.75rem',
                      marginBottom: '2px',
                    }}
                  >
                    契约 Schema 版本 (Schema Version):
                  </div>
                  {regression.document?.schemaVersion ? (
                    <span data-testid="provenance-schema-version">
                      v{regression.document.schemaVersion} (
                      {regression.document.kind || 'localqa/test'})
                    </span>
                  ) : (
                    <span
                      className="badge badge-warning"
                      data-testid="provenance-schema-version-missing"
                    >
                      未验证
                    </span>
                  )}
                </div>
              </div>

              {/* Module Snapshots */}
              <div style={{ marginTop: '4px' }}>
                <h4
                  style={{
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    marginBottom: '6px',
                  }}
                >
                  模块版本快照清单 (Module Snapshots:{' '}
                  {regression.moduleSnapshots?.length ?? 0})
                </h4>
                {regression.moduleSnapshots &&
                regression.moduleSnapshots.length > 0 ? (
                  <div className="table-container">
                    <table
                      className="data-table"
                      data-testid="module-snapshots-table"
                    >
                      <thead>
                        <tr>
                          <th>模块名称</th>
                          <th style={{ width: '80px' }}>版本</th>
                          <th>SHA-256 审计指纹</th>
                          <th style={{ width: '100px' }}>审查状态</th>
                        </tr>
                      </thead>
                      <tbody>
                        {regression.moduleSnapshots.map((m, idx) => (
                          <tr
                            key={idx}
                            data-testid={`module-snapshot-row-${idx}`}
                          >
                            <td>
                              <strong>{m.name}</strong>
                            </td>
                            <td>v{m.version}</td>
                            <td>
                              <code>{m.sha256}</code>
                            </td>
                            <td>
                              <StatusBadge status={m.reviewStatus} size="sm" />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : regression.moduleSnapshots ? (
                  <div
                    style={{
                      fontSize: '0.8rem',
                      color: 'var(--color-text-muted)',
                      padding: '6px 10px',
                      backgroundColor: 'var(--color-bg-subtle)',
                      borderRadius: 'var(--radius-sm)',
                    }}
                  >
                    无外部模块引用 (该用例为纯内联步骤回放)
                  </div>
                ) : (
                  <div
                    className="badge badge-danger"
                    data-testid="module-snapshots-missing"
                  >
                    模块快照数据缺失 (未验证)
                  </div>
                )}
              </div>
            </div>
          ) : (
            <ErrorCard
              type="missing_evidence"
              message="当前运行模式为回归运行 (regression)，但该用例未关联已审查批准的冻结基线版本与用例库来源，来源信息未验证。"
            />
          )}
        </div>
      )}

      {/* Acceptance Criteria Table */}
      <div className="card" style={{ marginBottom: '20px' }}>
        <div className="card-header">
          <h3 className="card-title">验收判定准则清单 (Acceptance Criteria)</h3>
        </div>

        <div className="table-container">
          <table className="data-table" data-testid="criteria-table">
            <thead>
              <tr>
                <th style={{ width: '180px' }}>准则编号 (Criterion ID)</th>
                <th>判定描述与要求</th>
                <th style={{ width: '140px' }}>依据来源</th>
                <th style={{ width: '120px' }}>单项判定</th>
              </tr>
            </thead>
            <tbody>
              {caseRecord.definition.criteria.map((cr) => {
                const result = caseRecord.verdict?.criterionResults.find(
                  (r) => r.criterionId === cr.id,
                );
                const criterionStatus = caseRecord.verdict
                  ? result?.result || 'not_evaluated'
                  : caseRecord.outcome === 'not_run'
                    ? 'not_run'
                    : 'not_evaluated';
                return (
                  <tr key={cr.id}>
                    <td>
                      <code>{cr.id}</code>
                    </td>
                    <td>{cr.description}</td>
                    <td>
                      <span className="badge badge-neutral">
                        {cr.sourceKind}
                      </span>
                    </td>
                    <td>
                      <StatusBadge status={criterionStatus} size="sm" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Execution Steps & Evidence Timeline */}
      <div className="card">
        <div className="card-header">
          <h3 className="card-title">
            执行动作轨迹与证据 (Step Actions & Evidence)
          </h3>
          <span
            style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}
          >
            {isNotRun || steps.length === 0
              ? '尚未执行回放 (排队中 / 未执行)'
              : `执行回放轨迹 (共 ${steps.length} 步)`}
          </span>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {steps.length === 0 ? (
            <div
              style={{
                padding: '24px',
                textAlign: 'center',
                color: 'var(--color-text-muted)',
                fontSize: '0.85rem',
                backgroundColor: 'var(--color-bg-subtle)',
                borderRadius: 'var(--radius-md)',
              }}
              data-testid="no-steps-placeholder"
            >
              {isNotRun
                ? '该用例目前处于排队/未执行状态，等待 Worker 节点领取并执行回放。'
                : '该用例未记录任何步骤动作。'}
            </div>
          ) : (
            steps.map((st) => (
              <div
                key={st.id}
                style={{
                  border: '1px solid var(--color-border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  padding: '14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '8px',
                }}
                data-testid={`step-row-${st.seq}`}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        marginBottom: '4px',
                      }}
                    >
                      <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>
                        步骤 #{st.seq}
                      </span>
                      <span className="badge badge-info">{st.toolName}</span>
                      <StatusBadge status={st.status} size="sm" />
                    </div>
                    <div
                      style={{
                        fontSize: '0.85rem',
                        color: 'var(--color-text-main)',
                      }}
                    >
                      目标: <code>{st.targetDescription}</code>
                    </div>
                  </div>

                  {st.evidenceRefs && st.evidenceRefs.length > 0 && (
                    <div>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() =>
                          alert(`查看证据材料: ${st.evidenceRefs.join(', ')}`)
                        }
                        data-testid={`btn-view-evidence-${st.seq}`}
                      >
                        查看截图 🖼️
                      </button>
                    </div>
                  )}
                </div>

                {/* Step Regression Source */}
                {st.regressionSource ? (
                  <div
                    style={{
                      padding: '6px 10px',
                      backgroundColor: 'var(--color-bg-subtle)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: '0.75rem',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '2px',
                    }}
                    data-testid={`step-provenance-${st.seq}`}
                  >
                    <div>
                      <strong>步骤出处:</strong> 原文档{' '}
                      <code>{st.regressionSource.documentId}</code> · 步骤{' '}
                      <code>#{st.regressionSource.stepIndex}</code>
                    </div>
                    {st.regressionSource.modulePath &&
                      st.regressionSource.modulePath.length > 0 && (
                        <div>
                          <strong>模块调用链:</strong>{' '}
                          {st.regressionSource.modulePath
                            .map(
                              (m) =>
                                `${m.ref} (sha:${m.sha256.slice(0, 8)}..., step:#${m.invocationStepIndex})`,
                            )
                            .join(' -> ')}
                        </div>
                      )}
                  </div>
                ) : isRegressionCase ? (
                  <div
                    style={{
                      padding: '4px 8px',
                      backgroundColor: 'var(--color-warning-subtle)',
                      color: 'var(--color-warning-text)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: '0.75rem',
                    }}
                    data-testid={`step-source-unverified-${st.seq}`}
                  >
                    ⚠️ 步骤出处: 未验证 (缺少用例出处溯源信息)
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </div>

      {saveModalOpen && (
        <SaveToLibraryModal
          caseRecord={caseRecord}
          steps={steps}
          projectId={currentProject?.id || 'prj_default'}
          onClose={() => setSaveModalOpen(false)}
          onSaved={(savedCase) => {
            setSaveModalOpen(false);
            setRoute('saved-case-detail', { caseId: savedCase.id });
          }}
        />
      )}
    </Page>
  );
};
