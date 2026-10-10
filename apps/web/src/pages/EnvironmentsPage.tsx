import React, { useEffect, useState } from 'react';
import type {
  Environment,
  AuthProfile,
  AuthProfileCreate,
  Criterion,
} from '@localqa/contracts';
import { useAppContext } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { Page } from '../components/layout/Page.tsx';
import { Section } from '../components/ui/Section.tsx';
import { Field } from '../components/ui/Field.tsx';
import { Alert } from '../components/ui/Alert.tsx';
import { EmptyState } from '../components/ui/EmptyState.tsx';
import { AppIcon } from '../components/ui/AppIcon.tsx';
import { validatedEnvironmentInput } from './environmentInput.ts';

export const EnvironmentsPage: React.FC = () => {
  const { currentProject, currentUser } = useAppContext();
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [authProfiles, setAuthProfiles] = useState<AuthProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [canConfigure, setCanConfigure] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [envName, setEnvName] = useState('');
  const [envBaseUrl, setEnvBaseUrl] = useState('');
  const [envOrigins, setEnvOrigins] = useState('');
  const [envExcludedPaths, setEnvExcludedPaths] = useState('');
  const [envTlsPolicy, setEnvTlsPolicy] = useState<
    'strict' | 'allow_self_signed'
  >('strict');
  const [confirmInsecureTls, setConfirmInsecureTls] = useState(false);
  const [envError, setEnvError] = useState('');
  const [addingEnv, setAddingEnv] = useState(false);
  const [editingEnvId, setEditingEnvId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editBaseUrl, setEditBaseUrl] = useState('');
  const [editOrigins, setEditOrigins] = useState('');
  const [editExcludedPaths, setEditExcludedPaths] = useState('');
  const [editTlsPolicy, setEditTlsPolicy] = useState<
    'strict' | 'allow_self_signed'
  >('strict');
  const [editTlsConfirmed, setEditTlsConfirmed] = useState(false);
  const [editDefaultAuthId, setEditDefaultAuthId] = useState('');
  const [editError, setEditError] = useState('');
  const [savingEnv, setSavingEnv] = useState(false);

  // Form states for creating auth profile
  const [authName, setAuthName] = useState('');
  const [authMode, setAuthMode] = useState<'none' | 'form' | 'storage_state'>(
    'form',
  );
  const [secretVal, setSecretVal] = useState('');
  const [authUsername, setAuthUsername] = useState('');
  const [authOrigins, setAuthOrigins] = useState('');
  const [authEnvironmentId, setAuthEnvironmentId] = useState('');
  const [authLoginUrl, setAuthLoginUrl] = useState('');
  const [authUsernameCss, setAuthUsernameCss] = useState(
    'input[name="username"]',
  );
  const [authPasswordCss, setAuthPasswordCss] = useState(
    'input[type="password"]',
  );
  const [authSubmitCss, setAuthSubmitCss] = useState('button[type="submit"]');
  const [authSuccessBy, setAuthSuccessBy] = useState<'test_id' | 'text'>(
    'test_id',
  );
  const [authSuccessTestId, setAuthSuccessTestId] = useState('');
  const [authError, setAuthError] = useState('');
  const [addingAuth, setAddingAuth] = useState(false);

  useEffect(() => {
    setEnvironments([]);
    setAuthProfiles([]);
    setAuthEnvironmentId('');
    setAuthOrigins('');
    setSecretVal('');
    setAuthUsername('');
    setAuthError('');
    setEnvError('');
    setEditingEnvId(null);
    setEditError('');
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
        // A project may have multiple environments. Never silently use a
        // hard-coded localhost origin when saving live authentication secrets.
        setAuthEnvironmentId(eRes.items[0]?.id ?? '');
        setAuthOrigins(eRes.items[0]?.allowedOrigins.join('\n') ?? '');
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

  const handleCreateEnvironment = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!currentProject || !canConfigure || addingEnv) return;
    setEnvError('');
    setAddingEnv(true);
    try {
      const input = validatedEnvironmentInput(
        envName,
        envBaseUrl,
        envOrigins,
        envExcludedPaths,
        envTlsPolicy,
        confirmInsecureTls,
      );
      const created = await defaultApiClient.createEnvironment(
        currentProject.id,
        input,
      );
      setEnvironments((prev) => [...prev, created]);
      if (!authEnvironmentId) {
        setAuthEnvironmentId(created.id);
        setAuthOrigins(created.allowedOrigins.join('\n'));
      }
      setEnvName('');
      setEnvBaseUrl('');
      setEnvOrigins('');
      setEnvExcludedPaths('');
      setEnvTlsPolicy('strict');
      setConfirmInsecureTls(false);
    } catch (err) {
      setEnvError(err instanceof Error ? err.message : '创建环境失败');
    } finally {
      setAddingEnv(false);
    }
  };

  const beginEditEnvironment = (env: Environment) => {
    setEditingEnvId(env.id);
    setEditName(env.name);
    setEditBaseUrl(env.baseUrl);
    setEditOrigins(env.allowedOrigins.join('\n'));
    setEditExcludedPaths(env.excludedPaths.join('\n'));
    setEditTlsPolicy(env.tlsPolicy);
    setEditTlsConfirmed(false);
    setEditDefaultAuthId(env.defaultAuthProfileId ?? '');
    setEditError('');
  };

  const handleUpdateEnvironment = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!currentProject || !canConfigure || !editingEnvId || savingEnv) return;
    const environment = environments.find((env) => env.id === editingEnvId);
    if (!environment) return;
    setSavingEnv(true);
    setEditError('');
    try {
      const input = validatedEnvironmentInput(
        editName,
        editBaseUrl,
        editOrigins,
        editExcludedPaths,
        editTlsPolicy,
        editTlsConfirmed,
      );
      const updated = await defaultApiClient.updateEnvironment(environment.id, {
        expectedVersion: environment.version,
        ...input,
        defaultAuthProfileId: editDefaultAuthId || null,
      });
      if (
        updated.projectId !== currentProject.id ||
        updated.id !== environment.id
      )
        throw new Error('服务器返回的环境标识与当前项目不一致');
      setEnvironments((old) =>
        old.map((env) => (env.id === updated.id ? updated : env)),
      );
      if (authEnvironmentId === updated.id) {
        setAuthOrigins(updated.allowedOrigins.join('\n'));
      }
      setEditingEnvId(null);
    } catch (error) {
      setEditError(
        error instanceof Error
          ? error.message
          : '保存环境失败，请刷新版本后重试',
      );
    } finally {
      setSavingEnv(false);
    }
  };

  const handleCreateAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authName.trim() || !currentProject || !canConfigure || addingAuth)
      return;
    setAddingAuth(true);
    setAuthError('');
    try {
      const selectedEnvironment = environments.find(
        (env) => env.id === authEnvironmentId,
      );
      if (!selectedEnvironment) throw new Error('MISSING_ENVIRONMENT');
      const origins = authOrigins
        .split(/[,\n]/)
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => {
          const url = new URL(item);
          if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.pathname !== '/' ||
            url.search ||
            url.hash ||
            !selectedEnvironment.allowedOrigins.includes(url.origin)
          )
            throw new Error('INVALID_AUTH_ORIGIN');
          return url.origin;
        });
      if (!origins.length || (authMode !== 'none' && !authSuccessTestId.trim()))
        throw new Error('MISSING_AUTH_CONFIGURATION');
      if (
        !authEnvironmentId ||
        !environments.some((env) => env.id === authEnvironmentId)
      )
        throw new Error('MISSING_ENVIRONMENT');
      const successCriterion: Criterion = {
        id: 'login_success',
        kind: 'element_visible',
        description: '用户配置的登录成功标识可见',
        sourceKind: 'user_spec',
        sourceRef: 'auth_profile',
        locator: { by: authSuccessBy, value: authSuccessTestId.trim() },
      };
      const config: AuthProfileCreate = {
        name: authName.trim(),
        mode: authMode,
        environmentId: authEnvironmentId,
        allowedOrigins: [origins[0]!, ...new Set(origins.slice(1))],
        sharingPolicy: 'exclusive_run',
        ...(authMode === 'form'
          ? {
              formConfig: {
                loginUrl: authLoginUrl.trim(),
                usernameTarget: {
                  by: 'css' as const,
                  value: authUsernameCss.trim(),
                },
                passwordTarget: {
                  by: 'css' as const,
                  value: authPasswordCss.trim(),
                },
                submitTarget: {
                  by: 'css' as const,
                  value: authSubmitCss.trim(),
                },
                successCriterion,
              },
              secretInput: { username: authUsername, password: secretVal },
            }
          : authMode === 'storage_state'
            ? {
                storageCriterion: successCriterion,
                secretInput: { storageState: secretVal },
              }
            : {}),
      };
      if (
        (authMode !== 'none' && !secretVal) ||
        (authMode === 'form' &&
          (!authUsername ||
            !authLoginUrl.trim() ||
            !authUsernameCss.trim() ||
            !authPasswordCss.trim() ||
            !authSubmitCss.trim()))
      )
        throw new Error('MISSING_AUTH_MATERIAL');
      const created = await defaultApiClient.createAuthProfile(
        currentProject.id,
        config,
      );
      setAuthProfiles((old) => [...old, created]);
      setAuthName('');
      setSecretVal('');
      setAuthUsername('');
      setAuthSuccessTestId('');
    } catch {
      // Never echo request bodies or server diagnostics: these fields contain
      // passwords and storage-state JSON.
      setAuthError(
        '保存失败。请检查环境、Origins、凭据、定位器与成功判定配置。',
      );
    } finally {
      setAddingAuth(false);
    }
  };

  const canCreateEnv = Boolean(
    currentProject && canConfigure && !loading && !loadError,
  );
  const canCreateAuth = Boolean(
    currentProject &&
    canConfigure &&
    environments.length > 0 &&
    !loading &&
    !loadError,
  );

  return (
    <Page
      testId="environments-page"
      width="wide"
      title="环境与认证"
      description="配置被测站点的访问范围与安全边界，并管理只写入、不回显的认证凭据。"
    >
      {loadError && (
        <Alert tone="danger" role="alert" testId="environment-load-error">
          {loadError}
        </Alert>
      )}

      <div className={`lqa-split ${canCreateEnv ? '' : 'is-single'}`}>
        <div className="page-column">
          <Section
            icon="server"
            title="测试环境"
            description="环境决定运行可访问的 Origin 范围、排除路径和证书校验策略。"
          >
            {loading ? (
              <p className="muted text-sm">正在加载项目配置…</p>
            ) : environments.length === 0 ? (
              <div data-testid="environments-empty-state">
                <EmptyState
                  compact
                  icon="server"
                  title="尚无测试环境"
                  description="项目负责人需要先创建环境，再添加认证配置。"
                />
              </div>
            ) : (
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>环境</th>
                      <th>获准 Origins</th>
                      <th>排除路径</th>
                      <th>TLS</th>
                      <th>默认认证</th>
                      {canConfigure && <th className="cell-actions">操作</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {environments.map((env) => (
                      <tr key={env.id} data-testid={`env-row-${env.id}`}>
                        <td>
                          <div className="cell-title">{env.name}</div>
                          <div className="cell-sub mono break-all">
                            {env.baseUrl}
                          </div>
                        </td>
                        <td className="text-sm break-all">
                          {env.allowedOrigins.join(', ')}
                        </td>
                        <td>
                          {env.excludedPaths.length > 0 ? (
                            <span className="badge badge-warning">
                              {env.excludedPaths.length} 条
                            </span>
                          ) : (
                            <span className="subtle">无</span>
                          )}
                        </td>
                        <td>
                          <span
                            className={`badge ${env.tlsPolicy === 'strict' ? 'badge-neutral' : 'badge-warning'}`}
                            title={env.tlsPolicy}
                          >
                            {env.tlsPolicy === 'strict'
                              ? '严格校验'
                              : '允许自签名'}
                          </span>
                        </td>
                        <td>
                          {authProfiles.find(
                            (ap) => ap.id === env.defaultAuthProfileId,
                          )?.name ?? <span className="subtle">无</span>}
                        </td>
                        {canConfigure && (
                          <td className="cell-actions">
                            <button
                              className="btn btn-secondary btn-sm"
                              type="button"
                              data-testid={`btn-edit-env-${env.id}`}
                              disabled={savingEnv}
                              onClick={() => beginEditEnvironment(env)}
                            >
                              <AppIcon name="edit" size={13} />
                              编辑
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {currentProject && canConfigure && !loadError && editingEnvId && (
              <form
                className="panel lqa-edit-panel"
                data-testid="edit-environment-form"
                onSubmit={(event) => void handleUpdateEnvironment(event)}
              >
                <h3 className="lqa-panel-title">编辑测试环境</h3>
                <p className="field-hint lqa-panel-hint">
                  保存时会校验版本，避免覆盖他人的修改。
                </p>
                <div className="grid-2">
                  <Field label="环境名称" htmlFor="edit-environment-name">
                    <input
                      id="edit-environment-name"
                      data-testid="edit-environment-name"
                      className="form-input"
                      value={editName}
                      maxLength={120}
                      onChange={(event) => setEditName(event.target.value)}
                      required
                      disabled={savingEnv}
                    />
                  </Field>
                  <Field label="基准 URL" htmlFor="edit-environment-base-url">
                    <input
                      id="edit-environment-base-url"
                      data-testid="edit-environment-base-url"
                      className="form-input"
                      type="url"
                      value={editBaseUrl}
                      onChange={(event) => setEditBaseUrl(event.target.value)}
                      required
                      disabled={savingEnv}
                    />
                  </Field>
                  <Field
                    label="获准 Origins"
                    hint="每行一个"
                    htmlFor="edit-environment-origins"
                  >
                    <textarea
                      id="edit-environment-origins"
                      data-testid="edit-environment-origins"
                      className="form-textarea is-mono"
                      rows={2}
                      value={editOrigins}
                      onChange={(event) => setEditOrigins(event.target.value)}
                      disabled={savingEnv}
                    />
                  </Field>
                  <Field
                    label="排除路径"
                    hint="每行一个"
                    htmlFor="edit-environment-excluded"
                  >
                    <textarea
                      id="edit-environment-excluded"
                      data-testid="edit-environment-excluded"
                      className="form-textarea is-mono"
                      rows={2}
                      value={editExcludedPaths}
                      onChange={(event) =>
                        setEditExcludedPaths(event.target.value)
                      }
                      disabled={savingEnv}
                    />
                  </Field>
                  <Field label="TLS 证书策略" htmlFor="edit-environment-tls">
                    <select
                      id="edit-environment-tls"
                      data-testid="edit-environment-tls"
                      className="form-select"
                      value={editTlsPolicy}
                      onChange={(event) => {
                        setEditTlsPolicy(
                          event.target.value as 'strict' | 'allow_self_signed',
                        );
                        setEditTlsConfirmed(false);
                      }}
                      disabled={savingEnv}
                    >
                      <option value="strict">严格验证证书</option>
                      <option value="allow_self_signed">
                        允许自签名证书（仅受控 HTTPS 测试环境）
                      </option>
                    </select>
                  </Field>
                  <Field
                    label="默认认证"
                    hint="仅可选择此环境下的有效凭据"
                    htmlFor="edit-environment-default-auth"
                  >
                    <select
                      id="edit-environment-default-auth"
                      data-testid="edit-environment-default-auth"
                      className="form-select"
                      value={editDefaultAuthId}
                      onChange={(event) =>
                        setEditDefaultAuthId(event.target.value)
                      }
                      disabled={savingEnv}
                    >
                      <option value="">无默认认证</option>
                      {authProfiles
                        .filter(
                          (ap) =>
                            ap.environmentId === editingEnvId &&
                            ap.status === 'active',
                        )
                        .map((ap) => (
                          <option key={ap.id} value={ap.id}>
                            {ap.name}
                          </option>
                        ))}
                    </select>
                  </Field>
                </div>
                {editTlsPolicy === 'allow_self_signed' && (
                  <label className="check">
                    <input
                      type="checkbox"
                      data-testid="edit-environment-tls-confirm"
                      checked={editTlsConfirmed}
                      onChange={(event) =>
                        setEditTlsConfirmed(event.target.checked)
                      }
                      disabled={savingEnv}
                    />
                    我确认该 HTTPS 环境的自签名证书风险。
                  </label>
                )}
                {editError && (
                  <Alert
                    tone="danger"
                    role="alert"
                    testId="edit-environment-error"
                  >
                    {editError}
                  </Alert>
                )}
                <div className="form-actions">
                  <button
                    className="btn btn-ghost"
                    type="button"
                    data-testid="btn-cancel-edit-environment"
                    disabled={savingEnv}
                    onClick={() => {
                      setEditingEnvId(null);
                      setEditError('');
                    }}
                  >
                    取消
                  </button>
                  <button
                    className="btn btn-primary"
                    type="submit"
                    data-testid="btn-save-environment"
                    disabled={
                      savingEnv ||
                      !editName.trim() ||
                      !editBaseUrl.trim() ||
                      (editTlsPolicy === 'allow_self_signed' &&
                        !editTlsConfirmed)
                    }
                  >
                    {savingEnv ? '保存中…' : '保存修改'}
                  </button>
                </div>
              </form>
            )}
          </Section>

          <Section
            icon="key"
            title="认证凭据"
            description="密钥原值只能写入一次，由后台 SecretVault 加密保存，仅在获准的 Worker 内解密；界面和接口都不会回显明文。"
            actions={
              <span className="badge badge-primary">
                <AppIcon name="lock" size={12} />
                只写入，不回显
              </span>
            }
          >
            {authProfiles.length === 0 ? (
              <EmptyState
                compact
                icon="key"
                title="尚无认证凭据"
                description="需要登录的站点请在右侧添加凭据；不填写时运行以匿名身份访问。"
              />
            ) : (
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>凭据</th>
                      <th>认证方式</th>
                      <th>密钥</th>
                      <th>版本</th>
                    </tr>
                  </thead>
                  <tbody>
                    {authProfiles.map((ap) => (
                      <tr key={ap.id} data-testid={`auth-row-${ap.id}`}>
                        <td>
                          <div className="cell-title">{ap.name}</div>
                          <div className="cell-sub mono">{ap.id}</div>
                        </td>
                        <td>
                          <span className="badge badge-info" title={ap.mode}>
                            {ap.mode === 'form'
                              ? '表单登录'
                              : ap.mode === 'storage_state'
                                ? '复用登录会话'
                                : ap.mode === 'none'
                                  ? '匿名访问'
                                  : ap.mode}
                          </span>
                        </td>
                        <td>
                          <span
                            className={`badge ${ap.hasSecret ? 'badge-success' : 'badge-neutral'}`}
                          >
                            {ap.hasSecret ? '已加密写入' : '无密钥'}
                          </span>
                        </td>
                        <td className="muted">v{ap.version}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </div>
        {canCreateEnv && (
          <div className="page-column">
            <Section icon="plus" title="新建测试环境">
              <form
                onSubmit={(event) => void handleCreateEnvironment(event)}
                data-testid="create-environment-form"
              >
                <Field label="环境名称" required htmlFor="environment-name">
                  <input
                    id="environment-name"
                    className="form-input"
                    data-testid="environment-name"
                    value={envName}
                    onChange={(event) => setEnvName(event.target.value)}
                    required
                    maxLength={120}
                    disabled={addingEnv}
                    placeholder="例如：预发布测试环境"
                  />
                </Field>
                <Field
                  label="基准 URL"
                  required
                  hint="保留路径与参数，运行默认从这里开始。"
                  htmlFor="environment-base-url"
                >
                  <input
                    id="environment-base-url"
                    className="form-input"
                    data-testid="environment-base-url"
                    type="url"
                    value={envBaseUrl}
                    onChange={(event) => {
                      setEnvBaseUrl(event.target.value);
                      if (!envOrigins.trim()) {
                        try {
                          const url = new URL(event.target.value);
                          if (['http:', 'https:'].includes(url.protocol))
                            setEnvOrigins(url.origin);
                        } catch {
                          /* Wait until the URL is complete. */
                        }
                      }
                    }}
                    required
                    disabled={addingEnv}
                    placeholder="https://staging.example.com/login?lang=zh"
                  />
                </Field>
                <Field
                  label="允许访问的 Origins"
                  hint="每行一个；填写基准 URL 后自动带出。"
                  htmlFor="environment-origins"
                >
                  <textarea
                    id="environment-origins"
                    className="form-textarea is-mono"
                    data-testid="environment-origins"
                    value={envOrigins}
                    onChange={(event) => setEnvOrigins(event.target.value)}
                    disabled={addingEnv}
                    rows={2}
                    placeholder="https://staging.example.com"
                  />
                </Field>
                <Field
                  label="排除路径"
                  hint="每行一个，运行时不会访问这些危险页面。"
                  htmlFor="environment-excluded"
                >
                  <textarea
                    id="environment-excluded"
                    className="form-textarea is-mono"
                    data-testid="environment-excluded"
                    value={envExcludedPaths}
                    onChange={(event) =>
                      setEnvExcludedPaths(event.target.value)
                    }
                    disabled={addingEnv}
                    rows={2}
                    placeholder="/admin/delete&#10;/checkout/payment"
                  />
                </Field>
                <Field label="TLS 证书校验" htmlFor="environment-tls">
                  <select
                    id="environment-tls"
                    className="form-select"
                    data-testid="environment-tls"
                    value={envTlsPolicy}
                    disabled={addingEnv}
                    onChange={(event) => {
                      setEnvTlsPolicy(
                        event.target.value as 'strict' | 'allow_self_signed',
                      );
                      setConfirmInsecureTls(false);
                    }}
                  >
                    <option value="strict">严格验证证书（推荐）</option>
                    <option value="allow_self_signed">
                      允许自签名证书（仅受控测试环境）
                    </option>
                  </select>
                </Field>
                {envTlsPolicy === 'allow_self_signed' && (
                  <label className="check lqa-form-check">
                    <input
                      type="checkbox"
                      checked={confirmInsecureTls}
                      data-testid="environment-tls-confirm"
                      onChange={(event) =>
                        setConfirmInsecureTls(event.target.checked)
                      }
                    />
                    我确认该 HTTPS
                    环境使用受控自签名证书，并理解放宽证书验证的风险。
                  </label>
                )}
                {envError && (
                  <Alert
                    tone="danger"
                    role="alert"
                    testId="environment-create-error"
                  >
                    {envError}
                  </Alert>
                )}
                <div className="form-actions">
                  <button
                    className="btn btn-primary"
                    data-testid="btn-create-environment"
                    type="submit"
                    disabled={
                      addingEnv ||
                      !envName.trim() ||
                      !envBaseUrl.trim() ||
                      (envTlsPolicy === 'allow_self_signed' &&
                        !confirmInsecureTls)
                    }
                  >
                    {addingEnv ? '创建中…' : '创建环境'}
                  </button>
                </div>
              </form>
            </Section>

            {canCreateAuth && (
              <Section icon="plus" title="添加认证凭据">
                <form onSubmit={handleCreateAuth}>
                  <Field label="凭据名称" required htmlFor="auth-profile-name">
                    <input
                      id="auth-profile-name"
                      type="text"
                      className="form-input"
                      data-testid="auth-profile-name"
                      placeholder="例如：财务管理员测试账号"
                      value={authName}
                      onChange={(e) => setAuthName(e.target.value)}
                      required
                    />
                  </Field>
                  <div className="grid-2">
                    <Field label="认证方式" htmlFor="auth-profile-mode">
                      <select
                        id="auth-profile-mode"
                        className="form-select"
                        data-testid="auth-profile-mode"
                        value={authMode}
                        onChange={(e) =>
                          setAuthMode(
                            e.target.value as 'none' | 'form' | 'storage_state',
                          )
                        }
                      >
                        <option value="none">不使用认证</option>
                        <option value="form">表单登录</option>
                        <option value="storage_state">
                          复用登录会话（storageState）
                        </option>
                      </select>
                    </Field>
                    <Field label="关联环境" htmlFor="auth-profile-environment">
                      <select
                        id="auth-profile-environment"
                        className="form-select"
                        data-testid="auth-profile-environment"
                        value={authEnvironmentId}
                        onChange={(e) => {
                          const id = e.target.value;
                          setAuthEnvironmentId(id);
                          setAuthOrigins(
                            environments
                              .find((env) => env.id === id)
                              ?.allowedOrigins.join('\n') ?? '',
                          );
                        }}
                        required
                      >
                        {environments.map((env) => (
                          <option key={env.id} value={env.id}>
                            {env.name}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>
                  <Field
                    label="获准 Origins"
                    required
                    hint="每行一个，须同时包含登录域名和业务域名，且不能超出所选环境的范围。"
                    htmlFor="auth-profile-origins"
                  >
                    <textarea
                      id="auth-profile-origins"
                      className="form-textarea is-mono"
                      data-testid="auth-profile-origins"
                      rows={2}
                      value={authOrigins}
                      onChange={(e) => setAuthOrigins(e.target.value)}
                      placeholder="https://app.example.com"
                      required
                    />
                  </Field>

                  {authMode === 'form' ? (
                    <>
                      <Field
                        label="登录页 URL"
                        required
                        htmlFor="auth-login-url"
                      >
                        <input
                          id="auth-login-url"
                          className="form-input"
                          type="url"
                          value={authLoginUrl}
                          onChange={(e) => setAuthLoginUrl(e.target.value)}
                          required
                        />
                      </Field>
                      <div className="grid-2">
                        <Field
                          label="登录用户名"
                          required
                          htmlFor="auth-username"
                        >
                          <input
                            id="auth-username"
                            className="form-input"
                            value={authUsername}
                            onChange={(e) => setAuthUsername(e.target.value)}
                            required
                          />
                        </Field>
                        <Field
                          label="登录密码"
                          required
                          hint="只写入，保存后不可查看"
                          htmlFor="auth-password"
                        >
                          <input
                            id="auth-password"
                            className="form-input"
                            type="password"
                            autoComplete="new-password"
                            value={secretVal}
                            onChange={(e) => setSecretVal(e.target.value)}
                            required
                          />
                        </Field>
                      </div>
                      <div className="section-label">登录表单定位器（CSS）</div>
                      <div className="lqa-locator-grid">
                        {[
                          ['用户名输入框', authUsernameCss, setAuthUsernameCss],
                          ['密码输入框', authPasswordCss, setAuthPasswordCss],
                          ['提交按钮', authSubmitCss, setAuthSubmitCss],
                        ].map(([label, value, setter]) => (
                          <Field label={label as string} key={label as string}>
                            <input
                              className="form-input is-mono"
                              value={value as string}
                              onChange={(e) =>
                                (
                                  setter as React.Dispatch<
                                    React.SetStateAction<string>
                                  >
                                )(e.target.value)
                              }
                              required
                            />
                          </Field>
                        ))}
                      </div>
                    </>
                  ) : authMode === 'storage_state' ? (
                    <Field
                      label="Playwright storageState JSON"
                      required
                      hint="只写入，保存后不可查看"
                      htmlFor="auth-storage-state"
                    >
                      <textarea
                        id="auth-storage-state"
                        className="form-textarea is-mono"
                        rows={4}
                        value={secretVal}
                        onChange={(e) => setSecretVal(e.target.value)}
                        placeholder='{"cookies":[],"origins":[]}'
                        required
                      />
                    </Field>
                  ) : (
                    <p className="field-hint lqa-form-note">
                      此凭据不保存任何密钥，仅用于明确标识匿名访问。
                    </p>
                  )}

                  {authMode !== 'none' && (
                    <Field
                      label="登录成功标识"
                      required
                      hint="用于判断登录是否真正成功，不以 Cookie 存在代替。"
                      htmlFor="auth-success-value"
                    >
                      <div className="lqa-success-row">
                        <select
                          className="form-select"
                          aria-label="登录成功标识类型"
                          value={authSuccessBy}
                          onChange={(e) =>
                            setAuthSuccessBy(
                              e.target.value as 'test_id' | 'text',
                            )
                          }
                        >
                          <option value="test_id">data-testid 属性</option>
                          <option value="text">页面可见文本（精确匹配）</option>
                        </select>
                        <input
                          id="auth-success-value"
                          className="form-input"
                          value={authSuccessTestId}
                          onChange={(e) => setAuthSuccessTestId(e.target.value)}
                          placeholder={
                            authSuccessBy === 'test_id'
                              ? 'dashboard-user-menu'
                              : '退出登录'
                          }
                          required
                        />
                      </div>
                    </Field>
                  )}
                  {authError && (
                    <Alert tone="danger" role="alert">
                      {authError}
                    </Alert>
                  )}

                  <div className="form-actions">
                    <button
                      type="submit"
                      className="btn btn-primary"
                      data-testid="btn-create-auth-profile"
                      disabled={addingAuth}
                    >
                      <AppIcon name="lock" size={14} />
                      {addingAuth ? '正在保存...' : '加密保存凭据'}
                    </button>
                  </div>
                </form>
              </Section>
            )}
          </div>
        )}
      </div>
    </Page>
  );
};
