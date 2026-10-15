import React, { useEffect, useRef, useState } from 'react';
import type { Environment, AuthProfile } from '@localqa/contracts';
import { useAppContext } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { Page } from '../components/layout/Page.tsx';
import { Alert } from '../components/ui/Alert.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { AppIcon } from '../components/ui/AppIcon.tsx';
import { EnvironmentDialog } from '../components/environments/EnvironmentDialog.tsx';
import { AuthProfileDialog } from '../components/environments/AuthProfileDialog.tsx';
import { Modal } from '../components/ui/Modal.tsx';

/** Two AI paths: agent sign-in follows instructions; AI forms fill a fixed
 * account/password sequence with AI-recognized fields. */
const authModeLabel = (profile: AuthProfile): string =>
  profile.mode === 'agent'
    ? 'AI 登录（按说明）'
    : profile.mode === 'form'
      ? profile.formConfig?.detectionMode === 'ai'
        ? '账号密码（AI 识别）'
        : '表单登录（固定定位）'
      : profile.mode === 'storage_state'
        ? '复用登录会话'
        : profile.mode === 'none'
          ? '匿名访问'
          : profile.mode;

type EnvDialogState = { mode: 'create' } | { mode: 'edit'; id: string } | null;

export const EnvironmentsPage: React.FC = () => {
  const { currentProject, currentUser } = useAppContext();
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [authProfiles, setAuthProfiles] = useState<AuthProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [canConfigure, setCanConfigure] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [envDialog, setEnvDialog] = useState<EnvDialogState>(null);
  const [authDialogEnvId, setAuthDialogEnvId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [switchingAuthId, setSwitchingAuthId] = useState<string | null>(null);
  const [authUpdateError, setAuthUpdateError] = useState('');
  const [editingAuthOrigins, setEditingAuthOrigins] = useState<string | null>(null);
  const [authOriginsDraft, setAuthOriginsDraft] = useState('');
  const [authOriginsSaving, setAuthOriginsSaving] = useState(false);
  const [authOriginsError, setAuthOriginsError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{
    kind: 'environment' | 'auth';
    record: Environment | AuthProfile;
  } | null>(null);
  const [deleteName, setDeleteName] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const projectRef = useRef(currentProject?.id);
  projectRef.current = currentProject?.id;
  const openDelete = (
    kind: 'environment' | 'auth',
    record: Environment | AuthProfile,
  ) => {
    setDeleteTarget({ kind, record });
    setDeleteName('');
    setDeleteError('');
  };
  const closeAuthOrigins = () => {
    if (!authOriginsSaving) setEditingAuthOrigins(null);
  };
  const saveAuthOrigins = async () => {
    const profile = authProfiles.find((item) => item.id === editingAuthOrigins);
    const projectId = currentProject?.id;
    if (!profile || !projectId || !canConfigure || authOriginsSaving ||
        profile.projectId !== projectId) return;
    setAuthOriginsError('');
    const rawOrigins = authOriginsDraft.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    if (rawOrigins.length < 1 || rawOrigins.length > 30 || new Set(rawOrigins).size !== rawOrigins.length ||
      rawOrigins.some((origin) => {
        try {
          const url = new URL(origin);
          return !['http:', 'https:'].includes(url.protocol) || url.origin !== origin ||
            Boolean(url.username || url.password);
        } catch { return true; }
      })) {
      setAuthOriginsError('请每行填写一个完整且不重复的 HTTP(S) Origin（协议、域名/IP、端口，不含路径或参数）。');
      return;
    }
    const environment = environments.find((item) => item.id === profile.environmentId);
    if (profile.environmentId && (!environment || rawOrigins.some((origin) =>
      !environment.allowedOrigins.includes(origin)))) {
      setAuthOriginsError('认证配置的 Origins 必须包含在所属测试环境的允许访问范围中；请先编辑环境。');
      return;
    }
    setAuthOriginsSaving(true);
    try {
      const updated = await defaultApiClient.updateAuthProfile(profile.id, {
        expectedVersion: profile.version,
        allowedOrigins: rawOrigins as [string, ...string[]],
      });
      if (projectRef.current !== projectId) return;
      setAuthProfiles((old) => old.map((item) => item.id === updated.id ? updated : item));
      setEditingAuthOrigins(null);
    } catch (error) {
      if (projectRef.current === projectId)
        setAuthOriginsError(error instanceof Error ? error.message : '保存失败，请刷新后重试');
    } finally {
      setAuthOriginsSaving(false);
    }
  };
  const closeDelete = () => {
    if (!deleting) setDeleteTarget(null);
  };
  const deleteConfig = async () => {
    if (
      !deleteTarget ||
      deleting ||
      !canConfigure ||
      deleteName !== deleteTarget.record.name
    )
      return;
    const target = deleteTarget;
    const projectId = currentProject?.id;
    if (!projectId || target.record.projectId !== projectId) return;
    setDeleting(true);
    setDeleteError('');
    try {
      const input = {
        expectedVersion: target.record.version,
        confirmName: deleteName,
      };
      if (target.kind === 'environment')
        await defaultApiClient.deleteEnvironment(target.record.id, input);
      else await defaultApiClient.deleteAuthProfile(target.record.id, input);
      if (projectRef.current !== projectId) return;
      if (target.kind === 'environment')
        setEnvironments((old) =>
          old.filter((env) => env.id !== target.record.id),
        );
      else {
        setAuthProfiles((old) =>
          old.filter((profile) => profile.id !== target.record.id),
        );
        setEnvironments((old) =>
          old.map((env) =>
            env.defaultAuthProfileId === target.record.id
              ? { ...env, defaultAuthProfileId: null }
              : env,
          ),
        );
        try {
          const refreshed = await defaultApiClient.listEnvironments(projectId, {
            limit: 100,
          });
          if (projectRef.current === projectId)
            setEnvironments(refreshed.items);
        } catch {
          if (projectRef.current === projectId)
            setNotice(
              '认证配置已删除，环境列表刷新失败，请刷新页面后继续编辑。',
            );
        }
      }
      setDeleteTarget(null);
    } catch (error) {
      if (projectRef.current === projectId)
        setDeleteError(
          error instanceof Error ? error.message : '删除失败，请刷新后重试',
        );
    } finally {
      setDeleting(false);
    }
  };

  const enableAiRecognition = async (profile: AuthProfile) => {
    if (
      !canConfigure ||
      switchingAuthId ||
      profile.mode !== 'form' ||
      !profile.formConfig
    )
      return;
    setSwitchingAuthId(profile.id);
    setAuthUpdateError('');
    try {
      const updated = await defaultApiClient.updateAuthProfile(profile.id, {
        expectedVersion: profile.version,
        formConfig: { ...profile.formConfig, detectionMode: 'ai' },
      });
      setAuthProfiles((old) =>
        old.map((item) => (item.id === updated.id ? updated : item)),
      );
    } catch {
      setAuthUpdateError('切换失败，请刷新版本后重试。现有凭据未重新填写。');
    } finally {
      setSwitchingAuthId(null);
    }
  };

  useEffect(() => {
    setEnvironments([]);
    setAuthProfiles([]);
    setEnvDialog(null);
    setAuthDialogEnvId(null);
    setDeleteTarget(null);
    setDeleteError('');
    setNotice('');
    setAuthUpdateError('');
    setEditingAuthOrigins(null);
    setAuthOriginsError('');
    setCanConfigure(currentUser?.globalRole === 'admin');
    setLoadError('');
    if (!currentProject) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const projId = currentProject.id;
    async function load() {
      setLoading(true);
      try {
        const [eRes, aRes, memberRes] = await Promise.all([
          defaultApiClient.listEnvironments(projId, { limit: 100 }),
          defaultApiClient.listAuthProfiles(projId, { limit: 100 }),
          defaultApiClient.listMembers(projId, { limit: 100 }),
        ]);
        if (cancelled) return;
        setEnvironments(eRes.items);
        setAuthProfiles(aRes.items);
        setCanConfigure(
          currentUser?.globalRole === 'admin' ||
            memberRes.items.some(
              (m) => m.userId === currentUser?.id && m.role === 'owner',
            ),
        );
      } catch {
        if (!cancelled)
          setLoadError('项目环境或成员权限读取失败，请检查权限后重试');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [currentProject?.id, currentUser?.id, currentUser?.globalRole]);

  const replaceEnvironment = (updated: Environment) =>
    setEnvironments((old) =>
      old.some((env) => env.id === updated.id)
        ? old.map((env) => (env.id === updated.id ? updated : env))
        : [...old, updated],
    );

  const canEdit = Boolean(
    currentProject && canConfigure && !loading && !loadError,
  );
  const editingEnvironment =
    envDialog?.mode === 'edit'
      ? environments.find((env) => env.id === envDialog.id)
      : undefined;
  const authDialogEnvironment = environments.find(
    (env) => env.id === authDialogEnvId,
  );
  const environmentIds = new Set(environments.map((env) => env.id));
  const unassignedProfiles = authProfiles.filter(
    (profile) =>
      !profile.environmentId || !environmentIds.has(profile.environmentId),
  );

  const renderProfiles = (
    profiles: AuthProfile[],
    defaultProfileId: string | null,
  ) => (
    <ul className="lqa-env-auth-list">
      {profiles.map((profile) => {
        const legacyForm =
          profile.mode === 'form' &&
          profile.formConfig &&
          profile.formConfig.detectionMode !== 'ai';
        return (
          <li
            key={profile.id}
            className="lqa-env-auth-row"
            data-testid={`auth-row-${profile.id}`}
          >
            <div className="lqa-env-auth-main">
              <div className="lqa-env-auth-title">
                <span className="cell-title" title={profile.id}>
                  {profile.name}
                </span>
                {profile.id === defaultProfileId && (
                  <span className="badge badge-primary badge-sm">默认</span>
                )}
                {profile.status === 'revoked' && (
                  <span className="badge badge-danger badge-sm">已吊销</span>
                )}
              </div>
              <div className="lqa-model-meta">
                <span>{authModeLabel(profile)}</span>
                <span aria-hidden="true">·</span>
                <span>{profile.hasSecret ? '密钥已加密写入' : '无密钥'}</span>
                <span aria-hidden="true">·</span>
                <span>v{profile.version}</span>
              </div>
            </div>
            {legacyForm && profile.status === 'active' && canEdit && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                data-testid={`auth-enable-ai-${profile.id}`}
                disabled={Boolean(switchingAuthId)}
                onClick={() => void enableAiRecognition(profile)}
              >
                <AppIcon name="sparkles" size={14} />
                {switchingAuthId === profile.id ? '切换中…' : '改用 AI 识别'}
              </button>
            )}
            {canEdit && profile.status === 'active' && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={deleting || authOriginsSaving}
                data-testid={`btn-edit-auth-origins-${profile.id}`}
                onClick={() => {
                  setEditingAuthOrigins(profile.id);
                  setAuthOriginsDraft(profile.allowedOrigins.join('\n'));
                  setAuthOriginsError('');
                }}
              >
                编辑访问范围
              </button>
            )}
            {canEdit && (
              <button
                type="button"
                className="btn btn-danger-outline btn-sm"
                disabled={deleting || Boolean(switchingAuthId)}
                data-testid={`btn-delete-auth-${profile.id}`}
                onClick={() => openDelete('auth', profile)}
              >
                删除
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );

  return (
    <Page
      testId="environments-page"
      title="环境与认证"
      description="每个环境限定运行可访问的范围，并管理自己的登录凭据。"
      actions={
        canEdit && (
          <button
            type="button"
            className="btn btn-primary"
            data-testid="btn-add-environment"
            onClick={() => setEnvDialog({ mode: 'create' })}
          >
            <AppIcon name="plus" size={16} />
            新建环境
          </button>
        )
      }
    >
      {loadError && (
        <Alert tone="danger" role="alert" testId="environment-load-error">
          {loadError}
        </Alert>
      )}
      {notice && (
        <Alert tone="warning" role="alert">
          {notice}
        </Alert>
      )}
      {authUpdateError && (
        <Alert tone="danger" role="alert">
          {authUpdateError}
        </Alert>
      )}

      {loading ? (
        <section className="card">
          <p className="muted text-sm">正在加载项目配置…</p>
        </section>
      ) : environments.length === 0 ? (
        <section className="card lqa-models-empty">
          <div data-testid="environments-empty-state">
            <EmptyState
              compact
              icon="server"
              title="尚无测试环境"
              description={
                canEdit
                  ? '先新建环境，限定运行可访问的范围，再为它添加登录凭据。'
                  : '需要项目负责人先创建环境，再添加登录凭据。'
              }
            />
          </div>
          {canEdit && (
            <button
              type="button"
              className="btn btn-primary"
              data-testid="environments-empty-add"
              onClick={() => setEnvDialog({ mode: 'create' })}
            >
              <AppIcon name="plus" size={16} /> 新建第一个环境
            </button>
          )}
        </section>
      ) : (
        environments.map((env) => {
          const profiles = authProfiles.filter(
            (profile) => profile.environmentId === env.id,
          );
          const defaultProfile = authProfiles.find(
            (profile) => profile.id === env.defaultAuthProfileId,
          );
          return (
            <section
              key={env.id}
              className="card card-flush lqa-env-card"
              data-testid={`env-card-${env.id}`}
            >
              <div
                className="lqa-env-summary"
                data-testid={`env-row-${env.id}`}
              >
                <div className="lqa-env-head">
                  <div className="lqa-env-heading">
                    <h2 className="card-title">
                      <AppIcon name="server" size={17} />
                      {env.name}
                    </h2>
                    <a
                      className="lqa-env-url"
                      href={env.baseUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {env.baseUrl}
                    </a>
                  </div>
                  {canEdit && (
                    <div className="lqa-model-actions">
                      <button
                        className="btn btn-secondary btn-sm"
                        type="button"
                        data-testid={`btn-edit-env-${env.id}`}
                        onClick={() =>
                          setEnvDialog({ mode: 'edit', id: env.id })
                        }
                      >
                        <AppIcon name="edit" size={13} />
                        编辑
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger-outline btn-sm"
                        disabled={deleting || Boolean(switchingAuthId)}
                        data-testid={`btn-delete-env-${env.id}`}
                        onClick={() => openDelete('environment', env)}
                      >
                        删除
                      </button>
                    </div>
                  )}
                </div>
                <dl className="lqa-env-facts">
                  <div>
                    <dt>允许访问</dt>
                    <dd className="lqa-env-origins">
                      {env.allowedOrigins.map((origin) => (
                        <code key={origin}>{origin}</code>
                      ))}
                    </dd>
                  </div>
                  <div>
                    <dt>排除路径</dt>
                    <dd>
                      {env.excludedPaths.length > 0 ? (
                        <span
                          className="badge badge-warning"
                          title={env.excludedPaths.join('\n')}
                        >
                          {env.excludedPaths.length} 条
                        </span>
                      ) : (
                        <span className="subtle">无</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>证书校验</dt>
                    <dd>
                      <span
                        className={`badge ${env.tlsPolicy === 'strict' ? 'badge-neutral' : 'badge-warning'}`}
                        title={env.tlsPolicy}
                      >
                        {env.tlsPolicy === 'strict' ? '严格校验' : '允许自签名'}
                      </span>
                    </dd>
                  </div>
                  <div>
                    <dt>默认登录</dt>
                    <dd>
                      {defaultProfile?.name ?? (
                        <span className="subtle">匿名访问</span>
                      )}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="lqa-env-auth">
                <div className="lqa-env-auth-head">
                  <span className="section-label">
                    登录凭据
                    <span className="badge badge-neutral badge-sm">
                      {profiles.length}
                    </span>
                  </span>
                  {canEdit && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      data-testid={`btn-add-auth-${env.id}`}
                      onClick={() => {
                        setNotice('');
                        setAuthDialogEnvId(env.id);
                      }}
                    >
                      <AppIcon name="plus" size={14} />
                      添加凭据
                    </button>
                  )}
                </div>
                {profiles.length === 0 ? (
                  <p className="lqa-env-auth-empty">
                    还没有登录凭据，运行时以匿名身份访问。
                  </p>
                ) : (
                  renderProfiles(profiles, env.defaultAuthProfileId)
                )}
              </div>
            </section>
          );
        })
      )}

      {unassignedProfiles.length > 0 && (
        <section className="card card-flush lqa-env-card">
          <div className="card-header">
            <div className="card-heading">
              <h2 className="card-title">
                <AppIcon name="key" size={17} />
                未关联环境的凭据
              </h2>
              <p className="card-description">
                这些凭据不属于当前任何环境，不会作为环境默认登录使用。
              </p>
            </div>
          </div>
          {renderProfiles(unassignedProfiles, null)}
        </section>
      )}

      <p className="lqa-models-footnote">
        <AppIcon name="lock" size={14} />
        凭据密钥只能写入一次，由后台 SecretVault 加密保存，仅在获准的 Worker
        内解密；界面和接口都不会回显明文。
      </p>

      {currentProject &&
        envDialog &&
        (envDialog.mode === 'create' || editingEnvironment) && (
          <EnvironmentDialog
            key={envDialog.mode === 'edit' ? envDialog.id : 'create'}
            projectId={currentProject.id}
            environment={editingEnvironment}
            authProfiles={authProfiles}
            onClose={() => setEnvDialog(null)}
            onSaved={(saved) => {
              replaceEnvironment(saved);
              setEnvDialog(null);
            }}
          />
        )}
      {currentProject && authDialogEnvironment && (
        <AuthProfileDialog
          key={authDialogEnvironment.id}
          projectId={currentProject.id}
          environment={authDialogEnvironment}
          onClose={() => setAuthDialogEnvId(null)}
          onCreated={(profile, updatedEnvironment, warning) => {
            setAuthProfiles((old) => [...old, profile]);
            if (updatedEnvironment) replaceEnvironment(updatedEnvironment);
            if (warning) setNotice(warning);
            setAuthDialogEnvId(null);
          }}
        />
      )}
      {editingAuthOrigins && (
        <Modal
          title="编辑认证配置访问范围"
          description="只更新允许访问的 Origins，不修改账号密码、密钥或登录步骤。"
          onClose={closeAuthOrigins}
          closeOnOverlay={!authOriginsSaving}
          testId="edit-auth-origins-dialog"
          footer={
            <>
              <button type="button" className="btn btn-secondary" disabled={authOriginsSaving} onClick={closeAuthOrigins}>取消</button>
              <button type="button" className="btn btn-primary" disabled={authOriginsSaving} data-testid="btn-save-auth-origins" onClick={() => void saveAuthOrigins()}>
                {authOriginsSaving ? '保存中…' : '保存访问范围'}
              </button>
            </>
          }
        >
          <label className="lqa-model-field">
            <span>允许访问的 Origins（每行一个）</span>
            <textarea className="form-textarea is-mono" rows={4} value={authOriginsDraft}
              data-testid="auth-origins-editor"
              disabled={authOriginsSaving}
              onChange={(event) => setAuthOriginsDraft(event.target.value)} />
          </label>
          {authOriginsError && <Alert tone="danger" role="alert" testId="auth-origins-edit-error">{authOriginsError}</Alert>}
        </Modal>
      )}
      {deleteTarget && (
        <Modal
          title={
            deleteTarget.kind === 'environment' ? '删除环境' : '删除认证配置'
          }
          onClose={closeDelete}
          closeOnOverlay={!deleting}
          testId="config-delete-dialog"
          footer={
            <>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={deleting}
                onClick={closeDelete}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-danger"
                data-testid="config-delete-confirm"
                disabled={deleting || deleteName !== deleteTarget.record.name}
                onClick={() => void deleteConfig()}
              >
                {deleting ? '删除中…' : '确认删除'}
              </button>
            </>
          }
        >
          <p>
            删除「{deleteTarget.record.name}
            」后，新任务将无法选择它，历史测试记录保留。
          </p>
          <p>
            {deleteTarget.kind === 'environment'
              ? '请先删除环境下的认证配置。正在被任务或启用的定时计划使用时无法删除。'
              : '如果它是环境默认登录，删除后将改为匿名访问。正在被任务或启用的定时计划使用时无法删除。'}
          </p>
          <label className="lqa-model-field">
            <span>输入名称「{deleteTarget.record.name}」以确认</span>
            <input
              className="form-input"
              value={deleteName}
              disabled={deleting}
              autoFocus
              data-testid="config-delete-name"
              onChange={(e) => setDeleteName(e.target.value)}
            />
          </label>
          {deleteError && (
            <Alert tone="danger" role="alert" testId="config-delete-error">
              {deleteError}
            </Alert>
          )}
        </Modal>
      )}
    </Page>
  );
};
