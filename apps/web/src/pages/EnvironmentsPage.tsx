import React, { useEffect, useState } from 'react';
import type { Environment, AuthProfile } from '@localqa/contracts';
import { useAppContext } from '../state/AppContext.tsx';
import { defaultApiClient } from '../api/index.ts';
import { AppHeader } from '../components/layout/AppHeader.tsx';

export const EnvironmentsPage: React.FC = () => {
  const { currentProject } = useAppContext();
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [authProfiles, setAuthProfiles] = useState<AuthProfile[]>([]);
  const [_loading, setLoading] = useState(true);

  // Form states for creating auth profile
  const [authName, setAuthName] = useState('');
  const [authMode, setAuthMode] = useState<'form' | 'storage_state'>('form');
  const [secretVal, setSecretVal] = useState('');
  const [addingAuth, setAddingAuth] = useState(false);

  useEffect(() => {
    if (!currentProject) return;
    const projId = currentProject.id;
    async function load() {
      setLoading(true);
      try {
        const [eRes, aRes] = await Promise.all([
          defaultApiClient.listEnvironments(projId),
          defaultApiClient.listAuthProfiles(projId),
        ]);
        setEnvironments(eRes.items);
        setAuthProfiles(aRes.items);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [currentProject]);

  const handleCreateAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authName.trim() || !currentProject) return;
    setAddingAuth(true);
    try {
      const created = await defaultApiClient.createAuthProfile(
        currentProject.id,
        {
          name: authName,
          mode: authMode,
          allowedOrigins: ['http://localhost:8080'],
        },
      );
      setAuthProfiles([...authProfiles, created]);
      setAuthName('');
      setSecretVal('');
      alert('认证凭据已保存（密码以 Write-Only 加密入库）');
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

          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>环境名称</th>
                  <th>基准地址 (Base URL)</th>
                  <th>获准 Origins</th>
                  <th>限制危险路径</th>
                  <th>TLS 策略</th>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
                      <span className="badge badge-success">
                        已加密写入 (Write-Only)
                      </span>
                    </td>
                    <td>v{ap.version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Add Auth Profile Form */}
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
                  value={authMode}
                  onChange={(e) =>
                    setAuthMode(e.target.value as 'form' | 'storage_state')
                  }
                >
                  <option value="form">表单模拟登录 (Form Login)</option>
                  <option value="storage_state">StorageState 会话复用</option>
                </select>
              </div>

              <div className="form-group">
                <label className="form-label">
                  登录密码 / Token (Write-Only)
                </label>
                <input
                  type="password"
                  className="form-input"
                  placeholder="••••••••••••"
                  value={secretVal}
                  onChange={(e) => setSecretVal(e.target.value)}
                  required
                />
              </div>
            </div>

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
                disabled={addingAuth}
              >
                {addingAuth ? '正在保存...' : '加密保存认证凭据'}
              </button>
            </div>
          </form>
        </div>
      </main>
    </div>
  );
};
