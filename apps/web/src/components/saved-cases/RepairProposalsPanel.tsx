import React, { useEffect, useState } from 'react';
import type {
  RepairProposal,
  RepairCandidateVerification,
  RepairCandidateEvidence,
  SavedCaseVersion,
  SavedCaseVersionCreate,
} from '../../api/types.ts';
import { defaultApiClient } from '../../api/index.ts';
import { AppIcon } from '../ui/AppIcon.tsx';
import { StatusBadge } from '../ui/Badge.tsx';

interface Props {
  caseId: string;
  canCreate: boolean;
  canReview: boolean;
  archived: boolean;
  baselineVersion: SavedCaseVersion | null;
  caseVersion: number;
  onCandidateCreated: (versionId: string) => Promise<void>;
}

/** Reviewable suggestions only. This UI cannot change case baselines. */
export const RepairProposalsPanel: React.FC<Props> = ({
  caseId,
  canCreate,
  canReview,
  archived,
  baselineVersion,
  caseVersion,
  onCandidateCreated,
}) => {
  const [proposals, setProposals] = useState<RepairProposal[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [findingId, setFindingId] = useState('');
  const [diff, setDiff] = useState('');
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [decision, setDecision] = useState<'approve' | 'reject'>('reject');
  const [reason, setReason] = useState('');
  const [candidateFor, setCandidateFor] = useState<string | null>(null);
  const [candidateJson, setCandidateJson] = useState('');
  const [knownCandidates, setKnownCandidates] = useState<
    Record<string, SavedCaseVersion>
  >({});
  const [verificationHistory, setVerificationHistory] = useState<
    Record<string, RepairCandidateVerification[]>
  >({});
  const [evidenceHistory, setEvidenceHistory] = useState<
    Record<string, RepairCandidateEvidence[]>
  >({});

  useEffect(() => {
    let active = true;
    setProposals([]);
    setCursor(null);
    setReviewId(null);
    setCandidateFor(null);
    setKnownCandidates({});
    setVerificationHistory({});
    setEvidenceHistory({});
    setError(null);
    setLoading(true);
    void defaultApiClient
      .listRepairProposals(caseId, { limit: 20 })
      .then((page) => {
        if (!active) return;
        setProposals(page.items);
        setCursor(page.nextCursor);
      })
      .catch((e: unknown) => {
        if (active)
          setError(e instanceof Error ? e.message : '修复建议加载失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [caseId]);

  async function reload(): Promise<void> {
    const page = await defaultApiClient.listRepairProposals(caseId, {
      limit: 20,
    });
    setProposals(page.items);
    setCursor(page.nextCursor);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !canCreate || archived) return;
    setBusy(true);
    setError(null);
    try {
      await defaultApiClient.createRepairProposal(caseId, {
        findingId: findingId.trim(),
        diff: diff.trim(),
      });
      setFindingId('');
      setDiff('');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法创建修复建议');
    } finally {
      setBusy(false);
    }
  }

  async function review(event: React.FormEvent) {
    event.preventDefault();
    if (!reviewId || busy || !canReview || reason.trim().length < 10) return;
    setBusy(true);
    setError(null);
    try {
      await defaultApiClient.reviewRepairProposal(caseId, reviewId, {
        decision,
        reason: reason.trim(),
      });
      setReviewId(null);
      setReason('');
      await reload();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : '审核失败，计划可能已被其他人修改',
      );
    } finally {
      setBusy(false);
    }
  }

  async function loadMore() {
    if (!cursor || busy) return;
    setBusy(true);
    setError(null);
    try {
      const page = await defaultApiClient.listRepairProposals(caseId, {
        limit: 20,
        cursor,
      });
      setProposals((prior) => [...prior, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法加载更多修复建议');
    } finally {
      setBusy(false);
    }
  }

  async function createCandidate(event: React.FormEvent) {
    event.preventDefault();
    if (!candidateFor || busy || !canCreate || archived || !baselineVersion)
      return;
    setBusy(true);
    setError(null);
    try {
      const parsed: SavedCaseVersionCreate['document'] =
        JSON.parse(candidateJson);
      const result = await defaultApiClient.createRepairCandidateDraft(
        caseId,
        candidateFor,
        { expectedVersion: caseVersion, document: parsed },
      );
      setKnownCandidates((prior) => ({ ...prior, [candidateFor]: result }));
      setCandidateFor(null);
      await onCandidateCreated(result.id);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : '草稿创建失败：版本可能已发生变化',
      );
    } finally {
      setBusy(false);
    }
  }

  async function locateCandidate(proposalId: string) {
    setBusy(true);
    setError(null);
    try {
      const candidate = await defaultApiClient.getRepairCandidateDraft(
        caseId,
        proposalId,
      );
      setKnownCandidates((prior) => ({ ...prior, [proposalId]: candidate }));
      setCandidateFor(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : '尚未找到关联候选草稿');
    } finally {
      setBusy(false);
    }
  }

  async function refreshVerifications(proposalId: string) {
    setBusy(true);
    setError(null);
    try {
      const page = await defaultApiClient.listRepairCandidateVerifications(
        caseId,
        proposalId,
        { limit: 20 },
      );
      setVerificationHistory((old) => ({
        ...old,
        [proposalId]: page.items,
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : '验证记录读取失败');
    } finally {
      setBusy(false);
    }
  }

  async function verifyCandidate(proposalId: string) {
    if (busy || !canCreate || archived) return;
    setBusy(true);
    setError(null);
    try {
      const queued = await defaultApiClient.startRepairCandidateVerification(
        caseId,
        proposalId,
      );
      setVerificationHistory((old) => ({
        ...old,
        [proposalId]: [queued, ...(old[proposalId] ?? [])],
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : '候选验证无法排队');
    } finally {
      setBusy(false);
    }
  }

  async function viewEvidence(proposalId: string, verificationId: string) {
    if (!canReview) return;
    setBusy(true);
    setError(null);
    try {
      const page = await defaultApiClient.listRepairCandidateEvidence(
        caseId,
        proposalId,
        verificationId,
      );
      setEvidenceHistory((prev) => ({ ...prev, [verificationId]: page.items }));
    } catch (e) {
      setError(e instanceof Error ? e.message : '验证证据读取失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" data-testid="repair-proposals-panel">
      <div className="card-header">
        <div className="card-heading">
          <h2 className="card-title">
            <AppIcon name="edit" size={17} />
            修复建议与人工审核
          </h2>
          <p className="card-description">
            只接收与该已批准用例相关、经独立复现确认的缺陷。批准建议仅代表人工同意评估，不会修改用例基线，也不证明修复已通过验证。
          </p>
        </div>
      </div>
      {error && (
        <p className="text-sm text-danger lqa-repair-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p className="muted text-sm">正在加载建议…</p>
      ) : !proposals.length ? (
        <div className="lqa-muted-box">暂无修复建议。</div>
      ) : (
        <div className="lqa-card-list">
          {proposals.map((proposal) => (
            <article key={proposal.id} className="lqa-item-card lqa-proposal">
              <div className="lqa-item-top">
                <span className="row">
                  <strong>建议 v{proposal.proposedVersion}</strong>
                  <StatusBadge status={proposal.status} size="sm" />
                </span>
                <span className="subtle text-xs">
                  {new Date(proposal.createdAt).toLocaleString()}
                </span>
              </div>
              <p className="text-xs muted">
                来源缺陷 <code>{proposal.findingId}</code>
              </p>
              <pre className="lqa-diff">{proposal.diff}</pre>
              {proposal.reviewReason && (
                <p className="text-sm">审核意见：{proposal.reviewReason}</p>
              )}
              {canReview && proposal.status === 'draft' && !archived && (
                <div className="btn-group">
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setReviewId((prior) =>
                        prior === proposal.id ? null : proposal.id,
                      );
                      setReason('');
                    }}
                  >
                    <AppIcon name="flag" size={13} />
                    {reviewId === proposal.id ? '取消审核' : '人工审核'}
                  </button>
                </div>
              )}
              {reviewId === proposal.id && canReview && (
                <form
                  onSubmit={(e) => void review(e)}
                  className="panel lqa-proposal-form"
                >
                  <div className="field">
                    <label className="field-label">结论</label>
                    <select
                      className="form-select"
                      value={decision}
                      onChange={(e) =>
                        setDecision(e.target.value as 'approve' | 'reject')
                      }
                    >
                      <option value="reject">驳回建议</option>
                      <option value="approve">仅批准建议（不变更基线）</option>
                    </select>
                  </div>
                  <div className="field">
                    <label className="field-label">
                      审核理由
                      <span className="field-optional">至少 10 个字</span>
                    </label>
                    <textarea
                      className="form-textarea"
                      required
                      minLength={10}
                      maxLength={2000}
                      rows={3}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </div>
                  <div className="form-actions">
                    <button
                      className="btn btn-primary btn-sm"
                      type="submit"
                      disabled={busy || reason.trim().length < 10}
                    >
                      确认审核
                    </button>
                  </div>
                </form>
              )}
              {proposal.status === 'approved' && canCreate && !archived && (
                <div className="btn-group">
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    disabled={busy || !baselineVersion}
                    onClick={() => {
                      setCandidateFor((old) =>
                        old === proposal.id ? null : proposal.id,
                      );
                      setCandidateJson(
                        baselineVersion
                          ? JSON.stringify(baselineVersion.document, null, 2)
                          : '',
                      );
                    }}
                  >
                    <AppIcon name="code" size={13} />
                    编辑候选用例 JSON
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    type="button"
                    disabled={busy}
                    onClick={() => void locateCandidate(proposal.id)}
                  >
                    查看关联候选草稿
                  </button>
                </div>
              )}
              {knownCandidates[proposal.id] && (
                <p role="status" className="text-sm muted">
                  候选版本 v{knownCandidates[proposal.id]!.version}（
                  {knownCandidates[proposal.id]!.reviewStatus}
                  ），尚未独立验证，不改变已批准的基线。
                </p>
              )}
              {proposal.status === 'approved' && (
                <div className="stack stack-sm">
                  <div className="btn-group">
                    {canCreate && !archived && (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={
                          busy ||
                          !knownCandidates[proposal.id] ||
                          knownCandidates[proposal.id]?.reviewStatus !== 'draft'
                        }
                        onClick={() => void verifyCandidate(proposal.id)}
                      >
                        <AppIcon name="play" size={12} />
                        发起独立验证（受限浏览器）
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy}
                      onClick={() => void refreshVerifications(proposal.id)}
                    >
                      <AppIcon name="refresh" size={13} />
                      刷新验证记录
                    </button>
                  </div>
                  {(verificationHistory[proposal.id] ?? []).map(
                    (verification) => (
                      <div key={verification.id} className="lqa-verification">
                        <div className="row row-wrap text-sm">
                          <StatusBadge status={verification.status} size="sm" />
                          <span>
                            {verification.outcome ?? '未完成'} · 已观察{' '}
                            {verification.observedSteps} 步 · 技术断言{' '}
                            {verification.verifiedCriteria}
                            {verification.reasonCode
                              ? ` · ${verification.reasonCode}`
                              : ''}
                          </span>
                          {verification.status === 'completed' && canReview && (
                            <button
                              className="btn btn-ghost btn-sm push"
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                void viewEvidence(proposal.id, verification.id)
                              }
                            >
                              查看持久化步骤与截图
                            </button>
                          )}
                        </div>
                        {verification.outcome === 'passed' && (
                          <p className="field-hint">
                            仅代表确定性的独立验证通过，仍须人工审批。
                          </p>
                        )}
                        {(evidenceHistory[verification.id] ?? []).map((e) => (
                          <div key={e.id} className="panel lqa-evidence-box">
                            <div className="text-sm">
                              步骤 {e.stepIndex + 1}：{e.stepKind}
                              {e.criterionId
                                ? ` · 断言 ${e.criterionId}：${e.criterionPassed ? '通过' : '失败'}`
                                : ''}
                            </div>
                            <div className="text-xs muted">
                              快照 SHA256{' '}
                              <code>{e.snapshotSha256.slice(0, 16)}…</code>
                            </div>
                            <div className="text-xs muted break-all">
                              页面 {e.displayUrl}
                            </div>
                            {e.retention === 'purged' && (
                              <span className="text-xs text-warning">
                                证据数据已到期清理，保留 SHA256 审计收据
                              </span>
                            )}
                            {e.retention === 'available' &&
                              e.screenshotSha256 && (
                                <a
                                  className="text-sm"
                                  href={`/api/v1/saved-cases/${encodeURIComponent(caseId)}/repair-proposals/${encodeURIComponent(proposal.id)}/verifications/${encodeURIComponent(verification.id)}/evidence/${encodeURIComponent(e.id)}/screenshot`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  打开加密存储的断言截图（仅负责人）
                                </a>
                              )}
                          </div>
                        ))}
                      </div>
                    ),
                  )}
                </div>
              )}
              {candidateFor === proposal.id && (
                <form
                  onSubmit={(e) => void createCandidate(e)}
                  className="panel lqa-proposal-form"
                >
                  <p className="field-hint">
                    下方预填当前已批准的版本。请手动编辑成完整有效的
                    RegressionDocument；系统不会把文字修复建议擅自解释成可执行变更。
                  </p>
                  <textarea
                    className="form-textarea is-mono"
                    rows={12}
                    required
                    value={candidateJson}
                    onChange={(e) => setCandidateJson(e.target.value)}
                  />
                  <div className="form-actions">
                    <button
                      className="btn btn-primary btn-sm"
                      type="submit"
                      disabled={busy}
                    >
                      保存新草稿（待独立验证与原审批流程）
                    </button>
                  </div>
                </form>
              )}
            </article>
          ))}
          {cursor && (
            <div className="lqa-load-more">
              <button
                className="btn btn-secondary btn-sm"
                type="button"
                disabled={busy}
                onClick={() => void loadMore()}
              >
                加载更多
              </button>
            </div>
          )}
        </div>
      )}
      {canCreate && !archived && (
        <details className="disclosure lqa-proposal-create">
          <summary>
            <AppIcon name="plus" size={14} />
            提交新的修复建议草稿
          </summary>
          <form onSubmit={(e) => void submit(e)} className="disclosure-body">
            <div className="field">
              <label className="field-label" htmlFor="repair-finding-id">
                已确认并复现的缺陷 UUID
              </label>
              <input
                id="repair-finding-id"
                className="form-input is-mono"
                value={findingId}
                required
                placeholder="Finding UUID"
                pattern="[0-9a-fA-F-]{36}"
                onChange={(e) => setFindingId(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="repair-diff">
                最小建议变更
                <span className="field-optional">文字描述，不是可执行补丁</span>
              </label>
              <textarea
                id="repair-diff"
                className="form-textarea"
                value={diff}
                required
                maxLength={20000}
                rows={4}
                onChange={(e) => setDiff(e.target.value)}
              />
            </div>
            <div className="form-actions">
              <button
                className="btn btn-primary btn-sm"
                type="submit"
                disabled={busy || !diff.trim() || !findingId.trim()}
              >
                保存草稿（不会应用变更）
              </button>
            </div>
          </form>
        </details>
      )}
    </section>
  );
};
