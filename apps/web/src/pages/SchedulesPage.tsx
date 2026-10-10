import React, { useCallback, useEffect, useState } from 'react';
import type {
  Environment,
  AuthProfile,
  Member,
  RunCreate,
  ScheduleOccurrence,
} from '@localqa/contracts';
import type {
  Schedule,
  ScheduleCreate,
  RegressionRunCreate,
  SavedCase,
} from '../api/types.ts';
import { useApp } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { AppHeader } from '../components/layout/AppHeader.tsx';

type Kind = 'smoke' | 'regression';
type Draft = {
  name: string;
  cron: string;
  timezone: string;
  kind: Kind;
  targetUrl: string;
  environmentId: string;
  authProfileId: string;
  caseVersionIds: string[];
  overlapPolicy: 'skip' | 'queue';
  missedPolicy: 'skip' | 'catchup_one';
  enabled: boolean;
};

function initialDraft(): Draft {
  return {
    name: '',
    cron: '0 9 * * 1-5',
    timezone:
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
    kind: 'smoke',
    targetUrl: '',
    environmentId: '',
    authProfileId: '',
    caseVersionIds: [],
    overlapPolicy: 'skip',
    missedPolicy: 'skip',
    enabled: true,
  };
}

function editDraft(schedule: Schedule): Draft {
  const template = schedule.runTemplate as RunCreate & RegressionRunCreate;
  return {
    name: schedule.name,
    cron: schedule.cron,
    timezone: schedule.timezone,
    kind: schedule.templateKind,
    targetUrl: template.targetUrl ?? '',
    environmentId: template.environmentId ?? '',
    authProfileId: template.authProfileId ?? '',
    caseVersionIds: template.caseVersionIds ?? [],
    overlapPolicy: schedule.overlapPolicy,
    missedPolicy: schedule.missedPolicy,
    enabled: schedule.enabled,
  };
}

function errorText(error: unknown): string {
  const e = error as { status?: number; message?: string };
  if (e?.status === 409) return '版本冲突或已有未完成运行，请刷新后重试。';
  if (e?.status === 403) return '无权操作该项目的定时任务。';
  return e?.message || '操作失败，请检查输入或网络连接。';
}

export const SchedulesPage: React.FC = () => {
  const { currentProject, currentUser, setRoute, isMock } = useApp();
  const projectId = currentProject?.id;
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [authProfiles, setAuthProfiles] = useState<AuthProfile[]>([]);
  const [approvedCases, setApprovedCases] = useState<SavedCase[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [casesTruncated, setCasesTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState(false);
  const [editing, setEditing] = useState<Schedule | null>(null);
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [occurrences, setOccurrences] = useState<ScheduleOccurrence[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const member = members.find((m) => m.userId === currentUser?.id);
  const canManage =
    currentUser?.globalRole === 'admin' ||
    member?.role === 'owner' ||
    member?.role === 'operator';

  const reload = useCallback(async () => {
    if (!projectId) return;
    const response = await defaultApiClient.listSchedules(projectId, {
      limit: 30,
    });
    setSchedules(response.items);
    setNextCursor(response.nextCursor);
  }, [projectId]);

  useEffect(() => {
    let active = true;
    setSchedules([]);
    setNextCursor(null);
    setHistoryId(null);
    setOccurrences([]);
    setEditor(false);
    setEditing(null);
    setDraft(initialDraft());
    setError(null);
    setNotice(null);
    if (!projectId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void (async () => {
      try {
        const [s, e, a, m, firstCases] = await Promise.all([
          defaultApiClient.listSchedules(projectId, { limit: 30 }),
          defaultApiClient.listEnvironments(projectId),
          defaultApiClient.listAuthProfiles(projectId),
          defaultApiClient.listMembers(projectId),
          defaultApiClient.listSavedCases(projectId, {
            status: 'active',
            limit: 100,
          }),
        ]);
        const cases = [...firstCases.items];
        let cursor = firstCases.nextCursor;
        // Bound initial discovery; API rechecks approval at execution time.
        for (let page = 0; cursor && page < 4; page++) {
          const next = await defaultApiClient.listSavedCases(projectId, {
            status: 'active',
            limit: 100,
            cursor,
          });
          cases.push(...next.items);
          cursor = next.nextCursor;
        }
        if (!active) return;
        setSchedules(s.items);
        setNextCursor(s.nextCursor);
        setEnvironments(e.items);
        setAuthProfiles(a.items);
        setMembers(m.items);
        setApprovedCases(cases.filter((c) => !!c.currentApprovedVersionId));
        setCasesTruncated(!!cursor);
      } catch (e) {
        if (active) setError(errorText(e));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [projectId]);

  function beginCreate() {
    setEditing(null);
    setDraft(initialDraft());
    setEditor(true);
    setError(null);
  }
  function beginEdit(schedule: Schedule) {
    setEditing(schedule);
    setDraft(editDraft(schedule));
    setEditor(true);
    setError(null);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!projectId || busy || !canManage) return;
    setError(null);
    setNotice(null);
    try {
      if (!draft.name.trim() || draft.name.trim().length > 120)
        throw new Error('计划名称不能为空，且不能超过 120 个字符。');
      if (draft.cron.trim().split(/\s+/).length !== 5)
        throw new Error('仅支持五段 Cron：分钟 小时 日期 月份 星期。');
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: draft.timezone }).format();
      } catch {
        throw new Error('请输入有效的 IANA 时区，例如 Asia/Shanghai。');
      }
      let runTemplate: ScheduleCreate['runTemplate'];
      if (draft.kind === 'smoke') {
        const url = new URL(draft.targetUrl.trim());
        if (
          !['http:', 'https:'].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw new Error('请填写有效的 http(s) 目标 URL。');
        runTemplate = {
          projectId,
          targetUrl: url.href,
          ...(draft.environmentId && { environmentId: draft.environmentId }),
          ...(draft.authProfileId && { authProfileId: draft.authProfileId }),
        };
      } else {
        if (!draft.caseVersionIds.length)
          throw new Error('至少选择一条已批准的用例版本。');
        runTemplate = {
          projectId,
          caseVersionIds: draft.caseVersionIds as [string, ...string[]],
          ...(draft.environmentId && { environmentId: draft.environmentId }),
          ...(draft.authProfileId && { authProfileId: draft.authProfileId }),
        };
      }
      const input: ScheduleCreate = {
        name: draft.name.trim(),
        cron: draft.cron.trim(),
        timezone: draft.timezone.trim(),
        templateKind: draft.kind,
        runTemplate,
        overlapPolicy: draft.overlapPolicy,
        missedPolicy: draft.missedPolicy,
        enabled: draft.enabled,
      };
      setBusy(true);
      if (editing) {
        await defaultApiClient.updateSchedule(editing.id, {
          expectedVersion: editing.version,
          ...input,
        });
      } else {
        await defaultApiClient.createSchedule(projectId, input);
      }
      await reload();
      setNotice(
        editing
          ? '定时计划已更新，既有 occurrence 的配置不会改变。'
          : '定时计划已创建。',
      );
      setEditor(false);
      setEditing(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(schedule: Schedule) {
    if (busy || !canManage) return;
    setBusy(true);
    setError(null);
    try {
      await defaultApiClient.updateSchedule(schedule.id, {
        expectedVersion: schedule.version,
        enabled: !schedule.enabled,
      });
      await reload();
      setNotice(schedule.enabled ? '定时计划已暂停。' : '定时计划已启用。');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function runNow(schedule: Schedule) {
    if (busy || !canManage || !schedule.enabled) return;
    setBusy(true);
    setError(null);
    try {
      const run = await defaultApiClient.runScheduleNow(schedule.id);
      setRoute('workbench', { runId: run.id });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function showHistory(scheduleId: string, cursor?: string) {
    if (historyLoading) return;
    if (!cursor && historyId === scheduleId) {
      setHistoryId(null);
      return;
    }
    setHistoryLoading(true);
    setError(null);
    try {
      const page = await defaultApiClient.listScheduleOccurrences(scheduleId, {
        limit: 30,
        ...(cursor ? { cursor } : {}),
      });
      setHistoryId(scheduleId);
      setOccurrences((old) => (cursor ? [...old, ...page.items] : page.items));
      setHistoryCursor(page.nextCursor);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setHistoryLoading(false);
    }
  }

  return (
    <div className="app-container" data-testid="schedules-page">
      <AppHeader />
      <main className="main-content">
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: 14,
              alignItems: 'center',
              marginBottom: 18,
            }}
          >
            <div>
              <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>
                定时测试 / Scheduled Runs
              </h1>
              <p
                style={{
                  color: 'var(--color-text-muted)',
                  fontSize: '0.875rem',
                }}
              >
                {currentProject?.name ?? '请选择项目'} · 五段 Cron / IANA 时区 ·
                已批准用例版本
              </p>
            </div>
            <button
              className="btn btn-primary"
              type="button"
              disabled={!projectId || !canManage || busy || isMock}
              onClick={beginCreate}
              data-testid="btn-new-schedule"
            >
              新建计划
            </button>
          </div>
          {isMock && (
            <p role="note">
              演示模式不执行实际计划。请切换真实 API 以使用定时调度。
            </p>
          )}
          {error && (
            <div
              role="alert"
              className="card"
              style={{
                padding: 14,
                color: 'var(--color-danger-text)',
                marginBottom: 12,
              }}
            >
              {error}
            </div>
          )}
          {notice && (
            <div
              role="status"
              className="card"
              style={{ padding: 14, marginBottom: 12 }}
            >
              {notice}
            </div>
          )}
          {loading ? (
            <p>正在加载定时计划…</p>
          ) : (
            <div className="card" style={{ padding: 20, marginBottom: 20 }}>
              {!schedules.length ? (
                <p style={{ color: 'var(--color-text-muted)' }}>
                  尚无定时计划。创建计划后，后台将按设定时区自动发起运行。
                </p>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table
                    style={{
                      width: '100%',
                      borderCollapse: 'collapse',
                      textAlign: 'left',
                    }}
                  >
                    <thead>
                      <tr>
                        <th>名称</th>
                        <th>Cron / 时区</th>
                        <th>类型</th>
                        <th>策略</th>
                        <th>状态</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {schedules.map((schedule) => (
                        <React.Fragment key={schedule.id}>
                          <tr
                            style={{
                              borderTop: '1px solid var(--color-border-subtle)',
                            }}
                          >
                            <td>
                              <strong>{schedule.name}</strong>
                              <div style={{ fontSize: '0.75rem' }}>
                                v{schedule.version}
                              </div>
                            </td>
                            <td>
                              <code>{schedule.cron}</code>
                              <div style={{ fontSize: '0.8rem' }}>
                                {schedule.timezone}
                              </div>
                            </td>
                            <td>
                              {schedule.templateKind === 'smoke'
                                ? '冒烟'
                                : '回归'}
                            </td>
                            <td>
                              {schedule.overlapPolicy === 'queue'
                                ? '重叠排队'
                                : '重叠跳过'}{' '}
                              /{' '}
                              {schedule.missedPolicy === 'catchup_one'
                                ? '补执行一次'
                                : '错过跳过'}
                            </td>
                            <td>{schedule.enabled ? '已启用' : '已暂停'}</td>
                            <td style={{ minWidth: 270 }}>
                              <div
                                style={{
                                  display: 'flex',
                                  gap: 6,
                                  flexWrap: 'wrap',
                                }}
                              >
                                <button
                                  className="btn btn-secondary btn-sm"
                                  type="button"
                                  onClick={() => void showHistory(schedule.id)}
                                >
                                  {historyId === schedule.id
                                    ? '收起历史'
                                    : '执行历史'}
                                </button>
                                {canManage && !isMock && (
                                  <>
                                    <button
                                      className="btn btn-secondary btn-sm"
                                      disabled={busy}
                                      type="button"
                                      onClick={() => beginEdit(schedule)}
                                    >
                                      编辑
                                    </button>
                                    <button
                                      className="btn btn-secondary btn-sm"
                                      disabled={busy}
                                      type="button"
                                      onClick={() =>
                                        void toggleEnabled(schedule)
                                      }
                                    >
                                      {schedule.enabled ? '暂停' : '启用'}
                                    </button>
                                    <button
                                      className="btn btn-primary btn-sm"
                                      disabled={busy || !schedule.enabled}
                                      type="button"
                                      onClick={() => void runNow(schedule)}
                                    >
                                      立即运行
                                    </button>
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                          {historyId === schedule.id && (
                            <tr>
                              <td
                                colSpan={6}
                                style={{
                                  padding: 14,
                                  background: 'var(--color-bg-surface)',
                                }}
                              >
                                <h3
                                  style={{
                                    fontSize: '0.9rem',
                                    marginBottom: 8,
                                  }}
                                >
                                  最近执行记录
                                </h3>
                                {historyLoading && !occurrences.length ? (
                                  '加载中…'
                                ) : !occurrences.length ? (
                                  '暂无执行记录。'
                                ) : (
                                  <div style={{ overflowX: 'auto' }}>
                                    <table
                                      style={{
                                        width: '100%',
                                        textAlign: 'left',
                                      }}
                                    >
                                      <thead>
                                        <tr>
                                          <th>计划本地时间</th>
                                          <th>计划 UTC</th>
                                          <th>状态</th>
                                          <th>版本</th>
                                          <th>运行</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {occurrences.map((o) => (
                                          <tr key={o.id}>
                                            <td>{o.scheduledLocal}</td>
                                            <td>
                                              {new Date(
                                                o.scheduledAt,
                                              ).toISOString()}
                                            </td>
                                            <td>{o.status}</td>
                                            <td>v{o.scheduleVersion}</td>
                                            <td>
                                              {o.runId ? (
                                                <button
                                                  className="btn btn-secondary btn-sm"
                                                  type="button"
                                                  onClick={() =>
                                                    setRoute('workbench', {
                                                      runId: o.runId!,
                                                    })
                                                  }
                                                >
                                                  查看运行
                                                </button>
                                              ) : (
                                                '—'
                                              )}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                    {historyCursor && (
                                      <button
                                        className="btn btn-secondary btn-sm"
                                        type="button"
                                        disabled={historyLoading}
                                        onClick={() =>
                                          void showHistory(
                                            schedule.id,
                                            historyCursor,
                                          )
                                        }
                                      >
                                        更多记录
                                      </button>
                                    )}
                                  </div>
                                )}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {nextCursor && (
                <button
                  className="btn btn-secondary btn-sm"
                  type="button"
                  disabled={busy}
                  style={{ marginTop: 12 }}
                  onClick={() => {
                    if (!projectId) return;
                    void defaultApiClient
                      .listSchedules(projectId, {
                        limit: 30,
                        cursor: nextCursor,
                      })
                      .then((page) => {
                        setSchedules((old) => [...old, ...page.items]);
                        setNextCursor(page.nextCursor);
                      })
                      .catch((e) => setError(errorText(e)));
                  }}
                >
                  加载更多计划
                </button>
              )}
            </div>
          )}

          {editor && (
            <section
              className="card"
              style={{ padding: 22 }}
              data-testid="schedule-editor"
            >
              <h2 style={{ fontSize: '1.2rem', marginBottom: 18 }}>
                {editing ? '编辑定时计划' : '创建定时计划'}
              </h2>
              <form onSubmit={(e) => void save(e)}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
                    gap: 16,
                  }}
                >
                  <div className="form-group">
                    <label className="form-label">名称 *</label>
                    <input
                      className="form-input"
                      required
                      maxLength={120}
                      value={draft.name}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, name: e.target.value }))
                      }
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">执行类型 *</label>
                    <select
                      className="form-select"
                      value={draft.kind}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          kind: e.target.value as Kind,
                        }))
                      }
                    >
                      <option value="smoke">冒烟测试</option>
                      <option value="regression">已批准用例回归</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Cron（5 段）*</label>
                    <input
                      className="form-input"
                      required
                      value={draft.cron}
                      placeholder="0 9 * * 1-5"
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, cron: e.target.value }))
                      }
                    />
                    <span className="form-help">
                      例如 0 9 * * 1-5：工作日每天 9:00
                    </span>
                  </div>
                  <div className="form-group">
                    <label className="form-label">IANA 时区 *</label>
                    <input
                      className="form-input"
                      required
                      value={draft.timezone}
                      placeholder="Asia/Shanghai"
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, timezone: e.target.value }))
                      }
                    />
                  </div>
                  {draft.kind === 'smoke' ? (
                    <div className="form-group">
                      <label className="form-label">目标 URL *</label>
                      <input
                        type="url"
                        required
                        className="form-input"
                        value={draft.targetUrl}
                        placeholder="https://test.example.com/"
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, targetUrl: e.target.value }))
                        }
                      />
                    </div>
                  ) : (
                    <div
                      className="form-group"
                      style={{ gridColumn: '1 / -1' }}
                    >
                      <label className="form-label">已批准用例版本 *</label>
                      <div
                        style={{
                          maxHeight: 210,
                          overflowY: 'auto',
                          padding: 12,
                          border: '1px solid var(--color-border-subtle)',
                          borderRadius: 6,
                        }}
                      >
                        {!approvedCases.length && (
                          <p>本项目暂无当前已批准的可执行用例。</p>
                        )}
                        {approvedCases.map((c) => (
                          <label
                            key={c.id}
                            style={{ display: 'block', padding: '4px 0' }}
                          >
                            <input
                              type="checkbox"
                              checked={draft.caseVersionIds.includes(
                                c.currentApprovedVersionId!,
                              )}
                              onChange={(e) =>
                                setDraft((d) => ({
                                  ...d,
                                  caseVersionIds: e.target.checked
                                    ? [
                                        ...d.caseVersionIds,
                                        c.currentApprovedVersionId!,
                                      ]
                                    : d.caseVersionIds.filter(
                                        (id) =>
                                          id !== c.currentApprovedVersionId,
                                      ),
                                }))
                              }
                            />{' '}
                            {c.name} <small>({c.slug})</small>
                          </label>
                        ))}
                        {casesTruncated && (
                          <p className="form-help">
                            用例超过 500 条，当前仅列出前 500 条。
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="form-group">
                    <label className="form-label">执行环境</label>
                    <select
                      className="form-select"
                      value={draft.environmentId}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          environmentId: e.target.value,
                        }))
                      }
                    >
                      <option value="">不指定</option>
                      {environments.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">认证配置</label>
                    <select
                      className="form-select"
                      value={draft.authProfileId}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          authProfileId: e.target.value,
                        }))
                      }
                    >
                      <option value="">使用环境默认配置 / 无</option>
                      {authProfiles
                        .filter((a) => a.status === 'active')
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">运行重叠策略</label>
                    <select
                      className="form-select"
                      value={draft.overlapPolicy}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          overlapPolicy: e.target
                            .value as Draft['overlapPolicy'],
                        }))
                      }
                    >
                      <option value="skip">跳过重叠运行</option>
                      <option value="queue">排队等待（最多一项）</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">错过执行策略</label>
                    <select
                      className="form-select"
                      value={draft.missedPolicy}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          missedPolicy: e.target.value as Draft['missedPolicy'],
                        }))
                      }
                    >
                      <option value="skip">跳过</option>
                      <option value="catchup_one">最多补执行一次</option>
                    </select>
                  </div>
                </div>
                <label style={{ display: 'block', margin: '16px 0' }}>
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, enabled: e.target.checked }))
                    }
                  />{' '}
                  启用计划
                </label>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button
                    className="btn btn-primary"
                    type="submit"
                    disabled={busy}
                  >
                    {busy ? '保存中…' : '保存计划'}
                  </button>
                  <button
                    className="btn btn-secondary"
                    type="button"
                    disabled={busy}
                    onClick={() => setEditor(false)}
                  >
                    取消
                  </button>
                </div>
              </form>
            </section>
          )}
        </div>
      </main>
    </div>
  );
};
