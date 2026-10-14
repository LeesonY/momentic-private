import { useEffect, useState } from 'react';
import {
  getLocatorMaintenanceEffectiveness,
  type LocatorMaintenanceEffectiveness,
} from '../../api/locatorMaintenance.ts';

function ratio(numerator: number, denominator: number): string {
  if (!denominator) return '暂无样本';
  return `${(numerator / denominator * 100).toFixed(1)}%（${numerator}/${denominator}）`;
}

const kindLabels: Record<
  LocatorMaintenanceEffectiveness['byKind'][number]['kind'],
  string
> = {
  locator_name_variation: '名称细微变化',
  locator_semantic_candidate: '语义定位候选',
};

const reviewLabels = {
  draft: '等待人工处理',
  approved: '人工已批准',
  rejected: '人工已拒绝',
} as const;

/** Reviewer-facing retrospective analytics; every metric is from persisted
 * worker verification / human review, not from heuristic confidence. */
export function LocatorEffectivenessPanel({
  caseId,
  canReview,
  revisionKey,
  onInspectVersion,
}: {
  caseId: string;
  canReview: boolean;
  revisionKey: string;
  onInspectVersion: (versionId: string) => void;
}) {
  const [data, setData] = useState<LocatorMaintenanceEffectiveness | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!canReview) {
      setData(null);
      return;
    }
    // Scope switches must not transiently display another case's analytics.
    setData(null);
    setLoading(true);
    setError(null);
    void getLocatorMaintenanceEffectiveness(caseId)
      .then((result) => {
        if (active) setData(result);
      })
      .catch((cause: unknown) => {
        if (active) {
          setData(null);
          setError(
            cause instanceof Error ? cause.message : '无法读取定位自愈效果',
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [caseId, canReview, revisionKey]);

  async function refresh() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      setData(await getLocatorMaintenanceEffectiveness(caseId));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : '无法刷新自愈效果',
      );
    } finally {
      setLoading(false);
    }
  }

  if (!canReview) return null;
  const metrics = data?.metrics;
  return (
    <section className="card" data-testid="locator-maintenance-effectiveness">
      <div className="card-header">
        <div className="card-heading">
          <h2 className="card-title">AI 定位自愈 · 真实效果评估</h2>
          <p className="card-description">
            关联真实执行器草稿、独立 Chromium 验证和负责人最终决议。
            统计仅供分析，不训练模型、不自动调整业务断言，也不代替人工审核。
          </p>
        </div>
        <button
          className="btn btn-secondary btn-sm"
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
        >
          {loading ? '正在读取…' : '刷新效果指标'}
        </button>
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {data && metrics && (
        <div className="stack stack-sm">
          <p className="text-xs muted">
            统计范围：最近 {data.sampleWindowDays} 天、
            最多 {data.sampleLimit} 份最新维护草稿；本次纳入 {metrics.drafts} 份。
            {data.truncated
              ? ' 样本已达到上限，以下比率不代表全部历史。'
              : ' 未达到样本条数上限。'}
            每份草稿仅采用最新一次验证结果；重试不重复计数。
          </p>
          <dl className="kv" data-testid="locator-effectiveness-metrics">
            <dt>独立验证通过率</dt>
            <dd>
              {ratio(metrics.verifiedPassed, metrics.verifiedCompleted)}
            </dd>
            <dt>人工采纳率</dt>
            <dd>
              {ratio(metrics.humanApproved, metrics.humanReviewed)}
            </dd>
            <dt>维护草稿</dt>
            <dd>{metrics.drafts} 份</dd>
            <dt>验证完成 / 进行中</dt>
            <dd>
              {metrics.verifiedCompleted} / {metrics.verificationPending}
            </dd>
            <dt>验证失败 / 无法判定</dt>
            <dd>
              {metrics.verifiedFailed} / {metrics.verifiedInconclusive}
            </dd>
            <dt>人工批准 / 拒绝 / 尚未决议</dt>
            <dd>
              {metrics.humanApproved} / {metrics.humanRejected} /{' '}
              {metrics.drafts - metrics.humanReviewed}
            </dd>
            <dt>浏览器通过但人工拒绝</dt>
            <dd>{metrics.passedButRejected} 份</dd>
          </dl>
          <p className="text-xs muted">
            口径说明：独立通过必须有真实 Worker 验证结论及截图哈希证据
            （超期证据可通过留存回执证明曾存在，但截图可能已清理）。
            “人工决议”只计批准/拒绝次数，不等于全部点击或人工干预次数。
            “通过但拒绝”是需要复盘的分歧信号，不能直接称为 AI 误推荐率。
          </p>
          <h3>候选类型反馈（持续优化依据）</h3>
          {data.byKind.map((group) => (
            <p className="text-sm" key={group.kind}>
              <strong>{kindLabels[group.kind]}</strong> ·
              草稿 {group.drafts} ·
              独立通过 {group.verifiedPassed} ·
              人工批准 {group.humanApproved} ·
              通过后被拒绝 {group.passedButRejected}
            </p>
          ))}
          {metrics.passedButRejected > 0 && (
            <p className="text-sm" role="status">
              已发现浏览器验证与人工决策不一致的案例：
              需检查对应拒绝理由，重点复核定位器业务语义、唯一性及环境差异。
              暂不据此自动降权或改变候选的安全判定。
            </p>
          )}
          <details>
            <summary>查看最近 {data.items.length} 份维护草稿及人工决议理由</summary>
            <div className="lqa-card-list">
              {data.items.length === 0 && (
                <p className="text-sm muted">当前统计范围内尚无定位维护草稿。</p>
              )}
              {data.items.map((item) => (
                <div className="lqa-item-card" key={item.candidateVersionId}>
                  <strong>
                    v{item.version} · {reviewLabels[item.reviewStatus]}
                    {item.kind ? ` · ${kindLabels[item.kind]}` : ' · 历史候选'}
                  </strong>
                  <p className="text-xs muted">
                    建立时间 {new Date(item.createdAt).toLocaleString('zh-CN')} ·
                    {item.suggestionIndex === null
                      ? '旧版未知候选序号'
                      : `原始候选序号 ${item.suggestionIndex + 1}`}
                  </p>
                  <p className="text-sm">
                    验证 {item.verificationStatus ?? '未开始'} /
                    {item.verificationOutcome ?? '无结论'}
                    {item.verifiedPassed ? ' · 通过证据有效' : ''}
                    {item.verifiedPassed && !item.screenshotAvailable
                      ? ' · 原始截图已按留存规则清理'
                      : ''}
                  </p>
                  {item.reviewStatus !== 'draft' && (
                    <p className="text-sm">
                      人工决议理由：
                      {item.reviewReason ?? '无可核实的历史理由记录'}
                    </p>
                  )}
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => onInspectVersion(item.candidateVersionId)}
                  >
                    查看候选版本
                  </button>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
      {!loading && !data && !error && (
        <p className="text-sm muted">暂无可用的历史统计。</p>
      )}
    </section>
  );
}
