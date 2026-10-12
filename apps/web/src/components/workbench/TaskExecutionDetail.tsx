import React, { useEffect, useMemo, useState } from 'react';
import type { Step, Task } from '@localqa/contracts';
import { defaultApiClient } from '../../api/index.ts';
import { AppIcon } from '../ui/AppIcon.tsx';
import { StatusBadge } from '../ui/Badge.tsx';
import { useApp } from '../../state/AppContext.tsx';

export const taskRoleLabel: Record<Task['role'], string> = {
  coordinator: '主 AI · 规划',
  explorer: '探索代理',
  executor: '执行代理',
  reproducer: '复现代理',
  finalizer: '总结代理',
};

export const taskStageLabel: Record<string, string> = {
  preflight: '确认测试范围和运行条件',
  auth: '准备浏览器认证',
  explore: '探索目标页面',
  plan: '生成测试方案',
  execute: '执行浏览器测试',
  reproduce: '独立复现疑似问题',
  finalize: '汇总验证证据和结果',
};

export const taskDurationLabel = (seconds: number) =>
  seconds > 0 ? `${seconds}s` : '耗时未记录';

/** Browser evidence comes from the real artifact endpoint, never a generated preview. */
export const EvidencePreview: React.FC<{
  artifactId: string;
  runId: string;
}> = ({ artifactId, runId }) => {
  const { currentProject } = useApp();
  const [meta, setMeta] = useState<{
    kind: string;
    status: string;
    error?: string | null;
  } | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let objectUrl = '';
    setMeta(null);
    setImageUrl('');
    setError('');
    void defaultApiClient
      .getArtifact(artifactId)
      .then(async (artifact) => {
        if (!active) return;
        if (
          artifact.runId !== runId ||
          (currentProject && artifact.projectId !== currentProject.id)
        )
          throw new Error('证据不属于当前运行或项目');
        setMeta(artifact);
        if (
          artifact.kind !== 'screenshot' ||
          artifact.status !== 'available' ||
          artifact.redaction === 'failed'
        )
          return;
        const blob = await defaultApiClient.downloadArtifact(artifactId);
        if (!active) return;
        if (blob.type !== 'image/png' || !blob.size) {
          setError('证据内容不是可预览的已脱敏 PNG 图片');
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      })
      .catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : '证据读取失败');
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifactId, runId, currentProject?.id]);
  return (
    <div className="mo-evidence" data-testid={`evidence-${artifactId}`}>
      {imageUrl && (
        <a
          href={imageUrl}
          target="_blank"
          rel="noreferrer"
          title="查看真实浏览器截图"
        >
          <img src={imageUrl} alt="由执行 Worker 采集的浏览器证据截图" />
        </a>
      )}
      {!imageUrl && (
        <span className="text-xs muted">
          {meta?.kind ?? '读取证据…'} · {meta?.status ?? '请求中'}
        </span>
      )}
      {error && (
        <span role="alert" className="text-xs text-danger">
          {error}
        </span>
      )}
      <code className="text-xs break-all">{artifactId.slice(0, 12)}</code>
    </div>
  );
};

interface Props {
  task: Task;
  active: boolean;
  runTargetUrl: string;
  onClose?: () => void;
}

export const TaskExecutionDetail: React.FC<Props> = ({
  task,
  active,
  runTargetUrl,
  onClose,
}) => {
  const [steps, setSteps] = useState<Step[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [openStepId, setOpenStepId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setSteps([]);
    setError(null);
    const load = async () => {
      try {
        const page = await defaultApiClient.listTaskSteps(task.id, {
          limit: 100,
        });
        if (!mounted) return;
        setSteps(page.items);
        setHasMore(Boolean(page.nextCursor));
        setError(null);
      } catch (e) {
        if (mounted)
          setError(e instanceof Error ? e.message : '任务步骤读取失败');
      }
    };
    void load();
    // Only a running task is polled. Once finished, the evidence stays stable.
    if (!active)
      return () => {
        mounted = false;
      };
    const timer = setInterval(() => void load(), 2500);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [task.id, active]);

  const lastScreenshot = useMemo(
    () =>
      [...steps]
        .reverse()
        .flatMap((s) => s.evidenceRefs)
        .at(0),
    [steps],
  );

  return (
    <div className="mo-agent-detail" data-testid={`task-detail-${task.id}`}>
      <div className="row row-wrap spread">
        <div>
          <strong>{taskRoleLabel[task.role]}</strong>
          <p className="text-xs muted">
            {taskStageLabel[task.summary] ?? task.summary ?? '等待任务反馈'}
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            aria-label="关闭代理详情"
          >
            收起
          </button>
        )}
      </div>
      <div className="row row-wrap">
        <StatusBadge status={task.status} size="sm" />
        <span className="text-xs muted">尝试 #{task.attempt}</span>
        <span className="text-xs muted">
          {taskDurationLabel(task.elapsedSeconds)}
        </span>
        {task.status === 'running' && (
          <span className="text-xs muted">等待代理执行与回传步骤…</span>
        )}
      </div>
      <div className="mo-browser-capture" data-testid="browser-evidence-panel">
        <div className="row row-wrap spread">
          <strong>
            <AppIcon name="image" size={14} /> 浏览器画面
          </strong>
          <span className="text-xs muted">最近采集的证据 · 非实时视频</span>
        </div>
        <a
          href={runTargetUrl}
          target="_blank"
          rel="noreferrer"
          className="text-xs break-all"
        >
          {runTargetUrl}
        </a>
        {lastScreenshot ? (
          <EvidencePreview artifactId={lastScreenshot} runId={task.runId} />
        ) : (
          <div className="mo-browser-placeholder">
            <AppIcon name="image" size={20} />
            <span>尚未采集到可查看的浏览器截图</span>
          </div>
        )}
      </div>
      <div className="row spread">
        <strong>真实执行步骤</strong>
        <span className="text-xs muted">{steps.length} 步</span>
      </div>
      {error && (
        <div className="alert alert-warning" role="alert">
          步骤加载失败：{error}。不能据此认定没有执行。
        </div>
      )}
      {!error && steps.length === 0 && (
        <p className="text-xs muted">
          代理尚未回传动作；请等待或检查任务状态。
        </p>
      )}
      {steps.map((step) => (
        <div
          key={step.id}
          className="mo-action-step"
          data-testid={`task-step-${step.id}`}
        >
          <button
            type="button"
            className="mo-action-toggle"
            onClick={() =>
              setOpenStepId((v) => (v === step.id ? null : step.id))
            }
            aria-expanded={openStepId === step.id}
          >
            <span>
              <AppIcon name="chevron-right" size={14} />{' '}
              <code>{step.toolName}</code> ·{' '}
              {step.summary || step.targetDescription || `步骤 ${step.seq}`}
            </span>
            <StatusBadge status={step.status} size="sm" />
          </button>
          {openStepId === step.id && (
            <div className="mo-action-evidence">
              <p className="text-xs">
                目标：{step.targetDescription || '未记录'}
              </p>
              <p className="text-xs">
                开始：{new Date(step.createdAt).toLocaleString()}
              </p>
              <p className="text-xs">
                结束：
                {step.finishedAt
                  ? new Date(step.finishedAt).toLocaleString()
                  : '未记录'}
              </p>
              {step.evidenceRefs.length ? (
                step.evidenceRefs.map((id) => (
                  <EvidencePreview
                    artifactId={id}
                    runId={task.runId}
                    key={id}
                  />
                ))
              ) : (
                <span className="text-xs muted">
                  本步骤无证据引用，不能据此断言通过
                </span>
              )}
            </div>
          )}
        </div>
      ))}
      {hasMore && (
        <p role="status" className="text-xs text-warning">
          步骤超过当前分页上限；仅展示已获取的部分，不能视为完整记录。
        </p>
      )}
    </div>
  );
};
