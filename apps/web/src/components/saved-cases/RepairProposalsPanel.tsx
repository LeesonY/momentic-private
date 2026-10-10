import React, { useEffect, useState } from 'react';
import type {
  RepairProposal,
  RepairCandidateVerification,
  RepairCandidateEvidence,
  SavedCaseVersion,
  SavedCaseVersionCreate,
} from '../../api/types.ts';
import { defaultApiClient } from '../../api/index.ts';

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
    <section
      className="card"
      style={{ padding: 22, marginTop: 18 }}
      data-testid="repair-proposals-panel"
    >
      <h2 style={{ fontSize: '1.1rem', marginBottom: 8 }}>
        修复建议与人工审核
      </h2>
      <p
        style={{
          color: 'var(--color-text-muted)',
          fontSize: '0.85rem',
          marginBottom: 16,
        }}
      >
        仅接收与该已批准用例相关、独立复现且确认的缺陷。
        批准建议仅代表人工同意评估，不会修改用例基线，也不证明修复已通过验证。
      </p>
      {error && (
        <p role="alert" style={{ color: 'var(--color-danger-text)' }}>
          {error}
        </p>
      )}
      {loading ? (
        <p>正在加载建议…</p>
      ) : !proposals.length ? (
        <p>暂无修复建议。</p>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {proposals.map((proposal) => (
            <article
              key={proposal.id}
              style={{
                border: '1px solid var(--color-border-subtle)',
                borderRadius: 7,
                padding: 14,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <strong>
                  建议 v{proposal.proposedVersion} · {proposal.status}
                </strong>
                <span
                  style={{
                    color: 'var(--color-text-muted)',
                    fontSize: '0.8rem',
                  }}
                >
                  {new Date(proposal.createdAt).toLocaleString()}
                </span>
              </div>
              <p style={{ marginTop: 8, fontSize: '0.8rem' }}>
                来源缺陷：<code>{proposal.findingId}</code>
              </p>
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  padding: 12,
                  maxHeight: 240,
                  overflowY: 'auto',
                  background: 'var(--color-bg-base)',
                  fontSize: '0.8rem',
                }}
              >
                {proposal.diff}
              </pre>
              {proposal.reviewReason && (
                <p style={{ fontSize: '0.8rem', marginTop: 8 }}>
                  审核意见：{proposal.reviewReason}
                </p>
              )}
              {canReview && proposal.status === 'draft' && !archived && (
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
                  {reviewId === proposal.id ? '取消审核' : '人工审核'}
                </button>
              )}
              {reviewId === proposal.id && canReview && (
                <form
                  onSubmit={(e) => void review(e)}
                  style={{ marginTop: 12, display: 'grid', gap: 10 }}
                >
                  <label className="form-label">
                    结论
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
                  </label>
                  <label className="form-label">
                    审核理由（至少 10 字符）
                    <textarea
                      className="form-input"
                      required
                      minLength={10}
                      maxLength={2000}
                      rows={3}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                  <button
                    className="btn btn-primary btn-sm"
                    type="submit"
                    disabled={busy || reason.trim().length < 10}
                  >
                    确认审核
                  </button>
                </form>
              )}
              {proposal.status === 'approved' && canCreate && !archived && (
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
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
                    编辑候选用例 JSON
                  </button>
                  <button
                    className="btn btn-secondary btn-sm"
                    type="button"
                    disabled={busy}
                    onClick={() => void locateCandidate(proposal.id)}
                  >
                    查看关联候选草稿
                  </button>
                </div>
              )}
              {knownCandidates[proposal.id] && (
                <p role="status" style={{ marginTop: 9, fontSize: '0.82rem' }}>
                  候选版本 v{knownCandidates[proposal.id]!.version}（
                  {knownCandidates[proposal.id]!.reviewStatus}），
                  尚未独立验证，不改变已批准基线。
                </p>
              )}
              {proposal.status === 'approved' && (
                <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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
                        发起独立验证（受限浏览器）
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={busy}
                      onClick={() => void refreshVerifications(proposal.id)}
                    >
                      刷新验证记录
                    </button>
                  </div>
                  {(verificationHistory[proposal.id] ?? []).map(
                    (verification) => (
                      <div
                        key={verification.id}
                        style={{ fontSize: '0.82rem' }}
                      >
                        {verification.status} ·{' '}
                        {verification.outcome ?? '未完成'}
                        {' · '}已观察 {verification.observedSteps} 步{' · '}
                        技术断言 {verification.verifiedCriteria}
                        {verification.reasonCode
                          ? ` · ${verification.reasonCode}`
                          : ''}
                        {verification.outcome === 'passed' &&
                          '（仅代表确定性独立验证通过，仍须人工审批）'}
                        {verification.status === 'completed' && canReview && (
                          <button
                            className="btn btn-secondary btn-sm"
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void viewEvidence(proposal.id, verification.id)
                            }
                            style={{ marginLeft: 8 }}
                          >
                            查看持久化步骤与截图
                          </button>
                        )}
                        {(evidenceHistory[verification.id] ?? []).map((e) => (
                          <div
                            key={e.id}
                            style={{
                              marginTop: 8,
                              padding: 8,
                              border: '1px solid var(--color-border-subtle)',
                              borderRadius: 6,
                            }}
                          >
                            <div>
                              步骤 {e.stepIndex + 1}：{e.stepKind}
                              {e.criterionId
                                ? ` · 断言 ${e.criterionId}：${e.criterionPassed ? '通过' : '失败'}`
                                : ''}
                            </div>
                            <div>
                              快照 SHA256：
                              <code>{e.snapshotSha256.slice(0, 16)}…</code>
                            </div>
                            <div style={{ overflowWrap: 'anywhere' }}>
                              页面：{e.displayUrl}
                            </div>
                            {e.retention === 'purged' && (
                              <span>
                                证据数据已到期清理，保留 SHA256 审计收据
                              </span>
                            )}
                            {e.retention === 'available' &&
                              e.screenshotSha256 && (
                                <a
                                  href={`/api/v1/saved-cases/${encodeURIComponent(caseId)}/repair-proposals/${encodeURIComponent(proposal.id)}/verifications/${encodeURIComponent(verification.id)}/evidence/${encodeURIComponent(e.id)}/screenshot`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  打开加密存储的断言截图（仅 Owner）
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
                  style={{ display: 'grid', gap: 10, marginTop: 12 }}
                >
                  <p style={{ fontSize: '0.82rem' }}>
                    以下预填当前批准版本。必须手动编辑成完整有效的
                    RegressionDocument；系统不会把文字修复建议擅自解释成可执行变更。
                  </p>
                  <textarea
                    className="form-input"
                    rows={12}
                    required
                    value={candidateJson}
                    onChange={(e) => setCandidateJson(e.target.value)}
                  />
                  <button
                    className="btn btn-primary btn-sm"
                    type="submit"
                    disabled={busy}
                  >
                    保存新草稿（待独立验证与原审批流程）
                  </button>
                </form>
              )}
            </article>
          ))}
          {cursor && (
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              disabled={busy}
              onClick={() => void loadMore()}
            >
              加载更多
            </button>
          )}
        </div>
      )}
      {canCreate && !archived && (
        <form
          onSubmit={(e) => void submit(e)}
          style={{ display: 'grid', gap: 12, marginTop: 18 }}
        >
          <h3 style={{ fontSize: '0.95rem' }}>提交新建议草稿</h3>
          <label className="form-label">
            已确认并复现的 Finding UUID
            <input
              className="form-input"
              value={findingId}
              required
              placeholder="Finding UUID"
              pattern="[0-9a-fA-F-]{36}"
              onChange={(e) => setFindingId(e.target.value)}
            />
          </label>
          <label className="form-label">
            最小建议变更（文字描述，非可执行补丁）
            <textarea
              className="form-input"
              value={diff}
              required
              maxLength={20000}
              rows={4}
              onChange={(e) => setDiff(e.target.value)}
            />
          </label>
          <button
            className="btn btn-primary btn-sm"
            type="submit"
            disabled={busy || !diff.trim() || !findingId.trim()}
          >
            保存草稿（不会应用变更）
          </button>
        </form>
      )}
    </section>
  );
};
