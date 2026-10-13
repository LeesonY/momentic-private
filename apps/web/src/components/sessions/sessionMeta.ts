import type { Run } from '@localqa/contracts';
import type { AppIconName } from '../ui/AppIcon.tsx';

/** A run is what Mo calls a session; these helpers keep the sidebar, the
 * session list and the session header saying the same thing. */
export const ACTIVE_RUN_STATUSES: Run['status'][] = [
  'draft',
  'queued',
  'running',
  'awaiting_input',
  'cancelling',
];

export const isRunActive = (run: Pick<Run, 'status'>) =>
  ACTIVE_RUN_STATUSES.includes(run.status);

export type SessionTone =
  'muted' | 'info' | 'ai' | 'warning' | 'success' | 'danger';

export const sessionStatusMeta: Record<
  Run['status'],
  { label: string; icon: AppIconName; tone: SessionTone }
> = {
  draft: { label: '准备中', icon: 'clock', tone: 'muted' },
  queued: { label: '排队中', icon: 'clock', tone: 'muted' },
  running: { label: '运行中', icon: 'activity', tone: 'info' },
  awaiting_input: { label: '等你回复', icon: 'alert-circle', tone: 'ai' },
  cancelling: { label: '正在停止', icon: 'clock', tone: 'warning' },
  completed: { label: '待查看', icon: 'check-circle', tone: 'success' },
  cancelled: { label: '已停止', icon: 'x-circle', tone: 'warning' },
  failed: { label: '未完成', icon: 'x-circle', tone: 'danger' },
};

export const sessionStatusLabel = (run: Run) =>
  run.status === 'completed' && run.completion === 'partial'
    ? '部分完成'
    : sessionStatusMeta[run.status].label;

export const taskIntentLabel: Record<string, string> = {
  flow: '流程测试',
  explore: '区域探索',
  reproduce: '问题复现',
  plan: '用例规划',
  changes: '变更回归',
  spec: '按规格测试',
};

/** Fields the session API adds for Mo's list and header; older servers
 * leave them out, and the UI falls back to what it can derive. */
export type RunWithMeta = Run & {
  title?: string | null;
  stats?: {
    cases: number;
    passed: number;
    issues: number;
    blocked: number;
    findings: number;
  } | null;
};

export const runStats = (run: Run) => (run as RunWithMeta).stats ?? null;

/** The AI's title when it gave one, else what is tested and where. */
export const sessionTitle = (run: Run) => {
  const title = (run as RunWithMeta).title?.trim();
  if (title) return title;
  const intent =
    run.executionMode === 'regression'
      ? '回归'
      : taskIntentLabel[run.effectiveConfig?.taskIntent ?? 'flow'];
  let where = run.targetUrl;
  try {
    const url = new URL(run.targetUrl);
    const path = `${url.pathname}${url.search}`.replace(/\/$/, '');
    where = `${url.host}${path}`;
  } catch {
    /* keep the raw value */
  }
  return intent ? `${intent} · ${where}` : where;
};

export const relativeTime = (iso: string) => {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(minutes) || minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  });
};
