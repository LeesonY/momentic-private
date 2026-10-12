import React, { useEffect, useState } from 'react';
import type { Environment, AuthProfile } from '@localqa/contracts';
import { useAppContext } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { Page } from '../components/layout/Page.tsx';
import { Alert } from '../components/ui/Alert.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { AppIcon } from '../components/ui/AppIcon.tsx';
import { EnvironmentDialog } from '../components/environments/EnvironmentDialog.tsx';
import { AuthProfileDialog } from '../components/environments/AuthProfileDialog.tsx';

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
    setNotice('');
    setAuthUpdateError('');
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
                    <button
                      className="btn btn-secondary btn-sm"
                      type="button"
                      data-testid={`btn-edit-env-${env.id}`}
                      onClick={() => setEnvDialog({ mode: 'edit', id: env.id })}
                    >
                      <AppIcon name="edit" size={13} />
                      编辑
                    </button>
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
    </Page>
  );
};
