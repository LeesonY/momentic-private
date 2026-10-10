import React, { useEffect, useState } from 'react';
import type {
  Environment,
  AuthProfile,
  AuthProfileCreate,
  Criterion,
} from '@localqa/contracts';
import { useAppContext } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { AppHeader } from '../components/layout/AppHeader.tsx';
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

  return (
    <div className="app-container" data-testid="environments-page">
      <AppHeader />
      <main className="main-content">
        <div style={{ marginBottom: '24px' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>
            环境与认证管理 (Environments & Auth)
          </h1>
          <p style={{ fontSize: '0.875rem', color: 'var(--color-text-muted)' }}>
            配置被测站点白名单范围、安全边界与 Write-Only 加密认证凭据。
          </p>
        </div>

        {/* Section 1: Environments */}
        <div className="card" style={{ marginBottom: '24px' }}>
          <div className="card-header">
            <h2 className="card-title">被测目标环境 (Environments)</h2>
          </div>

          {loadError && (
            <p role="alert" data-testid="environment-load-error">
              {loadError}
            </p>
          )}
          {loading && <p>正在加载项目配置…</p>}
          {!loading && environments.length === 0 && (
            <p data-testid="environments-empty-state">
              当前项目尚无环境。项目负责人需要先创建环境，再添加认证配置。
            </p>
          )}
          {currentProject && canConfigure && !loading && !loadError && (
            <form
              onSubmit={(event) => void handleCreateEnvironment(event)}
              data-testid="create-environment-form"
              style={{
                display: 'grid',
                gap: 12,
                padding: 16,
                marginBottom: 20,
                background: 'var(--color-bg-subtle)',
              }}
            >
              <h3 style={{ fontSize: '0.95rem', fontWeight: 600 }}>
                创建测试环境
              </h3>
              <label className="form-label" htmlFor="environment-name">
                环境名称
              </label>
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
              <label className="form-label" htmlFor="environment-base-url">
                基准 URL（保留路径与参数）
              </label>
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
              <label className="form-label" htmlFor="environment-origins">
                允许访问的 Origins（每行一个）
              </label>
              <textarea
                id="environment-origins"
                className="form-input"
                data-testid="environment-origins"
                value={envOrigins}
                onChange={(event) => setEnvOrigins(event.target.value)}
                disabled={addingEnv}
                rows={2}
                placeholder="https://staging.example.com"
              />
              <label className="form-label" htmlFor="environment-excluded">
                排除的路径（每行一个，默认不操作危险页面）
              </label>
              <textarea
                id="environment-excluded"
                className="form-input"
                data-testid="environment-excluded"
                value={envExcludedPaths}
                onChange={(event) => setEnvExcludedPaths(event.target.value)}
                disabled={addingEnv}
                rows={2}
                placeholder="/admin/delete&#10;/checkout/payment"
              />
              <label className="form-label" htmlFor="environment-tls">
                TLS 证书校验
              </label>
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
              {envTlsPolicy === 'allow_self_signed' && (
                <label style={{ display: 'flex', gap: 8 }}>
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
                <p role="alert" data-testid="environment-create-error">
                  {envError}
                </p>
              )}
              <button
                className="btn btn-primary"
                data-testid="btn-create-environment"
                type="submit"
                disabled={
                  addingEnv ||
                  !envName.trim() ||
                  !envBaseUrl.trim() ||
                  (envTlsPolicy === 'allow_self_signed' && !confirmInsecureTls)
                }
              >
                {addingEnv ? '创建中…' : '创建环境'}
              </button>
            </form>
          )}

          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>环境名称</th>
                  <th>基准地址 (Base URL)</th>
                  <th>获准 Origins</th>
                  <th>限制危险路径</th>
                  <th>TLS 策略</th>
                  <th>默认认证</th>
                  {canConfigure && <th>操作</th>}
                </tr>
              </thead>
              <tbody>
                {environments.map((env) => (
                  <tr key={env.id} data-testid={`env-row-${env.id}`}>
                    <td>
                      <strong>{env.name}</strong>
                    </td>
                    <td>
                      <code>{env.baseUrl}</code>
                    </td>
                    <td>{env.allowedOrigins.join(', ')}</td>
                    <td>
                      <span className="badge badge-warning">
                        {env.excludedPaths.length} 条排除路径
                      </span>
                    </td>
                    <td>
                      <span className="badge badge-neutral">
                        {env.tlsPolicy}
                      </span>
                    </td>
                    <td>
                      {authProfiles.find(
                        (ap) => ap.id === env.defaultAuthProfileId,
                      )?.name ?? '无'}
                    </td>
                    {canConfigure && (
                      <td>
                        <button
                          className="btn btn-secondary btn-sm"
                          type="button"
                          data-testid={`btn-edit-env-${env.id}`}
                          disabled={savingEnv}
                          onClick={() => beginEditEnvironment(env)}
                        >
                          编辑
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {currentProject && canConfigure && !loadError && editingEnvId && (
            <form
              data-testid="edit-environment-form"
              onSubmit={(event) => void handleUpdateEnvironment(event)}
              style={{
                display: 'grid',
                gap: 12,
                marginTop: 18,
                padding: 16,
                background: 'var(--color-bg-subtle)',
              }}
            >
              <h3>编辑测试环境（保存前检查版本）</h3>
              <label className="form-label" htmlFor="edit-environment-name">
                环境名称
              </label>
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
              <label className="form-label" htmlFor="edit-environment-base-url">
                基准 URL
              </label>
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
              <label className="form-label" htmlFor="edit-environment-origins">
                获准 Origins（每行一个）
              </label>
              <textarea
                id="edit-environment-origins"
                data-testid="edit-environment-origins"
                className="form-input"
                rows={2}
                value={editOrigins}
                onChange={(event) => setEditOrigins(event.target.value)}
                disabled={savingEnv}
              />
              <label className="form-label" htmlFor="edit-environment-excluded">
                排除路径（每行一个）
              </label>
              <textarea
                id="edit-environment-excluded"
                data-testid="edit-environment-excluded"
                className="form-input"
                rows={2}
                value={editExcludedPaths}
                onChange={(event) => setEditExcludedPaths(event.target.value)}
                disabled={savingEnv}
              />
              <label className="form-label" htmlFor="edit-environment-tls">
                TLS 证书策略
              </label>
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
              {editTlsPolicy === 'allow_self_signed' && (
                <label style={{ display: 'flex', gap: 8 }}>
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
              <label
                className="form-label"
                htmlFor="edit-environment-default-auth"
              >
                默认认证档案（仅此环境的有效档案）
              </label>
              <select
                id="edit-environment-default-auth"
                data-testid="edit-environment-default-auth"
                className="form-select"
                value={editDefaultAuthId}
                onChange={(event) => setEditDefaultAuthId(event.target.value)}
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
              {editError && (
                <p role="alert" data-testid="edit-environment-error">
                  {editError}
                </p>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-primary"
                  type="submit"
                  data-testid="btn-save-environment"
                  disabled={
                    savingEnv ||
                    !editName.trim() ||
                    !editBaseUrl.trim() ||
                    (editTlsPolicy === 'allow_self_signed' && !editTlsConfirmed)
                  }
                >
                  {savingEnv ? '保存中…' : '保存环境修改'}
                </button>
                <button
                  className="btn btn-secondary"
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
              </div>
            </form>
          )}
        </div>

        {/* Section 2: Auth Profiles & Write-Only Secret Form */}
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">
              认证凭据档案 (Auth Profiles - Write Only)
            </h2>
            <span className="badge badge-primary">Write-Only 安全保密</span>
          </div>

          <p
            style={{
              fontSize: '0.85rem',
              color: 'var(--color-text-muted)',
              marginBottom: '16px',
            }}
          >
            * 依照 LocalQA 安全设计，认证密钥原值仅支持一次性写入，写入后由后台
            SecretVault 单独存储并仅在获准 Worker 内解密，API 与 UI
            坚决不回显明文密码。
          </p>

          <div className="table-container" style={{ marginBottom: '24px' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>凭据标识</th>
                  <th>名称</th>
                  <th>认证模式</th>
                  <th>密钥状态</th>
                  <th>版本</th>
                </tr>
              </thead>
              <tbody>
                {authProfiles.map((ap) => (
                  <tr key={ap.id} data-testid={`auth-row-${ap.id}`}>
                    <td>
                      <code>{ap.id}</code>
                    </td>
                    <td>
                      <strong>{ap.name}</strong>
                    </td>
                    <td>
                      <span className="badge badge-info">{ap.mode}</span>
                    </td>
                    <td>
                      <span
                        className={`badge ${ap.hasSecret ? 'badge-success' : 'badge-neutral'}`}
                      >
                        {ap.hasSecret ? '已加密写入（不回显）' : '无密钥'}
                      </span>
                    </td>
                    <td>v{ap.version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Add Auth Profile Form */}
          {currentProject &&
            canConfigure &&
            environments.length > 0 &&
            !loading &&
            !loadError && (
              <form
                onSubmit={handleCreateAuth}
                style={{
                  padding: '16px',
                  backgroundColor: 'var(--color-bg-subtle)',
                  borderRadius: 'var(--radius-md)',
                }}
              >
                <h3
                  style={{
                    fontSize: '0.95rem',
                    fontWeight: 600,
                    marginBottom: '12px',
                  }}
                >
                  添加新认证凭据 (Write-Only 录入)
                </h3>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr 1fr',
                    gap: '14px',
                  }}
                >
                  <div className="form-group">
                    <label className="form-label">凭据档案名称</label>
                    <input
                      type="text"
                      className="form-input"
                      data-testid="auth-profile-name"
                      placeholder="例如: 财务管理员测试账号"
                      value={authName}
                      onChange={(e) => setAuthName(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label className="form-label">认证模式</label>
                    <select
                      className="form-select"
                      data-testid="auth-profile-mode"
                      value={authMode}
                      onChange={(e) =>
                        setAuthMode(
                          e.target.value as 'none' | 'form' | 'storage_state',
                        )
                      }
                    >
                      <option value="none">不使用认证（None）</option>
                      <option value="form">表单模拟登录 (Form Login)</option>
                      <option value="storage_state">
                        StorageState 会话复用
                      </option>
                    </select>
                  </div>

                  <div className="form-group">
                    <label className="form-label">关联环境</label>
                    <select
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
                  </div>
                </div>

                <div className="form-group" style={{ marginTop: '12px' }}>
                  <label className="form-label">
                    获准 Origins（每行一个，须包括登录域名和业务域名）
                  </label>
                  <textarea
                    className="form-input"
                    data-testid="auth-profile-origins"
                    rows={2}
                    value={authOrigins}
                    onChange={(e) => setAuthOrigins(e.target.value)}
                    placeholder="https://app.example.com"
                    required
                  />
                </div>

                {authMode === 'form' ? (
                  <>
                    <div className="form-group">
                      <label className="form-label">登录页 URL</label>
                      <input
                        className="form-input"
                        type="url"
                        value={authLoginUrl}
                        onChange={(e) => setAuthLoginUrl(e.target.value)}
                        required
                      />
                    </div>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr',
                        gap: '14px',
                      }}
                    >
                      <div className="form-group">
                        <label className="form-label">登录用户名</label>
                        <input
                          className="form-input"
                          value={authUsername}
                          onChange={(e) => setAuthUsername(e.target.value)}
                          required
                        />
                      </div>
                      <div className="form-group">
                        <label className="form-label">
                          登录密码（Write-Only）
                        </label>
                        <input
                          className="form-input"
                          type="password"
                          autoComplete="new-password"
                          value={secretVal}
                          onChange={(e) => setSecretVal(e.target.value)}
                          required
                        />
                      </div>
                      {[
                        [
                          '用户名 CSS 定位器',
                          authUsernameCss,
                          setAuthUsernameCss,
                        ],
                        [
                          '密码 CSS 定位器',
                          authPasswordCss,
                          setAuthPasswordCss,
                        ],
                        [
                          '提交按钮 CSS 定位器',
                          authSubmitCss,
                          setAuthSubmitCss,
                        ],
                      ].map(([label, value, setter]) => (
                        <div className="form-group" key={label as string}>
                          <label className="form-label">
                            {label as string}
                          </label>
                          <input
                            className="form-input"
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
                        </div>
                      ))}
                    </div>
                  </>
                ) : authMode === 'storage_state' ? (
                  <div className="form-group">
                    <label className="form-label">
                      Playwright storageState JSON（Write-Only）
                    </label>
                    <textarea
                      className="form-input"
                      rows={4}
                      value={secretVal}
                      onChange={(e) => setSecretVal(e.target.value)}
                      placeholder='{"cookies":[],"origins":[]}'
                      required
                    />
                  </div>
                ) : (
                  <p className="form-help">
                    此档案不保存凭据，仅用于明确标识匿名访问。
                  </p>
                )}

                {authMode !== 'none' && (
                  <div className="form-group">
                    <label className="form-label">
                      登录成功标识（必填，不以 Cookie 存在代替登录成功）
                    </label>
                    <select
                      className="form-select"
                      value={authSuccessBy}
                      onChange={(e) =>
                        setAuthSuccessBy(e.target.value as 'test_id' | 'text')
                      }
                    >
                      <option value="test_id">data-testid 属性</option>
                      <option value="text">页面可见文本（精确匹配）</option>
                    </select>
                    <input
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
                )}
                {authError && (
                  <p role="alert" className="text-danger">
                    {authError}
                  </p>
                )}

                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'flex-end',
                    marginTop: '12px',
                  }}
                >
                  <button
                    type="submit"
                    className="btn btn-primary btn-sm"
                    data-testid="btn-create-auth-profile"
                    disabled={addingAuth}
                  >
                    {addingAuth ? '正在保存...' : '加密保存认证凭据'}
                  </button>
                </div>
              </form>
            )}
        </div>
      </main>
    </div>
  );
};
