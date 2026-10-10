import React, { useEffect, useState } from 'react';
import type { CaseRecord, Step, CaseAttempt, Run } from '@localqa/contracts';
import { useAppContext } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { Page } from '../components/layout/Page.tsx';
import { StatusBadge } from '../components/ui/Badge.tsx';
import { ErrorCard } from '../components/ui/ErrorCard.tsx';
import { Section } from '../components/ui/Section.tsx';
import { AppIcon } from '../components/ui/AppIcon.tsx';
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
  const [openEvidence, setOpenEvidence] = useState<Set<string>>(new Set());

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

  const back = {
    label: '返回运行工作台',
    onClick: () => setRoute('workbench', { runId }),
    testId: 'btn-back-workbench',
  };

  if (loading) {
    return (
      <Page testId="case-detail-loading" back={back}>
        <div className="lqa-session-loading is-inline">正在加载用例详情...</div>
      </Page>
    );
  }

  if (error || !caseRecord) {
    return (
      <Page testId="case-detail-error" back={back}>
        <ErrorCard
          type="missing_evidence"
          message={error || '用例记录不存在或未找到'}
        />
      </Page>
    );
  }

  const isNotRun = caseRecord.outcome === 'not_run' || !caseRecord.verdict;
  const verdictStatus = caseRecord.verdict ? caseRecord.verdict.status : null;
  const isRegressionCase =
    !!caseRecord.definition.regression || run?.executionMode === 'regression';
  const regression = caseRecord.definition.regression;
  const provenanceStatus = getRegressionProvenanceStatus(regression);
  const verdictTone =
    verdictStatus === 'passed'
      ? 'is-success'
      : isNotRun
        ? 'is-neutral'
        : verdictStatus === 'issue_found'
          ? 'is-danger'
          : 'is-warning';
  const toggleEvidence = (id: string) =>
    setOpenEvidence((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Page
      testId="case-detail-page"
      back={back}
      eyebrow={
        <>
          <AppIcon name="list" size={14} /> 用例 ·{' '}
          <code>{caseRecord.definition.id}</code>
        </>
      }
      title={caseRecord.definition.title}
      description={caseRecord.definition.summary}
      actions={
        <button
          className="btn btn-primary"
          onClick={() => setSaveModalOpen(true)}
          data-testid="btn-save-to-library"
        >
          <AppIcon name="archive" size={14} />
          保存到用例库
        </button>
      }
    >
      <div className="row row-wrap lqa-finding-badges">
        {isNotRun ? (
          <StatusBadge status="not_run" label="未执行" />
        ) : (
          <StatusBadge status={verdictStatus!} />
        )}
        <span
          className={`badge ${isRegressionCase ? 'badge-primary' : 'badge-neutral'}`}
          data-testid="badge-case-type"
        >
          {isRegressionCase ? '回归用例' : '冒烟用例'}
        </span>
        {isNotRun && (
          <span
            className="badge badge-neutral"
            data-testid="notice-replay-state"
          >
            排队中或未执行，尚未完成回放
          </span>
        )}
        <span className="subtle text-xs">执行尝试 {attempts.length} 次</span>
      </div>

      <div className={`lqa-verdict ${verdictTone}`}>
        <div className="section-label lqa-flush-label">最终判定</div>
        <p data-testid="verdict-summary-text">
          {caseRecord.verdict?.summary ||
            '尚未生成最终判定（用例处于未执行或排队状态）。'}
        </p>
      </div>

      {isRegressionCase && (
        <Section
          icon="git-branch"
          title="冻结基线与来源"
          description="来源信息只说明基线绑定与契约是否合规；「未验证」不代表用例判定结论。"
          testId="regression-provenance-card"
          actions={
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
          }
        >
          {regression ? (
            <div className="stack stack-sm">
              {!provenanceStatus.isComplete &&
                provenanceStatus.missingFields.length > 0 && (
                  <div
                    className="alert alert-danger"
                    data-testid="provenance-validation-errors"
                  >
                    <AppIcon name="alert-circle" size={15} />
                    <div className="alert-body">
                      <div className="alert-title">
                        来源信息未通过规范校验（未验证）
                      </div>
                      <ul className="lqa-bullets">
                        {provenanceStatus.missingFields.map((err, idx) => (
                          <li key={idx}>{err}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}
              <dl className="kv panel">
                <dt>源用例版本</dt>
                <dd>
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
                </dd>
                <dt>原文档 SHA-256</dt>
                <dd>
                  {regression.sourceDocumentSha256 ? (
                    <code
                      className="break-all"
                      data-testid="provenance-source-sha"
                    >
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
                </dd>
                <dt>快照文档 SHA-256</dt>
                <dd>
                  {regression.snapshotDocumentSha256 ? (
                    <code
                      className="break-all"
                      data-testid="provenance-snapshot-sha"
                    >
                      {regression.snapshotDocumentSha256}
                    </code>
                  ) : (
                    <span
                      className="subtle"
                      data-testid="provenance-snapshot-sha-empty"
                    >
                      未生成快照（可选）
                    </span>
                  )}
                </dd>
                <dt>契约 Schema 版本</dt>
                <dd>
                  {regression.document?.schemaVersion ? (
                    <span data-testid="provenance-schema-version">
                      v{regression.document.schemaVersion}（
                      {regression.document.kind || 'localqa/test'}）
                    </span>
                  ) : (
                    <span
                      className="badge badge-warning"
                      data-testid="provenance-schema-version-missing"
                    >
                      未验证
                    </span>
                  )}
                </dd>
              </dl>

              <div>
                <div className="section-label">
                  模块版本快照（{regression.moduleSnapshots?.length ?? 0}）
                </div>
                {regression.moduleSnapshots &&
                regression.moduleSnapshots.length > 0 ? (
                  <div className="table-container">
                    <table
                      className="data-table"
                      data-testid="module-snapshots-table"
                    >
                      <thead>
                        <tr>
                          <th>模块</th>
                          <th>版本</th>
                          <th>SHA-256 审计指纹</th>
                          <th>审查状态</th>
                        </tr>
                      </thead>
                      <tbody>
                        {regression.moduleSnapshots.map((m, idx) => (
                          <tr
                            key={idx}
                            data-testid={`module-snapshot-row-${idx}`}
                          >
                            <td className="cell-title mono">{m.name}</td>
                            <td>v{m.version}</td>
                            <td>
                              <code className="text-xs break-all">
                                {m.sha256}
                              </code>
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
                  <div className="lqa-muted-box">
                    无外部模块引用，该用例为纯内联步骤回放。
                  </div>
                ) : (
                  <span
                    className="badge badge-danger"
                    data-testid="module-snapshots-missing"
                  >
                    模块快照数据缺失（未验证）
                  </span>
                )}
              </div>
            </div>
          ) : (
            <ErrorCard
              type="missing_evidence"
              message="当前是回归运行，但该用例没有关联经审查批准的冻结基线版本与用例库来源，来源信息未验证。"
            />
          )}
        </Section>
      )}

      <Section icon="target" title="验收准则">
        <div className="table-container">
          <table className="data-table" data-testid="criteria-table">
            <thead>
              <tr>
                <th>准则</th>
                <th>判定要求</th>
                <th>依据来源</th>
                <th>单项判定</th>
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
      </Section>

      <Section
        icon="activity"
        title="执行步骤与证据"
        description={
          isNotRun || steps.length === 0
            ? '尚未执行回放（排队中或未执行）'
            : `共 ${steps.length} 步`
        }
      >
        {steps.length === 0 ? (
          <div className="lqa-muted-box" data-testid="no-steps-placeholder">
            {isNotRun
              ? '该用例处于排队或未执行状态，等待 Worker 节点领取并执行回放。'
              : '该用例没有记录任何步骤动作。'}
          </div>
        ) : (
          <div className="lqa-card-list">
            {steps.map((st) => (
              <div
                key={st.id}
                className="lqa-item-card lqa-step-row"
                data-testid={`step-row-${st.seq}`}
              >
                <div className="lqa-item-top">
                  <span className="row row-wrap">
                    <span className="lqa-step-seq">{st.seq}</span>
                    <span className="badge badge-info badge-sm mono">
                      {st.toolName}
                    </span>
                    <StatusBadge status={st.status} size="sm" />
                  </span>
                  {st.evidenceRefs && st.evidenceRefs.length > 0 && (
                    <button
                      className="btn btn-ghost btn-sm"
                      aria-expanded={openEvidence.has(st.id)}
                      onClick={() => toggleEvidence(st.id)}
                      data-testid={`btn-view-evidence-${st.seq}`}
                    >
                      <AppIcon name="image" size={13} />
                      证据 {st.evidenceRefs.length}
                    </button>
                  )}
                </div>
                <div className="text-sm">
                  目标 <code>{st.targetDescription}</code>
                </div>
                {openEvidence.has(st.id) && (
                  <div className="row row-wrap text-xs">
                    {st.evidenceRefs.map((ref) => (
                      <code key={ref}>{ref}</code>
                    ))}
                  </div>
                )}

                {st.regressionSource ? (
                  <div
                    className="lqa-provenance"
                    data-testid={`step-provenance-${st.seq}`}
                  >
                    <span>
                      出处 <code>{st.regressionSource.documentId}</code> 步骤{' '}
                      <code>#{st.regressionSource.stepIndex}</code>
                    </span>
                    {st.regressionSource.modulePath &&
                      st.regressionSource.modulePath.length > 0 && (
                        <span>
                          模块调用链{' '}
                          {st.regressionSource.modulePath
                            .map(
                              (m) =>
                                `${m.ref}（sha ${m.sha256.slice(0, 8)}，步骤 #${m.invocationStepIndex}）`,
                            )
                            .join(' → ')}
                        </span>
                      )}
                  </div>
                ) : isRegressionCase ? (
                  <div
                    className="lqa-provenance is-warning"
                    data-testid={`step-source-unverified-${st.seq}`}
                  >
                    <AppIcon name="alert-triangle" size={12} />
                    步骤出处未验证（缺少用例出处溯源信息）
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Section>

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
