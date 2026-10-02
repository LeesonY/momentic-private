import React, { useEffect, useState } from 'react';
import type { CaseRecord, Step, CaseAttempt } from '@localqa/contracts';
import { useAppContext } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { AppHeader } from '../components/layout/AppHeader.tsx';
import { StatusBadge } from '../components/ui/Badge.tsx';
import { ErrorCard } from '../components/ui/ErrorCard.tsx';

export const CaseDetailPage: React.FC = () => {
  const { routeParams, setRoute } = useAppContext();
  const caseId = routeParams.caseId;
  const runId = routeParams.runId;

  const [caseRecord, setCaseRecord] = useState<CaseRecord | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [attempts, setAttempts] = useState<CaseAttempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!caseId) return;

    let mounted = true;
    setLoading(true);
    setError(null);

    Promise.all([
      defaultApiClient.getCase(caseId),
      defaultApiClient.listTaskSteps(caseId).catch(() => ({ items: [] })),
      defaultApiClient.listCaseAttempts(caseId).catch(() => ({ items: [] }))
    ])
      .then(([c, st, att]) => {
        if (!mounted) return;
        setCaseRecord(c);
        setSteps(st.items);
        setAttempts(att.items);
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
  }, [caseId]);

  if (loading) {
    return (
      <div className="app-container" data-testid="case-detail-loading">
        <AppHeader />
        <main className="main-content" style={{ display: 'flex', justifyContent: 'center', padding: '60px 0' }}>
          <div style={{ color: 'var(--color-text-muted)' }}>正在加载用例详情...</div>
        </main>
      </div>
    );
  }

  if (error || !caseRecord) {
    return (
      <div className="app-container" data-testid="case-detail-error">
        <AppHeader />
        <main className="main-content">
          <ErrorCard type="missing_evidence" message={error || '用例记录不存在或未找到'} />
          <button className="btn btn-secondary" onClick={() => setRoute('workbench', { runId })} style={{ marginTop: '16px' }}>
            返回工作台
          </button>
        </main>
      </div>
    );
  }

  return (
    <div className="app-container" data-testid="case-detail-page">
      <AppHeader />
      <main className="main-content">
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
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '0.85rem', color: 'var(--color-text-muted)' }}>用例编号: <code>{caseRecord.definition.id}</code></span>
              <StatusBadge status={caseRecord.outcome} />
              <span className="badge badge-neutral">来源: {caseRecord.definition.criteria[0]?.sourceKind || 'generic_smoke'}</span>
            </div>
            <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
              执行尝试次数: <strong>{attempts.length || 1}</strong>
            </span>
          </div>

          <h2 style={{ fontSize: '1.3rem', fontWeight: 700, marginBottom: '8px' }}>
            {caseRecord.definition.title}
          </h2>

          <p style={{ fontSize: '0.9rem', color: 'var(--color-text-main)', lineHeight: 1.6 }}>
            {caseRecord.definition.summary}
          </p>

          <div
            style={{
              marginTop: '16px',
              padding: '12px 16px',
              backgroundColor: 'var(--color-bg-subtle)',
              borderRadius: 'var(--radius-md)',
              borderLeft: '4px solid var(--color-primary)'
            }}
          >
            <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-text-muted)' }}>最终裁决总结 (Verdict Summary):</div>
            <div style={{ fontSize: '0.875rem', color: 'var(--color-text-main)', marginTop: '4px' }}>
              {caseRecord.verdict?.summary || '尚未生成终态裁决总结'}
            </div>
          </div>
        </div>

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
                  const result = caseRecord.verdict?.criterionResults.find((r) => r.criterionId === cr.id);
                  return (
                    <tr key={cr.id}>
                      <td><code>{cr.id}</code></td>
                      <td>{cr.description}</td>
                      <td><span className="badge badge-neutral">{cr.sourceKind}</span></td>
                      <td>
                        <StatusBadge status={result?.result || caseRecord.outcome} size="sm" />
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
            <h3 className="card-title">执行动作轨迹与证据 (Step Actions & Evidence)</h3>
            <span style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}>
              真实 Chromium 操作回放
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {steps.map((st) => (
              <div
                key={st.id}
                style={{
                  border: '1px solid var(--color-border-subtle)',
                  borderRadius: 'var(--radius-md)',
                  padding: '14px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between'
                }}
                data-testid={`step-row-${st.seq}`}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                    <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>步骤 #{st.seq}</span>
                    <span className="badge badge-info">{st.toolName}</span>
                    <StatusBadge status={st.status} size="sm" />
                  </div>
                  <div style={{ fontSize: '0.85rem', color: 'var(--color-text-main)' }}>
                    目标: <code>{st.targetDescription}</code>
                  </div>
                </div>

                {st.evidenceRefs && st.evidenceRefs.length > 0 && (
                  <div>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => alert(`查看证据材料: ${st.evidenceRefs.join(', ')}`)}
                      data-testid={`btn-view-evidence-${st.seq}`}
                    >
                      查看截图 🖼️
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
};
