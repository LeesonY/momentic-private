import React, { useEffect, useState } from 'react';
import type { Member, Health, User } from '@localqa/contracts';
import { useAppContext } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { Page } from '../components/layout/Page.tsx';
import { StatusBadge } from '../components/ui/Badge.tsx';
import { Section } from '../components/ui/Section.tsx';
import { Alert } from '../components/ui/Alert.tsx';
import { AppIcon } from '../components/ui/AppIcon.tsx';

export const MembersOpsPage: React.FC = () => {
  const { currentProject, currentUser, replaceProject, setRoute } =
    useAppContext();
  const [members, setMembers] = useState<Member[]>([]);
  const [draftMembers, setDraftMembers] = useState<Member[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [membersComplete, setMembersComplete] = useState(true);
  const [usersNotice, setUsersNotice] = useState('');
  const [addUserId, setAddUserId] = useState('');
  const [addRole, setAddRole] = useState<Member['role']>('viewer');
  const [confirmChanges, setConfirmChanges] = useState(false);
  const [savingMembers, setSavingMembers] = useState(false);
  const [membersError, setMembersError] = useState('');
  const [membersSuccess, setMembersSuccess] = useState('');

  useEffect(() => {
    setMembers([]);
    setDraftMembers([]);
    setUsers([]);
    setHealth(null);
    setLoadError('');
    setUsersNotice('');
    setMembersError('');
    setMembersSuccess('');
    setConfirmChanges(false);
    if (!currentProject) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const projId = currentProject.id;
    async function load() {
      setLoading(true);
      try {
        const mRes = await defaultApiClient.listMembers(projId, { limit: 100 });
        if (cancelled) return;
        setMembers(mRes.items);
        setDraftMembers(mRes.items.map((member) => ({ ...member })));
        setMembersComplete(!mRes.nextCursor);
      } catch (err) {
        if (!cancelled)
          setLoadError(err instanceof Error ? err.message : '成员信息读取失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    void defaultApiClient.healthReady().then(
      (result) => {
        if (!cancelled) setHealth(result);
      },
      () => {
        if (!cancelled) setHealth(null);
      },
    );
    // Platform user directory requires administrator rights. Project owners
    // without that role can still add existing accounts by an explicit UUID.
    if (currentUser?.globalRole === 'admin') {
      void defaultApiClient.listUsers({ limit: 100 }).then(
        (result) => {
          if (cancelled) return;
          setUsers(result.items);
          if (result.nextCursor)
            setUsersNotice(
              '用户目录超过 100 条；可通过用户 UUID 指定未显示的用户。',
            );
        },
        () => {
          if (!cancelled)
            setUsersNotice(
              '无法读取用户目录，可以通过用户 UUID 添加已有账号。',
            );
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [currentProject?.id, currentUser?.id, currentUser?.globalRole]);

  const isOwner = members.some(
    (member) => member.userId === currentUser?.id && member.role === 'owner',
  );
  const canManage =
    currentProject?.status === 'active' &&
    (currentUser?.globalRole === 'admin' || isOwner);
  const changed =
    JSON.stringify(
      [...members].sort((a, b) => a.userId.localeCompare(b.userId)),
    ) !==
    JSON.stringify(
      [...draftMembers].sort((a, b) => a.userId.localeCompare(b.userId)),
    );
  const remainingOwners = draftMembers.filter(
    (member) => member.role === 'owner',
  ).length;
  const addMember = (event: React.FormEvent) => {
    event.preventDefault();
    setMembersError('');
    const id = addUserId.trim();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    ) {
      setMembersError('请输入已有用户的有效 UUID');
      return;
    }
    if (draftMembers.some((member) => member.userId === id)) {
      setMembersError('该用户已在项目成员列表中');
      return;
    }
    setDraftMembers((old) => [...old, { userId: id, role: addRole }]);
    setAddUserId('');
    setConfirmChanges(false);
    setMembersSuccess('');
  };
  const reloadMembers = async () => {
    if (!currentProject || loading || savingMembers) return;
    setLoading(true);
    setLoadError('');
    setMembersError('');
    setMembersSuccess('');
    try {
      const [project, result] = await Promise.all([
        defaultApiClient.getProject(currentProject.id),
        defaultApiClient.listMembers(currentProject.id, { limit: 100 }),
      ]);
      if (project.id !== currentProject.id)
        throw new Error('服务器返回的项目标识不匹配');
      replaceProject(project);
      setMembers(result.items);
      setDraftMembers(result.items.map((member) => ({ ...member })));
      setMembersComplete(!result.nextCursor);
      setConfirmChanges(false);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '重新加载成员失败');
    } finally {
      setLoading(false);
    }
  };
  const saveMembers = async () => {
    if (
      !currentProject ||
      !canManage ||
      !membersComplete ||
      savingMembers ||
      !changed
    )
      return;
    setMembersError('');
    setMembersSuccess('');
    if (!confirmChanges || remainingOwners === 0) {
      setMembersError('请确认变更并至少保留一位项目负责人');
      return;
    }
    setSavingMembers(true);
    try {
      const updated = await defaultApiClient.replaceMembers(currentProject.id, {
        expectedVersion: currentProject.version,
        members: draftMembers as [Member, ...Member[]],
      });
      if (updated.id !== currentProject.id)
        throw new Error('服务器返回的项目标识不匹配');
      replaceProject(updated);
      setMembers(draftMembers.map((member) => ({ ...member })));
      setMembersSuccess('成员与角色已保存至服务器');
      setConfirmChanges(false);
    } catch (error) {
      setMembersError(
        error instanceof Error
          ? error.message
          : '保存失败，请重新加载项目版本后重试',
      );
    } finally {
      setSavingMembers(false);
    }
  };
  const roleScope: Record<Member['role'], string> = {
    owner: '管理环境、成员、认证资料、项目知识及策略',
    operator: '启动冒烟、停止运行、补充说明、提交人工审查决议',
    viewer: '查看运行事实、测试报告与脱敏证据（只读）',
  };

  return (
    <Page
      testId="members-ops-page"
      title="成员与运维"
      description="管理项目成员与角色，查看平台服务状态，以及归档或删除项目。"
    >
      <Section
        icon="server"
        title="平台服务状态"
        testId="system-health-card"
        actions={
          <span
            className={`badge badge-dot ${health?.status === 'ok' ? 'badge-success' : 'badge-warning'}`}
          >
            {health === null
              ? '未取得健康状态'
              : health.status === 'ok'
                ? '就绪'
                : '未就绪'}
          </span>
        }
      >
        <div className="stat-grid">
          <div className="stat">
            <div className="stat-label">服务运行状态</div>
            <div
              className={`stat-value ${health?.status === 'ok' ? 'text-success' : 'text-warning'}`}
            >
              {health === null
                ? '状态未知'
                : health.status === 'ok'
                  ? '就绪'
                  : '未就绪'}
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">契约协议版本</div>
            <div className="stat-value">
              {health?.version ? `v${health.version}` : '尚未获取'}
            </div>
          </div>
        </div>
      </Section>

      <Section
        icon="users"
        title="项目成员"
        description="项目级权限，保存后由服务器最终校验。"
        actions={
          currentProject && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              data-testid="btn-reload-members"
              disabled={loading || savingMembers}
              onClick={() => void reloadMembers()}
            >
              <AppIcon name="refresh" size={14} />
              重新加载
            </button>
          )
        }
      >
        <div className="stack stack-sm">
          {loading && (
            <p className="muted text-sm" data-testid="members-loading">
              正在读取成员与权限…
            </p>
          )}
          {loadError && (
            <Alert tone="danger" role="alert" testId="members-load-error">
              {loadError}
            </Alert>
          )}
          {!membersComplete && (
            <Alert
              tone="warning"
              role="alert"
              testId="members-pagination-blocker"
            >
              成员超过当前单页上限。为避免整体替换时意外删除未加载的成员，已禁止编辑。
            </Alert>
          )}
          {!loading && !loadError && draftMembers.length === 0 && (
            <p className="muted text-sm" data-testid="members-empty">
              尚未读取到项目成员。
            </p>
          )}

          {draftMembers.length > 0 && (
            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>成员</th>
                    <th>项目角色</th>
                    <th>权限范围</th>
                    <th>状态</th>
                    {canManage && <th className="cell-actions">操作</th>}
                  </tr>
                </thead>
                <tbody>
                  {draftMembers.map((m) => {
                    const displayName = users.find(
                      (u) => u.id === m.userId,
                    )?.displayName;
                    const saved = members.some(
                      (member) => member.userId === m.userId,
                    );
                    return (
                      <tr key={m.userId} data-testid={`member-row-${m.userId}`}>
                        <td>
                          <div className="row">
                            <span
                              className={`cell-title ${displayName ? '' : 'mono'}`}
                            >
                              {displayName || m.userId}
                            </span>
                            {m.userId === currentUser?.id && (
                              <span className="badge badge-sm badge-primary">
                                当前账号
                              </span>
                            )}
                          </div>
                          {displayName && (
                            <div className="cell-sub mono">{m.userId}</div>
                          )}
                        </td>
                        <td>
                          {canManage && membersComplete ? (
                            <select
                              className="form-select lqa-role-select"
                              aria-label="项目成员角色"
                              data-testid={`member-role-${m.userId}`}
                              value={m.role}
                              disabled={savingMembers}
                              onChange={(event) => {
                                const role = event.target
                                  .value as Member['role'];
                                setDraftMembers((old) =>
                                  old.map((item) =>
                                    item.userId === m.userId
                                      ? { ...item, role }
                                      : item,
                                  ),
                                );
                                setConfirmChanges(false);
                                setMembersSuccess('');
                              }}
                            >
                              <option value="owner">负责人</option>
                              <option value="operator">操作员</option>
                              <option value="viewer">只读成员</option>
                            </select>
                          ) : (
                            <StatusBadge status={m.role} size="sm" />
                          )}
                        </td>
                        <td className="muted text-sm">{roleScope[m.role]}</td>
                        <td>
                          <span
                            className={`badge ${saved ? 'badge-neutral' : 'badge-warning'}`}
                          >
                            {saved ? '已授权' : '待保存'}
                          </span>
                        </td>
                        {canManage && (
                          <td className="cell-actions">
                            <button
                              type="button"
                              className="btn btn-ghost btn-sm"
                              data-testid={`remove-member-${m.userId}`}
                              disabled={
                                savingMembers ||
                                !membersComplete ||
                                m.userId === currentUser?.id ||
                                (m.role === 'owner' && remainingOwners <= 1)
                              }
                              onClick={() => {
                                setDraftMembers((old) =>
                                  old.filter(
                                    (item) => item.userId !== m.userId,
                                  ),
                                );
                                setConfirmChanges(false);
                                setMembersSuccess('');
                              }}
                            >
                              移除
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {canManage && membersComplete && !loading && !loadError && (
          <div
            className="panel lqa-members-editor"
            data-testid="members-editor"
          >
            <h3 className="lqa-panel-title">添加成员</h3>
            <p className="field-hint lqa-panel-hint">
              这里只为已有账号授予项目权限，不会新建用户。
            </p>
            <form onSubmit={addMember} className="lqa-add-member">
              {users.length > 0 && (
                <select
                  className="form-select"
                  aria-label="从平台用户目录选择"
                  data-testid="member-user-directory"
                  value={addUserId}
                  onChange={(event) => setAddUserId(event.target.value)}
                  disabled={savingMembers}
                >
                  <option value="">从平台用户目录选择</option>
                  {users
                    .filter(
                      (user) =>
                        !user.disabled &&
                        !draftMembers.some(
                          (member) => member.userId === user.id,
                        ),
                    )
                    .map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.displayName}（{user.email}）
                      </option>
                    ))}
                </select>
              )}
              <input
                className="form-input"
                data-testid="member-new-user-id"
                aria-label="已有平台用户 UUID"
                value={addUserId}
                onChange={(event) => setAddUserId(event.target.value)}
                placeholder="或输入已有用户 UUID"
                disabled={savingMembers}
              />
              <select
                className="form-select"
                aria-label="新成员角色"
                data-testid="member-new-role"
                value={addRole}
                disabled={savingMembers}
                onChange={(event) =>
                  setAddRole(event.target.value as Member['role'])
                }
              >
                <option value="viewer">只读成员</option>
                <option value="operator">操作员</option>
                <option value="owner">负责人</option>
              </select>
              <button
                type="submit"
                className="btn btn-secondary"
                data-testid="btn-add-member"
                disabled={savingMembers}
              >
                <AppIcon name="plus" size={14} />
                加入待保存
              </button>
            </form>
            {usersNotice && <p className="field-hint">{usersNotice}</p>}

            <div className="stack stack-sm lqa-members-save">
              {remainingOwners === 0 && (
                <Alert tone="danger" role="alert" testId="last-owner-error">
                  至少保留一位负责人，不能保存当前变更。
                </Alert>
              )}
              {changed && (
                <label className="check">
                  <input
                    type="checkbox"
                    data-testid="confirm-member-changes"
                    checked={confirmChanges}
                    onChange={(event) =>
                      setConfirmChanges(event.target.checked)
                    }
                    disabled={savingMembers}
                  />
                  我已核对成员列表及角色；保存会用完整列表替换项目的成员授权。
                </label>
              )}
              {membersError && (
                <Alert tone="danger" role="alert" testId="members-save-error">
                  {membersError}
                </Alert>
              )}
              {membersSuccess && (
                <Alert
                  tone="success"
                  role="status"
                  testId="members-save-success"
                >
                  {membersSuccess}
                </Alert>
              )}
            </div>
            <div className="form-actions">
              <button
                type="button"
                className="btn btn-ghost"
                data-testid="btn-discard-member-changes"
                disabled={!changed || savingMembers}
                onClick={() => {
                  setDraftMembers(members.map((m) => ({ ...m })));
                  setConfirmChanges(false);
                  setMembersError('');
                }}
              >
                放弃修改
              </button>
              <button
                type="button"
                className="btn btn-primary"
                data-testid="btn-save-members"
                disabled={
                  !changed ||
                  !confirmChanges ||
                  remainingOwners === 0 ||
                  savingMembers
                }
                onClick={() => void saveMembers()}
              >
                {savingMembers ? '保存中…' : '保存成员权限'}
              </button>
            </div>
          </div>
        )}
        {!canManage && !loading && !loadError && (
          <p
            data-testid="members-readonly-notice"
            className="field-hint lqa-members-readonly"
          >
            当前账号仅可查看项目成员，或项目已归档，无权修改成员列表。
          </p>
        )}
      </Section>

      <Section
        icon="settings"
        title="项目生命周期"
        testId="project-lifecycle-card"
      >
        <p className="muted text-sm" data-testid="project-lifecycle-notice">
          归档、重命名、删除项目请到 平台 › 项目管理
          {currentUser?.globalRole === 'admin'
            ? '。'
            : '（仅平台管理员可用）。'}
        </p>
        {currentUser?.globalRole === 'admin' && (
          <div className="form-actions is-start">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setRoute('projects')}
              data-testid="btn-goto-projects"
            >
              <AppIcon name="chevron-right" size={14} />
              打开项目管理
            </button>
          </div>
        )}
      </Section>

      <Section
        icon="history"
        title="安全审计日志"
        actions={<span className="badge badge-neutral">暂无查询接口</span>}
      >
        <p className="muted text-sm" data-testid="audit-unavailable-notice">
          系统会记录授权变更的服务器审计事件，但当前页面尚未接入可查询的审计日志接口；不会展示任何模拟记录冒充真实历史。
        </p>
      </Section>
    </Page>
  );
};
