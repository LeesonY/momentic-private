import { useEffect, useState } from 'react';
import {
  getLocatorMaintenanceInfo,
  listLocatorMaintenanceEvidence,
  listLocatorMaintenanceVerifications,
  locatorMaintenanceScreenshotUrl,
  startLocatorMaintenanceVerification,
  type LocatorMaintenanceEvidence,
  type LocatorMaintenanceInfo,
  type LocatorMaintenanceVerification,
} from '../../api/locatorMaintenance.ts';

export function LocatorMaintenancePanel({
  versionId,
  canRun,
  canReview,
  archived,
}: {
  versionId: string;
  canRun: boolean;
  canReview: boolean;
  archived: boolean;
}) {
  const [info, setInfo] = useState<LocatorMaintenanceInfo | null>(null);
  const [items, setItems] = useState<LocatorMaintenanceVerification[]>([]);
  const [evidence, setEvidence] = useState<
    Record<string, LocatorMaintenanceEvidence[]>
  >({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    setInfo(null);
    setItems([]);
    setEvidence({});
    setError(null);
    void getLocatorMaintenanceInfo(versionId)
      .then(async (value) => {
        if (!active) return;
        setInfo(value);
        const latest = await listLocatorMaintenanceVerifications(versionId);
        if (active) setItems(latest.items);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        const status = (cause as { status?: number }).status;
        if (status !== 404)
          setError(cause instanceof Error ? cause.message : '维护记录读取失败');
      });
    return () => {
      active = false;
    };
  }, [versionId]);

  async function refresh() {
    setBusy(true);
    setError(null);
    try {
      setItems((await listLocatorMaintenanceVerifications(versionId)).items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '验证记录读取失败');
    } finally {
      setBusy(false);
    }
  }
  async function verify() {
    if (busy || !canRun || archived) return;
    setBusy(true);
    setError(null);
    try {
      const row = await startLocatorMaintenanceVerification(versionId);
      setItems((before) => [row, ...before]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法请求隔离验证');
    } finally {
      setBusy(false);
    }
  }
  async function loadEvidence(id: string) {
    if (busy || !canReview) return;
    setBusy(true);
    setError(null);
    try {
      const results = await listLocatorMaintenanceEvidence(versionId, id);
      setEvidence((before) => ({ ...before, [id]: results.items }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法获取证据');
    } finally {
      setBusy(false);
    }
  }
  if (!info && !error) return null;
  return (
    <section className="card" data-testid="locator-maintenance-verification">
      <div className="card-header">
        <div className="card-heading">
          <h2 className="card-title">定位维护 · 独立验证</h2>
          <p className="card-description">
            仅对单个定位器变更建立来源绑定；隔离 Chromium 验证原有业务断言。
            验证通过后仍需负责人使用正式的两阶段审核确认，绝不自动更新基线。
          </p>
        </div>
      </div>
      {error && (
        <p role="alert" className="text-danger text-sm">
          {error}
        </p>
      )}
      {info && (
        <>
          <p className="text-xs muted">
            来源版本 {info.sourceVersionId} · 失败任务 {info.taskId}
          </p>
          <div className="btn-group">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!canRun || busy || archived}
              onClick={() => void verify()}
            >
              启动独立 Chromium 验证
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={() => void refresh()}
            >
              刷新验证结果
            </button>
          </div>
          {items.length === 0 ? (
            <p className="muted text-sm">
              尚无独立验证记录，不能批准维护草稿。
            </p>
          ) : (
            <div className="lqa-card-list">
              {items.map((item) => (
                <div key={item.id} className="lqa-item-card">
                  <strong>
                    {item.status} / {item.outcome ?? '尚无结论'}
                  </strong>
                  <p className="text-xs muted">
                    核验步骤 {item.observedSteps} · 原有断言{' '}
                    {item.verifiedCriteria} · 原因 {item.reasonCode ?? '无'}
                  </p>
                  {item.outcome === 'passed' && (
                    <p className="text-sm">
                      已取得独立验证通过结论。负责人仍须查看验证证据并批准草稿。
                    </p>
                  )}
                  {canReview && item.status === 'completed' && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={busy}
                      onClick={() => void loadEvidence(item.id)}
                    >
                      查看步骤与截图证据
                    </button>
                  )}
                  {evidence[item.id]?.map((entry) => (
                    <div key={entry.id} className="text-xs muted">
                      步骤 {entry.stepIndex + 1} · {entry.stepKind} · 断言{' '}
                      {entry.criterionId ?? '—'}：
                      {entry.criterionPassed === null
                        ? '无'
                        : entry.criterionPassed
                          ? '通过'
                          : '失败'}{' '}
                      · {entry.retention}
                      {entry.retention === 'available' &&
                        entry.screenshotSha256 && (
                          <a
                            href={locatorMaintenanceScreenshotUrl(
                              versionId,
                              item.id,
                              entry.id,
                            )}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            查看脱敏截图
                          </a>
                        )}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
