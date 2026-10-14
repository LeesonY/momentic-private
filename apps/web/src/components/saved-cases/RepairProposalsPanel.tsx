import React, { useEffect, useMemo, useState } from 'react';
import type { RepairSuggestionRecord } from '@localqa/contracts';
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
import {
  previewLocatorMaintenance,
  type LocatorMaintenancePreview,
} from './locatorMaintenanceDraft.ts';
import {
  createLocatorMaintenanceDraft,
  listLocatorCandidateComparison,
  listLocatorMaintenanceEvidence,
  locatorMaintenanceScreenshotUrl,
  startLocatorMaintenanceVerification,
  type LocatorMaintenanceEvidence,
  type LocatorCandidateComparison,
} from '../../api/locatorMaintenance.ts';
import { rankLocatorMaintenanceCandidates } from './locatorMaintenanceRanking.ts';

interface Props {
  caseId: string;
  canCreate: boolean;
  canReview: boolean;
  archived: boolean;
  baselineVersion: SavedCaseVersion | null;
  caseVersion: number;
  onCandidateCreated: (versionId: string) => Promise<void>;
  onCandidatesQueued: () => Promise<void>;
  onRequestCandidateReview: (versionId: string) => Promise<void>;
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
  onCandidatesQueued,
  onRequestCandidateReview,
}) => {
  const [proposals, setProposals] = useState<RepairProposal[]>([]);
  const [repairSuggestions, setRepairSuggestions] = useState<
    RepairSuggestionRecord[]
  >([]);
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
  const [maintenance, setMaintenance] = useState<{
    taskId: string;
    suggestionIndex: number;
    preview: LocatorMaintenancePreview;
  } | null>(null);
  const [maintenanceConfirmed, setMaintenanceConfirmed] = useState(false);
  const [knownCandidates, setKnownCandidates] = useState<
    Record<string, SavedCaseVersion>
  >({});
  const [verificationHistory, setVerificationHistory] = useState<
    Record<string, RepairCandidateVerification[]>
  >({});
  const [evidenceHistory, setEvidenceHistory] = useState<
    Record<string, RepairCandidateEvidence[]>
  >({});
  // Read-only structural screening. The backend still validates the original
  // frozen witness, and only the human-approved candidate can become baseline.
  const screening = useMemo(
    () => rankLocatorMaintenanceCandidates(baselineVersion, repairSuggestions),
    [baselineVersion, repairSuggestions],
  );
  const newestTaskId = repairSuggestions[0]?.taskId ?? null;
  const latestCandidates = screening.candidates.filter(
    (candidate) => candidate.record.taskId === newestTaskId,
  );
  const [comparisonRows, setComparisonRows] = useState<LocatorCandidateComparison[]>([]);
  const [comparisonConfirmed, setComparisonConfirmed] = useState(false);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const [comparisonProgress, setComparisonProgress] = useState('');
  // Evidence is fetched only by an explicitly authorized reviewer, never
  // during candidate ranking or by the background comparison poll.
  const [activeEvidenceKey, setActiveEvidenceKey] = useState<string | null>(null);
  const [evidenceByVerification, setEvidenceByVerification] = useState<
    Record<string, LocatorMaintenanceEvidence[]>
  >({});
  const [evidenceLoadingKey, setEvidenceLoadingKey] = useState<string | null>(null);
  const [reviewAcknowledgedId, setReviewAcknowledgedId] = useState<string | null>(null);

  const compared = comparisonRows.filter(
    (row) => latestCandidates.some((candidate) =>
      candidate.suggestionIndex === row.suggestionIndex,
    ),
  );
  const comparisonPending = compared.some(
    (row) => row.status === 'queued' || row.status === 'running',
  );
  const allCompared =
    latestCandidates.length >= 1 &&
    latestCandidates.every((candidate) =>
      compared.some((row) =>
        row.suggestionIndex === candidate.suggestionIndex &&
        row.status === 'completed',
      ),
    );
  const verifiedPassed = compared.filter(
    (row) =>
      row.status === 'completed' &&
      row.outcome === 'passed' &&
      row.evidenceBacked,
  );
  const verifiedWinner =
    allCompared && verifiedPassed.length === 1 ? verifiedPassed[0] : null;

  useEffect(() => {
    let active = true;
    setComparisonRows([]);
    setComparisonError(null);
    setComparisonConfirmed(false);
    if (!newestTaskId) return;
    let inFlight = false;
    const load = async () => {
      if (!active || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const result = await listLocatorCandidateComparison(caseId, newestTaskId);
        if (active) {
          setComparisonRows(result.items);
        }
      } catch (cause) {
        if (active)
          setComparisonError(
            cause instanceof Error ? cause.message : '无法读取候选验证状态',
          );
      } finally {
        inFlight = false;
      }
    };
    void load();
    // Poll while this shortlist is visible. Old results are server-persisted
    // and recover on reload; the browser never invents a passing verdict.
    const timer = window.setInterval(() => void load(), 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [caseId, newestTaskId]);


  // A fresh comparison must be persisted by the existing verifier before
  // recommending any draft. Viewing evidence alone never approves a version.
  async function inspectVerification(row: LocatorCandidateComparison) {
    if (!canReview || !row.verificationId || busy || evidenceLoadingKey) return;
    const key = `${row.candidateVersionId}:${row.verificationId}`;
    if (activeEvidenceKey === key) {
      setActiveEvidenceKey(null);
      setReviewAcknowledgedId(null);
      return;
    }
    setActiveEvidenceKey(key);
    setReviewAcknowledgedId(null);
    if (evidenceByVerification[key]) return;
    setEvidenceLoadingKey(key);
    setComparisonError(null);
    try {
      const page = await listLocatorMaintenanceEvidence(
        row.candidateVersionId,
        row.verificationId,
      );
      setEvidenceByVerification((before) => ({
        ...before,
        [key]: page.items,
      }));
    } catch (cause) {
      setActiveEvidenceKey(null);
      setComparisonError(
        cause instanceof Error ? cause.message : '无法加载审核证据',
      );
    } finally {
      setEvidenceLoadingKey(null);
    }
  }

  async function retryVerification(row: LocatorCandidateComparison) {
    if (
      !canCreate || archived || busy || row.reviewStatus !== 'draft' ||
      row.status === 'queued' || row.status === 'running'
    ) return;
    setBusy(true);
    setComparisonError(null);
    try {
      await startLocatorMaintenanceVerification(row.candidateVersionId);
      setReviewAcknowledgedId(null);
      setActiveEvidenceKey(null);
      if (newestTaskId) {
        const updated = await listLocatorCandidateComparison(caseId, newestTaskId);
        setComparisonRows(updated.items);
      }
      setComparisonProgress('已重新排队隔离 Chromium 验证');
    } catch (cause) {
      setComparisonError(
        cause instanceof Error ? cause.message : '重新验证失败',
      );
    } finally {
      setBusy(false);
    }
  }

  async function requestCandidateReview(row: LocatorCandidateComparison) {
    const key = row.verificationId
      ? `${row.candidateVersionId}:${row.verificationId}`
      : '';
    const evidence = key ? evidenceByVerification[key] : undefined;
    const hasAvailableProof = evidence?.some(
      (item) =>
        item.retention === 'available' &&
        item.criterionPassed === true &&
        !!item.screenshotSha256,
    );
    if (
      !canReview || archived || busy || !allCompared ||
      row.reviewStatus !== 'draft' || row.status !== 'completed' ||
      row.outcome !== 'passed' || !row.evidenceBacked ||
      activeEvidenceKey !== key || !hasAvailableProof ||
      reviewAcknowledgedId !== row.candidateVersionId
    ) return;
    setBusy(true);
    setComparisonError(null);
    try {
      await onRequestCandidateReview(row.candidateVersionId);
    } catch (cause) {
      setComparisonError(
        cause instanceof Error ? cause.message : '无法打开候选版本审核',
      );
    } finally {
      setBusy(false);
    }
  }

  async function compareLatestCandidates() {
    if (
      busy || archived || !canCreate || !comparisonConfirmed ||
      !newestTaskId || latestCandidates.length < 2 || latestCandidates.length > 3
    ) return;
    setBusy(true);
    setComparisonError(null);
    setComparisonProgress('');
    let createdCount = 0;
    try {
      const current = await listLocatorCandidateComparison(caseId, newestTaskId);
      setComparisonRows(current.items);
      if (current.items.some((row) => row.suggestionIndex === null))
        throw new Error('该任务已有旧版单候选草稿，无法安全关联多个原始序号');
      let expected = caseVersion;
      // Every candidate produces an independent draft and queued Chromium
      // verification. Each server call rechecks the frozen Worker witness and
      // expectedVersion. A conflict leaves earlier legitimate drafts intact.
      for (const [index, candidate] of latestCandidates.entries()) {
        if (current.items.some(
          (row) => row.suggestionIndex === candidate.suggestionIndex,
        )) continue;
        setComparisonProgress(
          `正在排队候选 ${index + 1}/${latestCandidates.length}`,
        );
        await createLocatorMaintenanceDraft(
          caseId, newestTaskId, expected, candidate.suggestionIndex, true,
        );
        expected++;
        createdCount++;
        const next = await listLocatorCandidateComparison(caseId, newestTaskId);
        setComparisonRows(next.items);
      }
      setComparisonProgress('已提交独立验证；实时读取各候选结论');
    } catch (cause) {
      setComparisonError(
        cause instanceof Error
          ? `部分候选可能已经排队：${cause.message}。请核对列表后重试，已创建版本不会自动撤销。`
          : '无法提交全部候选，请刷新并检查当前版本',
      );
    } finally {
      if (createdCount) {
        await onCandidatesQueued().catch((cause: unknown) => {
          setComparisonError(
            cause instanceof Error ? cause.message : '用例版本刷新失败',
          );
        });
      }
      setBusy(false);
    }
  }



  useEffect(() => {
    let active = true;
    setProposals([]);
    setRepairSuggestions([]);
    setCursor(null);
    setReviewId(null);
    setCandidateFor(null);
    setMaintenance(null);
    setMaintenanceConfirmed(false);
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
        setRepairSuggestions(page.repairSuggestions ?? []);
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
    setRepairSuggestions(page.repairSuggestions ?? []);
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

  function prepareMaintenance(record: RepairSuggestionRecord) {
    setError(null);
    setMaintenanceConfirmed(false);
    try {
      if (!baselineVersion) throw new Error('尚未取得已批准的基线版本');
      const preview = previewLocatorMaintenance(baselineVersion, record);
      const suggestionIndex = repairSuggestions
        .filter((item) => item.taskId === record.taskId)
        .findIndex((item) => item === record);
      if (suggestionIndex < 0) throw new Error('维护建议已经失效');
      setMaintenance({ taskId: record.taskId, suggestionIndex, preview });
    } catch (e) {
      setMaintenance(null);
      setError(e instanceof Error ? e.message : '维护候选无法生成');
    }
  }

  async function saveMaintenance() {
    if (
      busy ||
      archived ||
      !canCreate ||
      !maintenanceConfirmed ||
      !maintenance ||
      !baselineVersion
    )
      return;
    setBusy(true);
    setError(null);
    try {
      // Recheck immediately before the write: suggestions can go stale while
      // the user reviews them. Backend expectedVersion is a second CAS guard.
      const selected = repairSuggestions.filter(
        (candidate) => candidate.taskId === maintenance.taskId,
      )[maintenance.suggestionIndex];
      if (!selected) throw new Error('维护建议已失效，请刷新');
      const current = previewLocatorMaintenance(baselineVersion, selected);
      if (
        JSON.stringify(current.document) !==
        JSON.stringify(maintenance.preview.document)
      )
        throw new Error('维护候选与最新观察不一致，请重新预览');
      const created = await createLocatorMaintenanceDraft(
        caseId,
        selected.taskId,
        caseVersion,
        maintenance.suggestionIndex,
        true, // Confirmed preview -> atomic draft + independent verification.
      );
      setMaintenance(null);
      setMaintenanceConfirmed(false);
      await onCandidateCreated(created.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : '维护草稿创建失败');
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
            产品缺陷修复提案必须关联独立复现确认的缺陷；定位维护候选则独立预览并生成待审核草稿，不得伪造产品缺陷。批准建议不代表修复验证通过，也不会自动更新正式基线。
          </p>
        </div>
      </div>
      {error && (
        <p className="text-sm text-danger lqa-repair-error" role="alert">
          {error}
        </p>
      )}
      {!loading && repairSuggestions.length > 0 && (
        <div className="lqa-card-list" data-testid="locator-repair-suggestions">
          <h3>执行器发现的定位修复候选（未验证）</h3>
          <p className="text-sm" role="status" data-testid="locator-candidate-screening">
            已自动筛选 {repairSuggestions.length} 条见证建议：
            可预览 {screening.candidates.length} 条
            {screening.excludedCount > 0
              ? ` · 排除过期、重复或不满足安全规则的 ${screening.excludedCount} 条`
              : ''}
            。排序只代表结构匹配程度，不代表业务等价或验证通过。
          </p>

          {latestCandidates.length >= 1 && (
            <div className="panel stack stack-sm" data-testid="locator-candidate-comparison">
              <h4>AI 自愈 · 统一维护决策工作台</h4>
              <p className="text-sm muted">
                最新失败任务有 {latestCandidates.length} 个结构筛选后的候选，
                可逐个在隔离 Chromium 中运行原有冻结业务断言。
                每个草稿独立保留版本及证据；即使全部通过也不会自动更新正式基线。
                多候选排队按顺序提交，部分失败时已提交任务不会自动撤销。
              </p>

              <div data-testid="locator-maintenance-decision">
                <strong>统一维护决策</strong>
                <p className="text-sm">
                  ① 已从真实失败任务提取 {latestCandidates.length} 个结构安全候选
                  {' → '}② 已提交 {compared.length}/{latestCandidates.length} 个独立验证
                  {' → '}③ {allCompared
                    ? '已获得全部候选结论，等待人工复核'
                    : comparisonPending
                      ? 'Chromium 正在执行，结果自动同步'
                      : '尚未完成全部候选验证'}
                </p>
                <p className="text-sm" role="status">
                  {allCompared
                    ? verifiedWinner
                      ? `证据支持的唯一通过候选：v${verifiedWinner.version}。这是技术验证优先项，不是自动批准结论。`
                      : verifiedPassed.length > 1
                        ? '存在多个通过候选，业务语义仍有歧义，必须由负责人逐条比较并选择。'
                        : '暂无符合证据要求的通过候选，不能建议批准。'
                    : '待所有候选完成验证后，才能比较通过结果和风险。'}
                </p>
                <p className="text-xs muted">
                  风险：冻结断言通过只能证明本次隔离浏览器执行的观察结果，
                  不能证明所有环境稳定、页面语义等价或没有副作用；
                  截图可能按留存策略清理。正式审批仍需人工填写依据并二次确认。
                </p>
              </div>
              {comparisonError && <p role="alert" className="text-sm text-danger">{comparisonError}</p>}
              {comparisonProgress && <p role="status" className="text-sm">{comparisonProgress}</p>}
              {canCreate && !archived && latestCandidates.length >= 2 && (
                <label className="row row-wrap text-sm">
                  <input
                    type="checkbox"
                    checked={comparisonConfirmed}
                    disabled={busy}
                    onChange={(event) => setComparisonConfirmed(event.target.checked)}
                  />
                  我已确认这些候选只改变定位器、冻结的业务断言不变；
                  同意分别创建待审版本并执行隔离验证。
                </label>
              )}
              {canCreate && !archived && latestCandidates.length >= 2 && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={
                    busy || !comparisonConfirmed || comparisonPending ||
                    (compared.length === latestCandidates.length) ||
                    !!comparisonRows.some((row) => row.suggestionIndex === null)
                  }
                  onClick={() => void compareLatestCandidates()}
                  data-testid="btn-compare-locator-candidates"
                >
                  {compared.length
                    ? '继续验证尚未提交的候选'
                    : '分别验证所有候选并对比结果'}
                </button>
              )}
              {latestCandidates.length === 1 && !compared.length && (
                <p className="text-sm muted">
                  单候选可直接使用下方“预览推荐修复”或“预览最小定位维护草稿”；
                  确认后自动创建草稿并排队独立验证，结果会在这里更新。
                </p>
              )}
              {compared.length > 0 && (
                <div className="lqa-card-list">
                  {latestCandidates.map((candidate) => {
                    const row = compared.find(
                      (item) => item.suggestionIndex === candidate.suggestionIndex,
                    );
                    return (
                      <div className="lqa-item-card" key={candidate.suggestionIndex}>
                        <strong>
                          候选 {candidate.suggestionIndex + 1} ·
                          {row ? ` v${row.version}` : ' 尚未提交'}
                          {verifiedWinner?.candidateVersionId === row?.candidateVersionId
                            ? ' · 唯一证据充分的通过候选'
                            : ''}
                        </strong>
                        <p className="text-xs muted">
                          定位器：{candidate.preview.after.value} /
                          {candidate.preview.after.name ?? '—'}
                        </p>
                        <p className="text-sm">
                          {row
                            ? `${row.status ?? '未排队'} / ${row.outcome ?? '尚无结论'}`
                            : '尚未进行独立验证'}
                          {row?.evidenceBacked ? ' · 已有独立截图及断言证据' : ''}
                        </p>
                        {row && (
                          <p className="text-xs muted">
                            原有断言验证 {row.verifiedCriteria} 项 ·
                            观察步骤 {row.observedSteps} ·
                            原因 {row.reasonCode ?? '无'} ·
                            审核状态 {row.reviewStatus}
                          </p>
                        )}

                        {row && row.status === 'completed' &&
                          row.reviewStatus === 'draft' && canCreate && !archived &&
                          (row.outcome !== 'passed' || !row.evidenceBacked) && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={busy || comparisonPending}
                            onClick={() => void retryVerification(row)}
                          >
                            重新执行该候选的独立验证
                          </button>
                        )}
                        {row?.verificationId && row.status === 'completed' && canReview && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={busy || !!evidenceLoadingKey}
                            onClick={() => void inspectVerification(row)}
                            data-testid={`btn-inspect-candidate-evidence-${candidate.suggestionIndex}`}
                          >
                            {activeEvidenceKey ===
                            `${row.candidateVersionId}:${row.verificationId}`
                              ? '收起审核证据'
                              : '在此查看断言与截图证据'}
                          </button>
                        )}
                        {row?.verificationId &&
                          activeEvidenceKey ===
                            `${row.candidateVersionId}:${row.verificationId}` &&
                          (() => {
                            const key = `${row.candidateVersionId}:${row.verificationId}`;
                            const entries = evidenceByVerification[key];
                            const proofReady = entries?.some(
                              (item) =>
                                item.retention === 'available' &&
                                item.criterionPassed === true &&
                                !!item.screenshotSha256,
                            );
                            return (
                              <div className="panel stack stack-sm" data-testid="locator-inline-evidence">
                                <strong>独立验证原始证据</strong>
                                {evidenceLoadingKey === key && (
                                  <p role="status" className="text-sm">正在加载受权限保护的审核证据…</p>
                                )}
                                {entries && entries.length === 0 && (
                                  <p className="text-sm muted">未找到可审查的步骤证据。</p>
                                )}
                                {entries?.map((entry) => (
                                  <p className="text-xs" key={entry.id}>
                                    步骤 {entry.stepIndex + 1} · {entry.stepKind}
                                    {' · '}断言 {entry.criterionId ?? '—'}
                                    ：{entry.criterionPassed === null
                                      ? '未评估'
                                      : entry.criterionPassed ? '通过' : '失败'}
                                    {' · '}{entry.retention === 'available' ? '证据保留' : '证据已清理'}
                                    {entry.retention === 'available' && entry.screenshotSha256 && (
                                      <>
                                        {' · '}
                                        <a
                                          href={locatorMaintenanceScreenshotUrl(
                                            row.candidateVersionId, row.verificationId!,
                                            entry.id,
                                          )}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                        >
                                          查看脱敏截图
                                        </a>
                                      </>
                                    )}
                                  </p>
                                ))}
                                {row.evidenceBacked && !proofReady && entries && (
                                  <p className="text-sm text-danger">
                                    当前无法查看支持通过结论的截图，不能在此进入审核；请检查证据留存。
                                  </p>
                                )}
                                {proofReady && row.outcome === 'passed' &&
                                  row.evidenceBacked && row.reviewStatus === 'draft' &&
                                  allCompared && !archived && (
                                  <>
                                    <label className="row row-wrap text-sm">
                                      <input
                                        type="checkbox"
                                        checked={reviewAcknowledgedId === row.candidateVersionId}
                                        disabled={busy}
                                        onChange={(event) => setReviewAcknowledgedId(
                                          event.target.checked ? row.candidateVersionId : null,
                                        )}
                                      />
                                      我已检查该版本的定位差异、原有断言、截图证据和业务等价风险；
                                      我理解此处仅打开正式审核，不会自动批准。
                                    </label>
                                    <button
                                      type="button"
                                      className="btn btn-primary btn-sm"
                                      disabled={
                                        busy ||
                                        reviewAcknowledgedId !== row.candidateVersionId
                                      }
                                      onClick={() => void requestCandidateReview(row)}
                                      data-testid={`btn-open-candidate-review-${candidate.suggestionIndex}`}
                                    >
                                      进入该候选的两阶段人工审核
                                    </button>
                                  </>
                                )}
                              </div>
                            );
                          })()}
                        {row && (
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={busy}
                            onClick={() => void onCandidateCreated(row.candidateVersionId)}
                          >
                            查看候选版本及独立验证证据
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {allCompared && (
                <p role="status" className="text-sm">
                  {verifiedWinner
                    ? `全部候选已完成验证，仅 v${verifiedWinner.version} 取得可核查截图支持的通过结果；仍需负责人审核。`
                    : verifiedPassed.length > 1
                      ? '多个候选具有独立通过证据，无法仅凭测试结果证明哪一个更符合业务语义，请人工比较。'
                      : '全部候选已结束，但不存在唯一且具有截图支持的通过候选，不进行自动推荐。'}
                </p>
              )}
            </div>
          )}
          {screening.recommended ? (
            <div className="panel stack stack-sm" data-testid="locator-candidate-recommendation">
              <strong>优先复核 · 步骤 {screening.recommended.preview.stepIndex + 1}</strong>
              <p className="text-sm muted">
                {screening.recommended.rationale}。
                已优先选择最新失败任务中的唯一高匹配候选；
                修复前后差异和所有断言仍需人工核对。
              </p>
              {canCreate && !archived && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy || !baselineVersion}
                  onClick={() => prepareMaintenance(screening.recommended!.record)}
                  data-testid="btn-preview-recommended-repair"
                >
                  预览推荐修复并准备独立验证
                </button>
              )}
            </div>
          ) : (
            <p className="text-sm muted" data-testid="locator-candidate-review-required">
              当前不存在唯一的高匹配候选，或最新失败任务的建议已失效。
              请逐条检查下方有效候选，不会自动猜测业务含义。
            </p>
          )}
          {screening.candidates.length === 0 && (
            <p className="text-sm muted">当前没有可安全生成维护草稿的建议。</p>
          )}
          <p className="text-sm muted">
            这些记录来自已审核版本的真实浏览器观察，不是已确认的产品
            Bug，也不是可直接执行的修复。
            需要人工判断业务等价性，另行验证候选版本并通过正式审核。
          </p>
          {screening.candidates.map(({ record, suggestionIndex, rationale, newestTask }) => (
            <details
              key={`${record.taskId}:${suggestionIndex}`}
              className="lqa-item-card"
            >
              <summary>
                步骤 {record.suggestion.source.stepIndex + 1} ·{' '}
                {record.suggestion.original.name ??
                  record.suggestion.original.value}
                {' → '}
                {record.suggestion.proposed.name ??
                  record.suggestion.proposed.value}
              </summary>
              <p className="text-xs muted">
                运行 {record.runId} · 已审核来源版本 {record.sourceVersionId}
              </p>
              <p className="text-xs muted">
                筛选依据：{rationale} · {newestTask ? '最新失败任务' : '历史任务'}
                · 候选原始序号 {suggestionIndex + 1}
              </p>
              <p className="text-xs muted">
                诊断 {record.suggestion.reasonCode} · 快照{' '}
                {record.suggestion.snapshotId} · 验证：尚未运行
              </p>
              <pre className="lqa-diff">
                {JSON.stringify(
                  {
                    source: record.suggestion.source,
                    original: record.suggestion.original,
                    proposed: record.suggestion.proposed,
                    observedOrigin: record.suggestion.observedOrigin,
                  },
                  null,
                  2,
                )}
              </pre>
              {canCreate && !archived && (
                <div className="btn-group">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busy || !baselineVersion}
                    onClick={() => prepareMaintenance(record)}
                  >
                    预览最小定位维护草稿
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() =>
                      setDiff(
                        JSON.stringify(
                          {
                            evidence: record.suggestion.snapshotId,
                            sourceVersionId: record.sourceVersionId,
                            source: record.suggestion.source,
                            from: record.suggestion.original,
                            to: record.suggestion.proposed,
                            reviewRequired: true,
                          },
                          null,
                          2,
                        ),
                      )
                    }
                  >
                    填入产品缺陷提案说明
                  </button>
                </div>
              )}
            </details>
          ))}
          {maintenance && (
            <div
              className="panel lqa-proposal-form"
              data-testid="locator-maintenance-preview"
            >
              <h4>AI 定位自愈 · 预览并自动验证</h4>
              <p className="text-sm muted">
                仅替换第 {maintenance.preview.stepIndex + 1}{' '}
                步定位器。所有业务断言、操作顺序、变量与预期结果保持不变。尚未独立验证。
              </p>
              <pre className="lqa-diff">
                {JSON.stringify(
                  {
                    original: maintenance.preview.before,
                    proposed: maintenance.preview.after,
                  },
                  null,
                  2,
                )}
              </pre>
              <details>
                <summary>查看完整候选 RegressionDocument JSON</summary>
                <pre className="lqa-diff">
                  {JSON.stringify(maintenance.preview.document, null, 2)}
                </pre>
              </details>
              <label className="row row-wrap text-sm">
                <input
                  type="checkbox"
                  checked={maintenanceConfirmed}
                  onChange={(event) =>
                    setMaintenanceConfirmed(event.target.checked)
                  }
                />
                我已核对定位器的业务等价性，同意创建待审核草稿并自动排队独立 Chromium 验证；验证通过仍须负责人审核后才会生效。
              </label>
              <div className="btn-group">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={busy || !maintenanceConfirmed}
                  onClick={() => void saveMaintenance()}
                >
                  创建草稿并自动验证（不更新基线）
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => {
                    setMaintenance(null);
                    setMaintenanceConfirmed(false);
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>
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
