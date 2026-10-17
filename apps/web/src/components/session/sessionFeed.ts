import type {
  CaseRecord,
  Finding,
  Run,
  RunEvent,
  SessionReport,
  Step,
  Task,
} from '@localqa/contracts';
import type { RunMessage } from '../../api/index.ts';
import { isDuplicateFinding } from './findingDedup.ts';
import { stepReasonText } from './stepReason.ts';
import {
  taskRoleLabel,
  taskStageLabel,
} from '../workbench/TaskExecutionDetail.tsx';

/** One row inside a collapsible "N 个动作" group, like Mo's tool rows. */
export interface FeedAction {
  key: string;
  at: string;
  label: string;
  chips: string[];
}

export type FeedItem =
  | { kind: 'user'; key: string; at: string; text: string }
  | {
      kind: 'assistant';
      key: string;
      at: string;
      text: string;
      tone?: 'warning' | 'danger';
    }
  | {
      kind: 'actions';
      key: string;
      at: string;
      endAt: string;
      actions: FeedAction[];
    }
  | { kind: 'agent'; key: string; at: string; taskId: string };

const safeTime = (iso: string) => {
  const stamp = new Date(iso).getTime();
  return Number.isFinite(stamp) ? stamp : 0;
};

const stepVerb: Record<string, string> = {
  navigate: '打开页面',
  click: '点击',
  type: '输入',
  fill: '输入',
  select: '选择',
  press: '按键',
  hover: '悬停',
  scroll: '滚动',
  observe: '观察页面',
  snapshot: '读取页面',
  screenshot: '截图',
  capture: '截图',
  prepare_auth_state: '准备登录状态',
  auth: '登录',
  extract: '读取内容',
  goto: '打开页面',
  wait: '等待',
  assert: '检查',
};

export const stepLabel = (step: Pick<Step, 'toolName'>) => {
  const name = step.toolName.replace(/^browser[._]/, '').toLowerCase();
  return stepVerb[name] ?? step.toolName;
};

const findingLabel: Record<Finding['status'], string> = {
  suspected: '发现疑似缺陷',
  confirmed: '确认缺陷',
  unconfirmed: '缺陷未能复现',
  blocked: '缺陷复现受阻',
};

const caseResultLabel: Record<string, string> = {
  passed: '用例通过',
  issue_found: '用例发现问题',
  blocked: '用例受阻',
  inconclusive: '用例无法判定',
};

/**
 * Turns the run's persisted events and messages into Mo's conversation:
 * what you asked, what the AI said, the tools it ran (grouped) and the
 * agents it started. Nothing is invented; a gap in events stays a gap.
 */
export function buildSessionFeed(input: {
  run: Run;
  events: RunEvent[];
  messages: RunMessage[];
  objective: string;
}): FeedItem[] {
  const { run, events, messages, objective } = input;
  const entries: (
    | { at: string; seq: number; item: Exclude<FeedItem, { kind: 'actions' }> }
    | { at: string; seq: number; action: FeedAction }
  )[] = [];

  entries.push({
    at: run.createdAt,
    seq: -1,
    item: {
      kind: 'user',
      key: 'request',
      at: run.createdAt,
      text: objective || `测试 ${run.targetUrl}`,
    },
  });
  for (const message of messages)
    entries.push({
      at: message.createdAt,
      seq: Number.MAX_SAFE_INTEGER,
      item: {
        kind: 'user',
        key: `msg-${message.id}`,
        at: message.createdAt,
        text: message.redactedText,
      },
    });

  const startedTasks = new Set<string>();
  const stepActions = new Map<string, FeedAction>();
  let lastPlan = '';
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const data = event.payload as Record<string, unknown>;
    const push = (label: string, chips: string[] = []) =>
      entries.push({
        at: event.at,
        seq: event.seq,
        action: { key: event.id, at: event.at, label, chips },
      });
    switch (event.type) {
      case 'task.updated': {
        const task = data as unknown as Task;
        if (typeof task.id !== 'string') break;
        if (task.role !== 'coordinator' && !startedTasks.has(task.id)) {
          startedTasks.add(task.id);
          entries.push({
            at: event.at,
            seq: event.seq,
            item: {
              kind: 'agent',
              key: `agent-${task.id}`,
              at: event.at,
              taskId: task.id,
            },
          });
        } else if (task.role === 'coordinator' && task.status === 'running') {
          push(`主 AI：${taskStageLabel[task.summary] ?? task.summary}`);
        }
        break;
      }
      case 'step.recorded': {
        const step = data as unknown as Step;
        if (typeof step.toolName !== 'string') break;
        const raw = step.targetDescription || step.summary;
        // A tool name repeated as its own description says nothing new.
        const chip =
          raw && raw.toLowerCase() !== step.toolName.toLowerCase() ? raw : '';
        const reason =
          step.status === 'failed' ? stepReasonText(step.reasonCode) : null;
        const label = `浏览器步骤 · ${stepLabel(step)}${
          step.status === 'failed'
            ? `（失败${reason ? `：${reason}` : ''}）`
            : ''
        }`;
        // A step is recorded when it starts and again when it settles;
        // show it once, with its latest state.
        const seen = step.id ? stepActions.get(step.id) : undefined;
        if (seen) {
          seen.label = label;
          seen.chips = chip ? [chip] : [];
          break;
        }
        const action: FeedAction = {
          key: event.id,
          at: event.at,
          label,
          chips: chip ? [chip] : [],
        };
        if (step.id) stepActions.set(step.id, action);
        entries.push({ at: event.at, seq: event.seq, action });
        break;
      }
      case 'case.created': {
        const record = data as unknown as CaseRecord | CaseRecord['definition'];
        const title =
          'definition' in record ? record.definition.title : record.title;
        if (title) push('记录了一个测试用例', [title]);
        break;
      }
      case 'case.result': {
        const record = data as unknown as CaseRecord;
        const status = record.verdict?.status ?? record.outcome;
        push(caseResultLabel[status] ?? '用例结果', [
          record.definition?.title ?? '',
        ]);
        break;
      }
      case 'finding.updated': {
        const finding = data as unknown as Finding;
        // Merged duplicates settle quietly; they fold into the retained
        // finding instead of surfacing as another discovery.
        if (finding.title && !isDuplicateFinding(finding))
          push(findingLabel[finding.status] ?? '缺陷更新', [finding.title]);
        break;
      }
      case 'input.resolved':
        push('收到你的回复，继续执行');
        break;
      case 'session.updated': {
        const session = data as unknown as SessionReport;
        const plan = session.plan?.trim();
        if (session.status !== 'complete' && plan && plan !== lastPlan) {
          lastPlan = plan;
          entries.push({
            at: event.at,
            seq: event.seq,
            item: {
              kind: 'assistant',
              key: `plan-${event.id}`,
              at: event.at,
              text: plan,
            },
          });
        }
        break;
      }
      default:
        break;
    }
  }

  entries.sort((a, b) => safeTime(a.at) - safeTime(b.at) || a.seq - b.seq);

  const feed: FeedItem[] = [];
  let group: Extract<FeedItem, { kind: 'actions' }> | null = null;
  for (const entry of entries) {
    if ('action' in entry) {
      if (!group) {
        group = {
          kind: 'actions',
          key: `group-${entry.action.key}`,
          at: entry.at,
          endAt: entry.at,
          actions: [],
        };
        feed.push(group);
      }
      group.actions.push(entry.action);
      group.endAt = entry.at;
    } else {
      group = null;
      feed.push(entry.item);
    }
  }
  return feed;
}

export const agentTitle = (task: Task, cases: CaseRecord[]) => {
  const record = task.caseId
    ? cases.find((item) => item.definition.id === task.caseId)
    : undefined;
  return (
    record?.definition.title ?? taskStageLabel[task.summary] ?? task.summary
  );
};

export const agentKind = (task: Task) => taskRoleLabel[task.role] ?? task.role;

export const elapsedLabel = (seconds: number) => {
  if (!seconds || seconds < 0) return '';
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
};

export const spanLabel = (from: string, to: string) => {
  const seconds = Math.round((safeTime(to) - safeTime(from)) / 1000);
  return elapsedLabel(seconds);
};
