import { sanitizeText } from '@localqa/browser';
import type { Verdict } from '@localqa/contracts';
import {
  parseReproStepActions,
  type ReproStepAction,
} from './reproduction-recording.js';

/**
 * Mo-style case report. The executing (or reproducing) agent submits it after
 * working through the case in its own browser; its status is the verdict.
 * The server keeps no oracle of its own; it only bounds and cleans the text.
 */
export interface AgentReport {
  status: 'passed' | 'issue_found' | 'blocked';
  summary: string;
  verified: string[];
  gaps: string[];
  criteria: {
    criterionId: string;
    result: 'passed' | 'failed' | 'unknown';
    reason: string;
  }[];
  bug: { title: string; expected: string; actual: string } | null;
  /** Optional reproducer anchors; absence never invalidates a case report. */
  reproStepActions?: ReproStepAction[];
}

/** Existing verdict fields remain required. Replay metadata is optional and
 * permissive: a malformed anchor must not invalidate the report itself. */
export const AGENT_REPORT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'verified', 'gaps', 'criteria', 'bug'],
  properties: {
    reproStepActions: { type: 'array', items: {} },
    status: { type: 'string', enum: ['passed', 'issue_found', 'blocked'] },
    summary: { type: 'string' },
    verified: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'string' } },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterionId', 'result', 'reason'],
        properties: {
          criterionId: { type: 'string' },
          result: { type: 'string', enum: ['passed', 'failed', 'unknown'] },
          reason: { type: 'string' },
        },
      },
    },
    bug: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['title', 'expected', 'actual'],
      properties: {
        title: { type: 'string' },
        expected: { type: 'string' },
        actual: { type: 'string' },
      },
    },
  },
};

const text = (value: unknown, max: number): string =>
  typeof value === 'string'
    ? sanitizeText(value).replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
const list = (value: unknown, items: number, max: number): string[] =>
  Array.isArray(value)
    ? value
        .map((item) => text(item, max))
        .filter(Boolean)
        .slice(0, items)
    : [];

/** Bounded, cleaned report, or null when the agent submitted none usable. */
export function parseAgentReport(value: unknown): AgentReport | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const status = row['status'];
  if (status !== 'passed' && status !== 'issue_found' && status !== 'blocked')
    return null;
  const criteria = Array.isArray(row['criteria'])
    ? row['criteria']
        .filter(
          (item): item is Record<string, unknown> =>
            !!item && typeof item === 'object' && !Array.isArray(item),
        )
        .map((item) => ({
          criterionId: text(item['criterionId'], 64),
          result: (['passed', 'failed', 'unknown'].includes(
            item['result'] as string,
          )
            ? item['result']
            : 'unknown') as AgentReport['criteria'][number]['result'],
          reason: text(item['reason'], 1000),
        }))
        .filter((item) => item.criterionId)
        .slice(0, 20)
    : [];
  const bug =
    row['bug'] && typeof row['bug'] === 'object' && !Array.isArray(row['bug'])
      ? (row['bug'] as Record<string, unknown>)
      : null;
  const anchors = parseReproStepActions(row['reproStepActions']);
  return {
    status,
    ...(anchors.length ? { reproStepActions: anchors } : {}),
    summary: text(row['summary'], 2000),
    verified: list(row['verified'], 30, 2000),
    gaps: list(row['gaps'], 30, 2000),
    criteria,
    bug:
      bug && text(bug['title'], 200)
        ? {
            title: text(bug['title'], 200),
            expected: text(bug['expected'], 2000),
            actual: text(bug['actual'], 2000),
          }
        : null,
  };
}

/** The verdict fields an agent report decides. A missing report is inconclusive. */
export function verdictFromReport(
  report: AgentReport | null,
  reason?: string,
): Pick<Verdict, 'status' | 'reasonCode' | 'summary' | 'gaps' | 'verified'> {
  if (!report)
    return {
      status: 'inconclusive',
      reasonCode: reason ?? 'AGENT_REPORT_MISSING',
      summary: '执行代理没有提交有效的报告，无法判定。',
      gaps: ['执行代理没有提交有效的报告。'],
      verified: [],
    };
  return {
    status: report.status,
    reasonCode:
      reason ??
      (report.status === 'passed'
        ? 'AGENT_VERIFIED'
        : report.status === 'issue_found'
          ? 'AGENT_ISSUE_FOUND'
          : 'AGENT_BLOCKED'),
    summary:
      report.summary ||
      (report.status === 'passed'
        ? '执行代理确认用例符合验收标准。'
        : report.status === 'issue_found'
          ? '执行代理发现与验收标准不符的表现。'
          : '执行代理未能完成验证。'),
    gaps: report.gaps,
    verified: report.verified,
  };
}
