import React, { useEffect, useState } from 'react';
import type { Member, Health, User } from '@localqa/contracts';
import { useAppContext } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { deleteEmptyProject } from '../api/projectDeletion.ts';
import { AppHeader } from '../components/layout/AppHeader.tsx';
import { StatusBadge } from '../components/ui/Badge.tsx';

export const MembersOpsPage: React.FC = () => {
  const {
    currentProject,
    currentUser,
    isMock,
    replaceProject,
    removeProject,
    setRoute,
  } = useAppContext();
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
  const [archiveName, setArchiveName] = useState('');
  const [archiveConfirmed, setArchiveConfirmed] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState('');
  const [deleteName, setDeleteName] = useState('');
  const [deleteConfirmed, setDeleteConfirmed] = useState(false);
  const [deletingProject, setDeletingProject] = useState(false);
  const [deleteError, setDeleteError] = useState('');

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
    setArchiveName('');
    setArchiveConfirmed(false);
    setDeleteName('');
    setDeleteConfirmed(false);
    setDeleteError('');
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
    if (!currentProject || loading || savingMembers || archiving) return;
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
  const archiveProject = async () => {
    if (
      !currentProject ||
      !canManage ||
      archiving ||
      changed ||
      !archiveConfirmed ||
      archiveName !== currentProject.name
    )
      return;
    setArchiving(true);
    setArchiveError('');
    try {
      const updated = await defaultApiClient.updateProject(currentProject.id, {
        expectedVersion: currentProject.version,
        status: 'archived',
      });
      if (updated.id !== currentProject.id || updated.status !== 'archived')
        throw new Error('服务器未确认项目归档');
      replaceProject(updated);
      setRoute('home');
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : '归档失败');
    } finally {
      setArchiving(false);
    }
  };

  const deleteProject = async () => {
    if (
      !currentProject ||
      currentUser?.globalRole !== 'admin' ||
      isMock ||
      deletingProject ||
      archiving ||
      changed ||
      !deleteConfirmed ||
      deleteName !== currentProject.name
    )
      return;
    if (
      !window.confirm(
        `确定永久删除项目「${currentProject.name}」（ID：${currentProject.id}）吗？此操作无法撤销。仅允许删除没有业务数据的空项目。`,
      )
    )
      return;
    setDeletingProject(true);
    setDeleteError('');
    try {
      await deleteEmptyProject(currentProject.id, {
        expectedVersion: currentProject.version,
        confirmName: currentProject.name,
      });
      removeProject(currentProject.id);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : '删除项目失败');
    } finally {
      setDeletingProject(false);
    }
  };

  return (
    <div className="app-container" data-testid="members-ops-page">
      <AppHeader />
      <main className="main-content">
        <div style={{ marginBottom: '24px' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>
            项目成员与运维状态 (Members & Operations)
          </h1>
          <p style={{ fontSize: '0.875rem', color: 'var(--color-text-muted)' }}>
            项目成员角色鉴权、执行槽位配额及平台核心服务健康度。
          </p>
        </div>

        {/* Section 1: System Health */}
        <div
          className="card"
          style={{ marginBottom: '24px' }}
          data-testid="system-health-card"
        >
          <div className="card-header">
            <h2 className="card-title">平台核心服务健康度 (System Health)</h2>
            <span
              className={`badge ${health?.status === 'ok' ? 'badge-success' : 'badge-warning'}`}
            >
              整体状态:{' '}
              {health === null
                ? '未取得健康状态'
                : health.status === 'ok'
                  ? '就绪 (READY)'
                  : '未就绪 (NOT_READY)'}
            </span>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: '14px',
            }}
          >
            <div
              style={{
                padding: '12px',
                backgroundColor: 'var(--color-bg-subtle)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <div
                style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}
              >
                服务运行状态 (Status)
              </div>
              <div
                style={{
                  fontSize: '1rem',
                  fontWeight: 600,
                  color:
                    health?.status === 'ok'
                      ? 'var(--color-success)'
                      : 'var(--color-warning)',
                  marginTop: '4px',
                }}
              >
                {health === null
                  ? '状态未知'
                  : health.status === 'ok'
                    ? '就绪 (OK)'
                    : '未就绪'}
              </div>
            </div>

            <div
              style={{
                padding: '12px',
                backgroundColor: 'var(--color-bg-subtle)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <div
                style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}
              >
                契约协议版本 (Version)
              </div>
              <div
                style={{
                  fontSize: '1rem',
                  fontWeight: 600,
                  color: 'var(--color-text-main)',
                  marginTop: '4px',
                }}
              >
                {health?.version ? `v${health.version}` : '尚未获取'}
              </div>
            </div>
          </div>
        </div>

        {/* Section 2: Members & RBAC */}
        <div className="card" style={{ marginBottom: '24px' }}>
          <div className="card-header">
            <h2 className="card-title">项目成员权限 (Members & RBAC)</h2>
            <span
              style={{ fontSize: '0.8rem', color: 'var(--color-text-muted)' }}
            >
              项目级权限，提交后由服务器最终验证
            </span>
          </div>

          {loading && <p data-testid="members-loading">正在读取成员与权限…</p>}
          {loadError && (
            <p role="alert" data-testid="members-load-error">
              {loadError}
            </p>
          )}
          {currentProject && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              data-testid="btn-reload-members"
              disabled={loading || savingMembers || archiving}
              onClick={() => void reloadMembers()}
            >
              重新加载成员和项目版本
            </button>
          )}
          {!membersComplete && (
            <p role="alert" data-testid="members-pagination-blocker">
              成员超过当前单页上限。为避免整体替换时意外删除未加载的成员，禁止编辑。
            </p>
          )}
          {!loading && !loadError && draftMembers.length === 0 && (
            <p data-testid="members-empty">尚未读取到项目成员。</p>
          )}
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>用户标识 (User ID)</th>
                  <th>项目内角色 (Project Role)</th>
                  <th>权限范围说明</th>
                  <th>状态</th>
                  {canManage && <th>操作</th>}
                </tr>
              </thead>
              <tbody>
                {draftMembers.map((m) => (
                  <tr key={m.userId} data-testid={`member-row-${m.userId}`}>
                    <td>
                      <code>{m.userId}</code>
                      {users.find((u) => u.id === m.userId)?.displayName && (
                        <div>
                          {users.find((u) => u.id === m.userId)?.displayName}
                        </div>
                      )}
                      {m.userId === currentUser?.id && (
                        <small>（当前账号）</small>
                      )}
                    </td>
                    <td>
                      {canManage && membersComplete ? (
                        <select
                          className="form-select"
                          aria-label="项目成员角色"
                          data-testid={`member-role-${m.userId}`}
                          value={m.role}
                          disabled={savingMembers}
                          onChange={(event) => {
                            const role = event.target.value as Member['role'];
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
                          <option value="owner">负责人 (owner)</option>
                          <option value="operator">操作员 (operator)</option>
                          <option value="viewer">观察员 (viewer)</option>
                        </select>
                      ) : (
                        <StatusBadge status={m.role} size="sm" />
                      )}
                    </td>
                    <td style={{ fontSize: '0.85rem' }}>
                      {m.role === 'owner' &&
                        '管理环境、成员、认证资料、项目知识及策略'}
                      {m.role === 'operator' &&
                        '启动冒烟、停止运行、补充说明、提交人工审查决议'}
                      {m.role === 'viewer' &&
                        '查看运行事实、测试报告与脱敏证据（只读）'}
                    </td>
                    <td>
                      <span className="badge badge-neutral">
                        {members.some((member) => member.userId === m.userId)
                          ? '已有授权'
                          : '待保存'}
                      </span>
                    </td>
                    {canManage && (
                      <td>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          data-testid={`remove-member-${m.userId}`}
                          disabled={
                            savingMembers ||
                            !membersComplete ||
                            m.userId === currentUser?.id ||
                            (m.role === 'owner' && remainingOwners <= 1)
                          }
                          onClick={() => {
                            setDraftMembers((old) =>
                              old.filter((item) => item.userId !== m.userId),
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
                ))}
              </tbody>
            </table>
          </div>
          {canManage && membersComplete && !loading && !loadError && (
            <div
              style={{ display: 'grid', gap: 12, marginTop: 16 }}
              data-testid="members-editor"
            >
              <h3 style={{ fontSize: '0.95rem' }}>添加已有平台用户</h3>
              <form
                onSubmit={addMember}
                style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}
              >
                {users.length > 0 && (
                  <select
                    className="form-select"
                    data-testid="member-user-directory"
                    value={addUserId}
                    onChange={(event) => setAddUserId(event.target.value)}
                    disabled={savingMembers}
                    style={{ maxWidth: 280 }}
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
                          {user.displayName} ({user.email})
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
                  style={{ maxWidth: 350 }}
                />
                <select
                  className="form-select"
                  data-testid="member-new-role"
                  value={addRole}
                  disabled={savingMembers}
                  onChange={(event) =>
                    setAddRole(event.target.value as Member['role'])
                  }
                  style={{ maxWidth: 150 }}
                >
                  <option value="viewer">观察员</option>
                  <option value="operator">操作员</option>
                  <option value="owner">负责人</option>
                </select>
                <button
                  type="submit"
                  className="btn btn-secondary"
                  data-testid="btn-add-member"
                  disabled={savingMembers}
                >
                  添加至待保存列表
                </button>
              </form>
              {usersNotice && <p className="form-help">{usersNotice}</p>}
              <p className="form-help">
                这里仅为已有账号授予项目权限，不会新建用户；保存采用完整成员列表及项目版本号。
              </p>
              {remainingOwners === 0 && (
                <p role="alert" data-testid="last-owner-error">
                  至少保留一位负责人，不能保存当前变更。
                </p>
              )}
              {changed && (
                <label style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="checkbox"
                    data-testid="confirm-member-changes"
                    checked={confirmChanges}
                    onChange={(event) =>
                      setConfirmChanges(event.target.checked)
                    }
                    disabled={savingMembers}
                  />
                  我已核对成员列表及角色；保存会替换项目的完整成员授权。
                </label>
              )}
              {membersError && (
                <p role="alert" data-testid="members-save-error">
                  {membersError}
                </p>
              )}
              {membersSuccess && (
                <p role="status" data-testid="members-save-success">
                  {membersSuccess}
                </p>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
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
                <button
                  type="button"
                  className="btn btn-secondary"
                  data-testid="btn-discard-member-changes"
                  disabled={!changed || savingMembers}
                  onClick={() => {
                    setDraftMembers(members.map((m) => ({ ...m })));
                    setConfirmChanges(false);
                    setMembersError('');
                  }}
                >
                  放弃未保存修改
                </button>
              </div>
            </div>
          )}
          {!canManage && !loading && !loadError && (
            <p data-testid="members-readonly-notice" className="form-help">
              当前账号仅可查看项目成员，或项目已归档；无权限修改成员列表。
            </p>
          )}
        </div>

        {/* Section 3: Project archive */}
        {canManage && (
          <div
            className="card"
            style={{ marginBottom: '24px' }}
            data-testid="archive-project-card"
          >
            <div className="card-header">
              <h2 className="card-title">归档项目</h2>
            </div>
            <p className="form-help">
              归档后不可启动新冒烟运行；历史报告不会因此删除。
              输入完整项目名称并确认，服务器成功返回后才更新项目状态。
            </p>
            <label className="form-label" htmlFor="archive-project-name">
              输入项目名称以确认
            </label>
            <input
              id="archive-project-name"
              className="form-input"
              data-testid="archive-project-name"
              value={archiveName}
              onChange={(event) => setArchiveName(event.target.value)}
              disabled={archiving}
              autoComplete="off"
              style={{ maxWidth: 360 }}
            />
            <label style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <input
                type="checkbox"
                data-testid="confirm-project-archive"
                checked={archiveConfirmed}
                onChange={(event) => setArchiveConfirmed(event.target.checked)}
                disabled={archiving}
              />
              我确认将当前项目归档，而不是删除数据。
            </label>
            {changed && <p role="alert">请先保存或放弃未提交的成员变更。</p>}
            {archiveError && (
              <p role="alert" data-testid="archive-project-error">
                {archiveError}
              </p>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              data-testid="btn-archive-project"
              style={{ marginTop: 12 }}
              disabled={
                archiving ||
                changed ||
                !archiveConfirmed ||
                archiveName !== currentProject?.name
              }
              onClick={() => void archiveProject()}
            >
              {archiving ? '归档中…' : '确认归档当前项目'}
            </button>
          </div>
        )}

        {currentUser?.globalRole === 'admin' && currentProject && (
          <section
            className="card lqa-project-danger-zone"
            data-testid="delete-project-card"
            aria-labelledby="delete-project-heading"
          >
            <div className="card-header">
              <h2 id="delete-project-heading" className="card-title">
                危险操作 · 永久删除项目
              </h2>
            </div>
            <p className="form-help">
              仅支持删除没有运行记录、测试用例、环境、模型授权、其他成员或配置的空项目。
              删除后项目不可恢复，历史安全审计记录仍会保留；有业务数据的项目请使用归档。
            </p>
            <p className="form-help">
              当前项目 ID：
              <code data-testid="delete-project-target-id">
                {currentProject.id}
              </code>
              （请核对，重名项目不会一起删除）
            </p>
            <label className="form-label" htmlFor="delete-project-name">
              输入当前项目的完整名称「{currentProject.name}」以确认
            </label>
            <input
              id="delete-project-name"
              data-testid="delete-project-name"
              className="form-input"
              autoComplete="off"
              style={{ maxWidth: 360 }}
              value={deleteName}
              onChange={(event) => setDeleteName(event.target.value)}
              disabled={deletingProject || isMock}
            />
            <label className="lqa-project-delete-check">
              <input
                type="checkbox"
                checked={deleteConfirmed}
                onChange={(event) => setDeleteConfirmed(event.target.checked)}
                disabled={deletingProject || isMock}
                data-testid="confirm-project-delete"
              />
              我理解永久删除不可恢复，并确认当前项目不再需要。
            </label>
            {isMock && (
              <p className="form-help">演示模式不提供真实项目删除。</p>
            )}
            {deleteError && (
              <p
                role="alert"
                className="lqa-project-delete-error"
                data-testid="delete-project-error"
              >
                {deleteError}
              </p>
            )}
            <button
              type="button"
              className="btn btn-danger"
              data-testid="btn-delete-project"
              disabled={
                deletingProject ||
                isMock ||
                archiving ||
                changed ||
                !deleteConfirmed ||
                deleteName !== currentProject.name
              }
              onClick={() => void deleteProject()}
            >
              {deletingProject ? '正在删除…' : '永久删除当前项目'}
            </button>
          </section>
        )}

        {/* Section 4: Audit status, without synthetic entries */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">安全审计日志 (Audit Log)</h2>
            <span className="badge badge-neutral">暂无查询接口</span>
          </div>
          <p data-testid="audit-unavailable-notice">
            系统记录授权变更的服务器审计事件，但当前页面尚未接入可查询的审计日志接口；
            不展示任何模拟记录作为真实历史。
          </p>
        </div>
      </main>
    </div>
  );
};
